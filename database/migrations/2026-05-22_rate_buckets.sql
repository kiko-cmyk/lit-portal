-- 2026-05-22: rate-limit buckets (audit 2026-05-21 finding #13).
-- One row per (subject, endpoint). `subject` is the customer_id for
-- authed endpoints or "ip:<address>" for pre-auth (login). The window
-- start time + count make a simple fixed-window limiter; on hit, count
-- increments; if window stale (>windowMs old), count resets.

create table if not exists rate_buckets (
  subject          text not null,
  endpoint         text not null,
  count            int  not null default 0,
  window_start_at  timestamptz not null default now(),
  primary key (subject, endpoint)
);

-- 2026-05-27: enable RLS. Supabase flagged `rls_disabled_in_public` for
-- this table. All access is via the service-role client (the
-- rate_limit_check RPC is invoked with it), which bypasses RLS. No public
-- policies → anon/authenticated cannot read or tamper with the counters.
alter table rate_buckets enable row level security;

-- Helper RPC for atomic upsert + increment in a single round-trip.
-- Returns:
--   ok=true and current count when allowed
--   ok=false and seconds until window expires when blocked
create or replace function rate_limit_check(
  p_subject text,
  p_endpoint text,
  p_limit int,
  p_window_ms int
) returns table (ok boolean, count int, retry_after_sec int) as $$
declare
  v_now timestamptz := now();
  v_row rate_buckets%rowtype;
  v_age_ms int;
begin
  -- Try to fetch existing bucket; lock the row so concurrent calls serialise.
  select * into v_row
  from rate_buckets
  where subject = p_subject and endpoint = p_endpoint
  for update;

  if not found then
    -- First call: create the bucket at count=1.
    insert into rate_buckets (subject, endpoint, count, window_start_at)
    values (p_subject, p_endpoint, 1, v_now);
    return query select true, 1, 0;
    return;
  end if;

  v_age_ms := floor(extract(epoch from (v_now - v_row.window_start_at)) * 1000);
  if v_age_ms >= p_window_ms then
    -- Window expired: reset to count=1.
    update rate_buckets
    set count = 1, window_start_at = v_now
    where subject = p_subject and endpoint = p_endpoint;
    return query select true, 1, 0;
    return;
  end if;

  if v_row.count >= p_limit then
    -- Over the limit, deny. Return seconds until window resets.
    return query
      select false, v_row.count, greatest(1, ceil((p_window_ms - v_age_ms)::numeric / 1000)::int);
    return;
  end if;

  -- Under the limit: bump and allow.
  update rate_buckets
  set count = v_row.count + 1
  where subject = p_subject and endpoint = p_endpoint;
  return query select true, v_row.count + 1, 0;
end;
$$ language plpgsql;
