-- 2026-07-04  claimed_rewards: fix status CHECK + add idempotency unique index
--
-- Phase-2 Drops (September launch) — DORMANT. Apply this BEFORE the Drops
-- rewards flow is exposed to customers. Safe to run on an empty or populated
-- table; run it in a transaction.
--
-- Two drifts between database/schema.sql and src/app/api/rewards/claim/route.ts:
--
--   1. The route writes fulfillment_status = 'confirmed' / 'failed_rollback',
--      but the CHECK only allowed ('pending','fulfilled','failed'). Every
--      status UPDATE therefore hit a 23514 the route never surfaced, leaving
--      rows stuck 'pending' — including failed claims that must be found and
--      refunded. Re-point the CHECK at the values the code actually writes.
--
--   2. The route's double-claim protection relies on a UNIQUE index over
--      (customer_id, reward_id) to raise 23505 → 409 already_claimed. Only a
--      NON-unique index existed, so two rapid clicks both inserted and
--      double-fulfilled (and double-deducted drops). Add the unique index.
--
-- The default constraint name for the inline column check is
-- claimed_rewards_fulfillment_status_check. If `drop ... if exists` is a no-op
-- on your DB, look up the real name (\d claimed_rewards) before re-running, so
-- you don't end up with two conflicting checks.

begin;

alter table claimed_rewards
  drop constraint if exists claimed_rewards_fulfillment_status_check;

alter table claimed_rewards
  add constraint claimed_rewards_fulfillment_status_check
  check (fulfillment_status in ('pending', 'confirmed', 'failed_rollback'));

create unique index if not exists uq_claimed_rewards_customer_reward
  on claimed_rewards (customer_id, reward_id);

commit;
