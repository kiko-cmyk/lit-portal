-- 2026-09-23 — congelar si era suscriptor EN EL MOMENTO de contestar.
--
-- Una columna nueva en `profile_survey_answers`.
--
-- ══ Por qué hace falta guardarlo ══
--
-- `hadLiveSubscription` ya se calcula en la ruta del submit y se manda a
-- Klaviyo como `has_active_subscription`, pero NO se guardaba en ningún sitio
-- nuestro. Eso deja la pregunta de negocio sin responder: "¿era suscriptor
-- cuando contestó?" sólo se podía sacar rebuscando en los eventos de Klaviyo,
-- que caducan, que no se pueden cruzar por customer_id sin parsear el
-- `$event_id`, y que obligan a pasear una métrica saturada por los envíos
-- masivos.
--
-- El tag de Shopify NO sirve para esto: `seal_active_subscriber` dice lo que el
-- cliente es HOY. El 23-sep, tres personas que contestaron siendo one-shot se
-- suscribieron con el cupón ese mismo día, así que la foto de hoy las muestra
-- como suscriptoras y hace ilegible el dato que de verdad importa (a quién le
-- tocaba cupón, y quién se convirtió DESPUÉS).
--
-- ══ Se ejecuta ANTES de desplegar el código ══
--
-- Aditiva y nullable, así que correrla sola es segura: el código de hoy la
-- ignora. Al revés NO: si el código sale primero, el upsert del submit escribe
-- sobre una columna inexistente, la transacción entera revienta y el cliente
-- pierde las nueve respuestas después de contestarlas. Es la misma lección de
-- la migración del cupón del 22-sep.
--
-- ══ Por qué nullable y sin DEFAULT ══
--
-- NULL significa "no se registró", que es la verdad para las 70 filas
-- anteriores a este despliegue. Un `default false` las marcaría a todas como
-- "no era suscriptor", que es una afirmación falsa para las 16 que sí lo eran:
-- convertiría un dato ausente en un dato incorrecto, y encima silenciosamente.
-- El backfill se hace aparte, desde los eventos de Klaviyo, y sólo donde se
-- puede demostrar.
--
-- Verificación obligatoria contra PRODUCCIÓN:
--   select column_name, data_type, is_nullable from information_schema.columns
--    where table_name = 'profile_survey_answers'
--      and column_name = 'was_subscriber_at_answer';
--     → una fila, boolean, YES
--
-- Idempotente: `add column if not exists`.

alter table profile_survey_answers
  add column if not exists was_subscriber_at_answer boolean;

comment on column profile_survey_answers.was_subscriber_at_answer is
  'Si el cliente tenia suscripcion viva (active/paused/reactivating) en el INSTANTE de contestar. Congelado a proposito: el tag de Shopify dice lo que es hoy, esto dice lo que era. NULL = respuestas anteriores al 2026-09-23, no registrado.';
