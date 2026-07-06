-- 2026-07-06  Multi-sub: flip subscriptions + reanchor_intents to a composite PK
--
-- Enables N subscriptions per customer in the cache. Deploy the composite
-- `onConflict: "customer_id,seal_subscription_id"` code FIRST (it needs the
-- composite unique indexes, added additively beforehand), then run this. After
-- this, `onConflict: "customer_id"` on these two tables would ERROR (no unique on
-- customer_id alone) — that's why the code ships first.
--
-- PREREQS (already applied additively, safe on 1-row-per-customer data):
--   create unique index uq_subscriptions_customer_seal on subscriptions(customer_id, seal_subscription_id);
--   create unique index uq_reanchor_customer_seal      on subscription_reanchor_intents(customer_id, seal_subscription_id);
--
-- SAFETY: take a fresh dump first (Supabase Free, no PITR). Atomic (BEGIN/COMMIT):
-- a mid-DDL failure rolls back with no change. Rollback plan: re-add the old
-- single-column PKs (customer_id was unique before) + FKs, restore rows from dump.

begin;

-- The two FKs point at subscriptions(customer_id); a composite PK there makes a
-- single-column FK invalid, so drop them (these tables are app-managed cache/
-- audit — no hard deletes of subscriptions rows, so cascade is moot). Keep a
-- plain index for lookups.
alter table subscription_changes drop constraint if exists subscription_changes_customer_id_fkey;
alter table subscription_states  drop constraint if exists subscription_states_customer_id_fkey;
create index if not exists idx_subscription_changes_customer on subscription_changes(customer_id);

-- subscriptions: swap PK (customer_id) → (customer_id, seal_subscription_id).
-- Promote the pre-built composite unique index to PK. Keep UNIQUE(seal_subscription_id)
-- (each Seal sub is still one row — a valid, useful guard).
alter table subscriptions drop constraint subscriptions_pkey;
alter table subscriptions add constraint subscriptions_pkey primary key using index uq_subscriptions_customer_seal;

-- reanchor_intents: same swap → one pending intent per (customer, sub).
alter table subscription_reanchor_intents drop constraint subscription_reanchor_intents_pkey;
alter table subscription_reanchor_intents add constraint subscription_reanchor_intents_pkey primary key using index uq_reanchor_customer_seal;

commit;
