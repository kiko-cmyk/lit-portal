# LIT Portal

Post-purchase portal for LIT Hydration subscribers. Lives under Shopify App Proxy at `/apps/portal/*`.

**Status:** MVP scaffold (2026-04-27). Backend stubs in place, integrations pending credentials.

## Stack

- Next.js 15 (App Router) + TypeScript + Tailwind
- Supabase (Postgres) — schema in `database/schema.sql`
- Seal Subscriptions Merchant API
- Shopify Admin GraphQL
- Klaviyo (transactional emails + profile properties)

## Architecture

The portal is **NOT** a standalone app. It is mounted under Shopify's App Proxy at `litsalt.com/apps/portal/*`. Every request is signed by Shopify and verified in `src/lib/shopify-app-proxy.ts`. The trusted `customerId` comes from the proxy, never from query params or cookies.

See `../BACKEND_CONTRACT.md` for the full API spec, table schemas, webhook handlers, and business rules. See `../LIT-Portal-Master-Spec.txt` for the product spec.

## MVP scope

**Included:** Confirmation email, First-login welcome, Hub, Drops, The World (no QR check-in), Account, Cancel flow.

**Excluded (Phase 2):** Collection (depends on physical cards), Event QR check-in, real progressive pricing.

## Getting started

```bash
# 1. install
npm install

# 2. env
cp .env.example .env.local
# fill in the values

# 3. supabase schema
# Open Supabase SQL Editor and run database/schema.sql

# 4. dev server
npm run dev
# → http://localhost:3000

# 5. type check
npx tsc --noEmit
```

## Project layout

```
lit-portal/
├── database/
│   └── schema.sql              ← run once in Supabase SQL Editor
├── src/
│   ├── app/
│   │   ├── api/                ← all backend routes (mounted under /apps/portal/api/*)
│   │   │   ├── pricing/
│   │   │   ├── subscription/   ← GET/PATCH plan, skip, address, cancel, reactivate, extras
│   │   │   ├── drops/          ← balance, puzzle
│   │   │   ├── rewards/        ← claim
│   │   │   ├── referral/       ← code
│   │   │   ├── events/         ← list, save bookmark
│   │   │   ├── moments/
│   │   │   ├── stories/
│   │   │   ├── the-world/      ← barcelona-waitlist
│   │   │   ├── customer/       ← profile, language
│   │   │   ├── orders/         ← Shopify order history
│   │   │   ├── hub/            ← aggregated dashboard
│   │   │   ├── timeline/
│   │   │   ├── tier/
│   │   │   ├── first-login/    ← whatsapp, language, complete
│   │   │   ├── webhooks/       ← shopify, seal
│   │   │   └── health/
│   │   └── (frontend pages — TBD next session)
│   └── lib/
│       ├── shopify-app-proxy.ts  ← signature verification
│       ├── api-helpers.ts        ← withCustomer() wrapper
│       ├── supabase.ts           ← admin + anon clients
│       ├── seal.ts               ← Seal API client (stubbed)
│       ├── shopify-admin.ts      ← Shopify Admin GraphQL (stubbed)
│       ├── klaviyo.ts            ← Klaviyo API client (stubbed)
│       ├── pricing.ts            ← PRICE_PER_BOX constants — single source of truth
│       ├── drops.ts              ← awarding rules + puzzle math + active reward logic
│       ├── cutoff.ts             ← 72h cutoff helper
│       └── types.ts              ← shared types mirroring BACKEND_CONTRACT
└── .env.example
```

## Locked decisions (see `../BACKEND_CONTRACT.md` § 0)

- Cutoff: 72h before next ship
- Reactivation: no cooldown (1st cancel within 90d → drops restored; 2nd cancel → drops reset to 0 immediately)
- Card webhook: Shopify `fulfillments/create` (NOT Hive — Hive is not integrated)
- Multi-box: linear +100 Drops/box
- Extras admin: Shopify collection tagged `add-to-box`
- Pricing: flat €14/box placeholder until MVP launch — single edit in `src/lib/pricing.ts`
- Puzzle: `pieces_revealed = floor((current_drops / reward_threshold) × 16)`
- No emojis anywhere — typographic icons + minimal SVG only

## What's next (engineering)

Backend implementation, in priority order:

1. **Wire Seal client** to a sandbox subscription. Verify auth + the 4 endpoints we use most: get subscription, skip/unskip, update plan, cancel.
2. **Implement `GET /api/subscription`** end-to-end — first real flow, validates the App Proxy auth chain.
3. **Implement `POST /api/subscription/cancel`** with the 4-step persistence and the 1st-vs-2nd cancel branching.
4. **Implement webhooks** (`fulfillments/create` first — drives the +100 Drops earn loop).
5. Port the Hub HTML from `../designs/mobile/lit-hub-hifi/index.html` to Next.js components, wired to `GET /api/hub/dashboard`.
6. Repeat for the other 5 surfaces.

## Deployment

- Hosting: Vercel (project `kiko-5145s-projects/lit-portal`)
- Shopify App Proxy subpath prefix: `apps`, subpath: `portal`, URL: this Vercel deployment
- Supabase project to be confirmed by Juan (URL/keys go into `.env.local` and Vercel env)
