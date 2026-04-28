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
