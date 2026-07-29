-- 2026-07-28 — Persist webhook payloads (auditability)
--
-- Context: chasing four customer-side subscription pauses took ~40 minutes of
-- paging through the Seal API by hand, because we keep no trace of what Seal
-- actually sent us. `webhook_log` stored only (provider, event_id, topic,
-- received_at, processed_at), so "who paused this subscription and when" was
-- unanswerable from our own database even though the answer travels in every
-- payload: Seal's subscription object carries a `log` array that names the actor
-- verbatim ("Customer paused the subscription." vs "Merchant ... through the
-- API.").
--
-- With the payload stored, the same investigation is one query.
--
-- Size: the body is a few KB and the table sees ~4k Seal + Shopify events a
-- month, so this is single-digit MB a month on a Free-tier project. `purge_after`
-- gives a cheap retention handle without a cron: any future sweep can just
-- delete where purge_after < now(). 90 days is plenty for support work and keeps
-- customer data from accumulating indefinitely (payloads contain PII: email,
-- shipping address).
--
-- Does NOT change dedup behaviour: `event_id` is still the sha256 of the body
-- computed in the route, and the (provider, event_id) PK is untouched.
--
-- KNOWN GAP, accepted on purpose: the release-on-failure policy added on
-- 2026-06-30 DELETES the webhook_log row when a replay-safe handler throws, so
-- the payload of a FAILED event does not survive — exactly the events you would
-- most want to audit. Changing that would reopen the P0 where a redelivery died
-- on dedup:true and the event was lost forever, which is a worse trade. Failed
-- handlers now post to Slack instead (see the `unhandled_topic` alert and the
-- handler's console.error), and the successful-event payload is what answers
-- "who did this".
--
-- PII: Seal bodies carry email and full shipping address, Shopify bodies carry
-- the customer object. That is why retention is bounded rather than forever.
--
-- Additive and idempotent: safe to run anytime, BEFORE deploying the code.
-- Apply via `npm run migrate` (runs schema.sql) or paste into the Supabase SQL
-- editor against the session pooler.

alter table webhook_log add column if not exists payload jsonb;
alter table webhook_log
  add column if not exists purge_after timestamptz
  default (now() + interval '90 days');

-- Retention sweep support. Partial index: only rows that actually carry a
-- payload are worth scanning for deletion.
create index if not exists idx_webhook_log_purge
  on webhook_log (purge_after)
  where payload is not null;

-- RLS is already enabled on webhook_log in schema.sql (RLS ON + zero policies →
-- service_role only). Restated here so applying this file standalone against a
-- drifted database can never leave a payload column readable by the anon key.
alter table webhook_log enable row level security;
