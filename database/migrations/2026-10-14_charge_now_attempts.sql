-- 2026-10-14 — Rescate de los «Adelantar» que la tarjeta rechaza después de que
-- Seal acepte el cobro. Diseño en lib/charge-now-recovery.ts.
--
-- ══ Se ejecuta ANTES de desplegar el código ══
--
-- Aditiva e idempotente: una tabla nueva y sus índices. El código viejo no la
-- lee. Al revés no rompe el Adelantar (charge-now escribe la fila en modo
-- best-effort y sigue si falla), pero sin la tabla no hay rescate.
--
-- ══ Por qué hace falta guardar algo ══
--
-- Seal aplica reset_schedule en cuanto acepta el cobro y NO lo deshace si la
-- pasarela lo rechaza segundos después, y para un cobro manual NO manda el
-- webhook billing_attempt/failed. Sin esta fila no sabríamos ni qué fecha tenía
-- el cliente antes de adelantar ni que ese cobro lo lanzó el portal (los «cobrar
-- ya» de soporte desde el admin de Seal no se tocan).
--
-- ══ Estados ══
--   requested        charge-now la escribió antes de llamar a Seal
--   handling         un proceso la ha reclamado y está rescatando
--   retry_scheduled  rechazo normal: el cobro pasa a mañana
--   date_restored    antifraude: vuelve la fecha de antes de adelantar
--   succeeded        el cobro pasó (lo marca el cron)
--   superseded       hubo otro Adelantar o un cobro bueno después: no se toca
--   not_active       la sub ya no está activa cuando se iba a rescatar
--   unhandled        no se pudo mover el calendario: aviso en Slack, a mano
--   sync_failed      Seal lo rechazó en la misma llamada: lo arregla charge-now
--   expired          72 h sin resolverse

create table if not exists public.charge_now_attempts (
  id                    bigserial primary key,
  seal_subscription_id  text        not null,
  customer_id           text        not null,
  pre_charge_date       date,
  requested_at          timestamptz not null default now(),
  status                text        not null default 'requested'
    check (status in ('requested','handling','retry_scheduled','date_restored','succeeded',
                      'superseded','not_active','unhandled','sync_failed','expired')),
  -- El intento de Seal que falló. Único: dos filas no pueden reclamar el mismo.
  failed_attempt_id     text unique,
  error_code            text,
  retry_date            date,
  handled_at            timestamptz,
  note                  text
);

create index if not exists charge_now_attempts_sub_requested_idx
  on public.charge_now_attempts (seal_subscription_id, requested_at desc);

-- El cron solo lee las abiertas.
create index if not exists charge_now_attempts_open_idx
  on public.charge_now_attempts (requested_at) where status = 'requested';

-- RLS activado y SIN policies: solo la service role (las rutas del portal).
alter table public.charge_now_attempts enable row level security;

-- ══ Verificación (debe devolver 1 fila con rls = true y 0 policies) ══
-- select c.relname, c.relrowsecurity as rls,
--        (select count(*) from pg_policies p where p.tablename = c.relname) as policies
--   from pg_class c where c.relname = 'charge_now_attempts';
-- select indexname from pg_indexes where tablename = 'charge_now_attempts';
