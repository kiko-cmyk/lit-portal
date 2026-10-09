# Referidos «Trae a alguien», fase 0

**El programa en una frase:** cada suscriptor activo tiene un código personal (`MARIA27`). Su amigo lo escribe en el checkout y tiene 10 € en su primer pedido de cajas, con suscripción o en compra única. Quien invita tiene 10 € menos en su siguiente cobro.

**Lo que manda en el diseño:** en Seal, un código aplicado a una suscripción se repite en cada cobro hasta que se quita, y aplicar dos veces duplica el descuento. Por eso el premio de quien invita sigue estas reglas:

- lo aplica un único sitio (el cron, cada 4 h), entre 1 y 48 h antes del cobro, con el cerrojo del cambio de plan de esa sub tomado ANTES de reclamar la recompensa (120 s, más que la vida de la función);
- nunca antes de 48 h desde el pago del amigo (carencia);
- se da por consumido solo con el pedido de renovación que lleva el código delante;
- se retira en cuanto se consume;
- si una pasada muere a mitad, `apply_sent_at` dice si la orden llegó a salir.

Cualquier alerta de dinero lleva el id de la recompensa en su código de Slack.

## Piezas

| Fichero | Qué hace |
|---|---|
| `database/migrations/2026-10-10_referrals_fase0.sql` | Columnas de estado en `referral_codes` y `referral_conversions`, tabla `referral_rewards`, índice «una recompensa viva por sub» |
| `src/lib/referral-core.ts` | Lógica pura: códigos, normalizadores, reglas de cualificación y de recompensa |
| `src/lib/referral-shopify.ts` | Descuento padre, alta de códigos en bloque, descuentos `LITREF`, lectura de pedidos y clientes |
| `src/lib/referral-reward.ts` | Orquestación: registrar, cualificar, emitir, aplicar, consumir, retirar, revocar |
| `src/app/api/webhooks/shopify/route.ts` | `orders/paid`: registra la conversión y, en `after()`, cualifica |
| `src/app/api/webhooks/seal/route.ts` | Consume premios tras un cobro (nunca aplica) |
| `src/app/api/subscription/plan/route.ts` | Retira el premio (y cualquier `LITREF` suelto) antes de un alta y baja de líneas. Si no puede, 409 `referral_reward_busy` sin tocar nada |
| `src/app/api/cron/referral-sweep/route.ts` | Cron cada 4 h (minuto 50): aplica, consume y retira premios, cualifica pendientes y emite códigos |
| `src/app/api/referral/code/route.ts` | La tarjeta de Mi LIT (solo lee) |
| `src/app/api/referral/track/route.ts` | «Ha compartido» (solo el canal, para el KPI) |
| `src/components/ReferralCard.tsx` | Tarjeta «TRAE A ALGUIEN» en Mi LIT |
| `scripts/referral-*.ts` | Preflight, descuento padre, backfill de códigos, operación a mano |
| `scripts/test-referral-*.ts` | Tests (dentro de `npm test`) |

De paso, `src/lib/retention-discount.ts` arregla la fuga de LITSTAY15: ahora retira todas las copias del código, no solo la primera.

## Variables de entorno (Vercel, Production)

| Variable | Valor al empezar | Nota |
|---|---|---|
| `REFERRALS` | `off` | `off` \| `allowlist` \| `on`: tarjeta y alta de códigos |
| `REFERRALS_ALLOWLIST` | ids del equipo | separados por comas |
| `REFERRAL_REWARDS` | `off` | Solo aplicar en Seal. Apagado, las recompensas esperan en cola |
| `REFERRAL_REWARDS_ALLOWLIST` | ids del equipo | |
| `REFERRAL_FRIEND_DISCOUNT_ID` | gid del padre | Lo imprime `scripts/referral-create-parent-discount.ts` |
| `REFERRAL_FINGERPRINT_SECRET` | aleatorio largo | Huellas del antifraude. No rotar |
| `REFERRAL_TERMS_URL` | URL de las condiciones | Enlace de la tarjeta |

Tras cambiar cualquiera, hay que hacer **Redeploy**: Vercel no aplica cambios de variables a despliegues existentes.

## Lanzamiento (cada paso que escribe en producción, con OK explícito)

0. **Comprobaciones previas:**
   - `npx tsx scripts/referral-preflight.ts --seal`.
   - En el admin de Seal, comprobar que el portal de cliente **no** deja meter códigos de descuento.
   - Página de condiciones creada en Shopify.
   - Flow de Klaviyo en borrador.
1. Variables con todo en `off`.
2. Migración en el SQL Editor de Supabase, con sus consultas de verificación (cabecera del fichero).
3. `npx tsx scripts/referral-create-parent-discount.ts --apply` → `REFERRAL_FRIEND_DISCOUNT_ID` → Redeploy.
4. Desplegar el PR, con todo apagado.
5. **Lado del amigo, con el equipo:**
   - `REFERRALS=allowlist`.
   - `npx tsx scripts/referral-backfill-codes.ts --reserve --only=<ids>` y después `--issue --only=<ids>`.
   - E2E 1, 2 y 7.
6. **Lado de quien invita:** `REFERRAL_REWARDS=allowlist` y E2E 3 a 6 y 8.
7. **Backfill completo:** `--reserve` y después `--issue` (sigue en bucle hasta que no queda ningún `pending`). Comprobar que el preflight da `códigos colgados` igual a las filas `active`. Va ANTES del paso 8: el cron emite como mucho 40 códigos por pasada, y sin el backfill la tarjeta diría «estará listo en unas horas» a casi todo el mundo durante días.
8. `REFERRALS=on`, `REFERRAL_REWARDS=on` y Redeploy. Campaña de lanzamiento al segmento «`referral_code` is set».

## E2E (Seal solo se toca en subs del equipo)

1. **Código:** con la cuenta de Juan en la allowlist, abrir Mi LIT.
   - La tarjeta enseña el código.
   - `codeDiscountNodeByCode` lo encuentra.
   - La fila queda `active`.
   - El perfil de Klaviyo tiene `referral_code`.
2. **Compras del amigo:** dos compras de prueba, cada una con email y dirección nuevos, escribiendo el código en el checkout. Una de suscripción (18,35 €) y otra de compra única (27,80 €). Para cada una, comprobar:
   - la conversión queda `qualified`;
   - la recompensa queda `queued`;
   - `referral_friend_joined` llega sin datos del amigo.
   - Casos negativos: usar el propio código da `self_referral`; repetir el webhook deja una sola conversión.
   - Un uso por cliente en todo el programa: con el email de una de las compras, meter en el checkout el código de OTRA persona del equipo. Shopify tiene que rechazarlo, sin llegar a pagar.
3. **Aplicación:** sobre la sub 14692586 (creada a mano), pasada a 2 líneas y con el intento llevado a la ventana. Correr `GET /api/cron/referral-sweep?only_sub=14692586` con `CRON_SECRET`. Comprobar:
   - el código aparece en las líneas;
   - `total_value` baja 10 € (no 20);
   - quedan guardados los UUID.
4. **Cambio de sabor:** cambiar el sabor desde el portal. El código se retira, la recompensa vuelve a la cola y el cron la repone.
5. **Borrado en Shopify:** con un `LITREF-PROBE` desechable, aplicarlo, borrarlo en Shopify y releer Seal (¿sigue descontando?). Después, retirarlo.
6. **Cobro real** en una sub real del equipo, en su cobro natural (o con charge-now si se autoriza). Comprobar:
   - el pedido lleva un descuento manual de 10,00;
   - la recompensa queda `consumed`;
   - el código ya no está en Seal y el descuento está borrado en Shopify.
7. **Revocación:** cancelar y reembolsar un pedido de prueba deja la recompensa `revoked`.
8. **Dry-run y limpieza:**
   - `?dry_run=1` del cron devuelve decisiones sin escribir nada;
   - devolver 14692586 a una línea;
   - cancelar las subs de prueba.

**Ojo:** un `orders/paid` simulado vuelve a disparar `confirmation_sent`. Usarlo solo con pedidos del equipo.

## Vigilancia (las 2 primeras semanas)

- Resumen del cron en Slack («Referidos: pasada del cron»). Solo sale cuando pasa algo, no en las pasadas tranquilas.
- `npx tsx scripts/referral-admin.ts status`. Cuadre: aplicadas = consumidas + vivas + revocadas.
- `npx tsx scripts/referral-admin.ts review` para lo que espera a una persona. Después, `approve <id> --apply` o `reject <id> <motivo> --apply`.
- **Recompensas `failed`:** cada pasada les quita el código si aún se ve en Seal, y avisa. Si después de mirarlo le correspondía, `requeue <rewardId> --apply`.
  - Si el motivo dice que el código pudo quedarse puesto sin verse (`not_visible…`, `…stuck…`, `…ambiguous`, `…unknown…`), primero se mira en Seal y después se añade `--force`.
  - Una fallida que ya se cobró no se reencola: `requeue` la cierra como consumida.
  - `friend_order_missing`: Shopify no encuentra el pedido del amigo. Si se borró tras cancelarlo, no le corresponde; si existe, se reencola.
- **En el resumen, `deadline_left` o `apply_deferred_time`:** la pasada no da abasto. Hay que mirarlo antes de que una recompensa se salte su cobro (cada cobro tiene una docena de pasadas dentro de su ventana, así que una sola no es grave; varias seguidas, sí).
- **`skip:plan_change_in_progress`:** el cliente estaba cambiando su plan justo en ese momento. La pasada siguiente lo reintenta.

## Marcha atrás

Ver `docs/ROLLBACK.md`, sección (e). Del lado del amigo, lo inmediato es poner fecha de fin *ahora* al descuento padre en Shopify. Para emergencias: primero `REFERRAL_REWARDS=off` y Redeploy, y después `scripts/referral-admin.ts detach-all --apply`.

## Riesgos que se aceptan en la fase 0

- **Un cliente que ya ha comprado puede usar un código de amigo una vez,** porque Shopify no reconoce a los invitados sin sesión. Quien le invitó no gana nada, porque la cualificación lo rechaza. Coste máximo: 10 € por cliente, una sola vez en su vida para todo el programa. Esto último depende de que «un uso por cliente» valga para el descuento padre entero; se comprueba en el E2E (paso 2).
- **Los códigos `NOMBRE` + 2 cifras se pueden adivinar.** Es el mismo caso de arriba. Si un código acaba en una web de cupones, la regla de velocidad lo para en revisión y se regenera.
- **Un `LITREF` filtrado valdría una vez en el checkout.** Es aleatorio y solo se ve en Seal o en el pedido de quien invita, y se borra en Shopify en cuanto se consume.
- **Con `REFERRAL_REWARDS=off` la cola ni se lee.** Revocar o caducar una recompensa en cola espera a que se abra el flag. No mueve dinero: en cola no hay nada puesto en Seal.
- **Un cliente puede encontrarse el cerrojo tomado** si cambia su plan justo cuando el cron le está poniendo los 10 € (unos segundos, solo en las 48 h antes de su cobro). Ve «Estamos terminando otro cambio en tu suscripción. Espera un momento y vuelve a intentarlo.»

## Klaviyo

Ningún evento lleva datos del amigo.

| Qué | Dónde | Propiedades |
|---|---|---|
| Propiedad de perfil `referral_code` | al activarse el código | el código |
| `referral_friend_joined` | a quien invita, cuando un amigo cualifica | `reward_amount`, `reward_amount_label`, `friends_joined`, `referral_code` |
| `referral_reward_applied` | a quien invita, cuando el cron aplica los 10 € | `reward_amount`, `reward_amount_label`, `charge_date`, `charge_date_label` |
| `referral_shared` | al copiar o compartir en Mi LIT | `channel` (`copy` \| `whatsapp` \| `native`) |

**Qué montar:**
- **Flow transaccional «Referidos · Alguien se ha unido»** (disparador `referral_friend_joined`, con reentrada permitida).
- **Campaña de lanzamiento.**
- **Opcional:** flow «Tu entrega llega con 10 € menos» (`referral_reward_applied`).
- Proceso de diseño: Figma (página email) → HTML → preview → Klaviyo.

## Copy

Reglas: tuteo, sin guiones largos y sin emojis. En los emails, «tu próximo LIT» y «entrega», no «suscripción» ni «pedido».

**Tarjeta de Mi LIT**

| | ES | EN |
|---|---|---|
| Antetítulo | 10 € para cada uno | €10 each |
| Título | TRAE A ALGUIEN. | BRING SOMEONE IN. |
| Texto | Pásale tu código a quien quieras. Tiene 10 € en su primera caja, y tú 10 € menos en tu próximo envío. | Give your code to anyone you like. They get €10 off their first box, and you get €10 off your next delivery. |
| Letra pequeña | Para quien aún no ha probado LIT. Vale en suscripción y en compra única. | For people new to LIT. Works on subscriptions and one-time orders. |

**WhatsApp (texto prellenado):** «Llevo un tiempo con LIT y lo noto. Si lo quieres probar, usa mi código {CÓDIGO} en litsalt.com y tienes 10 € de descuento en tu primera caja.»

**Email «Alguien se ha unido con tu código»** (transaccional)
- **Asunto:** Alguien se ha unido con tu código
- **Preheader:** Tienes 10 € menos en tu próximo LIT.
- **Cuerpo:** «Alguien ha probado LIT con tu código {{ event.referral_code }}. Te has ganado 10 € menos en tu próximo LIT: se aplican solos justo antes del cobro, no tienes que hacer nada. Tu código sigue funcionando, así que si conoces a alguien más, pásaselo.»
- **CTA:** Ver mi código → `https://litsalt.com/apps/portal/es/mi-lit`

**Email de lanzamiento** (campaña, al segmento con `referral_code` y consentimiento)
- **Asunto:** 10 € para ti, 10 € para quien traigas
- **Preheader:** Tu código: {{ person.referral_code }}
- **Cuerpo:** «Si LIT te funciona, seguro que conoces a alguien a quien le vendría bien. Pásale tu código {{ person.referral_code }}: tendrá 10 € de descuento en su primera caja, la pida como la pida, y tú 10 € menos en tu próximo LIT. Vale para quien aún no ha probado LIT.»
- **CTA:** Compartir mi código → `https://litsalt.com/apps/portal/es/mi-lit`

**Email opcional «Tu próxima entrega llega con 10 € menos»**
- **Asunto:** Tu próxima entrega llega con 10 € menos
- **Cuerpo:** «Gracias por traer a alguien a LIT. Tu próximo LIT, el {{ event.charge_date_label }}, llega con 10 € de descuento.»

## Condiciones (texto para `/pages/trae-a-alguien-condiciones`)

**Trae a alguien: condiciones**

1. **Quién puede invitar.** Cualquier persona con una suscripción activa a LIT. Tu código personal está en Mi LIT y lleva tu nombre de pila.
2. **Qué recibe tu amigo.**
   - 10 € de descuento en su primer pedido de cajas LIT en litsalt.com, con suscripción o en compra única.
   - Solo para quien no ha comprado nunca cajas LIT.
   - Un código de amigo por persona.
   - No se combina con otros descuentos.
3. **Qué recibes tú.**
   - 10 € de descuento en tu siguiente cobro de suscripción por cada amigo que complete su pedido, si ese cobro cae al menos 48 h después.
   - Se aplica un descuento por cobro; si traes a varias personas, se aplican en los cobros siguientes.
   - Los descuentos no tienen valor en efectivo.
   - Caducan si en 180 días no tienes una suscripción activa en la que aplicarlos.
4. **Cuándo se retira.** Si el pedido de tu amigo se cancela o se reembolsa antes de que se aplique tu descuento.
5. **Qué no cuenta.**
   - Invitarte a ti mismo, con otro email, teléfono o desde tu mismo domicilio.
   - Cualquier uso fraudulento. Podemos revisar los casos dudosos antes de aplicar un descuento.
6. **Tus datos.** No pedimos los datos de tus amigos ni te contamos quién ha usado tu código: solo cuántas personas se han unido.
7. **Cambios.** LIT Hydration Spain S.L. puede cambiar o terminar el programa avisando con antelación. Los descuentos ya ganados se respetan.
8. **Dudas.** hola@litsalt.com
