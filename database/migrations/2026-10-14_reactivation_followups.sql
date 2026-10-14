-- 2026-10-14 — Lo que pasa DESPUÉS de reactivar o reanudar desde el portal.
-- Diseño en lib/reactivation.ts.
--
-- ══ Se ejecuta ANTES de desplegar el código ══
--
-- Aditiva e idempotente: una tabla nueva. Sin ella el código sigue funcionando
-- (las rutas avisan al momento si no pueden apuntar), pero sin el cobro a
-- mañana de quien vuelve tras un impago.
--
-- ══ Por qué ══
--
-- Seal regenera el calendario 27-170 s después de reactivar o reanudar (medido
-- en 6 reactivaciones del portal), anclado en el último intento de cobro. Dos
-- cosas esperan a ese calendario: el cobro a MAÑANA de quien vuelve tras un
-- impago (si no, la caja que no se cobró llegaría un ciclo más tarde) y el aviso
-- a Klaviyo con la fecha de la próxima caja ya buena. Una fila por sub.
--
-- ══ Estados ══
--   pending   apuntado; esperando a que Seal regenere
--   handling  un proceso lo está aplicando
--   done      aplicado y avisado
--   failed    no se pudo mover el cobro (aviso en Slack); el aviso sí salió
--   expired   72 h sin que Seal regenerara o sin que la sub estuviera activa

create table if not exists public.reactivation_followups (
  seal_subscription_id  text        primary key,
  customer_id           text        not null,
  kind                  text        not null check (kind in ('portal','unpaid','support','resume')),
  -- Solo impago: el día al que traer el siguiente cobro (mañana al reactivar).
  pull_to               date,
  -- Lo que el aviso necesita y no está en Seal (dropsRestored, pausedOn).
  extra                 jsonb       not null default '{}'::jsonb,
  status                text        not null default 'pending'
    check (status in ('pending','handling','done','failed','expired')),
  created_at            timestamptz not null default now(),
  handled_at            timestamptz,
  note                  text
);

-- El cron solo lee las pendientes.
create index if not exists reactivation_followups_pending_idx
  on public.reactivation_followups (created_at) where status = 'pending';

-- RLS activado y SIN policies: solo la service role (las rutas del portal).
alter table public.reactivation_followups enable row level security;

-- ══ Verificación (debe devolver 1 fila con rls = true y 0 policies) ══
-- select c.relname, c.relrowsecurity as rls,
--        (select count(*) from pg_policies p where p.tablename = c.relname) as policies
--   from pg_class c where c.relname = 'reactivation_followups';
