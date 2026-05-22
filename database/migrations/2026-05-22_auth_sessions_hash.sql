-- 2026-05-22: hash auth_sessions.session_id at rest.
--
-- Audit 2026-05-21 finding LOW: a read-only DB leak today would
-- expose every live session token in plaintext, equivalent to leaking
-- every authed customer's password for the portal. We now persist only
-- the SHA-256 hash of the random session id; the raw value lives only
-- in the customer's localStorage. A DB leak becomes harmless because
-- brute-forcing a 256-bit hash is infeasible.
--
-- Backward compatible: existing rows get backfilled with the hash of
-- their current session_id so customers stay logged in across the
-- deploy. The `session_id` column STAYS for now (allows rollback);
-- it will be dropped in a follow-up migration once the new code has
-- been verified in prod.

create extension if not exists pgcrypto;

-- 1) Add hash column (nullable so we can backfill).
alter table auth_sessions
  add column if not exists session_id_hash text;

-- 2) Backfill existing rows.
update auth_sessions
set session_id_hash = encode(digest(session_id, 'sha256'), 'hex')
where session_id_hash is null;

-- 3) NOT NULL + unique index.
alter table auth_sessions
  alter column session_id_hash set not null;

create unique index if not exists auth_sessions_session_id_hash_uniq
  on auth_sessions(session_id_hash);
