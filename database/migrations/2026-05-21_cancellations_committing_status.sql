-- 2026-05-21: allow `committing` as a valid status for `cancellations`.
--
-- Background: the cancel step 4 endpoint writes `status = 'committing'`
-- BEFORE calling Seal so that, if Seal succeeds but a follow-up write
-- fails, we still have a visible "half-done" row to reconcile. The
-- audit on 2026-05-18 added the code path but the CHECK constraint
-- was never widened, so every step 4 attempt failed at the pre-commit
-- write with `cancellations_status_check`.
--
-- Effect: zero-downtime constraint swap. No row data changes. The new
-- constraint is a strict superset of the old one, so any existing
-- 'pending' / 'confirmed' row remains valid.

alter table cancellations
  drop constraint if exists cancellations_status_check;

alter table cancellations
  add constraint cancellations_status_check
  check (status in ('pending','committing','confirmed'));
