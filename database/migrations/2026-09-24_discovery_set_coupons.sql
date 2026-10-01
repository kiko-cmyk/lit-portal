-- 2026-09-24 — cupón de 5,95 € para quien compra el LIT Discovery Set.
--
-- Tabla NUEVA, no una columna más en `profile_survey_answers`. El cupón del
-- perfilado nace dentro de una sesión de cliente que está contestando un
-- formulario, así que vive en la fila de sus respuestas. Este nace en el
-- webhook `orders/paid`, sin sesión y sin formulario: colgarlo de la tabla de
-- la encuesta obligaría a crear filas de encuesta vacías para gente que nunca
-- la ha contestado, y a partir de ahí `answered` dejaría de significar nada.
--
-- ══ Se ejecuta ANTES de desplegar el código ══
--
-- Correrla sola es seguro: la tabla no la lee nadie todavía. Al revés NO: si el
-- código sale antes, el INSERT revienta contra una tabla que no existe y el
-- cupón no se emite, que es justo el pedido que el cliente ya ha pagado.
--
-- ══ La PK hace el trabajo de verdad ══
--
-- `customer_id` como PRIMARY KEY es la idempotencia. Quien compre un segundo
-- Discovery Set recibe EL MISMO código, porque la emisión lee esta fila antes
-- de crear nada. Sin la PK, una redelivery del webhook (o un segundo pedido)
-- emitiría un cupón nuevo cada vez.
--
-- El índice único sobre `discount_code` cubre lo otro: que `generateCode`
-- colisione y el mismo código se reparta a dos clientes. Es despreciable
-- (32^8) pero el coste de la red es cero y el de repartirlo dos veces no.
--
-- Verificación obligatoria contra PRODUCCIÓN:
--   select column_name, is_nullable from information_schema.columns
--    where table_name = 'discovery_set_coupons';
--     → 6 filas; solo `customer_id`, `order_id`, `discount_code`,
--       `discount_issued_at`, `discount_expires_at`, `created_at`
--   select indexname from pg_indexes where tablename = 'discovery_set_coupons';
--     → discovery_set_coupons_pkey + idx_discovery_coupons_code
--
-- Idempotente: `create table if not exists` + `create unique index if not exists`.

create table if not exists discovery_set_coupons (
  -- Id numérico de Shopify, sin el prefijo gid://, igual que el resto del
  -- esquema del portal.
  customer_id         text primary key,
  -- El pedido que lo originó. Sirve para reconciliar a mano y para saber si el
  -- cupón salió del primer Discovery Set o de uno posterior.
  order_id            text not null,
  discount_code       text not null,
  discount_issued_at  timestamptz not null default now(),
  discount_expires_at timestamptz not null,
  created_at          timestamptz not null default now()
);

-- Contra una colisión de generateCode: el mismo código no puede pertenecer a
-- dos clientes. `not null` en la columna, así que no hace falta el WHERE
-- parcial que sí lleva el índice del perfilado (allí el código puede ser NULL).
create unique index if not exists idx_discovery_coupons_code
  on discovery_set_coupons (discount_code);

-- RLS ON y CERO policies: esta tabla solo se toca con la service key desde el
-- webhook, que salta RLS. Sin esto, el anon key del proyecto podría leerla y
-- tendríamos la lista de cupones expuesta. Es el patrón de toda tabla nueva del
-- portal.
alter table discovery_set_coupons enable row level security;
