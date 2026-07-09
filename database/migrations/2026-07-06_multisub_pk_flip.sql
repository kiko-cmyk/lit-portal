-- 2026-07-06  Multi-sub: flip subscriptions + reanchor_intents to a composite PK
--
-- Enables N subscriptions per customer in the cache. Deploy the composite
-- `onConflict: "customer_id,seal_subscription_id"` code FIRST (it needs the
-- composite unique indexes, added additively beforehand), then run this. After
-- this, `onConflict: "customer_id"` on these two tables would ERROR (no unique on
-- customer_id alone) — that's why the code ships first.
--
-- SAFETY: take a fresh dump first (Supabase Free, no PITR). Atomic (BEGIN/COMMIT):
-- a mid-DDL failure rolls back with no change. Rollback plan: re-add the old
-- single-column PKs (customer_id was unique before) + FKs, restore rows from dump.
--
-- Idempotent + self-contained (audit 2026-07-06): the prereq composite unique
-- indexes are created HERE if missing (in prod they were applied additively
-- before the flip — `if not exists` makes both paths work), and each PK swap is
-- guarded on the CURRENT PK still being the single-column one, so a replay on
-- an already-flipped database (or a fresh environment whose schema.sql already
-- creates the composite PKs) is a no-op instead of an abort. Without this, a
-- rebuilt environment died on the missing index and left reanchor_intents on
-- PK customer_id — turning every composite onConflict upsert into a silent
-- 42P10 error.

begin;

-- Prereqs (no-op when already applied, or when schema.sql already built the
-- tables with the composite PK).
create unique index if not exists uq_subscriptions_customer_seal
  on subscriptions(customer_id, seal_subscription_id);
create unique index if not exists uq_reanchor_customer_seal
  on subscription_reanchor_intents(customer_id, seal_subscription_id);

-- The two FKs point at subscriptions(customer_id); a composite PK there makes a
-- single-column FK invalid, so drop them (these tables are app-managed cache/
-- audit — no hard deletes of subscriptions rows, so cascade is moot). Keep a
-- plain index for lookups.
alter table subscription_changes drop constraint if exists subscription_changes_customer_id_fkey;
alter table subscription_states  drop constraint if exists subscription_states_customer_id_fkey;
create index if not exists idx_subscription_changes_customer on subscription_changes(customer_id);

-- subscriptions: swap PK (customer_id) → (customer_id, seal_subscription_id).
-- Promote the pre-built composite unique index to PK. Keep UNIQUE(seal_subscription_id)
-- (each Seal sub is still one row — a valid, useful guard). Skipped when the PK
-- is already composite (replay / fresh environment).
do $$
begin
  if (
    select count(*)
    from information_schema.key_column_usage
    where table_name = 'subscriptions'
      and constraint_name = 'subscriptions_pkey'
  ) = 1 then
    alter table subscriptions drop constraint subscriptions_pkey;
    alter table subscriptions add constraint subscriptions_pkey
      primary key using index uq_subscriptions_customer_seal;
  end if;
end $$;

-- reanchor_intents: same swap → one pending intent per (customer, sub).
do $$
begin
  if (
    select count(*)
    from information_schema.key_column_usage
    where table_name = 'subscription_reanchor_intents'
      and constraint_name = 'subscription_reanchor_intents_pkey'
  ) = 1 then
    alter table subscription_reanchor_intents drop constraint subscription_reanchor_intents_pkey;
    alter table subscription_reanchor_intents add constraint subscription_reanchor_intents_pkey
      primary key using index uq_reanchor_customer_seal;
  end if;
end $$;

commit;
