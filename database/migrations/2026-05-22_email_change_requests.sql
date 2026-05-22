-- 2026-05-22: email change verification.
-- Audit 2026-05-21 finding #11: pre-fix PATCH /api/customer accepted
-- `email` and applied it instantly to Shopify. A stolen session token
-- (XSS, shared device, leaked log) could be used to redirect a
-- customer's account to an attacker's email.
--
-- New flow: PATCH writes a pending row here, dispatches a Klaviyo
-- event with a confirmation URL to the NEW email. Only when the
-- recipient clicks the link does the change apply.

create table if not exists email_change_requests (
  token         text primary key,           -- 32 bytes hex random
  customer_id   text not null,
  new_email     text not null,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '15 minutes',
  consumed_at   timestamptz
);

-- Lookup index for "any pending request for this customer" (used to
-- avoid spamming when the customer clicks save multiple times).
create index if not exists email_change_requests_customer_pending
  on email_change_requests(customer_id)
  where consumed_at is null;
