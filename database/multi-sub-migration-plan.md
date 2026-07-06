# LIT Portal — Multi-Subscription Migration Plan

Branch: `feature/multi-sub` (NOT deployed until F3 is tested). Prod keeps deploying
from `feat/master-spec-rewrite`. Core principle: the composite PK flips LAST;
everything before it is additive and byte-identical for the 99% single-sub users.

Origin: mapped 48 touchpoints (workflow, 2026-07-06). See memory
`project_portal_multi_sub`.

## 1. Cache migration (split in two)

Current: `subscriptions` PK `(customer_id)`, `seal_subscription_id` UNIQUE NOT NULL.
Target:  `subscriptions` PK `(customer_id, seal_subscription_id)`, UNIQUE dropped.

- **Migration A (F1, additive, zero-risk):** ensure `seal_subscription_id` column on
  `subscription_reanchor_intents` + add nullable `seal_subscription_id` to
  `subscription_changes` (audit breadcrumb). No PK change.
- **Migration B (F3a, the flip, coordinated):** drop UNIQUE on seal_subscription_id,
  drop the `(customer_id)` PK, add PK `(customer_id, seal_subscription_id)`; composite
  unique on reanchor_intents; drop the two `customer_id` FKs on subscription_changes /
  subscription_states (replace with plain index) — a single-col FK can't reference a
  composite PK. Run inside BEGIN/COMMIT. `retention_discounts` stays PK customer_id
  (deliberate one-discount-per-customer guardrail).

Backfill the ~27 multi-sub customers: read-only from Seal, insert-only into cache,
idempotent script (`scripts/backfill-multisub.ts`), `--dry-run` first. Single-sub
customers need no backfill (their one row already carries the right seal_subscription_id).

## 2. Phases

- **F0 — guards** (DONE: reactivate prefers cancelled, #36). Invisible, no DB.
- **F1 — additive schema + composite-safe writers.** Make every writer
  composite-key-correct WHILE the PK is still `customer_id` (no-op for single-sub;
  guarantees full writer coverage before any flip). Migration A. Deployable alone,
  invisible, low DB risk.
  - Group 1 (onConflict → `["customer_id","seal_subscription_id"]`): webhooks/seal
    syncSubscription, hub/dashboard upsert, plan cache upsert.
  - Group 2 (add `.eq("seal_subscription_id", …)` — the 4 HIGH silent-breaks):
    cancel cache-invalidate UPDATE; webhooks/seal applyReanchorIfPending deletes
    (l.174, l.196); cron/reanchor-drain deletes+updates; plan writeReanchorIntent
    onConflict (l.37).
  - Group 3 (per-sub cron dedup keys): monthly-streak, winback, drops-cleanup.
    renewal-reminder already per-sealSubscriptionId (verify only).
- **F2 — sub-id-aware resolution + reads (backwards-compatible, defaults to auto-pick).**
  `resolveActiveSubFast(customerId, email, sealSubId?)`; GET routes accept optional
  `?seal_subscription_id`; new `GET /api/subscriptions` (plural); mutation routes make
  `sealSubscriptionId` authoritative but optional. No caller passes it yet → invisible.
- **F3a — PK flip + backfill (COORDINATED, prod DB).** Ping Kiko + dump first.
  Migration B + backfill. Ships NO new code (F1/F2 already composite-safe).
- **F3b — selector UI (only user-visible part).** `SubscriptionSelector` renders only
  when `subscriptions.length > 1` (single-sub users never see it). my-lit + account
  pages hold `selectedSealSubId` (localStorage), inject `?seal_subscription_id`.

## 3. Ordering (single-sub never breaks)

F0 → Migration A → F1 writers (composite-safe while PK still customer_id) → F2
readers (accept sub_id, default auto-pick) → **dump** → Migration B (flip) → backfill
27 → F3b selector behind flag. Invariant: steps 1–7 produce byte-identical writes/reads
for a single-sub customer.

## 4. Test plan

Preview deploy of `feature/multi-sub` on staging Supabase (or prod flag-off). A
dedicated TEST customer with 2 real Seal subs (never mutate a real customer). Probe
`?seal_subscription_id=A|B` on GET /subscription, /subscriptions, /hub/dashboard.
Silent-break regression suite: cancel A → row B untouched; reanchor intent per-sub
isolation; per-sub cron dedup; webhook upsert coexists. Single-sub non-regression:
full happy path with no param → identical, selector doesn't render. Selector last.

## 5. Riskiest step

**F3a Migration B** (drop UNIQUE + flip PK + drop 2 FKs on prod). Mitigation: ping
Kiko; fresh `pg_dump` right before (Free tier, no PITR); F1+F2 already soaked in prod;
BEGIN/COMMIT; backfill `--dry-run` first; selector flag off. Rollback: DDL failure
auto-rolls-back; post-flip corruption → restore `subscriptions` from dump + rerun
idempotent backfill; selector misbehaves → flag off (backend already serves single-sub).
