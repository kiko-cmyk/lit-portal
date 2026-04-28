/**
 * Shopify Admin GraphQL client.
 *
 * Auth strategy: the LIT app uses `client_credentials` grant. Tokens are
 * issued via `POST /admin/oauth/access_token` with client_id + client_secret
 * and live for 24h. We cache the token in-process and refresh on demand.
 *
 * If `SHOPIFY_ADMIN_TOKEN` is set in env, we use it directly (e.g., for a
 * statically-issued long-lived token). Otherwise we fetch via client creds.
 */

const SHOPIFY_STORE = process.env.SHOPIFY_STORE; // e.g. "lit-tienda.myshopify.com"
const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
const ADMIN_API_VERSION = "2026-04";

interface CachedToken {
  token: string;
  expiresAt: number; // epoch ms
}

let _cached: CachedToken | null = null;

async function getAdminToken(): Promise<string> {
  // Static override from env wins
  const fromEnv = process.env.SHOPIFY_ADMIN_TOKEN;
  if (fromEnv) return fromEnv;

  // Cache hit (with 5min buffer before expiry)
  if (_cached && _cached.expiresAt > Date.now() + 5 * 60 * 1000) {
    return _cached.token;
  }

  if (!SHOPIFY_STORE || !SHOPIFY_API_KEY || !SHOPIFY_API_SECRET) {
    throw new Error("SHOPIFY_STORE, SHOPIFY_API_KEY, SHOPIFY_API_SECRET required");
  }

  const res = await fetch(`https://${SHOPIFY_STORE}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: SHOPIFY_API_KEY,
      client_secret: SHOPIFY_API_SECRET,
      grant_type: "client_credentials",
    }),
  });
  if (!res.ok) {
    throw new Error(`Shopify token exchange failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { access_token: string; expires_in?: number };
  const ttlMs = (json.expires_in ?? 86400) * 1000;
  _cached = { token: json.access_token, expiresAt: Date.now() + ttlMs };
  return json.access_token;
}

class ShopifyAdminClient {
  private endpoint(): string {
    if (!SHOPIFY_STORE) throw new Error("SHOPIFY_STORE not set");
    return `https://${SHOPIFY_STORE}/admin/api/${ADMIN_API_VERSION}/graphql.json`;
  }

  async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const token = await getAdminToken();
    const res = await fetch(this.endpoint(), {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`Shopify Admin ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { data?: T; errors?: unknown };
    if (json.errors) throw new Error(`Shopify Admin errors: ${JSON.stringify(json.errors)}`);
    return json.data as T;
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

  async getCustomer(customerId: string): Promise<{
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    phone: string | null;
    createdAt: string;
    numberOfOrders: string;
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
      } | null;
    }>(
      `query getCustomer($id: ID!) {
         customer(id: $id) {
           id email firstName lastName phone createdAt numberOfOrders
         }
       }`,
      { id: gid },
    );
    return data.customer ?? null;
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
      throw new Error(`Shopify customerUpdate errors: ${JSON.stringify(data.customerUpdate.userErrors)}`);
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
   */
  async updateCustomerDefaultAddress(
    customerId: string,
    address: {
      address1: string;
      address2?: string;
      city: string;
      zip: string;
      country: string;
      countryCode: string;
      province?: string;
      provinceCode?: string;
      firstName?: string;
      lastName?: string;
      phone?: string;
    },
  ): Promise<void> {
    const gid = customerId.startsWith("gid://") ? customerId : `gid://shopify/Customer/${customerId}`;
    // Strategy: create a new address (Shopify defaults it via setDefault) — simpler than
    // tracking the existing address ID. Old addresses live on the account; portal only
    // surfaces the default.
    const data = await this.graphql<{
      customerAddressCreate: {
        customerAddress: { id: string } | null;
        userErrors: Array<{ field: string[]; message: string }>;
      };
    }>(
      `mutation createAddr($customerId: ID!, $address: MailingAddressInput!) {
         customerAddressCreate(customerId: $customerId, address: $address) {
           customerAddress { id }
           userErrors { field message }
         }
       }`,
      {
        customerId: gid,
        address: {
          address1: address.address1,
          address2: address.address2,
          city: address.city,
          zip: address.zip,
          country: address.country,
          countryCode: address.countryCode,
          province: address.province,
          provinceCode: address.provinceCode,
          firstName: address.firstName,
          lastName: address.lastName,
          phone: address.phone,
        },
      },
    );
    if (data.customerAddressCreate.userErrors.length > 0) {
      throw new Error(
        `Shopify addressCreate errors: ${JSON.stringify(data.customerAddressCreate.userErrors)}`,
      );
    }
    const newAddrId = data.customerAddressCreate.customerAddress?.id;
    if (!newAddrId) return;
    // Set the new address as default
    await this.graphql<{
      customerDefaultAddressUpdate: { userErrors: Array<{ message: string }> };
    }>(
      `mutation setDefault($customerId: ID!, $addressId: ID!) {
         customerDefaultAddressUpdate(customerId: $customerId, addressId: $addressId) {
           userErrors { message }
         }
       }`,
      { customerId: gid, addressId: newAddrId },
    );
  }
}

export const shopifyAdmin = new ShopifyAdminClient();
