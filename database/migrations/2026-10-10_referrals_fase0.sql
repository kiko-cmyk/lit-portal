-- 2026-10-10 — Referidos, fase 0: «Trae a alguien».
--
-- Amigo: 10 € en su primer pedido de cajas LIT (suscripción o compra única),
-- con el código personal de quien le invita. Quien invita: 10 € menos en su
-- siguiente cobro de suscripción, aplicados por el cron JUSTO ANTES del cobro
-- y retirados en cuanto se cobra. Diseño completo en lib/referral-reward.ts.
--
-- ══ Se ejecuta ANTES de desplegar el código ══
--
-- Es aditiva e idempotente: solo añade columnas, una tabla y sus índices. El
-- código viejo (el GET muerto de /api/referral/code y la vía de
-- note_attributes.ref del webhook) no lee ninguna columna nueva, así que
-- correrla antes no rompe nada. Al revés SÍ: el código nuevo escribe columnas
-- que sin esto no existen.
--
-- ══ Lo que había ══
--
-- `referral_codes` y `referral_conversions` existen desde abril (schema.sql)
-- pero nunca se usaron de verdad: el 2026-10-09 había 1 fila de prueba en
-- referral_codes (28-abr) y 0 conversiones. Esa fila se marca `retired`: su
-- código no existe en Shopify, así que no puede repartirse. Si su cliente es
-- suscriptor activo, la emisión le asignará uno nuevo sobre la misma fila (la
-- PK es el cliente).
--
-- ══ El invariante del dinero ══
--
-- `uq_referral_rewards_live_per_sub`: como mucho UNA recompensa viva
-- (applying | applied) por suscripción de Seal. `apply` de Seal no es
-- idempotente y un código aplicado se repite en CADA cobro hasta que se quita,
-- así que dos recompensas vivas en la misma sub serían 20 € en un cobro sin
-- control. El índice convierte esa carrera en un 23505.
--
-- Verificación obligatoria contra PRODUCCIÓN después de correrla:
--   select indexname from pg_indexes where tablename like 'referral_%' order by 1;
--     → incluye uq_referral_rewards_live_per_sub, uq_referral_conversions_friend_once
--       y referral_codes_code_key
--   select relname, relrowsecurity from pg_class
--    where relname in ('referral_codes','referral_conversions','referral_rewards');
--     → las tres con relrowsecurity = t
--   select count(*) from pg_policies where tablename like 'referral_%';
--     → 0
--   select status, count(*) from referral_codes group by 1;
--     → solo 'retired' (o vacío)

-- Por si se corre contra una base sin schema.sql (no debería): mismas
-- definiciones que allí.
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

-- ─────────────────────────────────────────────────────────────────────────────
-- referral_codes: un código personal por cliente, colgado del descuento padre
-- «Referidos · Amigo 10 €» de Shopify.
-- ─────────────────────────────────────────────────────────────────────────────
alter table referral_codes
  add column if not exists status             text,
  add column if not exists shopify_discount_id text,  -- gid del descuento padre
  add column if not exists bulk_creation_id   text,   -- gid de la bulk que lo dio de alta
  add column if not exists activated_at       timestamptz,
  add column if not exists disabled_at        timestamptz,
  add column if not exists disabled_reason    text,
  add column if not exists attempts           int not null default 0,
  add column if not exists last_error         text,
  add column if not exists updated_at         timestamptz not null default now();

update referral_codes set status = 'retired' where status is null;

alter table referral_codes alter column status set default 'pending';
alter table referral_codes alter column status set not null;

do $$ begin
  alter table referral_codes add constraint referral_codes_status_chk
    check (status in ('pending', 'active', 'failed', 'disabled', 'retired'));
exception when duplicate_object then null; end $$;

-- Shopify trata los códigos sin distinguir mayúsculas; el UNIQUE de la columna
-- sí distingue. Guardarlos siempre en mayúsculas cierra ese hueco.
do $$ begin
  alter table referral_codes add constraint referral_codes_code_upper_chk
    check (code = upper(code));
exception when duplicate_object then null; end $$;

create index if not exists idx_referral_codes_pending
  on referral_codes (updated_at) where status = 'pending';

-- ─────────────────────────────────────────────────────────────────────────────
-- referral_conversions: un pedido pagado con un código de amigo. Se registra
-- en el webhook (pending) y se cualifica después (qualified | rejected | review).
-- ─────────────────────────────────────────────────────────────────────────────
alter table referral_conversions
  add column if not exists code                  text,
  add column if not exists friend_customer_id    text,
  add column if not exists friend_order_name     text,
  -- subscription | one_time | mixed: el amigo puede entrar como quiera, y se
  -- guarda para medir cuántos acaban en suscripción.
  add column if not exists purchase_type         text,
  add column if not exists status                text,
  add column if not exists reason                text,
  -- Solo booleanos y huellas HMAC (email, teléfono, dirección). NUNCA el dato.
  add column if not exists signals               jsonb,
  add column if not exists attempts              int not null default 0,
  add column if not exists last_error            text,
  add column if not exists qualified_at          timestamptz,
  add column if not exists revoked_at            timestamptz,
  add column if not exists friend_sub_checked_at timestamptz,
  add column if not exists updated_at            timestamptz not null default now();

update referral_conversions set status = 'legacy' where status is null;

alter table referral_conversions alter column status set default 'pending';
alter table referral_conversions alter column status set not null;
-- La fase 0 no da Drops por referido (llegarán con efecto retroactivo en Drops 2.0).
alter table referral_conversions alter column drops_awarded set default 0;

do $$ begin
  alter table referral_conversions add constraint referral_conversions_status_chk
    check (status in ('pending', 'qualified', 'rejected', 'review', 'revoked', 'legacy'));
exception when duplicate_object then null; end $$;

-- Un amigo cualifica UNA vez en la vida, con quien sea que le invite.
create unique index if not exists uq_referral_conversions_friend_once
  on referral_conversions (friend_customer_id) where status = 'qualified';

create index if not exists idx_referral_conversions_open
  on referral_conversions (status, converted_at) where status in ('pending', 'review');

-- ─────────────────────────────────────────────────────────────────────────────
-- referral_rewards: los 10 € de quien invita, uno por conversión cualificada.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists referral_rewards (
  id                          uuid primary key default uuid_generate_v4(),
  conversion_id               uuid not null unique references referral_conversions (id),
  referrer_customer_id        text not null,
  amount_cents                int  not null default 1000 check (amount_cents > 0),
  status                      text not null default 'queued'
                                check (status in ('queued', 'applying', 'applied', 'consumed',
                                                  'revoked', 'expired', 'failed')),
  status_reason               text,
  -- La sub de Seal donde está aplicada (solo mientras applying | applied).
  seal_subscription_id        text,
  -- `LITREF-XXXXXXXX`, un código de un solo uso por recompensa. Se crea al
  -- aplicar por primera vez y se reutiliza si hay que reaplicar.
  reward_code                 text unique check (reward_code = upper(reward_code)),
  shopify_discount_id         text,
  -- UUIDs de items[].discount_codes en Seal (uno por línea en subs multi-línea).
  seal_discount_ids           text[] not null default '{}',
  charge_due_at               timestamptz,
  -- Se escribe JUSTO ANTES de llamar a Seal. Si una pasada muere a mitad, la
  -- siguiente sabe que el apply pudo entrar (y desde cuándo contar los cobros), o
  -- que nunca salió y se puede devolver a la cola sin riesgo.
  apply_sent_at               timestamptz,
  applied_at                  timestamptz,
  consumed_at                 timestamptz,
  consumed_order_id           text unique,
  -- Cuándo vuelve a mirarla el cron (solo en cola). Con el cobro a semanas vista no
  -- hace falta leer Seal en cada pasada: así escala con muchas recompensas. Nace
  -- «ya» y nunca se deja sin fecha en cola: la cola se recorre por esta columna.
  next_check_at               timestamptz default now(),
  revoked_at                  timestamptz,
  expires_at                  timestamptz not null default (now() + interval '180 days'),
  attempts                    int not null default 0,
  last_error                  text,
  shopify_discount_deleted_at timestamptz,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  constraint referral_rewards_live_has_sub
    check (status not in ('applying', 'applied') or seal_subscription_id is not null),
  constraint referral_rewards_consumed_shape
    check (status <> 'consumed' or consumed_at is not null)
);

-- Si la tabla ya existía de una pasada anterior de esta misma migración: las
-- columnas que se añadieron después, ANTES de los índices que las usan.
alter table referral_rewards
  add column if not exists apply_sent_at timestamptz,
  add column if not exists next_check_at timestamptz default now();
alter table referral_rewards alter column next_check_at set default now();

-- EL invariante del dinero (ver la cabecera).
create unique index if not exists uq_referral_rewards_live_per_sub
  on referral_rewards (seal_subscription_id) where status in ('applying', 'applied');

create index if not exists idx_referral_rewards_open
  on referral_rewards (status, created_at) where status in ('queued', 'applying', 'applied');

create index if not exists idx_referral_rewards_referrer
  on referral_rewards (referrer_customer_id, created_at desc);

create index if not exists idx_referral_rewards_next_check
  on referral_rewards (next_check_at) where status = 'queued';

-- RLS ON y CERO policies, el patrón de toda tabla del portal: solo se tocan con
-- la service key desde las rutas y los crons.
alter table referral_codes       enable row level security;
alter table referral_conversions enable row level security;
alter table referral_rewards     enable row level security;
