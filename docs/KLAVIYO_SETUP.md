# Klaviyo — setup de flows y emails

El backend del portal **dispara eventos custom a Klaviyo** automáticamente. Lo que falta es construir los **flows** y las **plantillas de email** en el dashboard de Klaviyo (no son código — son configuración visual).

---

## 1. Eventos custom que el backend YA dispara

El cliente Klaviyo (`src/lib/klaviyo.ts`) llama a `klaviyo.trackEvent(name, email, properties)` cuando ocurren estos eventos:

| Event name (metric) | Cuándo se dispara | Properties |
|---|---|---|
| `confirmation_sent` | Tras primer order pagado (Shopify webhook `orders/paid`) | `boxCount`, `frequency`, `flavor`, `shipDate` |
| `tier_unlocked` | Primera vez que cliente cruza 300 lifetime Drops | `dropsBalance`, `earnedAt` |
| `reward_claimed` | Cliente reclama Bottle/Merch/Event | `rewardId`, `merchOption?`, `remainingDrops` |
| `subscription_skip` | Cliente skipea próximo box | `newNextShipDate` |
| `subscription_cancelled` | Cliente confirma cancelación step 4 | `primaryReason`, `lastShipDate`, `cancelCount` |
| `subscription_reactivated` | Cliente reactiva tras cancel | `dropsRestored` |
| `winback_d14` | Cron 14 días post-cancel (TODO: implementar cron) | — |
| `winback_d30` | Cron 30 días post-cancel (TODO: implementar cron) | — |
| `first_login_completed` | Cliente cierra el welcome takeover | `whatsappOptIn`, `language` |
| `drops_earned` | Webhook `fulfillments/create` por cada box enviado | `amount`, `action`, `metadata` |

> Nota: hoy mismo el código tiene los wrappers listos pero **pocos endpoints llaman a `trackEvent`** todavía. Hay que añadir las llamadas en cada endpoint relevante. Lo dejo pendiente como un sweep rápido cuando los flows estén creados.

### 1.b Dunning y pausa (añadidos 2026-07-28)

| Event name (metric) | Cuándo se dispara | Properties |
|---|---|---|
| `payment_failed` | Webhook Seal `billing_attempt/failed`, **solo en el primer fallo de cada ciclo** | `sealSubscriptionId`, `attemptDate`, `gatewayMessage`, `paymentType`, `cardExpiryMonth`, `cardExpiryYear`, `amount`, `currency`, `locale`, `daysUntilCancel` |
| `subscription_paused` | Webhook Seal `subscription/paused` | `sealSubscriptionId`, `pausedOn`, `amount`, `currency` |
| `subscription_resumed` | `POST /api/subscription/resume` | `sealSubscriptionId`, `pausedOn` |

**Por qué importa `payment_failed`.** Medido sobre datos reales de Seal el 2026-07-28:
Seal reintenta un cobro fallido 4 veces en días consecutivos, manda su propio email
cada vez, y a la cuarta **cancela la suscripción**. Solo en julio 2026 eso cancelo
35 suscripciones, unos 987 €/mes. Hasta hoy el `case` del webhook era un `break`
con un TODO, así que en esa ventana de 3 días el único que hablaba con el cliente
era Seal, con un email que no controlamos cuyo CTA es un enlace mágico al portal
nativo de Seal (el mismo que tenía el botón de pausar hasta el 2026-07-28).

**Antiduplicados.** El backend dispara `payment_failed` una sola vez por ciclo de
dunning, no una por reintento: guarda una fila en `email_logs` con
`template_id = 'payment_failed'` y `metadata.sealSubscriptionId`, y se calla si ya
hay una en los últimos 5 días. Por eso la secuencia (día 0, día 2, último aviso)
hay que montarla **dentro del flow con delays**, no esperando 4 triggers.

**CTA del email: siempre al portal**, `https://litsalt.com/apps/portal/es/cuenta`.
Nunca a un enlace de Seal ni al de actualizar tarjeta de Shopify. Motivos: el
enlace de Shopify es de un solo uso y caduca, y para Shop Pay / PayPal Shopify
rechaza el formulario inline (`INVALID_INSTRUMENT_TYPE`), así que el portal es el
único sitio que resuelve los dos casos. Usa `paymentType` para el copy:

- `card` → "actualiza tu tarjeta" (en Cuenta se cambia en línea).
- `shop_pay` / `paypal` / `other` → "entra en tu área personal y pídenos el enlace"
  (el botón de Cuenta dispara el email de Shopify). 2 de los 3 clientes que
  pausaron tras un cobro fallido eran Shop Pay.

**Flow que hay que crear** (no existe ninguno de fallo de pago en la cuenta hoy,
lo verifiqué el 2026-07-28):

```
Trigger: Metric = payment_failed
  ├─ Email 1 · inmediato   · "No pudimos cobrar tu caja" · CTA → /apps/portal/es/cuenta
  ├─ Delay 48 h
  ├─ Filtro: no ha habido `subscription_charge_now` ni cobro correcto desde el trigger
  └─ Email 2 · "Último aviso, mañana se cancela" · mismo CTA
```

`daysUntilCancel` viene a 3 en el evento: es la ventana real medida, no una
estimación. Ojo con la cadencia del § 3: esto es transaccional, va fuera de la
Quiet Zone.

> La métrica `payment_failed` no aparecerá en el selector de Klaviyo hasta que
> llegue el primer evento. Para poder montar el flow antes, dispara uno de prueba
> contra un perfil interno.

---

## 2. Flows que hay que construir (Klaviyo dashboard)

Para cada uno: `Flows → Create Flow → Metric Trigger → seleccionar el evento`.

### 2.1 Confirmation email (5 variantes por plan)

Trigger: `confirmation_sent`

Spec § 3.1 define 5 variantes de subject según el plan:

| Plan | Subject EN | Subject ES |
|---|---|---|
| 1 box / 1 mes | "You're in. Here's what happens next." | "Estás dentro. Esto es lo que viene." |
| 1 box / 15 días | "You're in. Your first 15 days of LIT." | "Estás dentro. Tus primeros 15 días de LIT." |
| 3 boxes / 3 meses | "You're in. 3 boxes coming your way." | "Estás dentro. 3 cajas en camino." |
| 2 boxes / 1 mes | "You're in. Two boxes a month." | "Estás dentro. Dos cajas al mes." |
| One-time | "Your LIT is on the way." | "Tu LIT está en camino." |

**Cómo en Klaviyo**: 1 flow con 5 conditional split branches usando `event.boxCount` + `event.frequency`. Cada branch envía la plantilla email correspondiente (HTML basado en `designs/mobile/lit-confirmation-hifi/index.html`, ya bilingüe con `data-en`/`data-es`).

### 2.2 Tier unlock celebration

Trigger: `tier_unlocked`

Email único: "You're in the inner circle now." / "Ya estás en el círculo interior."

### 2.3 Reward claimed

Trigger: `reward_claimed`

Conditional split por `event.rewardId`:
- `bottle_500` → "Your bottle is on its way."
- `merch_1000` → "Your merch is on its way." (incluir `merchOption`)
- `event_2500` → "Your seat is reserved." (con detalles del evento)

### 2.4 Win-back D14

Trigger: `winback_d14` (necesita un cron job en el backend que dispare el evento — TODO)

Subject: "Door's still open." / "La puerta sigue abierta."

### 2.5 Win-back D30

Trigger: `winback_d30`

Subject: "Last one from us." / "El último de nosotros."

### 2.6 WhatsApp welcome (separate channel)

Trigger: `first_login_completed` con condición `whatsappOptIn = true`

Lo que mande Klaviyo por WhatsApp (no email): bienvenida + confirmación del +50 Drops. Necesita Klaviyo WhatsApp activado.

---

## 3. Cadencia que respetar (Master Spec § 8)

- **Active Zone** (Days 1-14 post-purchase): max 5 emails total
- **Quiet Zone** (Day 15+): max 1 email/mes
- **No stacking**: no email + WhatsApp el mismo día (excepto delivery alert)
- **NO renewal reminder emails**: nunca

Para implementar en Klaviyo: usar **smart sending + frequency caps** en cada flow para respetar estos límites.

---

## 4. Plantillas HTML

El email de confirmación tiene su HTML hi-fi en:
`designs/mobile/lit-confirmation-hifi/index.html`

- 600px de ancho, sin JS dependencies
- Bilingüe con `data-en`/`data-es` (Klaviyo soporta dynamic content por property)
- Fonts: Clash Display (display) + Barlow (body) — fallback a Helvetica Neue / Arial
- 6 colores del brand exclusivamente

Cuando subas a Klaviyo: copia el HTML, reemplaza tokens estáticos por merge tags de Klaviyo (`{{ first_name }}`, `{{ event.flavor }}`, etc).

---

## 5. Pendiente para hacer en otra sesión (cuando los flows existan)

- [ ] Sweep en endpoints `/api/subscription/skip`, `/api/subscription/cancel`, `/api/rewards/claim`, `/api/first-login/*` para llamar a `klaviyo.trackEvent(...)` con properties correctas
- [ ] Cron job que dispare `winback_d14` y `winback_d30` (ej. Vercel Cron job o Supabase scheduled function)
- [ ] Logica de selector de variant del confirmation email (mapear box+frequency → variant)
- [ ] Test end-to-end: trigger un evento con `klaviyo.trackEvent` desde un endpoint, ver que llega al flow y dispara el email

---

## Tu acción inmediata

1. Crear los 6 flows en Klaviyo dashboard con los triggers de la tabla 2
2. Subir las plantillas HTML adaptadas
3. Configurar smart sending / caps por la cadencia § 8
4. Avísame cuando estén creados y yo enchufo las llamadas `trackEvent` desde los endpoints del backend

---

## ✅ Estado actual (lo que YA hace el backend) — actualizado 2026-04-28

- **Plantilla Confirmation Email subida via API** → ID `Utdb9S` (visible en Klaviyo → Email → Templates)
- **Llamadas `klaviyo.trackEvent` enchufadas** en:
  - `POST /api/subscription/skip` → `subscription_skip`
  - `POST /api/subscription/cancel` (step 4) → `subscription_cancelled`
  - `POST /api/subscription/reactivate` → `subscription_reactivated`
  - `POST /api/rewards/claim` → `reward_claimed`
  - `POST /api/first-login/complete` → `first_login_completed`
  - `POST /api/webhooks/shopify` topic `orders/paid` → `confirmation_sent`
  - `POST /api/webhooks/shopify` topic `fulfillments/create` (cuando se cruza 300 lifetime) → `tier_unlocked`
- **Cron jobs implementados** (Vercel Cron schedules en `vercel.json`):
  - `0 9 * * *` daily → `/api/cron/winback` → dispara `winback_d14` y `winback_d30` para cancellations a 14/30 días
  - `0 0 1 * *` monthly → `/api/cron/monthly-streak` → +50 Drops a active subscribers
  - `0 1 * * *` daily → `/api/cron/drops-cleanup` → reset balance a 0 cuando expira hold de 90 días

**Para que los crons funcionen en Vercel**: Kiko tiene que generar un `CRON_SECRET` (cualquier string aleatoria) y añadirlo a Vercel env vars. Los cron handlers verifican el header `Authorization: Bearer ${CRON_SECRET}` que Vercel inyecta automáticamente.

---

## 🎯 Guion clic-a-clic para crear cada flow

Para cada uno de los 6 flows, en Klaviyo dashboard:

1. **Flows** (sidebar) → **Create Flow** → **Create from scratch**
2. Trigger: **Metric Triggered Flow**
3. Selecciona la metric correspondiente (la metric aparece **automáticamente** en cuanto el evento se dispara una vez en producción — si todavía no aparece, fuerza un evento con un test)
4. Drag-and-drop **Send Email** action al canvas
5. En el email step, selecciona **Use existing template** → **LIT — Confirmation Email (post-checkout)** (o tu template específico para ese flow)
6. Configura subject/preheader según las 5 variantes (ver tabla 2.1 del documento)
7. Activate el flow

Para el flow de Confirmation con 5 variantes:
- Trigger: `confirmation_sent`
- Add **Conditional Split** después del trigger
- Branch por `event.box_count` y `event.plan_label` para escoger subject + variante
- Cada branch → Send Email con el template + subject/preheader ajustado

Para win-back D14 / D30:
- Trigger: `winback_d14` o `winback_d30`
- Send Email → cuerpo simple con "Door's still open" / "Last one from us"
- Smart Sending ON (respeta global frequency caps)

Para tier_unlocked y reward_claimed:
- Trigger respectivo
- 1 email celebratorio con copy "You're in the inner circle now" / "Your reward is on its way"
