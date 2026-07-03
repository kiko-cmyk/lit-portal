-- 2026-07-03 — allow 'dont_like' as a cancellation reason.
--
-- The cancel UI (src/components/CancelTakeover.tsx) offers "No me gusta" (value
-- dont_like) as one of its five reasons, but neither the server whitelist nor
-- this CHECK included it — so a customer choosing "No me gusta" could NOT
-- cancel (invalid_reason 400, and a 500 before that). Add dont_like.
--
-- ORDER MATTERS: run this in Supabase BEFORE merging the server change that
-- accepts dont_like. If the server accepts it while the CHECK still rejects it,
-- the insert blows the CHECK as a 500. This migration ALONE is safe to run any
-- time (it only widens the allowed set; current behaviour unchanged).
--
-- Idempotent: drop + re-add the named constraint. NOTE: the inline CHECK in
-- schema.sql is auto-named `cancellations_primary_reason_check` by Postgres
-- (same convention as cancellations_status_check in the 2026-05-21 migration).
-- If your DB named it differently, adjust the drop below (verify with:
--   select conname from pg_constraint where conrelid = 'cancellations'::regclass;).

alter table cancellations drop constraint if exists cancellations_primary_reason_check;
alter table cancellations add constraint cancellations_primary_reason_check
  check (primary_reason in (
    'too_expensive','too_much_product','not_using_enough','taking_a_break','dont_like','other'
  ));
