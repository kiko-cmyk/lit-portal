-- 2026-06-30 — Webhook reliability (P0)
--
-- Context: both webhook handlers (shopify, seal) insert into webhook_log BEFORE
-- running the handler. If the handler then threw, the retry hit the
-- (provider, event_id) PK, returned dedup:true, and the event was lost forever
-- (missed confirmation emails / drops). The code fix releases the reservation
-- on failure so the retry re-processes — which requires the box_shipped award
-- to be idempotent on replay. This migration adds that idempotency key.
--
-- Additive and idempotent: safe to run anytime, BEFORE deploying the code.
-- Apply via `npm run migrate` (runs schema.sql) or paste into the Supabase SQL
-- editor against the session pooler.

alter table drops_events add column if not exists dedup_key text;
create unique index if not exists uq_drops_events_dedup_key on drops_events(dedup_key);

-- Note: NULL dedup_key is allowed and distinct (Postgres default), so existing
-- rows and non-opt-in awards (referral, monthly_streak, manual_adjustment, …)
-- are never deduped — only awards that pass an explicit key (today: box_shipped).
