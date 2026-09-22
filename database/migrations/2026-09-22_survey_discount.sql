-- 2026-09-22 — cupón de 5 € al terminar el formulario de perfilado.
--
-- Tres columnas en `profile_survey_answers`, la tabla que ya existe.
--
-- ══ Se ejecuta ANTES de desplegar el código ══
--
-- Es aditiva y las columnas son nullable, así que correrla sola es seguro en
-- cualquier momento: el código de hoy las ignora. Al revés NO: si el código
-- sale antes, el upsert del submit escribe `discount_code` sobre una columna
-- que no existe, la transacción entera revienta y el cliente pierde las nueve
-- respuestas después de contestarlas.
--
-- ══ La columna que hace el trabajo de verdad ══
--
-- `discount_code` es UNIQUE. Esa restricción es la red de seguridad contra el
-- doble submit y las dos pestañas: si dos peticiones simultáneas intentan
-- guardar dos códigos para el mismo cliente, la segunda choca contra el índice
-- y no llega a duplicar. La lógica de "ya tiene código, devuélvele el suyo"
-- vive en la ruta, pero esto es lo que la hace cierta bajo concurrencia.
--
-- Verificación obligatoria contra PRODUCCIÓN:
--   select column_name, is_nullable from information_schema.columns
--    where table_name = 'profile_survey_answers'
--      and column_name in ('discount_code','discount_issued_at','discount_expires_at');
--     → tres filas, las tres YES
--   select indexname from pg_indexes
--    where tablename = 'profile_survey_answers' and indexname like '%discount%';
--     → idx_profile_survey_discount_code
--
-- Idempotente: `add column if not exists` + `create unique index if not exists`.

alter table profile_survey_answers
  -- El código que se le enseñó al cliente. NULL = no le tocaba (tenía
  -- suscripción viva) o la llamada a Shopify falló. Los dos casos se
  -- distinguen mirando `answers`: si hay respuestas y el código es NULL con
  -- `discount_issued_at` también NULL, es que no le tocaba.
  add column if not exists discount_code        text,
  add column if not exists discount_issued_at   timestamptz,
  add column if not exists discount_expires_at  timestamptz;

-- UNIQUE y no PRIMARY: la fila ya tiene su pk en customer_id. Esto impide que
-- el mismo código se reparta dos veces, que sería peor que no emitirlo.
create unique index if not exists idx_profile_survey_discount_code
  on profile_survey_answers (discount_code)
  where discount_code is not null;
