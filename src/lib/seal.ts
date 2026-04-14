const SEAL_API_BASE = process.env.SEAL_API_BASE!;
const SEAL_API_TOKEN = process.env.SEAL_API_TOKEN!;

interface SealRequestOptions {
  method?: string;
  body?: Record<string, unknown>;
  params?: Record<string, string>;
}

async function sealFetch(endpoint: string, options: SealRequestOptions = {}) {
  const { method = 'GET', body, params } = options;

  let url = `${SEAL_API_BASE}${endpoint}`;
  if (params) {
    const searchParams = new URLSearchParams(params);
    url += `?${searchParams.toString()}`;
  }

  const res = await fetch(url, {
    method,
    headers: {
      'X-Seal-Token': SEAL_API_TOKEN,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Seal API error ${res.status}: ${text}`);
  }

  return res.json();
}

// --- Subscriptions ---

export async function getSubscriptionsByEmail(email: string) {
  const response = await sealFetch('/subscriptions', {
    params: { query: email },
  });
  // Seal wraps subscriptions in payload.subscriptions
  return response?.payload?.subscriptions || response?.subscriptions || response || [];
}

export async function getSubscription(subscriptionId: string) {
  return sealFetch(`/subscriptions/${subscriptionId}`);
}

// --- Billing Attempts ---

export async function getBillingAttempts(subscriptionId: string) {
  return sealFetch('/billing_attempts', {
    params: { subscription_id: subscriptionId },
  });
}

export async function skipBillingAttempt(billingAttemptId: string) {
  return sealFetch(`/billing_attempts/${billingAttemptId}/skip`, {
    method: 'POST',
  });
}

export async function unskipBillingAttempt(billingAttemptId: string) {
  return sealFetch(`/billing_attempts/${billingAttemptId}/unskip`, {
    method: 'POST',
  });
}

// --- Subscription Actions ---

export async function pauseSubscription(subscriptionId: string) {
  return sealFetch(`/subscriptions/${subscriptionId}/pause`, {
    method: 'POST',
  });
}

export async function resumeSubscription(subscriptionId: string) {
  return sealFetch(`/subscriptions/${subscriptionId}/resume`, {
    method: 'POST',
  });
}

export async function cancelSubscription(subscriptionId: string) {
  return sealFetch(`/subscriptions/${subscriptionId}/cancel`, {
    method: 'POST',
  });
}

export async function updateSubscriptionInterval(
  subscriptionId: string,
  interval: number,
  intervalUnit: 'day' | 'week' | 'month'
) {
  return sealFetch(`/subscriptions/${subscriptionId}`, {
    method: 'PUT',
    body: {
      delivery_interval: interval,
      delivery_interval_type: intervalUnit,
    },
  });
}
