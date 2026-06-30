-- LIT Portal — Supabase Schema (MVP)
-- 2026-04-27
--
-- Run this in Supabase SQL Editor on a fresh project.
-- Excludes Collection + event_checkins (Phase 2).
-- See ../BACKEND_CONTRACT.md § 2 for the full reference.

-- ============================================================
-- 0. Extensions
-- ============================================================

create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";

-- ============================================================
-- 1. Subscriptions + state
-- ============================================================

create table if not exists subscriptions (
  customer_id            text primary key,
  seal_subscription_id   text unique not null,
  box_count              int  not null check (box_count between 1 and 6),
  frequency              text not null check (frequency in ('15d','1mo','45d','2mo','3mo','4mo','5mo','6mo')),
  flavor                 text not null,
  next_ship_date         timestamptz,
  next_box_number        int,
  status                 text not null default 'active'
                              check (status in ('active','paused','post_cancel','reactivating','expired')),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index if not exists idx_subscriptions_status on subscriptions(status);
create index if not exists idx_subscriptions_next_ship on subscriptions(next_ship_date);

create table if not exists subscription_changes (
  id            uuid primary key default uuid_generate_v4(),
  customer_id   text not null references subscriptions(customer_id) on delete cascade,
  change_type   text not null check (change_type in ('plan','flavor','address','skip','skip_undo','extras')),
  payload       jsonb not null,
  applied_at    timestamptz not null default now(),
  applies_from  date
);

create index if not exists idx_subscription_changes_customer on subscription_changes(customer_id, applied_at desc);

create table if not exists subscription_states (
  customer_id        text primary key references subscriptions(customer_id) on delete cascade,
  skip_state         jsonb,
  locked_until       timestamptz,
  post_cancel_state  jsonb,
  updated_at         timestamptz not null default now()
);

-- ============================================================
-- 2. Drops + rewards
-- ============================================================

create table if not exists drops_events (
  id           uuid primary key default uuid_generate_v4(),
  customer_id  text not null,
  action       text not null check (action in (
                  'box_shipped','referral_converted','monthly_streak',
                  'product_review','social_share','whatsapp_optin',
                  'event_checkin','reward_claim','cancel_reset','manual_adjustment'
                )),
  amount       int  not null,
  metadata     jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists idx_drops_events_customer on drops_events(customer_id, created_at desc);
create index if not exists idx_drops_events_action on drops_events(action, created_at desc);

-- Idempotency key for REPLAYABLE awards (e.g. box_shipped re-fired by a webhook
-- retry). awardDrops() upserts ON CONFLICT (dedup_key) DO NOTHING when a key is
-- given, so a replay is a no-op instead of a duplicate award. NULLs are allowed
-- and distinct, so awards that don't opt in are never deduped.
alter table drops_events add column if not exists dedup_key text;
create unique index if not exists uq_drops_events_dedup_key on drops_events(dedup_key);

create table if not exists drops_balances (
  customer_id      text primary key,
  balance          int not null default 0,
  lifetime_earned  int not null default 0,
  tier_earned_at   timestamptz,
  streak_months    int not null default 0,
  updated_at       timestamptz not null default now()
);

-- Trigger: recompute drops_balances when drops_events changes
create or replace function recompute_drops_balance() returns trigger as $$
declare
  v_customer text := coalesce(new.customer_id, old.customer_id);
  v_balance int;
  v_lifetime int;
  v_tier_earned_at timestamptz;
begin
  select coalesce(sum(amount), 0),
         coalesce(sum(case when amount > 0 then amount else 0 end), 0)
    into v_balance, v_lifetime
    from drops_events
   where customer_id = v_customer;

  -- Tier earned at first time lifetime crosses 300 — write once, never clear
  select tier_earned_at into v_tier_earned_at
    from drops_balances where customer_id = v_customer;

  if v_tier_earned_at is null and v_lifetime >= 300 then
    -- find the timestamp at which lifetime crossed 300
    select created_at into v_tier_earned_at
      from (
        select created_at,
               sum(case when amount > 0 then amount else 0 end)
                 over (order by created_at) as running_lifetime
          from drops_events
         where customer_id = v_customer
      ) t
     where running_lifetime >= 300
     order by created_at asc
     limit 1;
  end if;

  insert into drops_balances (customer_id, balance, lifetime_earned, tier_earned_at, updated_at)
  values (v_customer, v_balance, v_lifetime, v_tier_earned_at, now())
  on conflict (customer_id) do update
     set balance         = excluded.balance,
         lifetime_earned = excluded.lifetime_earned,
         tier_earned_at  = coalesce(drops_balances.tier_earned_at, excluded.tier_earned_at),
         updated_at      = now();

  return null;
end;
$$ language plpgsql;

drop trigger if exists trg_drops_events_recompute on drops_events;
create trigger trg_drops_events_recompute
  after insert or update or delete on drops_events
  for each row execute function recompute_drops_balance();

create table if not exists claimed_rewards (
  id                     uuid primary key default uuid_generate_v4(),
  customer_id            text not null,
  reward_id              text not null,           -- e.g. 'bottle_500', 'merch_1000', 'event_2500'
  threshold              int  not null,
  merch_option           text,                    -- only for merch_1000: 'socks'|'tee'|'hoodie'
  fulfillment_method     text not null check (fulfillment_method in ('next_shipment','seat_reserved')),
  fulfillment_status     text not null default 'pending'
                              check (fulfillment_status in ('pending','fulfilled','failed')),
  fulfillment_metadata   jsonb,
  claimed_at             timestamptz not null default now()
);

create index if not exists idx_claimed_rewards_customer on claimed_rewards(customer_id, claimed_at desc);

create table if not exists referral_codes (
  customer_id  text primary key,
  code         text not null unique,
  created_at   timestamptz not null default now()
);

create table if not exists referral_conversions (
  id                    uuid primary key default uuid_generate_v4(),
  referrer_customer_id  text not null,
  converted_order_id    text not null unique,
  converted_at          timestamptz not null default now(),
  drops_awarded         int  not null default 250
);

create index if not exists idx_referral_conversions_referrer on referral_conversions(referrer_customer_id, converted_at desc);

-- ============================================================
-- 3. The World (events / moments / stories)
-- ============================================================

create table if not exists events (
  id              uuid primary key default uuid_generate_v4(),
  city            text not null check (city in ('madrid','barcelona')),
  title_en        text not null,
  title_es        text not null,
  description_en  text,
  description_es  text,
  datetime        timestamptz not null,
  hero_image      text,
  ticket_url      text,
  capacity        int,
  status          text not null default 'active' check (status in ('active','past','draft')),
  created_at      timestamptz not null default now()
);

create index if not exists idx_events_city_datetime on events(city, datetime);

create table if not exists event_bookmarks (
  customer_id  text not null,
  event_id     uuid not null references events(id) on delete cascade,
  saved_at     timestamptz not null default now(),
  primary key (customer_id, event_id)
);

create table if not exists event_reservations (
  id               uuid primary key default uuid_generate_v4(),
  customer_id      text not null,
  event_id         uuid not null references events(id) on delete cascade,
  reserved_at      timestamptz not null default now(),
  reward_claim_id  uuid references claimed_rewards(id)
);

create table if not exists moments (
  id            uuid primary key default uuid_generate_v4(),
  image_url     text not null,
  caption_en    text,
  caption_es    text,
  position      int not null default 0,
  published_at  timestamptz not null default now()
);

create index if not exists idx_moments_position on moments(position, published_at desc);

create table if not exists stories (
  id            uuid primary key default uuid_generate_v4(),
  type          text not null check (type in ('feature','letter','recap')),
  slug          text not null unique,
  title_en      text not null,
  title_es      text not null,
  body_en       text,
  body_es       text,
  cover_image   text,
  published_at  timestamptz not null default now()
);

create index if not exists idx_stories_published on stories(published_at desc);

create table if not exists barcelona_waitlist (
  email      text primary key,
  joined_at  timestamptz not null default now(),
  position   serial
);

-- ============================================================
-- 4. Lifecycle / preferences
-- ============================================================

create table if not exists customer_preferences (
  customer_id            text primary key,
  language               text not null default 'en' check (language in ('en','es')),
  whatsapp_opt_in        boolean not null default false,
  first_login_completed  boolean not null default false,
  cancel_count           int not null default 0,
  last_cancelled_at      timestamptz,
  updated_at             timestamptz not null default now()
);

create table if not exists cancellations (
  id                          uuid primary key default uuid_generate_v4(),
  customer_id                 text not null,
  status                      text not null default 'pending' check (status in ('pending','committing','confirmed')),
  primary_reason              text check (primary_reason in (
                                  'too_expensive','too_much_product','not_using_enough','taking_a_break','other'
                                )),
  free_text                   text,
  step_completed              int not null default 1 check (step_completed between 1 and 4),
  started_at                  timestamptz not null default now(),
  confirmed_at                timestamptz,
  effective_last_ship_date    date,
  drops_held_at_cancel        int,
  drops_release_at            timestamptz, -- null if 2nd cancel (immediate reset, no hold)
  cancel_count_at_event       int not null
);

create index if not exists idx_cancellations_customer on cancellations(customer_id, confirmed_at desc nulls last);
create index if not exists idx_cancellations_release on cancellations(drops_release_at) where drops_release_at is not null;

create table if not exists email_logs (
  id                  uuid primary key default uuid_generate_v4(),
  customer_id         text not null,
  template_id         text not null,
  klaviyo_message_id  text,
  metadata            jsonb,
  sent_at             timestamptz not null default now()
);

create index if not exists idx_email_logs_customer on email_logs(customer_id, sent_at desc);

-- ============================================================
-- 5. Webhook idempotency
-- ============================================================

create table if not exists webhook_log (
  provider      text not null check (provider in ('shopify','seal','klaviyo')),
  event_id      text not null,
  topic         text not null,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz,
  primary key (provider, event_id)
);

create index if not exists idx_webhook_log_topic on webhook_log(topic, received_at desc);

-- ============================================================
-- 5b. Auth sessions
-- ============================================================
-- Maps an opaque session_id (issued after Customer Account API OAuth)
-- to a Shopify customer ID. Used by the portal API routes when the
-- request can't be authenticated via App Proxy (`logged_in_customer_id`)
-- — happens when the customer logged in through Customer Account API
-- and lacks a storefront session cookie.
--
-- The FE stores `session_id` in localStorage and sends it as
-- `Authorization: Bearer <session_id>` on every API call. Backend
-- middleware (`withCustomer`) tries App Proxy first, then this table.

create table if not exists auth_sessions (
  session_id     text primary key,           -- raw token, KEPT FOR ROLLBACK only; pending drop
  session_id_hash text not null unique,       -- SHA-256 of raw token; this is the column code reads
  customer_id    text not null,
  email          text,                        -- TODO 2026-05-22: review whether still needed at rest
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  -- We DO NOT persist Shopify access_token / refresh_token. The portal
  -- doesn't call Customer Account API directly — it uses Admin API
  -- server-side with our app token. The session is just a customer_id
  -- pointer with our own TTL semantics.
  last_used_at   timestamptz not null default now(),
  -- id_token is the OIDC id_token returned by Shopify during the OAuth
  -- callback. We persist it ONLY to decide between OIDC end_session vs
  -- storefront logout (id_token expires in ~10min so we check freshness).
  id_token       text
);

create index if not exists idx_auth_sessions_customer on auth_sessions(customer_id);
create index if not exists idx_auth_sessions_expires on auth_sessions(expires_at);

-- ============================================================
-- 6. RLS policies
-- ============================================================
-- Service role bypasses RLS; portal API routes always run with service role.
-- We enable RLS as a defense-in-depth so anon key cannot leak.

alter table subscriptions          enable row level security;
alter table subscription_changes   enable row level security;
alter table subscription_states    enable row level security;
alter table drops_events           enable row level security;
alter table drops_balances         enable row level security;
alter table claimed_rewards        enable row level security;
alter table referral_codes         enable row level security;
alter table referral_conversions   enable row level security;
alter table events                 enable row level security;
alter table event_bookmarks        enable row level security;
alter table event_reservations     enable row level security;
alter table moments                enable row level security;
alter table stories                enable row level security;
alter table barcelona_waitlist     enable row level security;
alter table customer_preferences   enable row level security;
alter table cancellations          enable row level security;
alter table email_logs             enable row level security;
alter table webhook_log            enable row level security;
alter table auth_sessions          enable row level security;
-- NOTE: email_change_requests and rate_buckets are created in their own
-- migration files (database/migrations/2026-05-22_*.sql) and enable RLS
-- there. They are NOT created here, so don't add their ALTER statements to
-- this file or a fresh standalone run would fail. (Supabase flagged both as
-- rls_disabled on 2026-05-25; fixed 2026-05-27.)

-- No public policies — all access via service role from API routes.
