-- 2026-07-28: reconciliación asíncrona de líneas de suscripción.
--
-- POR QUÉ EXISTE (incidente real, ver scripts/repair-duplicate-lines.mjs):
-- /api/subscription/plan converge las líneas con edit_items -> add_items ->
-- remove_items. Si el `remove_items` falla y tampoco se puede restaurar el estado
-- previo, la suscripción queda con la línea vieja Y la nueva, y **el próximo cobro es
-- de MÁS**. Eso le pasó a 7 suscripciones entre junio y julio de 2026 y nadie se
-- enteró hasta que se auditó el libro entero.
--
-- La ruta escribe aquí el estado final deseado y /api/cron/mix-repair-drain lo
-- reconcilia. Es idempotente: si el estado vivo ya coincide, no hace nada.
--
-- Modelado sobre subscription_reanchor_intents (2026-06-12): PK compuesta, contador
-- de intentos y TTL, y un intent que no converge se marca `failed` y se loguea, nunca
-- se borra en silencio.

create table if not exists subscription_line_repairs (
  customer_id           text not null,
  seal_subscription_id  text not null,
  -- TargetLine[]: las líneas que la suscripción DEBE acabar teniendo.
  desired               jsonb not null,
  -- Las líneas que tenía antes de la mutación, para restaurar a mano si hace falta.
  snapshot              jsonb not null,
  status                text not null default 'pending'
                          check (status in ('pending', 'done', 'failed')),
  attempts              int  not null default 0,
  last_error            text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  primary key (customer_id, seal_subscription_id)
);

-- El cron solo busca pendientes.
create index if not exists idx_line_repairs_pending
  on subscription_line_repairs (updated_at) where status = 'pending';

-- REGLA DEL PROYECTO: toda tabla nueva activa RLS. El service role la salta, y hay
-- CERO políticas a propósito, así que las claves anon/authenticated no pueden leerla
-- ni tocarla. Mismo patrón que retention_discounts y subscription_reanchor_intents.
alter table subscription_line_repairs enable row level security;
