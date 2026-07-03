-- 2026-07-02 — rate_limit_check: race-safe first insert (audit 2026-06-30 / Kiko).
--
-- Bug: the previous body did `select ... for update` and, `if not found`,
-- `insert ... values (count = 1)`. FOR UPDATE locks nothing when the row does
-- not exist yet, so two concurrent FIRST calls for the same (subject, endpoint)
-- both fell into the not-found branch and both tried to INSERT. One won; the
-- other hit the (subject, endpoint) PK and raised unique_violation, which
-- surfaced to enforceRateLimit() as an RPC error → the caller failed OPEN. So
-- the very first request to any bucket could silently bypass the limit under
-- concurrency.
--
-- Fix: ensure the bucket exists with a race-safe `insert ... on conflict do
-- nothing` (a concurrent insert is absorbed, never errors), THEN lock the now
-- guaranteed row with `for update` and run the same window/limit logic. Return
-- shape is unchanged (ok, count, retry_after_sec), so this is a drop-in
-- `create or replace` with NO ordering dependency on the app code — safe to run
-- against Supabase any time (before or after deploy).
--
-- Also fixes an int4 OVERFLOW surfaced 2026-07-03 by the new fail-open alert:
-- v_age_ms was declared `int`, but v_age_ms = floor(epoch_seconds * 1000)
-- overflows int4 (max 2_147_483_647 ms ≈ 24.8 days) once a bucket goes that
-- long without resetting. Worse, the overflow throws on the assignment BEFORE
-- the age >= window reset branch runs, so such a bucket gets stuck erroring on
-- every hit (RPC error → fail-open → alert per retry). Declaring v_age_ms
-- `bigint` removes the overflow AND self-heals stuck buckets: their next hit
-- computes a huge age, takes the reset branch, and starts a fresh window — no
-- manual cleanup. p_window_ms stays int (login windows are minutes, nowhere
-- near the limit), so the signature is unchanged and this is still a clean
-- create-or-replace with no ordering dependency.
--
-- Idempotent + additive: only replaces the function; no data change.

create or replace function rate_limit_check(
  p_subject text,
  p_endpoint text,
  p_limit int,
  p_window_ms int
) returns table (ok boolean, count int, retry_after_sec int) as $$
declare
  v_now timestamptz := now();
  v_row rate_buckets%rowtype;
  v_age_ms bigint; -- bigint, NOT int: age in ms overflows int4 after ~24.8 days
begin
  -- Race-safe bucket creation: a fresh bucket is seeded at count = 0. A
  -- concurrent first call is absorbed by ON CONFLICT DO NOTHING (no error, no
  -- overwrite of an existing counter), so two simultaneous first hits can no
  -- longer collide on the PK and force a fail-open.
  insert into rate_buckets (subject, endpoint, count, window_start_at)
  values (p_subject, p_endpoint, 0, v_now)
  on conflict (subject, endpoint) do nothing;

  -- The row now definitely exists; lock it so concurrent calls serialise.
  select * into v_row
  from rate_buckets
  where subject = p_subject and endpoint = p_endpoint
  for update;

  v_age_ms := floor(extract(epoch from (v_now - v_row.window_start_at)) * 1000);
  if v_age_ms >= p_window_ms then
    -- Window expired: reset to count = 1.
    update rate_buckets
    set count = 1, window_start_at = v_now
    where subject = p_subject and endpoint = p_endpoint;
    return query select true, 1, 0;
    return;
  end if;

  if v_row.count >= p_limit then
    -- Over the limit, deny. Return seconds until the window resets. (No
    -- increment while blocked, same as before.)
    return query
      select false, v_row.count, greatest(1, ceil((p_window_ms - v_age_ms)::numeric / 1000)::int);
    return;
  end if;

  -- Under the limit (this includes a freshly seeded count = 0 bucket): bump and
  -- allow.
  update rate_buckets
  set count = v_row.count + 1
  where subject = p_subject and endpoint = p_endpoint;
  return query select true, v_row.count + 1, 0;
end;
$$ language plpgsql;
