-- Multi-sub audit 2026-07-06: cancellations must identify WHICH sub was
-- cancelled. Without it, the step-4 idempotency window and in-flight re-drive
-- were per CUSTOMER: cancelling sub B <10 min after sub A returned
-- `cancelled:true` without touching Seal (B kept billing), and B's step 4
-- could adopt A's committing row. Additive + nullable → legacy rows and
-- old payloads (no id) keep the per-customer behaviour.
--
-- Apply in Supabase (session pooler, port 5432). Idempotent.

BEGIN;

ALTER TABLE cancellations
  ADD COLUMN IF NOT EXISTS seal_subscription_id text;

COMMIT;
