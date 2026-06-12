-- 2026-06-12: re-anchor intents (preserve next-ship date after a plan change).
--
-- Problem: a plan change (frequency / box count) makes Seal DELETE and
-- REGENERATE the whole billing_attempts schedule anchored on "today +
-- interval", which silently undoes a prior skip (e.g. a customer who skipped
-- to 27-Sep ends up with the next charge back on 27-Jun). Business rule: a
-- plan change must NEVER move the next charge earlier than the date the
-- customer already had.
--
-- The plan-change route skips the early regenerated attempts in-request when
-- Seal finishes regenerating quickly (the common case). When Seal is still
-- regenerating past the in-request poll budget (rare, can take minutes), the
-- route records an intent here and the cron drain
-- (/api/cron/reanchor-drain, every 5 min) finishes the skip. The skip helper
-- (seal.skipIntermediateAttempts) is idempotent, so draining is safe to retry.

create table if not exists subscription_reanchor_intents (
  customer_id           text primary key,            -- one live intent per customer
  seal_subscription_id  text not null,
  preserve_date         date not null,               -- YYYY-MM-DD the next charge must hold
  status                text not null default 'pending'
                          check (status in ('pending', 'done', 'failed')),
  attempts              int  not null default 0,      -- drain attempts (hard backstop)
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists idx_reanchor_pending
  on subscription_reanchor_intents (status)
  where status = 'pending';

-- RLS ON + 0 policies: all access is via the service-role client (every API
-- route + the cron drain), which bypasses RLS. No public policies → anon /
-- authenticated cannot read or tamper. Same pattern as rate_buckets,
-- email_change_requests, webhook_log.
alter table subscription_reanchor_intents enable row level security;
