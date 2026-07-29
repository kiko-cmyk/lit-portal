/**
 * Shopify Admin GraphQL client.
 *
 * Auth strategy: client_credentials grant. Tokens are issued via
 * `POST /admin/oauth/access_token` with client_id + client_secret and
 * live for 24h. We cache the token in-process and refresh on demand.
 *
 * If `SHOPIFY_ADMIN_TOKEN` is set in env, we use it directly (e.g., for a
 * statically-issued long-lived token). Otherwise we fetch via client creds.
 *
 * Credential selection (resolved 2026-05-26 when Kiko's old orders stopped
 * showing): the LIT Portal v3 app and LIT Portal Admin app both have
 * `read_orders` scope but NOT `read_all_orders` (Shopify denies the request
 * for these app types). Without `read_all_orders` Shopify hides orders
 * older than 60 days from the API — which silently wipes most history for
 * any customer who's been around a while.
 *
 * Workaround: a third app (the legacy LIT theme app, full-scoped) DOES
 * have `read_all_orders`. We use ITS credentials for Admin API calls when
 * `SHOPIFY_ADMIN_CLIENT_ID`/`SHOPIFY_ADMIN_CLIENT_SECRET` are set. The
 * existing `SHOPIFY_API_KEY`/`SECRET` remain reserved for App Proxy
 * signature verification (which MUST stay on the v3 app's secret because
 * Shopify signs proxy requests with that app's client_secret).
 */

import { budgetWithin, fetchDeadline, msLeft, UpstreamTimeoutError } from "./http-timeout";

const SHOPIFY_STORE = process.env.SHOPIFY_STORE; // e.g. "lit-tienda.myshopify.com"
const ADMIN_CLIENT_ID = process.env.SHOPIFY_ADMIN_CLIENT_ID ?? process.env.SHOPIFY_API_KEY;
const ADMIN_CLIENT_SECRET = process.env.SHOPIFY_ADMIN_CLIENT_SECRET ?? process.env.SHOPIFY_API_SECRET;
const ADMIN_API_VERSION = "2026-04";

interface CachedToken {
  token: string;
  expiresAt: number; // epoch ms
}

let _cached: CachedToken | null = null;

async function getAdminToken(): Promise<string> {
  // Prefer client_credentials when separate admin app creds are configured
  // (SHOPIFY_ADMIN_CLIENT_ID set). This wins even if SHOPIFY_ADMIN_TOKEN
  // is also set in env — operators sometimes forget to clear the old
  // static token when adding the new dedicated admin app, and we need
  // the new app to take effect immediately. The static token remains as
  // a fallback for environments without separate admin creds.
  const hasDedicatedAdminApp = !!process.env.SHOPIFY_ADMIN_CLIENT_ID && !!process.env.SHOPIFY_ADMIN_CLIENT_SECRET;
  if (!hasDedicatedAdminApp) {
    const fromEnv = process.env.SHOPIFY_ADMIN_TOKEN;
    if (fromEnv) return fromEnv;
  }

  // Cache hit (with 5min buffer before expiry)
  if (_cached && _cached.expiresAt > Date.now() + 5 * 60 * 1000) {
    return _cached.token;
  }

  if (!SHOPIFY_STORE || !ADMIN_CLIENT_ID || !ADMIN_CLIENT_SECRET) {
    throw new Error("SHOPIFY_STORE, SHOPIFY_ADMIN_CLIENT_ID (or SHOPIFY_API_KEY), SHOPIFY_ADMIN_CLIENT_SECRET (or SHOPIFY_API_SECRET) required");
  }

  // The token exchange is the first hop of every cold invocation, so it gets a
  // deadline of its own: a stall here used to hang the whole route before a
  // single GraphQL byte moved.
  const { signal, timedOut } = fetchDeadline(SHOPIFY_TOKEN_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`https://${SHOPIFY_STORE}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: ADMIN_CLIENT_ID,
        client_secret: ADMIN_CLIENT_SECRET,
        grant_type: "client_credentials",
      }),
      signal,
    });
  } catch (err) {
    if (timedOut()) {
      throw new UpstreamTimeoutError("shopify", "oauth/access_token", SHOPIFY_TOKEN_TIMEOUT_MS);
    }
    throw err;
  }
  if (!res.ok) {
    throw new Error(`Shopify token exchange failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { access_token: string; expires_in?: number };
  const ttlMs = (json.expires_in ?? 86400) * 1000;
  _cached = { token: json.access_token, expiresAt: Date.now() + ttlMs };
  return json.access_token;
}

// Transient-failure retry budget for idempotent reads. Shopify occasionally
// returns a 5xx / INTERNAL_SERVER_ERROR / THROTTLED on an otherwise healthy
// call — e.g. 2026-07-01 a lone INTERNAL_SERVER_ERROR on the payment-method
// read surfaced to a customer as a 500 + a false P0 alert, and the identical
// read succeeded seconds later. One or two retries with backoff absorb the
// common blip; persistent failures still propagate as before. Mirrors the
// Seal client's retry (src/lib/seal.ts).
const SHOPIFY_MAX_RETRIES = 2;
const SHOPIFY_BACKOFF_MS = 300;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Deadlines (incident 2026-07-27, see lib/http-timeout.ts). Admin GraphQL
// answers in ~150ms healthy, so 6s per attempt only ever catches a stall. The
// 9s total is what actually matters: it bounds token exchange + all retries +
// backoff, keeping the client inside the App Proxy's ~10s patience instead of
// silently burning the route's 60s maxDuration.
const SHOPIFY_ATTEMPT_TIMEOUT_MS = 6_000;
const SHOPIFY_TOTAL_BUDGET_MS = 9_000;
const SHOPIFY_TOKEN_TIMEOUT_MS = 5_000;

// Shopify GraphQL error codes (in `errors[].extensions.code`) safe to retry on
// an idempotent read. Everything else (validation, ACCESS_DENIED, user-level
// errors) is terminal — retrying would just waste time.
const RETRYABLE_GQL_CODES = new Set(["INTERNAL_SERVER_ERROR", "THROTTLED"]);

function hasTransientGraphqlError(errors: unknown): boolean {
  if (!Array.isArray(errors)) return false;
  return errors.some((e) => {
    const code = (e as { extensions?: { code?: string } })?.extensions?.code;
    return typeof code === "string" && RETRYABLE_GQL_CODES.has(code);
  });
}

// True ONLY when the document is confidently a read (a `query` or an anonymous
// `{ ... }` query). Fail-safe by design: GraphQL always POSTs, so the HTTP verb
// can't tell reads from writes, and anything we can't positively classify as a
// read (mutations, subscriptions, or a doc with an unexpected leading token) is
// treated as NON-retryable. A retried mutation would double-send the card
// update email (customerPaymentMethodSendUpdateEmail), burn a single-use update
// URL, or double-apply a subscription-contract commit — so when in doubt we
// never retry. Leading whitespace and `#` comment lines are stripped first so a
// commented mutation can't slip through as a "read".
function isRetryableReadDocument(doc: string): boolean {
  const head = doc.replace(/^(?:\s+|#[^\n]*\n?)+/, "");
  return /^(?:query\b|\{)/.test(head);
}

/** Errors we deliberately threw from graphql() — terminal, never retried. */
class ShopifyAdminError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShopifyAdminError";
  }
}

/**
 * A Shopify mutation came back with `userErrors` — i.e. the INPUT was rejected
 * (a malformed phone, an email already in use, a name too long…). That's the
 * customer's data, not a bug on our side, so callers can catch this and map it
 * to a 400 instead of letting a plain Error bubble up as a generic 500 (which
 * also fires a false internal_error alert into #server-errors). Carries the raw
 * userErrors so the caller can branch on the offending field.
 */
export class ShopifyUserError extends Error {
  constructor(public userErrors: Array<{ field: string[]; message: string }>) {
    super(`Shopify user errors: ${JSON.stringify(userErrors)}`);
    this.name = "ShopifyUserError";
  }
}

class ShopifyAdminClient {
  private endpoint(): string {
    if (!SHOPIFY_STORE) throw new Error("SHOPIFY_STORE not set");
    return `https://${SHOPIFY_STORE}/admin/api/${ADMIN_API_VERSION}/graphql.json`;
  }

  async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    // Retry transient Shopify failures ONLY on idempotent reads. GraphQL always
    // POSTs, so we classify the document itself; mutations are never retried
    // (see isRetryableReadDocument).
    const readRetryable = isRetryableReadDocument(query);
    // Budget covers the whole call: token exchange + every attempt + backoff.
    const budget = budgetWithin(SHOPIFY_TOTAL_BUDGET_MS);
    const token = await getAdminToken();

    for (let attempt = 0; ; attempt++) {
      const canRetry = readRetryable && attempt < SHOPIFY_MAX_RETRIES;
      const left = msLeft(budget);
      if (left <= 0) {
        throw new UpstreamTimeoutError("shopify", "graphql", SHOPIFY_TOTAL_BUDGET_MS);
      }
      const { signal, timedOut } = fetchDeadline(Math.min(SHOPIFY_ATTEMPT_TIMEOUT_MS, left));
      try {
        const res = await fetch(this.endpoint(), {
          method: "POST",
          headers: {
            "X-Shopify-Access-Token": token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query, variables }),
          signal,
        });
        if (!res.ok) {
          if (canRetry && (res.status === 429 || res.status >= 500)) {
            const wait = SHOPIFY_BACKOFF_MS * (attempt + 1);
            if (msLeft(budget) > wait + 500) {
              await sleep(wait);
              continue;
            }
          }
          throw new ShopifyAdminError(`Shopify Admin ${res.status}: ${await res.text()}`);
        }
        const json = (await res.json()) as { data?: T; errors?: unknown };
        if (json.errors) {
          if (canRetry && hasTransientGraphqlError(json.errors)) {
            const wait = SHOPIFY_BACKOFF_MS * (attempt + 1);
            if (msLeft(budget) > wait + 500) {
              await sleep(wait);
              continue;
            }
          }
          throw new ShopifyAdminError(`Shopify Admin errors: ${JSON.stringify(json.errors)}`);
        }
        return json.data as T;
      } catch (err) {
        // Our own deadline fired: a stalled socket. Typed so api-helpers can
        // alert and return a retryable 503 instead of hanging the whole route.
        if (timedOut()) {
          throw new UpstreamTimeoutError("shopify", "graphql", SHOPIFY_ATTEMPT_TIMEOUT_MS);
        }
        // fetch() itself rejected (network / DNS / connection reset). Retry
        // idempotent reads. Never retry a ShopifyAdminError we already chose to
        // throw above (terminal), nor a caller-driven AbortError.
        const name = (err as { name?: string })?.name;
        if (
          canRetry &&
          !(err instanceof ShopifyAdminError) &&
          !(err instanceof UpstreamTimeoutError) &&
          name !== "AbortError"
        ) {
          const wait = SHOPIFY_BACKOFF_MS * (attempt + 1);
          if (msLeft(budget) > wait + 500) {
            await sleep(wait);
            continue;
          }
        }
        throw err;
      }
    }
  }

  /**
   * Resolve the customer's email from their Shopify customer ID.
   * Used by the portal to translate App Proxy `logged_in_customer_id`
   * (numeric Shopify ID) into something Seal can match on.
   */
  async getCustomerEmail(customerId: string): Promise<string | null> {
    const gid = customerId.startsWith("gid://")
      ? customerId
      : `gid://shopify/Customer/${customerId}`;
    const data = await this.graphql<{ customer: { email: string } | null }>(
      `query getEmail($id: ID!) { customer(id: $id) { email } }`,
      { id: gid },
    );
    return data.customer?.email ?? null;
  }

  /**
   * Email + tags in one query. Sibling of `getCustomerEmail` (which has 26 call
   * sites and stays untouched): only the callers that need to know whether this
   * is a wholesale customer pay for the extra field. `tags` is where the B2B
   * cohort lives — LIT's store is non-Plus, so there are no Shopify Companies
   * and the whole B2B experience is gated on the customer tag `B2B`.
   */
  async getCustomerEmailAndTags(
    customerId: string,
  ): Promise<{ email: string | null; tags: string[] }> {
    const gid = customerId.startsWith("gid://")
      ? customerId
      : `gid://shopify/Customer/${customerId}`;
    const data = await this.graphql<{
      customer: { email: string; tags: string[] } | null;
    }>(`query getEmailTags($id: ID!) { customer(id: $id) { email tags } }`, {
      id: gid,
    });
    return { email: data.customer?.email ?? null, tags: data.customer?.tags ?? [] };
  }

  async getCustomer(customerId: string): Promise<{
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    phone: string | null;
    createdAt: string;
    numberOfOrders: string;
    tags: string[];
    defaultAddress: {
      company: string | null;
      address1: string | null;
      address2: string | null;
      city: string | null;
      zip: string | null;
      province: string | null;
      provinceCode: string | null;
      country: string | null;
      countryCode: string | null;
      phone: string | null;
    } | null;
    /** `lit_b2b.tax_id` — NIF/CIF. Only ever written from the B2B account form. */
    taxId: string | null;
  } | null> {
    const gid = customerId.startsWith("gid://")
      ? customerId
      : `gid://shopify/Customer/${customerId}`;
    const data = await this.graphql<{
      customer: {
        id: string;
        email: string;
        firstName: string | null;
        lastName: string | null;
        phone: string | null;
        createdAt: string;
        numberOfOrders: string;
        tags: string[];
        defaultAddress: {
          company: string | null;
          address1: string | null;
          address2: string | null;
          city: string | null;
          zip: string | null;
          province: string | null;
          provinceCode: string | null;
          country: string | null;
          countryCode: string | null;
          phone: string | null;
        } | null;
        metafield: { value: string } | null;
      } | null;
    }>(
      // `tags`, `defaultAddress` and the fiscal metafield ride along in the query
      // this route already makes (no extra round trip) so the Account page can
      // tell a wholesale customer apart and show their billing details.
      `query getCustomer($id: ID!) {
         customer(id: $id) {
           id email firstName lastName phone createdAt numberOfOrders tags
           defaultAddress {
             company address1 address2 city zip province provinceCode country countryCode phone
           }
           metafield(namespace: "lit_b2b", key: "tax_id") { value }
         }
       }`,
      { id: gid },
    );
    if (!data.customer) return null;
    const { metafield, ...rest } = data.customer;
    return { ...rest, taxId: metafield?.value ?? null };
  }

  /**
   * List orders for a customer (Account page order history).
   */
  async listOrdersByCustomer(customerId: string, limit = 10): Promise<Array<{
    id: string;
    orderNumber: string;
    date: string;
    total: number;
    currency: string;
    status: string;
    invoiceUrl: string | null;
  }>> {
    const numericId = customerId.replace(/^gid:\/\/shopify\/Customer\//, "");
    const data = await this.graphql<{
      orders: { edges: Array<{ node: {
        id: string;
        name: string;
        createdAt: string;
        currentTotalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
        displayFulfillmentStatus: string;
        statusPageUrl: string | null;
      } }> };
    }>(
      `query orders($q: String!, $first: Int!) {
         orders(first: $first, query: $q, sortKey: CREATED_AT, reverse: true) {
           edges { node {
             id name createdAt
             currentTotalPriceSet { shopMoney { amount currencyCode } }
             displayFulfillmentStatus
             statusPageUrl
           } }
         }
       }`,
      { q: `customer_id:${numericId}`, first: limit },
    );
    return data.orders.edges.map(({ node: o }) => ({
      id: o.id,
      orderNumber: o.name,
      date: o.createdAt,
      total: parseFloat(o.currentTotalPriceSet.shopMoney.amount),
      currency: o.currentTotalPriceSet.shopMoney.currencyCode,
      status: o.displayFulfillmentStatus,
      invoiceUrl: o.statusPageUrl,
    }));
  }

  /**
   * Recent fulfillments for the timeline strip on Hub.
   * Returns shipped/delivered events with tracking info, plus a peek of
   * the in-progress order (if any).
   */
  async listFulfillmentsByCustomer(customerId: string, limit = 5): Promise<Array<{
    shipmentId: string;
    status: "scheduled" | "shipped" | "delivered";
    shippedAt: string | null;
    trackingNumber: string | null;
    trackingUrl: string | null;
    deliveredAt: string | null;
    boxNumber: number;
  }>> {
    const numericId = customerId.replace(/^gid:\/\/shopify\/Customer\//, "");
    const data = await this.graphql<{
      orders: { edges: Array<{ node: {
        id: string;
        createdAt: string;
        fulfillments: Array<{
          id: string;
          createdAt: string;
          deliveredAt: string | null;
          status: string;
          displayStatus: string | null;
          trackingInfo: Array<{ number: string | null; url: string | null }>;
        }>;
      } }> };
    }>(
      `query fulfillments($q: String!, $first: Int!) {
         orders(first: $first, query: $q, sortKey: CREATED_AT, reverse: true) {
           edges { node {
             id createdAt
             fulfillments(first: 3) {
               id createdAt deliveredAt status displayStatus
               trackingInfo { number url }
             }
           } }
         }
       }`,
      { q: `customer_id:${numericId}`, first: limit },
    );

    // Flatten orders → fulfillments (newest first), assign sequential box numbers.
    const all: Array<{
      shipmentId: string;
      shippedAt: string | null;
      deliveredAt: string | null;
      trackingNumber: string | null;
      trackingUrl: string | null;
      status: "scheduled" | "shipped" | "delivered";
    }> = [];

    for (const { node: order } of data.orders.edges) {
      for (const f of order.fulfillments) {
        const tracking = f.trackingInfo[0];
        const status: "shipped" | "delivered" = f.deliveredAt ? "delivered" : "shipped";
        all.push({
          shipmentId: f.id,
          shippedAt: f.createdAt,
          deliveredAt: f.deliveredAt,
          trackingNumber: tracking?.number ?? null,
          trackingUrl: tracking?.url ?? null,
          status,
        });
      }
    }
    // Oldest first for sequential box numbering, then reverse for return (newest first)
    all.sort((a, b) => (a.shippedAt ?? "").localeCompare(b.shippedAt ?? ""));
    return all.map((entry, i) => ({ ...entry, boxNumber: i + 1 })).reverse();
  }

  /**
   * Single-order full detail for the portal's per-order page. Pulls
   * everything needed to render contact, addresses, items, totals,
   * fulfillment + tracking, and to verify ownership against the
   * authenticated customer.
   *
   * The caller MUST check that `result.customerNumericId` matches
   * `ctx.customerId` before returning to the client — otherwise this
   * exposes any order by GID.
   */
  async getOrderDetail(orderGid: string): Promise<{
    customerNumericId: string | null;
    id: string;
    name: string;
    createdAt: string;
    cancelledAt: string | null;
    displayFulfillmentStatus: string;
    displayFinancialStatus: string;
    customer: { email: string | null; phone: string | null; firstName: string | null; lastName: string | null } | null;
    shippingAddress: {
      firstName: string | null; lastName: string | null;
      address1: string | null; address2: string | null;
      city: string | null; zip: string | null; province: string | null; country: string | null;
      phone: string | null;
    } | null;
    billingAddress: {
      firstName: string | null; lastName: string | null;
      address1: string | null; address2: string | null;
      city: string | null; zip: string | null; province: string | null; country: string | null;
      phone: string | null;
    } | null;
    lineItems: Array<{
      id: string;
      title: string;
      variantTitle: string | null;
      quantity: number;
      originalUnitPrice: string;
      currency: string;
      sku: string | null;
      imageUrl: string | null;
    }>;
    subtotalPrice: { amount: string; currencyCode: string } | null;
    totalShippingPrice: { amount: string; currencyCode: string } | null;
    totalTax: { amount: string; currencyCode: string } | null;
    currentTotalPrice: { amount: string; currencyCode: string };
    shippingMethodTitle: string | null;
    fulfillments: Array<{
      id: string;
      createdAt: string;
      deliveredAt: string | null;
      status: string;
      displayStatus: string | null;
      trackingNumber: string | null;
      trackingUrl: string | null;
      trackingCompany: string | null;
    }>;
  } | null> {
    const data = await this.graphql<{
      order: {
        id: string;
        name: string;
        createdAt: string;
        cancelledAt: string | null;
        displayFulfillmentStatus: string;
        displayFinancialStatus: string;
        customer: { id: string; email: string | null; phone: string | null; firstName: string | null; lastName: string | null } | null;
        shippingAddress: {
          firstName: string | null; lastName: string | null;
          address1: string | null; address2: string | null;
          city: string | null; zip: string | null; province: string | null; country: string | null;
          phone: string | null;
        } | null;
        billingAddress: {
          firstName: string | null; lastName: string | null;
          address1: string | null; address2: string | null;
          city: string | null; zip: string | null; province: string | null; country: string | null;
          phone: string | null;
        } | null;
        lineItems: {
          edges: Array<{ node: {
            id: string;
            title: string;
            variantTitle: string | null;
            quantity: number;
            sku: string | null;
            originalUnitPriceSet: { shopMoney: { amount: string; currencyCode: string } };
            image: { url: string } | null;
          } }>;
        };
        subtotalPriceSet: { shopMoney: { amount: string; currencyCode: string } } | null;
        totalShippingPriceSet: { shopMoney: { amount: string; currencyCode: string } } | null;
        totalTaxSet: { shopMoney: { amount: string; currencyCode: string } } | null;
        currentTotalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
        shippingLines: { edges: Array<{ node: { title: string } }> };
        fulfillments: Array<{
          id: string;
          createdAt: string;
          deliveredAt: string | null;
          status: string;
          displayStatus: string | null;
          trackingInfo: Array<{ number: string | null; url: string | null; company: string | null }>;
        }>;
      } | null;
    }>(
      `query orderDetail($id: ID!) {
         order(id: $id) {
           id name createdAt cancelledAt
           displayFulfillmentStatus displayFinancialStatus
           customer { id email phone firstName lastName }
           shippingAddress { firstName lastName address1 address2 city zip province country phone }
           billingAddress  { firstName lastName address1 address2 city zip province country phone }
           lineItems(first: 50) {
             edges { node {
               id title variantTitle quantity sku
               originalUnitPriceSet { shopMoney { amount currencyCode } }
               image { url }
             } }
           }
           subtotalPriceSet      { shopMoney { amount currencyCode } }
           totalShippingPriceSet { shopMoney { amount currencyCode } }
           totalTaxSet           { shopMoney { amount currencyCode } }
           currentTotalPriceSet  { shopMoney { amount currencyCode } }
           shippingLines(first: 1) { edges { node { title } } }
           fulfillments(first: 5) {
             id createdAt deliveredAt status displayStatus
             trackingInfo { number url company }
           }
         }
       }`,
      { id: orderGid },
    );

    const o = data.order;
    if (!o) return null;

    const customerNumericId = o.customer?.id
      ? o.customer.id.replace(/^gid:\/\/shopify\/Customer\//, "")
      : null;

    return {
      customerNumericId,
      id: o.id,
      name: o.name,
      createdAt: o.createdAt,
      cancelledAt: o.cancelledAt,
      displayFulfillmentStatus: o.displayFulfillmentStatus,
      displayFinancialStatus: o.displayFinancialStatus,
      customer: o.customer
        ? {
            email: o.customer.email,
            phone: o.customer.phone,
            firstName: o.customer.firstName,
            lastName: o.customer.lastName,
          }
        : null,
      shippingAddress: o.shippingAddress,
      billingAddress: o.billingAddress,
      lineItems: o.lineItems.edges.map(({ node: li }) => ({
        id: li.id,
        title: li.title,
        variantTitle: li.variantTitle,
        quantity: li.quantity,
        originalUnitPrice: li.originalUnitPriceSet.shopMoney.amount,
        currency: li.originalUnitPriceSet.shopMoney.currencyCode,
        sku: li.sku,
        imageUrl: li.image?.url ?? null,
      })),
      subtotalPrice: o.subtotalPriceSet?.shopMoney ?? null,
      totalShippingPrice: o.totalShippingPriceSet?.shopMoney ?? null,
      totalTax: o.totalTaxSet?.shopMoney ?? null,
      currentTotalPrice: o.currentTotalPriceSet.shopMoney,
      shippingMethodTitle: o.shippingLines.edges[0]?.node.title ?? null,
      fulfillments: o.fulfillments.map((f) => ({
        id: f.id,
        createdAt: f.createdAt,
        deliveredAt: f.deliveredAt,
        status: f.status,
        displayStatus: f.displayStatus,
        trackingNumber: f.trackingInfo[0]?.number ?? null,
        trackingUrl: f.trackingInfo[0]?.url ?? null,
        trackingCompany: f.trackingInfo[0]?.company ?? null,
      })),
    };
  }

  /**
   * Products tagged `add-to-box` — the catalog shown in the Extras overlay.
   * Returns first variant of each product as the addable SKU.
   */
  async listExtrasCatalog(): Promise<
    Array<{ variantId: string; productId: string; title: string; price: string; image: string | null }>
  > {
    const data = await this.graphql<{
      products: {
        edges: Array<{
          node: {
            id: string;
            title: string;
            featuredImage: { url: string } | null;
            variants: { edges: Array<{ node: { id: string; price: string } }> };
          };
        }>;
      };
    }>(
      `query extras {
         products(first: 50, query: "tag:add-to-box AND status:active") {
           edges { node {
             id title
             featuredImage { url }
             variants(first: 1) { edges { node { id price } } }
           } }
         }
       }`,
    );
    return data.products.edges.flatMap(({ node: p }) => {
      const v = p.variants.edges[0]?.node;
      if (!v) return [];
      return [{
        variantId: v.id,
        productId: p.id,
        title: p.title,
        price: v.price,
        image: p.featuredImage?.url ?? null,
      }];
    });
  }

  /**
   * Fetch the fields Seal's `add_items` action needs to construct a new
   * subscription line: product/variant gids, title, sku, price, taxability,
   * shipping flag. Used by the plan-change flow.
   */
  async getVariantForSealAddItems(variantId: string): Promise<{
    productId: string;
    variantId: string;
    title: string;
    sku: string;
    price: string;
    taxable: boolean;
    requiresShipping: boolean;
  } | null> {
    const gid = variantId.startsWith("gid://")
      ? variantId
      : `gid://shopify/ProductVariant/${variantId}`;
    // Note: `requiresShipping` moved from ProductVariant to inventoryItem
    // in Admin API 2024-01+ — fetching it via inventoryItem.requiresShipping.
    const data = await this.graphql<{
      productVariant: {
        id: string;
        title: string;
        sku: string | null;
        price: string;
        taxable: boolean;
        inventoryItem: { requiresShipping: boolean };
        product: { id: string; title: string };
      } | null;
    }>(
      `query variantForSeal($id: ID!) {
         productVariant(id: $id) {
           id title sku price taxable
           inventoryItem { requiresShipping }
           product { id title }
         }
       }`,
      { id: gid },
    );
    const v = data.productVariant;
    if (!v) return null;
    return {
      productId: v.product.id.replace(/^gid:\/\/shopify\/Product\//, ""),
      variantId: v.id.replace(/^gid:\/\/shopify\/ProductVariant\//, ""),
      title: v.product.title,
      sku: v.sku ?? "",
      price: v.price,
      taxable: v.taxable,
      requiresShipping: v.inventoryItem.requiresShipping,
    };
  }

  /**
   * Validate that a variant ID belongs to a product tagged `add-to-box`.
   * Used by POST /subscription/extras to prevent customers from adding
   * arbitrary products to their next charge.
   */
  async isVariantInExtrasCatalog(variantId: string): Promise<boolean> {
    const gid = variantId.startsWith("gid://") ? variantId : `gid://shopify/ProductVariant/${variantId}`;
    const data = await this.graphql<{ productVariant: { product: { tags: string[] } } | null }>(
      `query checkVariant($id: ID!) {
         productVariant(id: $id) { product { tags } }
       }`,
      { id: gid },
    );
    return data.productVariant?.product.tags.includes("add-to-box") ?? false;
  }

  /**
   * Update Shopify customer fields (firstName, lastName, email, phone).
   * Returns the updated customer or throws on user error.
   */
  async updateCustomer(
    customerId: string,
    fields: { firstName?: string; lastName?: string; email?: string; phone?: string },
  ): Promise<void> {
    const gid = customerId.startsWith("gid://") ? customerId : `gid://shopify/Customer/${customerId}`;
    const data = await this.graphql<{
      customerUpdate: { customer: { id: string } | null; userErrors: Array<{ field: string[]; message: string }> };
    }>(
      `mutation updateCustomer($input: CustomerInput!) {
         customerUpdate(input: $input) {
           customer { id }
           userErrors { field message }
         }
       }`,
      { input: { id: gid, ...fields } },
    );
    if (data.customerUpdate.userErrors.length > 0) {
      throw new ShopifyUserError(data.customerUpdate.userErrors);
    }
  }

  /**
   * Set a customer metafield. Used for portal preferences:
   * - lit_portal.whatsapp_opt_in (boolean)
   * - lit_portal.language_pref (single_line_text_field)
   * - lit_portal.first_login_completed (boolean)
   * - lit_portal.cancellation_reasons (json)
   * - lit_portal.tier_inner_circle_earned_at (date_time)
   * - lit_portal.cancel_count (number_integer)
   */
  async setCustomerMetafield(
    customerId: string,
    namespace: string,
    key: string,
    value: unknown,
    type:
      | "boolean"
      | "single_line_text_field"
      | "json"
      | "date_time"
      | "number_integer",
  ): Promise<void> {
    const gid = customerId.startsWith("gid://") ? customerId : `gid://shopify/Customer/${customerId}`;
    const stringValue = type === "json" ? JSON.stringify(value) : String(value);
    const data = await this.graphql<{
      metafieldsSet: { userErrors: Array<{ field: string[]; message: string }> };
    }>(
      `mutation setMetafield($metafields: [MetafieldsSetInput!]!) {
         metafieldsSet(metafields: $metafields) {
           userErrors { field message }
         }
       }`,
      { metafields: [{ ownerId: gid, namespace, key, value: stringValue, type }] },
    );
    if (data.metafieldsSet.userErrors.length > 0) {
      throw new Error(`Shopify metafieldsSet errors: ${JSON.stringify(data.metafieldsSet.userErrors)}`);
    }
  }

  /**
   * Get a customer metafield value. Returns null if not set.
   */
  async getCustomerMetafield(
    customerId: string,
    namespace: string,
    key: string,
  ): Promise<string | null> {
    const gid = customerId.startsWith("gid://") ? customerId : `gid://shopify/Customer/${customerId}`;
    const data = await this.graphql<{
      customer: { metafield: { value: string } | null } | null;
    }>(
      `query getMetafield($id: ID!, $namespace: String!, $key: String!) {
         customer(id: $id) {
           metafield(namespace: $namespace, key: $key) { value }
         }
       }`,
      { id: gid, namespace, key },
    );
    return data.customer?.metafield?.value ?? null;
  }

  /**
   * Update the customer's default shipping address. Used in sync with
   * Seal subscription address update so future orders ship to the new place.
   *
   * Written against Admin API 2026-04 (`ADMIN_API_VERSION`). The previous shape
   * was written for an older version and had been failing on EVERY call since
   * the bump on 2026-04-28, silently until PR #73 turned the sync into an
   * alerting `after()` (found the same day the alert first fired, 2026-07-29):
   *   - `CustomerAddressCreatePayload.customerAddress` no longer exists, the
   *     created address comes back as `address`.
   *   - `customerDefaultAddressUpdate` was removed from the schema entirely.
   *     `customerAddressCreate` now takes `setAsDefault`, which also collapses
   *     the old create-then-default pair into one round trip: no window where a
   *     new address exists without being the default.
   *   - `MailingAddressInput` only accepts `countryCode`/`provinceCode`, not the
   *     free-text `country`/`province`. Shopify canonicalises the display names.
   * Any change here must be re-validated against the live schema, the old shape
   * type-checked and linted fine while being rejected at runtime.
   *
   * Edits the existing default address in place (2026-07-29) instead of adding a
   * new one on every save, which used to pile up near-duplicates on the customer
   * file that support then has to read past.
   */
  async updateCustomerDefaultAddress(
    customerId: string,
    address: {
      address1: string;
      address2?: string;
      city: string;
      zip: string;
      countryCode: string;
      provinceCode?: string;
      firstName?: string;
      lastName?: string;
      phone?: string;
      /**
       * Trading name. Only the B2B account form sends it (a wholesale customer's
       * address is the company's); left undefined by the subscription address
       * sync, and `undefined` fields are omitted from the mutation input, so an
       * existing company is never blanked by a subscriber saving their address.
       */
      company?: string;
    },
  ): Promise<void> {
    const gid = customerId.startsWith("gid://") ? customerId : `gid://shopify/Customer/${customerId}`;
    const input = {
      address1: address.address1,
      address2: address.address2,
      city: address.city,
      zip: address.zip,
      countryCode: address.countryCode,
      provinceCode: address.provinceCode,
      firstName: address.firstName,
      lastName: address.lastName,
      phone: address.phone,
      company: address.company,
    };

    // Edit the existing default in place when there is one. Creating a fresh
    // address on every save (the old strategy, "simpler than tracking the id")
    // silently littered the customer file: Juan's had FIVE near-identical
    // Madrid addresses by 2026-07-29, one of them carrying a typo from a single
    // mistyped save. Support reads that list, so the noise has a real cost.
    // Falls back to create when the customer has no default yet.
    const current = await this.graphql<{
      customer: { defaultAddress: { id: string } | null } | null;
    }>(`query defaultAddr($id: ID!) { customer(id: $id) { defaultAddress { id } } }`, {
      id: gid,
    });
    const existingId = current.customer?.defaultAddress?.id ?? null;

    if (existingId) {
      const data = await this.graphql<{
        customerAddressUpdate: {
          address: { id: string } | null;
          userErrors: Array<{ field: string[]; message: string }>;
        };
      }>(
        `mutation updateAddr($customerId: ID!, $addressId: ID!, $address: MailingAddressInput!) {
           customerAddressUpdate(customerId: $customerId, addressId: $addressId, address: $address, setAsDefault: true) {
             address { id }
             userErrors { field message }
           }
         }`,
        { customerId: gid, addressId: existingId, address: input },
      );
      if (data.customerAddressUpdate.userErrors.length > 0) {
        throw new Error(
          `Shopify addressUpdate errors: ${JSON.stringify(data.customerAddressUpdate.userErrors)}`,
        );
      }
      if (!data.customerAddressUpdate.address?.id) {
        throw new Error("Shopify customerAddressUpdate returned no address and no userErrors");
      }
      return;
    }

    const data = await this.graphql<{
      customerAddressCreate: {
        address: { id: string } | null;
        userErrors: Array<{ field: string[]; message: string }>;
      };
    }>(
      `mutation createAddr($customerId: ID!, $address: MailingAddressInput!) {
         customerAddressCreate(customerId: $customerId, address: $address, setAsDefault: true) {
           address { id }
           userErrors { field message }
         }
       }`,
      { customerId: gid, address: input },
    );
    if (data.customerAddressCreate.userErrors.length > 0) {
      throw new Error(
        `Shopify addressCreate errors: ${JSON.stringify(data.customerAddressCreate.userErrors)}`,
      );
    }
    if (!data.customerAddressCreate.address?.id) {
      // No address and no userErrors should be impossible. Throw rather than
      // return quietly: the caller alerts, and a silent no-op here is exactly
      // the failure mode this function just spent three months in.
      throw new Error("Shopify customerAddressCreate returned no address and no userErrors");
    }
  }

  // ───────────────────────────────────────────────────────────────
  // Subscription contracts (Shopify Admin GraphQL)
  //
  // Shopify is the source of truth for variant_id / selling_plan_id /
  // quantity. Seal projects this state and syncs via webhooks. Mutating
  // via Seal Merchant API silently no-ops (verified 2026-05-13), so we
  // mutate Shopify directly and let Seal catch up.
  //
  // Requires the app scopes:
  //   - read_own_subscription_contracts
  //   - write_own_subscription_contracts
  // (added 2026-05-13 — token refreshed via the OAuth callback flow).
  // ───────────────────────────────────────────────────────────────

  /**
   * List subscription contracts for a customer. Filters out cancelled by default.
   */
  async listSubscriptionContractsByCustomer(
    customerId: string,
    opts: { includeCancelled?: boolean; first?: number } = {},
  ): Promise<SubscriptionContractSummary[]> {
    const gid = customerId.startsWith("gid://")
      ? customerId
      : `gid://shopify/Customer/${customerId}`;
    const first = opts.first ?? 10;
    const data = await this.graphql<{
      customer: {
        subscriptionContracts: {
          edges: Array<{
            node: {
              id: string;
              status: string;
              nextBillingDate: string | null;
              originOrder: { id: string; name: string } | null;
              lines: {
                edges: Array<{
                  node: {
                    id: string;
                    variantId: string | null;
                    sellingPlanId: string | null;
                    sellingPlanName: string | null;
                    quantity: number;
                    title: string;
                  };
                }>;
              };
            };
          }>;
        };
      } | null;
    }>(
      `query custContracts($id: ID!, $first: Int!) {
         customer(id: $id) {
           subscriptionContracts(first: $first) {
             edges { node {
               id status nextBillingDate
               originOrder { id name }
               lines(first: 10) { edges { node {
                 id variantId sellingPlanId sellingPlanName quantity title
               } } }
             } }
           }
         }
       }`,
      { id: gid, first },
    );
    const edges = data.customer?.subscriptionContracts.edges ?? [];
    return edges
      .map((e) => ({
        id: e.node.id,
        status: e.node.status,
        nextBillingDate: e.node.nextBillingDate,
        originOrderId: e.node.originOrder?.id ?? null,
        originOrderName: e.node.originOrder?.name ?? null,
        lines: e.node.lines.edges.map((l) => ({
          id: l.node.id,
          variantId: l.node.variantId,
          sellingPlanId: l.node.sellingPlanId,
          sellingPlanName: l.node.sellingPlanName,
          quantity: l.node.quantity,
          title: l.node.title,
        })),
      }))
      .filter((c) => opts.includeCancelled || c.status !== "CANCELLED");
  }

  /**
   * Get a single subscription contract by GID.
   */
  async getSubscriptionContract(
    contractId: string,
  ): Promise<SubscriptionContractSummary | null> {
    const gid = contractId.startsWith("gid://")
      ? contractId
      : `gid://shopify/SubscriptionContract/${contractId}`;
    const data = await this.graphql<{
      subscriptionContract: {
        id: string;
        status: string;
        nextBillingDate: string | null;
        originOrder: { id: string; name: string } | null;
        lines: {
          edges: Array<{
            node: {
              id: string;
              variantId: string | null;
              sellingPlanId: string | null;
              sellingPlanName: string | null;
              quantity: number;
              title: string;
            };
          }>;
        };
      } | null;
    }>(
      `query contract($id: ID!) {
         subscriptionContract(id: $id) {
           id status nextBillingDate
           originOrder { id name }
           lines(first: 10) { edges { node {
             id variantId sellingPlanId sellingPlanName quantity title
           } } }
         }
       }`,
      { id: gid },
    );
    const c = data.subscriptionContract;
    if (!c) return null;
    return {
      id: c.id,
      status: c.status,
      nextBillingDate: c.nextBillingDate,
      originOrderId: c.originOrder?.id ?? null,
      originOrderName: c.originOrder?.name ?? null,
      lines: c.lines.edges.map((l) => ({
        id: l.node.id,
        variantId: l.node.variantId,
        sellingPlanId: l.node.sellingPlanId,
        sellingPlanName: l.node.sellingPlanName,
        quantity: l.node.quantity,
        title: l.node.title,
      })),
    };
  }

  /**
   * Update the shipping address on a subscription contract. Same draft/commit
   * pattern as updateSubscriptionLine, only the middle mutation differs
   * (subscriptionDraftDeliveryMethodUpdate instead of line update).
   *
   * ⚠️ UNUSED and BROKEN as written: nothing calls this (Seal is the source of
   * truth for subscription addresses, see api/subscription/address), and
   * `subscriptionDraftDeliveryMethodUpdate` no longer exists in Admin API
   * 2026-04 — the same class of rot that silently killed
   * `updateCustomerDefaultAddress` for three months. Re-validate the mutation
   * against the live schema before wiring this up to anything.
   *
   * The Shipping/Local input shapes are documented at:
   *   https://shopify.dev/docs/api/admin-graphql/latest/input-objects/SubscriptionShippingDeliveryMethodInput
   */
  async updateSubscriptionDeliveryAddress(
    contractId: string,
    address: {
      address1: string;
      address2?: string;
      city: string;
      zip: string;
      countryCode: string;
      provinceCode?: string;
      province?: string;
      firstName?: string;
      lastName?: string;
      phone?: string;
    },
  ): Promise<void> {
    // 1. Open draft
    const draftData = await this.graphql<{
      subscriptionContractUpdate: {
        draft: { id: string } | null;
        userErrors: Array<{ field: string[]; message: string; code?: string }>;
      };
    }>(
      `mutation contractUpdate($contractId: ID!) {
         subscriptionContractUpdate(contractId: $contractId) {
           draft { id }
           userErrors { field message code }
         }
       }`,
      { contractId },
    );
    if (draftData.subscriptionContractUpdate.userErrors.length > 0) {
      throw new Error(
        `Shopify subscriptionContractUpdate(address): ${JSON.stringify(draftData.subscriptionContractUpdate.userErrors)}`,
      );
    }
    const draftId = draftData.subscriptionContractUpdate.draft?.id;
    if (!draftId) throw new Error("subscriptionContractUpdate(address) returned no draft");

    // 2. Update delivery method (shipping address)
    const deliveryData = await this.graphql<{
      subscriptionDraftDeliveryMethodUpdate: {
        draft: { id: string } | null;
        userErrors: Array<{ field: string[]; message: string; code?: string }>;
      };
    }>(
      `mutation methodUpdate($draftId: ID!, $input: SubscriptionDeliveryMethodInput!) {
         subscriptionDraftDeliveryMethodUpdate(draftId: $draftId, deliveryMethod: $input) {
           draft { id }
           userErrors { field message code }
         }
       }`,
      {
        draftId,
        input: {
          shipping: {
            address: {
              address1: address.address1,
              address2: address.address2,
              city: address.city,
              zip: address.zip,
              countryCode: address.countryCode,
              provinceCode: address.provinceCode,
              firstName: address.firstName,
              lastName: address.lastName,
              phone: address.phone,
            },
          },
        },
      },
    );
    if (deliveryData.subscriptionDraftDeliveryMethodUpdate.userErrors.length > 0) {
      throw new Error(
        `Shopify subscriptionDraftDeliveryMethodUpdate: ${JSON.stringify(deliveryData.subscriptionDraftDeliveryMethodUpdate.userErrors)}`,
      );
    }

    // 3. Commit
    const commitData = await this.graphql<{
      subscriptionDraftCommit: {
        contract: { id: string } | null;
        userErrors: Array<{ field: string[]; message: string; code?: string }>;
      };
    }>(
      `mutation commit($draftId: ID!) {
         subscriptionDraftCommit(draftId: $draftId) {
           contract { id }
           userErrors { field message code }
         }
       }`,
      { draftId },
    );
    if (commitData.subscriptionDraftCommit.userErrors.length > 0) {
      throw new Error(
        `Shopify subscriptionDraftCommit(address): ${JSON.stringify(commitData.subscriptionDraftCommit.userErrors)}`,
      );
    }
  }

  /**
   * Swap the variant / selling plan / quantity on a single subscription line.
   * Three-step Shopify flow: open draft, update line in draft, commit.
   *
   * `lineId` and `contractId` must both be Shopify GIDs.
   */
  async updateSubscriptionLine(
    contractId: string,
    lineId: string,
    patch: { variantId?: string; sellingPlanId?: string; quantity?: number },
  ): Promise<void> {
    // 1. Open draft
    const draftData = await this.graphql<{
      subscriptionContractUpdate: {
        draft: { id: string } | null;
        userErrors: Array<{ field: string[]; message: string; code?: string }>;
      };
    }>(
      `mutation contractUpdate($contractId: ID!) {
         subscriptionContractUpdate(contractId: $contractId) {
           draft { id }
           userErrors { field message code }
         }
       }`,
      { contractId },
    );
    if (draftData.subscriptionContractUpdate.userErrors.length > 0) {
      throw new Error(
        `Shopify subscriptionContractUpdate: ${JSON.stringify(draftData.subscriptionContractUpdate.userErrors)}`,
      );
    }
    const draftId = draftData.subscriptionContractUpdate.draft?.id;
    if (!draftId) throw new Error("subscriptionContractUpdate returned no draft");

    // 2. Update line in draft
    const lineInput: Record<string, unknown> = {};
    if (patch.variantId !== undefined) {
      lineInput.productVariantId = patch.variantId.startsWith("gid://")
        ? patch.variantId
        : `gid://shopify/ProductVariant/${patch.variantId}`;
    }
    if (patch.sellingPlanId !== undefined) {
      lineInput.sellingPlanId = patch.sellingPlanId.startsWith("gid://")
        ? patch.sellingPlanId
        : `gid://shopify/SellingPlan/${patch.sellingPlanId}`;
    }
    if (patch.quantity !== undefined) {
      lineInput.quantity = patch.quantity;
    }

    const updateData = await this.graphql<{
      subscriptionDraftLineUpdate: {
        lineUpdated: { id: string } | null;
        userErrors: Array<{ field: string[]; message: string; code?: string }>;
      };
    }>(
      `mutation lineUpdate($draftId: ID!, $lineId: ID!, $input: SubscriptionLineUpdateInput!) {
         subscriptionDraftLineUpdate(draftId: $draftId, lineId: $lineId, input: $input) {
           lineUpdated { id }
           userErrors { field message code }
         }
       }`,
      { draftId, lineId, input: lineInput },
    );
    if (updateData.subscriptionDraftLineUpdate.userErrors.length > 0) {
      throw new Error(
        `Shopify subscriptionDraftLineUpdate: ${JSON.stringify(updateData.subscriptionDraftLineUpdate.userErrors)}`,
      );
    }

    // 3. Commit
    const commitData = await this.graphql<{
      subscriptionDraftCommit: {
        contract: { id: string } | null;
        userErrors: Array<{ field: string[]; message: string; code?: string }>;
      };
    }>(
      `mutation commit($draftId: ID!) {
         subscriptionDraftCommit(draftId: $draftId) {
           contract { id }
           userErrors { field message code }
         }
       }`,
      { draftId },
    );
    if (commitData.subscriptionDraftCommit.userErrors.length > 0) {
      throw new Error(
        `Shopify subscriptionDraftCommit: ${JSON.stringify(commitData.subscriptionDraftCommit.userErrors)}`,
      );
    }
  }
}

export interface SubscriptionContractLine {
  id: string;
  variantId: string | null;
  sellingPlanId: string | null;
  sellingPlanName: string | null;
  quantity: number;
  title: string;
}

export interface SubscriptionContractSummary {
  id: string;
  status: string;
  nextBillingDate: string | null;
  originOrderId: string | null;
  originOrderName: string | null;
  lines: SubscriptionContractLine[];
}

// ============ Payment method ============

export type PaymentInstrumentType =
  | "card"
  | "paypal"
  | "shop_pay"
  | "other"
  | "unknown";

export interface PaymentInstrument {
  /** Shopify CustomerPaymentMethod GID (used for update-url mutation). */
  id: string;
  type: PaymentInstrumentType;
  /** UI label, e.g. "Visa ·· 4242 · exp 08/28" or "PayPal · juan@…" */
  label: string;
  brand: string | null;
  lastDigits: string | null;
  expiryMonth: string | null;
  expiryYear: string | null;
  paypalEmail: string | null;
}

interface PaymentMethodEdge {
  node: {
    id: string;
    revokedAt: string | null;
    instrument:
      | {
          __typename: "CustomerCreditCard";
          brand: string | null;
          lastDigits: string | null;
          expiryMonth: number | null;
          expiryYear: number | null;
        }
      | {
          __typename: "CustomerPaypalBillingAgreement";
          paypalAccountEmail: string | null;
        }
      | {
          __typename: "CustomerShopPayAgreement";
          lastDigits: string | null;
        }
      | { __typename: string };
  };
}

/**
 * Get the customer's most recent non-revoked payment method (PayPal / card /
 * Shop Pay / etc.). For Seal-owned subs the contract isn't visible to our
 * app's scope, so we read from the customer directly. Shopify exposes all
 * methods on `customer.paymentMethods`; we surface the first non-revoked.
 */
async function getCustomerPaymentMethodImpl(
  client: ShopifyAdminClient,
  customerId: string,
): Promise<PaymentInstrument | null> {
  const gid = customerId.startsWith("gid://")
    ? customerId
    : `gid://shopify/Customer/${customerId}`;
  const data = await client.graphql<{
    customer: { paymentMethods: { edges: PaymentMethodEdge[] } } | null;
  }>(
    `query custPay($id: ID!) {
       customer(id: $id) {
         paymentMethods(first: 10) {
           edges { node {
             id
             revokedAt
             instrument {
               __typename
               ... on CustomerCreditCard { brand lastDigits expiryMonth expiryYear }
               ... on CustomerPaypalBillingAgreement { paypalAccountEmail }
               ... on CustomerShopPayAgreement { lastDigits }
             }
           } }
         }
       }
     }`,
    { id: gid },
  );

  const active = (data.customer?.paymentMethods.edges ?? []).find(
    (e) => !e.node.revokedAt,
  );
  if (!active) return null;
  const inst = active.node.instrument;
  const id = active.node.id;

  if (inst.__typename === "CustomerCreditCard") {
    const card = inst as Extract<
      PaymentMethodEdge["node"]["instrument"],
      { __typename: "CustomerCreditCard" }
    >;
    const exp =
      card.expiryMonth && card.expiryYear
        ? ` · exp ${String(card.expiryMonth).padStart(2, "0")}/${String(card.expiryYear).slice(-2)}`
        : "";
    return {
      id,
      type: "card",
      label: `${card.brand ?? "Card"} ·· ${card.lastDigits ?? "····"}${exp}`,
      brand: card.brand,
      lastDigits: card.lastDigits,
      expiryMonth: card.expiryMonth ? String(card.expiryMonth) : null,
      expiryYear: card.expiryYear ? String(card.expiryYear) : null,
      paypalEmail: null,
    };
  }
  if (inst.__typename === "CustomerPaypalBillingAgreement") {
    const pp = inst as Extract<
      PaymentMethodEdge["node"]["instrument"],
      { __typename: "CustomerPaypalBillingAgreement" }
    >;
    return {
      id,
      type: "paypal",
      label: pp.paypalAccountEmail ? `PayPal · ${pp.paypalAccountEmail}` : "PayPal",
      brand: null,
      lastDigits: null,
      expiryMonth: null,
      expiryYear: null,
      paypalEmail: pp.paypalAccountEmail,
    };
  }
  if (inst.__typename === "CustomerShopPayAgreement") {
    const sp = inst as Extract<
      PaymentMethodEdge["node"]["instrument"],
      { __typename: "CustomerShopPayAgreement" }
    >;
    return {
      id,
      type: "shop_pay",
      label: sp.lastDigits ? `Shop Pay ·· ${sp.lastDigits}` : "Shop Pay",
      brand: null,
      lastDigits: sp.lastDigits,
      expiryMonth: null,
      expiryYear: null,
      paypalEmail: null,
    };
  }
  return {
    id,
    type: "other",
    label: "Active payment method",
    brand: null,
    lastDigits: null,
    expiryMonth: null,
    expiryYear: null,
    paypalEmail: null,
  };
}

/**
 * Generate a single-use Shopify-hosted URL where the customer can replace
 * their stored payment method. Shopify renders the PCI-compliant form and
 * redirects to the storefront on success.
 *
 * Shopify limitation: this mutation rejects non-card instruments with
 * INVALID_INSTRUMENT_TYPE — for PayPal / Shop Pay we have to fall back to
 * `customerPaymentMethodSendUpdateEmail` (see below).
 */
async function getPaymentMethodUpdateUrlImpl(
  client: ShopifyAdminClient,
  paymentMethodId: string,
): Promise<string | null> {
  const data = await client.graphql<{
    customerPaymentMethodGetUpdateUrl: {
      updatePaymentMethodUrl: string | null;
      userErrors: Array<{ field: string[]; message: string }>;
    };
  }>(
    `mutation updUrl($id: ID!) {
       customerPaymentMethodGetUpdateUrl(customerPaymentMethodId: $id) {
         updatePaymentMethodUrl
         userErrors { field message }
       }
     }`,
    { id: paymentMethodId },
  );
  const errs = data.customerPaymentMethodGetUpdateUrl.userErrors;
  if (errs.length > 0) {
    console.warn("[payment-method] getUpdateUrl userErrors:", errs);
  }
  // Be permissive: if Shopify returned a URL even alongside a warning (which
  // happens for some PayPal billing agreements), use it — the URL takes
  // priority over the userErrors signal. Only fall back to email-update
  // when the URL is genuinely absent.
  return data.customerPaymentMethodGetUpdateUrl.updatePaymentMethodUrl || null;
}

/**
 * Fallback path for non-card payment methods (PayPal, Shop Pay, etc.):
 * Shopify emails the customer a one-time link they can follow to add or
 * replace a payment method. Returns true if the email was queued, false if
 * Shopify returned userErrors.
 */
async function sendPaymentMethodUpdateEmailImpl(
  client: ShopifyAdminClient,
  paymentMethodId: string,
): Promise<boolean> {
  const data = await client.graphql<{
    customerPaymentMethodSendUpdateEmail: {
      customer: { id: string } | null;
      userErrors: Array<{ field: string[]; message: string }>;
    };
  }>(
    `mutation sendUpd($id: ID!) {
       customerPaymentMethodSendUpdateEmail(customerPaymentMethodId: $id) {
         customer { id }
         userErrors { field message }
       }
     }`,
    { id: paymentMethodId },
  );
  const errs = data.customerPaymentMethodSendUpdateEmail.userErrors;
  if (errs.length > 0) {
    console.warn("[payment-method] sendUpdateEmail userErrors:", errs);
    return false;
  }
  return !!data.customerPaymentMethodSendUpdateEmail.customer;
}

const _shopifyAdminClient = new ShopifyAdminClient();

export const shopifyAdmin = Object.assign(_shopifyAdminClient, {
  getCustomerPaymentMethod: (customerId: string) =>
    getCustomerPaymentMethodImpl(_shopifyAdminClient, customerId),
  getPaymentMethodUpdateUrl: (paymentMethodId: string) =>
    getPaymentMethodUpdateUrlImpl(_shopifyAdminClient, paymentMethodId),
  sendPaymentMethodUpdateEmail: (paymentMethodId: string) =>
    sendPaymentMethodUpdateEmailImpl(_shopifyAdminClient, paymentMethodId),
});
