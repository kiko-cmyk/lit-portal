-- 2026-07-27: MEZCLA DE SABORES — caché de suscripciones multi-línea.
--
-- Una suscripción puede tener ahora una línea recurrente de Seal POR SABOR:
-- 3 cajas como 2× Salty Lemon + 1× Salty Watermelon, con precios por unidad que
-- reparten el total del tramo, así que el cliente paga lo mismo que un plan puro.
--
-- Estas columnas son SOLO CACHÉ para ops y crons. La fuente de verdad sigue siendo
-- Seal: la composición se deriva de los propios items (src/lib/seal.ts::getLines),
-- así que no hay dos fuentes que puedan desincronizarse.
--
-- Idempotente y aditiva: se puede aplicar antes de desplegar el código.

alter table subscriptions
  -- [{"flavor":"salty-lemon","boxes":2},{"flavor":"salty-watermelon","boxes":1}]
  -- Suma = box_count. NULL en filas escritas antes de esta migración.
  add column if not exists composition jsonb,
  -- 'packed' = una línea de variante pack, quantity 1 (lo que usa toda sub de un
  -- solo sabor: 1560 de 1571 activas, sin migrar y sin precio custom).
  -- 'split'  = una línea de variante de 1 caja por sabor.
  add column if not exists shape text not null default 'packed'
       check (shape in ('packed', 'split')),
  -- Nº de líneas recurrentes. Un valor > nº de sabores del catálogo es señal de
  -- líneas duplicadas por un swap fallido.
  add column if not exists line_count int not null default 1
       check (line_count between 1 and 12),
  -- Σ quantity × precio unitario, en céntimos. Se compara contra el precio del
  -- tramo para detectar que Seal ha tirado un precio custom.
  add column if not exists charge_total_cents int;

comment on column subscriptions.composition is
  'Cajas por sabor de las líneas recurrentes; suma box_count. NULL en filas previas a la migración: derivar de box_count + flavor.';
comment on column subscriptions.shape is
  'packed = una línea de pack (sub de un sabor). split = una línea por sabor con precio unitario repartido.';
comment on column subscriptions.charge_total_cents is
  'Σ quantity × precio unitario en céntimos. NO es total_value de Seal, que descuenta los cupones.';

-- El CHECK de box_count sigue siendo 1..6 A PROPÓSITO. getBoxCount aplica clamp y
-- avisa cuando la suma cruda se sale: una suma > 6 significa líneas duplicadas de un
-- swap fallido (hay 6 subs así, ver project_portal_duplicate_lines_incident) y
-- queremos que se detecte, no que la BD lo acepte en silencio.

-- El barrido de deriva de precios y la métrica diaria solo miran las mezcladas.
create index if not exists idx_subscriptions_split
  on subscriptions (shape) where shape = 'split';

-- RLS: `subscriptions` ya tiene RLS activado con CERO políticas (solo service_role).
-- Una columna nueva lo hereda. NO añadir política aquí: sería una regresión de
-- seguridad, no un requisito.
