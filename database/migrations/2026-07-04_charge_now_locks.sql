-- 2026-07-04  charge_now_locks — idempotency mutex for "charge now"
--
-- Defense-in-depth so two near-simultaneous charge-now requests can't both
-- reach Seal and double-charge (on top of Seal's own "already scheduled"
-- rejection + the client busy-lock). The route acquires a per-subscription
-- lock before calling Seal and releases it in a finally; stale rows self-heal
-- after ~2 min. Acquisition is fail-open — a lock-table error never blocks a
-- legitimate charge.
--
-- Safe to run anytime (new table). RLS on with no policies → service_role only
-- (portal convention). Run in a transaction.

begin;

create table if not exists charge_now_locks (
  seal_subscription_id bigint primary key,
  customer_id          text not null,
  created_at           timestamptz not null default now()
);

alter table charge_now_locks enable row level security;
-- No policies: all access via service role from the API route.

commit;
