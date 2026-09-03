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
       check (preserved_charge_cents is null or preserved_charge_cents > 0);

comment on column subscriptions.preserved_charge_cents is
  'INTENCIÓN: el importe que este contrato tiene derecho a pagar por entrega tras conservarle el precio de la escalera vieja al cambiar de sabor. NULL = paga catálogo. Distinto de charge_total_cents, que es la OBSERVACIÓN de lo que Seal cobra y que un reseteo de precio de Seal actualizaría sin avisar.';
