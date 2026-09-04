-- 2026-09-03: el importe que un contrato tiene DERECHO a pagar.
--
-- POR QUÉ EXISTE
-- Desde hoy, un contrato de la escalera vieja que cambia de sabor conserva su precio
-- (ver planPreservingCharge en src/lib/mix.ts). Eso deja ~533 suscripciones con un
-- precio CUSTOM escrito sobre las variantes CANÓNICAS del modelo nuevo (W30 a 22,64
-- en vez de 28,35, PACK4 a 83,16 en vez de 85,05).
--
-- Y ahí se pierde una señal. Hasta hoy un contrato viejo se reconocía por su VARIANTE
-- (SL90, SL180...): si Seal pisaba su precio, el line-set seguía delatándolo. Una vez
-- preservado, el line-set es idéntico al de una sub nueva legítima, así que si Seal
-- reseteara una línea al precio de catálogo la sub aterrizaría EXACTAMENTE en la
-- escalera web y ningún detector lo vería: ni assertMixPrice (que compara contra la
-- escalera), ni audit-ladder-drift.ts (que lo clasificaría ALINEADA), ni la
-- verificación de la ruta. El cliente pagaría +17,12 y no saltaría nada.
--
-- La limitación ya estaba documentada en assertMixPrice para los splits viejos; lo
-- que cambia es la escala: de un puñado de splits a los 533 contratos.
--
-- Por eso el importe preservado se guarda como INTENCIÓN, separado de
-- charge_total_cents, que es OBSERVACIÓN (lo que Seal dice que cobra hoy, y que un
-- reseteo de Seal actualizaría tan campante). Con la intención guardada, el cron y la
-- auditoría pueden comparar contra lo que el contrato debería pagar en vez de contra
-- la escalera, que es la única forma de distinguir un precio preservado legítimo de
-- una corrupción de Seal.
--
-- NULL = sin precio preservado: la sub paga catálogo y la escalera sigue siendo su
-- referencia. Se limpia (a NULL) en cuanto el cliente cambia de nº de cajas, porque
-- ahí compra otra cantidad y el catálogo pasa a ser su precio legítimo.

alter table subscriptions
  -- Σ quantity × precio unitario que este contrato debe pagar por entrega, en
  -- céntimos, cuando se le ha conservado un precio por debajo del catálogo.
  add column if not exists preserved_charge_cents int
       check (preserved_charge_cents is null or preserved_charge_cents > 0),
  -- LAS CAJAS A LAS QUE CORRESPONDE ESE IMPORTE. Sin esto la columna dice "tiene
  -- derecho a pagar 67,92" sin decir POR CUÁNTAS CAJAS, y la regla que decide si se
  -- preserva es justamente el nº de cajas: dato y regla desacoplados. Un importe de 3
  -- cajas sobre una sub que hoy tiene 4 hace que el cron vea sobre-cobro (85,05 > 67,92)
  -- y "cure" a la baja, regalando 17,13 por entrega sobre un contrato legítimo.
  -- Se llega ahí por tres caminos nada raros: que le cambien las cajas fuera del portal
  -- (Seal admin, CS, portal de Seal — el webhook actualiza box_count sin tocar esta
  -- columna), un 502 de verificación parcial que sale antes del clear, o que falle el
  -- write best-effort que la limpia. OJO A LA ASIMETRÍA: fallar al ESCRIBIR la
  -- preservación es inocuo (la sub se queda a catálogo), pero fallar al LIMPIARLA deja
  -- una entitlement fantasma que el cron ejecuta. (Aviso de Kiko, 2026-09-03.)
  add column if not exists preserved_box_count int
       check (preserved_box_count is null or preserved_box_count between 1 and 6);

comment on column subscriptions.preserved_box_count is
  'Nº de cajas al que corresponde preserved_charge_cents. El importe preservado SOLO es válido si las cajas vivas coinciden con este número: cualquier cambio de cajas fuera de banda deja la preservación inerte en vez de convertirla en un descuento que nadie autorizó.';

comment on column subscriptions.preserved_charge_cents is
  'INTENCIÓN: el importe que este contrato tiene derecho a pagar por entrega tras conservarle el precio de la escalera vieja al cambiar de sabor. NULL = paga catálogo. Distinto de charge_total_cents, que es la OBSERVACIÓN de lo que Seal cobra y que un reseteo de precio de Seal actualizaría sin avisar.';

-- RLS: `subscriptions` ya tiene row level security activada (database/schema.sql:463)
-- con 0 políticas, o sea acceso solo con service role. Esta columna hereda esa
-- postura y no necesita política nueva; se deja dicho porque es un dato de dinero por
-- cliente y la regla del proyecto es que toda migración se pronuncie sobre RLS.
-- Verificar tras aplicar:
--   select relrowsecurity from pg_class where relname = 'subscriptions';  -- t
--   select count(*) from pg_policies where tablename = 'subscriptions';   -- 0
