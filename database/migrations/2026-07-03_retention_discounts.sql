-- 2026-07-03: retention discounts (cancel flow "15% a la desesperada").
--
-- When a customer, after rejecting the tailored solution, accepts the 15% off
-- their NEXT order, we apply a Shopify discount code to their Seal subscription.
-- A Seal discount code recurs on EVERY future charge until removed. Business
-- rule (Juan, IMPORTANTÍSIMO): the 15% must hit ONLY the next immediate charge
-- and none after it.
--
-- Guarantee: we record the applied code here as `pending_charge`; the
-- `billing_attempt.succeeded` Seal webhook then removes the code right after
-- that first (discounted) charge and flips this row to `removed`. So the
-- discount lands on exactly one charge. (The Shopify code is also created with a
-- 1-cycle limit as a second safety net.)
--
-- Guardrail: `customer_id` is the primary key → a customer can only ever have
-- ONE retention discount. The endpoint refuses to apply a second one, so nobody
-- can "farm" the discount by cancelling repeatedly.

create table if not exists retention_discounts (
  customer_id           text primary key,          -- one retention discount EVER per customer
  seal_subscription_id  text not null,
  code                  text not null,             -- Shopify discount code applied
  discount_code_id      text,                      -- Seal UUID (item.discount_codes[].id) used to remove it
  status                text not null default 'pending_charge'
                          check (status in ('pending_charge', 'removed', 'failed')),
  reason                text,                      -- cancel reason at the time of the offer
  applied_at            timestamptz not null default now(),
  removed_at            timestamptz,
  updated_at            timestamptz not null default now()
);

-- The billing_attempt.succeeded webhook looks up the pending row by sub id.
create index if not exists idx_retention_discounts_pending
  on retention_discounts (seal_subscription_id)
  where status = 'pending_charge';

-- RLS ON + 0 policies: all access via the service-role client (endpoint +
-- webhook), which bypasses RLS. No public policies → anon / authenticated
-- cannot read or tamper. Same pattern as subscription_reanchor_intents,
-- webhook_log, rate_buckets.
alter table retention_discounts enable row level security;
