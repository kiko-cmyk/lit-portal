const SHOPIFY_STORE = 'lit-tienda.myshopify.com';
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID || '';
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_API_SECRET || '';

const SHOPIFY_ADMIN_API = `https://${SHOPIFY_STORE}/admin/api/2024-10/graphql.json`;

// Token cache
let cachedToken: string | null = null;
let tokenExpiresAt = 0;

async function getAccessToken(): Promise<string> {
  // Return cached token if still valid (refresh 1 hour before expiry)
  if (cachedToken && Date.now() < tokenExpiresAt - 3600000) {
    return cachedToken;
  }

  const res = await fetch(`https://${SHOPIFY_STORE}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify OAuth error ${res.status}: ${text}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  // Token lasts 24h, cache for 23h
  tokenExpiresAt = Date.now() + 23 * 60 * 60 * 1000;

  return cachedToken!;
}

async function shopifyGraphQL(query: string, variables?: Record<string, unknown>) {
  const token = await getAccessToken();

  const res = await fetch(SHOPIFY_ADMIN_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify Admin API error ${res.status}: ${text}`);
  }

  const json = await res.json();
  if (json.errors) {
    throw new Error(`Shopify GraphQL error: ${JSON.stringify(json.errors)}`);
  }

  return json.data;
}

// Get customer by email
export async function getCustomerByEmail(email: string) {
  const query = `
    query getCustomer($query: String!) {
      customers(first: 1, query: $query) {
        edges {
          node {
            id
            firstName
            lastName
            email
            ordersCount
            totalSpent
            metafields(first: 10) {
              edges {
                node {
                  namespace
                  key
                  value
                }
              }
            }
          }
        }
      }
    }
  `;

  const data = await shopifyGraphQL(query, { query: `email:${email}` });
  const customer = data.customers.edges[0]?.node;
  return customer || null;
}

// Get orders for a customer
export async function getCustomerOrders(email: string, first: number = 10) {
  const query = `
    query getOrders($query: String!, $first: Int!) {
      orders(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) {
        edges {
          node {
            id
            name
            createdAt
            displayFinancialStatus
            displayFulfillmentStatus
            totalPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            lineItems(first: 10) {
              edges {
                node {
                  title
                  quantity
                  variant {
                    image {
                      url
                    }
                    product {
                      handle
                    }
                  }
                }
              }
            }
            fulfillments {
              trackingInfo {
                number
                url
              }
              status
            }
            shippingAddress {
              city
              country
            }
          }
        }
      }
    }
  `;

  const data = await shopifyGraphQL(query, { query: `email:${email}`, first });
  return data.orders.edges.map((e: { node: unknown }) => e.node);
}
