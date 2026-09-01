-- 2026-09-02 — formulario de perfilado del área personal ("Conoce a tus clientes").
--
-- Dos bloques: la acción nueva de drops, y la tabla donde viven las respuestas.
--
-- ══ ORDER MATTERS: esto se ejecuta en Supabase ANTES de mergear el código ══
--
-- El bloque 1 amplía un conjunto permitido, así que correrlo solo es seguro en
-- cualquier momento (no cambia ningún comportamiento actual). Al revés NO lo es,
-- y es el fallo más caro de todo el proyecto: si el código sale y el CHECK aún
-- no acepta 'profile_survey', el INSERT de los 50 drops revienta la constraint
-- DESPUÉS de que el cliente haya contestado nueve preguntas. Y como el guardado
-- y el pago van en la misma transacción, revienta la transacción entera: se
-- pierde también la respuesta. El cliente ve un error después de molestarse, y
-- no vuelve.
--
-- ══ Y OJO CON CREER QUE YA ESTÁ HECHO ══
--
-- Hay tres formas de creer que has migrado sin que llegue a producción:
--   1. `npm run migrate` ejecuta SOLO database/schema.sql (scripts/migrate.ts),
--      no esta carpeta. Imprime "Schema applied successfully" igualmente.
--   2. El CHECK de drops_events vive INLINE en un `create table if not exists`
--      (schema.sql), así que editarlo ahí en una base que ya existe es un no-op.
--   3. Los ficheros de esta carpeta se pegan A MANO en el SQL Editor. No hay
--      runner, ni tabla de migraciones aplicadas, ni numeración.
--
-- Verificación obligatoria contra PRODUCCIÓN, y nada se despliega sin esto:
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--    where conrelid = 'drops_events'::regclass and contype = 'c';
--     → la definición tiene que contener 'profile_survey'
--   select to_regclass('public.profile_survey_answers');   → no nulo
--
-- Idempotente y aditiva: drop + re-add de la constraint con nombre, y
-- `create table if not exists`. Se puede correr dos veces sin daño.

-- ── 1. La acción nueva de drops ──────────────────────────────────────────────
-- El nombre auto-generado por Postgres para un CHECK inline sobre una columna es
-- <tabla>_<columna>_check (misma convención que cancellations_primary_reason_check
-- en la migración del 2026-07-03). Si tu base lo nombró de otra forma, míralo con
-- la primera select de arriba y ajusta el drop.
alter table drops_events drop constraint if exists drops_events_action_check;
alter table drops_events add constraint drops_events_action_check
  check (action in (
    'box_shipped','referral_converted','monthly_streak',
    'product_review','social_share','whatsapp_optin',
    'event_checkin','reward_claim','cancel_reset','manual_adjustment',
    'profile_survey'
  ));

-- ── 2. Las respuestas ────────────────────────────────────────────────────────
-- Una fila por cliente. Las respuestas van en jsonb y SIN CHECK sobre los
-- valores a propósito: la lista de opciones vive en src/lib/profile-questions.ts
-- y la valida el servidor contra ese mismo módulo. Un CHECK aquí sería un tercer
-- sitio que sincronizar, y es exactamente el bug que documenta
-- api/subscription/cancel/route.ts (el valor tenía que existir en el componente,
-- en el Set del servidor y en el CHECK, y faltaba en dos).
create table if not exists profile_survey_answers (
  customer_id        text primary key,
  -- { "situacion": "Bien", "uso": "Deporte", ... } con los valores canónicos.
  answers            jsonb       not null default '{}'::jsonb,
  -- Consentimiento para personalizar. Si es false las respuestas se guardan
  -- igual (estadística agregada) pero NO se escriben las cs_* en Klaviyo.
  consent            boolean     not null default false,
  consent_at         timestamptz,
  -- Versión del texto que aceptó, para poder demostrar QUÉ aceptó. El texto
  -- vive en un módulo versionado, no dentro del JSX: con la copia inline,
  -- editar la frase reescribe en silencio lo que la gente ya había aceptado.
  consent_version    int,
  -- Idioma en el que lo vio. Necesario para leer las respuestas de "Otro" y
  -- para auditar el consentimiento.
  locale_shown       text        not null default 'es',
  -- Marca de agua del sync a Klaviyo. NULL = pendiente de empujar. La ruta de
  -- submit NO habla con Klaviyo (upsertProfile no tiene ni un call site en el
  -- repo, y klaviyo.ts no pasa signal a fetch, así que un socket colgado se
  -- comería el maxDuration entero y moriría en silencio). Lo empuja un cron.
  klaviyo_synced_at  timestamptz,
  -- Se pone a NULL en CADA edición. Sin eso, corregir una respuesta ya
  -- sincronizada la dejaría congelada en Klaviyo con el valor viejo: es el bug
  -- LIT-397 del CS Platform, y aquí nace cerrado.
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists idx_profile_survey_unsynced
  on profile_survey_answers (updated_at)
  where klaviyo_synced_at is null;

-- RLS habilitada SIN políticas: todo el acceso va por el cliente service-role
-- desde las rutas de API, que la salta. No hay cliente anon en el navegador
-- (src/lib/supabase.ts). Misma convención que rate_buckets y que el resto de
-- schema.sql.
alter table profile_survey_answers enable row level security;
