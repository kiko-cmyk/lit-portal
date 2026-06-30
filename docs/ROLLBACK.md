# LIT Portal — Rollback runbook

The portal is customer-facing and in production. This is the "something broke, get back to a known-good state" runbook. Print-friendly; keep it short.

## Before you ever need it (verify once)

- [ ] **Vercel deployment retention.** Project → Deployments: confirm prior **production** deployments are still listed and show **"Promote to Production"**. If retention is short, your only rollback is `git revert` (slower). The project is `kiko-5145s-projects/lit-portal`; prod branch is `main`.
- [ ] **Supabase backups / PITR.** Project → Database → Backups: confirm a backup schedule / PITR is enabled and note the retention window. This is the **only** DB rollback path (migrations are forward-only, no down-steps).
- [ ] **Env backup.** `vercel env pull .env.local` periodically so the full config can be restored. The required vars are in `.env.example`.

## Deploy model (so rollback makes sense)

- Push to `main` → Vercel auto-deploys to **production**.
- Any branch push → Vercel **preview** deploy. ⚠️ Previews use **production** Supabase/Seal/Shopify credentials — never run mutating tests against a preview thinking it is isolated.
- Static assets load from the Vercel origin via `assetPrefix`; HTML + `/api/*` go through the Shopify App Proxy (`litsalt.com/apps/portal/*`).

## (a) Bad code deploy — fastest path

1. Vercel dashboard → **Deployments** → find the last known-good production deployment (before the bad merge) → **⋯ → Promote to Production**. Re-points the prod alias to existing artifacts in seconds, no rebuild.
2. Verify recovery:
   ```bash
   curl -s "https://lit-portal-drab.vercel.app/api/health/ready?token=$HEALTH_READY_TOKEN" | jq
   SMOKE_API_BASE=https://lit-portal-drab.vercel.app/api HEALTH_READY_TOKEN=… npm run smoke
   ```
3. If "Promote" is unavailable (retention) OR to make the rollback permanent on `main`:
   ```bash
   git revert <bad-merge-sha> -m 1   # -m 1 for a merge commit
   git push                          # Vercel auto-deploys the revert
   ```
   Batches are kept small precisely so `git revert` is always a clean single commit.

## (b) Bad DB migration

- **Additive change** (new table/column/index, merely unused or wrong): harmless to leave; revert the *code* (path a). Forward-fix in a follow-up migration. No DB action.
- **Destructive change** (a `DROP`/data loss): the only rollback is **Supabase restore-from-backup** to the snapshot taken immediately before. Restore to a new DB/branch first and verify before repointing prod if the platform allows.
- This rollout ships **no destructive migrations**. The one deferred destructive change (drop `auth_sessions.session_id`) is gated on a verified backup taken right before — see the master plan, Lote 5.

## (c) CSP / security headers broke the app

CSP failures are usually **silent** (white screen / `Refused to load …` in the console, no 5xx) → the Slack alert may NOT fire. You find them via the smoke test + a visual check. That is why CSP ships **Report-Only first**.

1. Fastest: `git revert <csp-commit-sha>` → push → rebuild. The CSP change ships **alone** in its batch, so the revert touches nothing else.
2. If a Vercel project-level header override or the Shopify App Proxy layer can strip/override the header, use it as a no-redeploy kill switch while the revert builds (confirm this capability with the owner).
3. Recovery check: load every screen as the test customer, console clean of `Refused to…`; then re-introduce CSP via `Content-Security-Policy-Report-Only`, fix the allowlist, and only then re-enforce.

## (d) Feature-flag kill switch (cache-first reads, Lote 4)

The cache-first subscription read is behind `SUBSCRIPTION_CACHE_FIRST` = `off` | `shadow` | `on`. To disable instantly **without a redeploy**: Vercel → Settings → Environment Variables → set `SUBSCRIPTION_CACHE_FIRST=off` → it takes effect on the next request. The code also falls back to the full Seal scan on any cache-path error, so the worst case is "slow", never "wrong".

## After any restore — reconcile

- Check `webhook_log` for events that failed during the incident window.
- If a subscription mutation ran during the window, reconcile Seal state vs the Supabase `subscriptions` cache (a Hub load re-syncs it).
- Confirm Klaviyo flows aren't stuck; clear stale `rate_buckets` rows only if a customer is wrongly blocked (windows self-expire ≤ 1h).
