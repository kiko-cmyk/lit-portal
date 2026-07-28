-- 2026-07-28: permitir change_type = 'mix' en la tabla de auditoría.
--
-- `subscription_changes` existe desde el principio y NO tiene ni un escritor en `src/`.
-- Al investigar el incidente de las líneas duplicadas se echó de menos exactamente esto:
-- no había ningún registro propio de qué cambio pidió cada cliente ni cuándo, y hubo que
-- reconstruirlo desde el campo `log` de Seal.
--
-- El camino de la mezcla empieza a escribir aquí. Además de trazabilidad para soporte,
-- es lo que permite que un rollback distinga las mezclas que creó EL PORTAL de las que
-- el cliente compró en el checkout (que no hay que deshacer: es lo que pidió).

alter table subscription_changes drop constraint if exists subscription_changes_change_type_check;
alter table subscription_changes add constraint subscription_changes_change_type_check
  check (change_type in ('plan', 'flavor', 'address', 'skip', 'skip_undo', 'extras', 'mix'));

-- El rollback y soporte buscan por suscripción, que vive dentro del payload.
create index if not exists idx_subscription_changes_seal_sub
  on subscription_changes ((payload->>'sealSubscriptionId'));

create index if not exists idx_subscription_changes_type_time
  on subscription_changes (change_type, applied_at desc);
