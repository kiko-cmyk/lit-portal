-- 2026-11-10 — Intención de re-anclaje EXACTA para los cambios de «Tu plan».
-- Diseño en lib/frequency-core.ts (`planChangeTargetDate`, `reanchorNeedsPullBack`).
--
-- ══ Se ejecuta ANTES de desplegar el código ══
--
-- Aditiva e idempotente: una columna con valor por defecto. Las filas que ya hay quedan
-- con `exact = false`, que es el comportamiento de hoy (la fecha es un suelo). El código
-- nuevo la LEE (webhook de Seal, reanchor-drain, hub/dashboard) y la ESCRIBE en cada
-- intención: sin la columna, esas lecturas y escrituras fallan.
--
-- ══ Por qué ══
--
-- Al cambiar la frecuencia desde «Tu plan», la próxima entrega tiene que quedar en
-- max(la que tenía el cliente, ancla + frecuencia nueva), y Seal tiene que acabar
-- EXACTAMENTE ahí. Hoy la intención es solo un suelo: al acortar, si `ancla + frecuencia
-- nueva` ya ha pasado, Seal salta un ciclo entero y el re-anclaje lo da por bueno (sub
-- 16140086: 2 meses → 45 días, tenía el 15-nov, Seal la dejó el 14-dic). Con `exact` el
-- re-anclaje también tira hacia atrás (`seal.pullCadenceBackTo`). Las intenciones de
-- `fromNext` (pantalla de saltar, CancelTakeover, encuesta, bot) siguen siendo un suelo.

alter table public.subscription_reanchor_intents
  add column if not exists exact boolean not null default false;
