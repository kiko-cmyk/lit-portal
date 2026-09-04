-- 2026-09-04: cerrojo real para el cambio de plan.
--
-- POR QUÉ EXISTE
-- `/api/subscription/plan` encadena hasta tres mutaciones en Seal (edit_items,
-- add_items, remove_items). Su única protección frente a dos peticiones a la vez era
-- `expectedLineIds`: se lee el estado vivo, se compara con el que vio el cliente y se
-- sigue si coinciden. Eso es una comprobación OPTIMISTA, no un cerrojo, y tiene la
-- carrera clásica de leer y luego escribir: dos peticiones simultáneas leen el MISMO
-- estado, las dos lo encuentran igual al esperado, las dos pasan, y las dos ejecutan
-- `add_items` sobre las mismas variantes. La suscripción acaba con las líneas
-- duplicadas y cobrando de más, que es justo el daño del incidente del 4-sep, solo
-- que entrando por otra puerta.
--
-- No es teórico: basta un doble clic en "Guardar plan", un reintento del navegador o
-- dos pestañas abiertas. El rate limit no lo cubre (10 por minuto deja pasar dos
-- simultáneas de sobra).
--
-- POR QUÉ UNA TABLA Y NO UN ADVISORY LOCK
-- El primer diseño fue `pg_try_advisory_lock`, que es lo natural para esto. No sirve
-- aquí: la ruta habla con la base por PostgREST (`supabaseAdmin`), y cada llamada RPC
-- sale por una conexión distinta del pooler, así que un lock de SESIÓN se tomaría en
-- una conexión y el unlock iría a otra. Un lock de transacción tampoco, porque la
-- sección crítica abarca varias llamadas HTTP a Seal, no una transacción.
--
-- Así que el cerrojo es una FILA con clave primaria: el insert lo gana uno solo, el
-- otro choca con la PK y se va con un 409. Es atómico en Postgres y no depende de qué
-- conexión toque.
--
-- EL PELIGRO DE UN CERROJO ASÍ es quedarse colgado: si la invocación muere a mitad
-- (el modo de fallo del 4-sep), la fila se queda y el cliente no puede volver a tocar
-- su plan nunca más. Por eso lleva `expires_at`: el lock es válido solo mientras no
-- ha caducado, y quien llega después de la caducidad lo reclama. Se dimensiona sobre
-- el presupuesto de la ruta (9,5s) más el margen de la compensación que corre fuera
-- de él, no sobre el `maxDuration`.

create table if not exists plan_change_locks (
  -- (cliente, suscripción): dos subs del mismo cliente pueden cambiarse a la vez, dos
  -- peticiones sobre la MISMA sub no.
  customer_id           text not null,
  seal_subscription_id  text not null,
  acquired_at           timestamptz not null default now(),
  -- Pasada esta hora el cerrojo está muerto y otra petición puede reclamarlo. Es lo
  -- que impide que una invocación que se murió deje al cliente bloqueado.
  expires_at            timestamptz not null,
  -- Solo para depurar: qué petición lo tiene.
  holder                text,
  primary key (customer_id, seal_subscription_id)
);

-- Toma el cerrojo, o lo reclama si el anterior ya caducó. TRUE = lo tienes.
--
-- Todo en una sentencia a propósito: el `insert ... on conflict ... where` es atómico,
-- así que dos peticiones simultáneas no pueden ganarlo las dos. Hacerlo como
-- "select y luego insert" desde la aplicación reintroduciría exactamente la carrera
-- que este cerrojo existe para cerrar.
create or replace function plan_change_try_lock(
  p_customer_id text,
  p_subscription_id text,
  p_ttl_seconds int,
  p_holder text default null
)
returns boolean
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  insert into plan_change_locks (customer_id, seal_subscription_id, acquired_at, expires_at, holder)
  values (p_customer_id, p_subscription_id, now(), now() + make_interval(secs => p_ttl_seconds), p_holder)
  on conflict (customer_id, seal_subscription_id) do update
     set acquired_at = now(),
         expires_at  = now() + make_interval(secs => p_ttl_seconds),
         holder      = p_holder
   -- La condición ES el cerrojo: solo se pisa una fila YA CADUCADA.
   where plan_change_locks.expires_at <= now()
  returning true;
$$;

-- Lo suelta. Idempotente: soltar uno que ya no está no rompe nada.
create or replace function plan_change_unlock(
  p_customer_id text,
  p_subscription_id text
)
returns void
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  delete from plan_change_locks
   where customer_id = p_customer_id
     and seal_subscription_id = p_subscription_id;
$$;

-- REGLA DEL PROYECTO: toda tabla nueva activa RLS. El service role la salta, y hay
-- CERO políticas a propósito, así que ninguna clave de navegador puede leerla ni
-- tocarla. Mismo patrón que subscription_line_repairs y retention_discounts.
alter table plan_change_locks enable row level security;

revoke all on function plan_change_try_lock(text, text, int, text) from public, anon, authenticated;
revoke all on function plan_change_unlock(text, text) from public, anon, authenticated;
grant execute on function plan_change_try_lock(text, text, int, text) to service_role;
grant execute on function plan_change_unlock(text, text) to service_role;

comment on table plan_change_locks is
  'Cerrojo por (customer_id, seal_subscription_id) que serializa los cambios de plan. Con expires_at para que una invocación muerta no deje al cliente bloqueado: pasada esa hora, la siguiente petición lo reclama.';
