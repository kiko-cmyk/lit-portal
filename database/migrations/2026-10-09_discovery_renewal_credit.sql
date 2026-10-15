-- 2026-10-09 — Discovery Set + suscripción en el MISMO pedido: los 4,99 € se
-- descuentan de la PRIMERA RENOVACIÓN en vez de mandar un código para usar luego.
--
-- Caso que lo destapó: pedido #11724 (9-oct, vía pop-up de la PDP). La clienta
-- compró Discovery Set + caja con suscripción en el mismo carrito, recibió el
-- código de 4,99 € para "tu nueva suscripción" (que ya tenía) y entró en el flow
-- de cinco emails que le pedía suscribirse. Decisión de Juan: en ese caso el
-- importe va a su siguiente renovación, "así nos aseguramos de que renueva".
--
-- ══ Qué añade ══
--
-- `mode` distingue las dos promesas:
--   'checkout' → la de siempre: código por email, se canjea en un checkout de
--                suscripción nueva. Todas las filas que ya existen.
--   'renewal'  → el código NO se manda al cliente: el portal lo aplica él mismo
--                a la suscripción de Seal que nació en `order_id`, y lo retira
--                después del primer cobro.
--
-- `status` es el ciclo de vida del modo 'renewal' (NULL en 'checkout'):
--   pending_apply  → emitido, falta aplicarlo en Seal (Seal aún no ha creado la sub)
--   applying       → reclamado por un proceso que está aplicando ahora mismo
--   pending_charge → aplicado; esperando el cobro de la renovación
--   removed        → cobrada la renovación con descuento y retirado el código
--   void           → la sub se canceló antes de aplicarlo: no hay renovación
--
-- `discount_expires_at` deja de ser NOT NULL: el código de 'renewal' NO caduca.
-- Si caducara a los 30 días, en una sub de 45 días o más llegaría caducado a la
-- renovación, y además el cron `survey-discount-cleanup` lo BORRARÍA (borra los
-- Discovery caducados sin usar) antes de que se cobrara.
--
-- ══ Se ejecuta ANTES de desplegar el código ══
--
-- Correrla sola es seguro: las columnas nuevas tienen default y el código actual
-- no las lee. Al revés no: el webhook nuevo escribe `mode`/`status` en la rama
-- 'renewal' y leería columnas que no existen. (La rama 'checkout' NO escribe las
-- columnas nuevas, así que esa sigue funcionando aunque la migración llegue tarde.)
--
-- Verificación contra PRODUCCIÓN:
--   select column_name, is_nullable, column_default from information_schema.columns
--    where table_name = 'discovery_set_coupons' order by ordinal_position;
--     → 13 filas; discount_expires_at is_nullable = YES; mode default 'checkout'
--   select mode, status, count(*) from discovery_set_coupons group by 1, 2;
--     → todas las filas existentes en ('checkout', NULL)
--
-- Idempotente: `if not exists` + drop/add de los checks.

alter table discovery_set_coupons
  add column if not exists mode                 text not null default 'checkout',
  add column if not exists status               text,
  -- La sub de Seal a la que se aplicó (se fija al reclamar la fila).
  add column if not exists seal_subscription_id text,
  -- UUID del código en la sub de Seal, para poder retirarlo. Puede quedar NULL si
  -- Seal no lo devuelve al momento: el consumidor lo vuelve a buscar por código.
  add column if not exists discount_code_id     text,
  add column if not exists applied_at           timestamptz,
  add column if not exists removed_at           timestamptz,
  -- Token optimista: cada transición lo cambia, y las escrituras que cierran o
  -- liberan la fila lo comprueban, igual que `retention_discounts`.
  add column if not exists updated_at           timestamptz not null default now();

alter table discovery_set_coupons alter column discount_expires_at drop not null;

alter table discovery_set_coupons drop constraint if exists discovery_set_coupons_mode_check;
alter table discovery_set_coupons
  add constraint discovery_set_coupons_mode_check check (mode in ('checkout', 'renewal'));

alter table discovery_set_coupons drop constraint if exists discovery_set_coupons_status_check;
alter table discovery_set_coupons
  add constraint discovery_set_coupons_status_check check (
    (mode = 'checkout' and status is null)
    or (mode = 'renewal' and status in ('pending_apply', 'applying', 'pending_charge', 'removed', 'void'))
  );

-- El cron y el webhook de Seal buscan por estado; casi todas las filas son
-- 'checkout' con status NULL, así que el índice parcial es diminuto.
create index if not exists idx_discovery_coupons_status
  on discovery_set_coupons (status) where status is not null;

-- El webhook de Seal busca la fila por el pedido que creó la sub.
create index if not exists idx_discovery_coupons_order
  on discovery_set_coupons (order_id);

-- RLS ya estaba ON con 0 policies (migración del 2026-09-24); no cambia.
