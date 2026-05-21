# Security Audit — LIT Portal

**Fecha:** 2026-05-21
**Alcance:** Portal Next.js servido vía Shopify App Proxy en `litsalt.com/apps/portal/*`
**Repos:** `kiko-cmyk/lit-portal` rama `feat/master-spec-rewrite`
**Método:** 3 agentes en paralelo cubriendo (1) auth/session, (2) API mutations & validación, (3) secrets, integrations & data layer.

---

## Hallazgos CRÍTICO / ALTO

### 1. App Proxy timestamp nunca validado → replay window infinito
`src/lib/shopify-app-proxy.ts:38-89`
Parsea `timestamp` pero nunca compara con `Date.now()`. Cualquier URL firmada de App Proxy (capturada de un referer, ngrok log, historial del navegador, link compartido) sigue siendo válida para siempre y produce un `customerId` confiable. Como `logged_in_customer_id` es estable, quien tenga la URL impersona al cliente.
**Fix:** rechazar si `Math.abs(now - timestamp) > 60s`.

### 2. session_id filtrado por URL en el handoff (referer, history, proxy logs)
`src/app/api/auth/callback/route.ts:174-184`
Redirige a `https://litsalt.com/apps/portal/es/auth/handoff?s=<sessionId>`. Esa URL queda en el historial del navegador y cualquier `<a>`/`<script>`/`<img>` cargado en handoff manda `s=...` en el `Referer`. El token es un secret de 32 bytes equivalente a una contraseña.
**Fix:** POST vía form auto-submit, o usar fragment (`#s=...`) que no se manda en Referer.

### 3. Token de sesión en localStorage → XSS = account takeover de 30 días
`src/app/[locale]/auth/handoff/page.tsx:30` + `src/lib/api-client.ts:24-31`
Cualquier XSS exfiltra `lit_session` y el atacante autentica 30 días; `last_used_at` lo renueva. Sin HttpOnly/Secure/SameSite porque no se usa cookie. Combinado con el leak vía URL, la superficie es grande.
**Fix:** cookie HttpOnly+Secure+SameSite=Lax en `.litsalt.com` desde el callback, o tightenear CSP + acortar TTL.

### 4. id_token no verifica signature antes de confiar en `sub`
`src/app/api/auth/callback/route.ts:234-244`
Decodea sin verificar signature/issuer/audience/nonce. El comentario dice "el network path es el trust anchor", pero un nodo CDN comprometido, un confused-deputy, o un refactor futuro = customer impersonation inmediato. Tampoco se manda `nonce` en /authorize.
**Fix:** verificar contra Shopify JWKS, checkear `iss`, `aud == client_id`, `exp`, y bind `nonce` del state.

### 5. Mismo secret para HMAC App Proxy y JWT state
`src/app/api/auth/login/route.ts:64-70`, `callback/route.ts:203-214`, `shopify-app-proxy.ts:65`
Usa `SHOPIFY_API_SECRET` tanto para verificar HMAC de Shopify como para firmar el JWT state propio. Un signing oracle en un contexto debilita el otro.
**Fix:** derivar keys separadas vía HKDF con labels distintos.

### 6. Logout solo lee `Authorization: Bearer`, ignora `X-LIT-Session`
`src/app/api/auth/logout/route.ts:33-37`
Pero `api-client.ts:61` manda `X-LIT-Session`. Resultado: **cada logout es un no-op en DB**; la row queda en `auth_sessions` hasta su expiry natural (30 días). Tokens robados siguen vivos.
**Fix:** leer `x-lit-session` primero, fallback a bearer.

### 7. Stack traces + raw upstream messages devueltos al cliente
`src/lib/api-helpers.ts:106-112`
En cualquier error sin capturar, `withCustomer` devuelve `{ message, stack }` al cliente (8 líneas, paths internos incluidos). Combinado con `throw new Error("cancellations update: ${error.message}")` y `throw new Error("Shopify customerUpdate errors: ${JSON.stringify(...)}")`, leak de nombres de columnas Supabase, GIDs Shopify y errores Seal.
**Fix:** nunca incluir `stack`. Whitelist mensaje genérico al cliente. Log detalle solo server-side.

### 8. Shopify Admin `access_token` logueado en plaintext
`src/app/api/auth/shopify/callback/route.ts:99`
`console.log(... access_token: ${json.access_token})`. Token `shpat_` con full Admin API access en Vercel logs → visible para cualquiera con log read (incl. log shippers, ex-staff con retained access).
**Fix:** parar de loggear el token, persistirlo directo. Rotar el token actual.

### 9. `verifyOwnershipFast` no filtra por `seal_subscription_id`
`src/lib/sub-ownership.ts:15-30`
Consulta solo por `customer_id`, luego compara el id retornado contra el del body. Si un customer tiene 2 subs, `.maybeSingle()` lanza → falla → cae al slow path. Pero el slow path coge el PRIMER ACTIVE sub, no el solicitado. IDOR latente.
**Fix:** `.eq("customer_id", x).eq("seal_subscription_id", id).maybeSingle()`. Slow path debe rechazar `sealSubscriptionId` desconocido en vez de elegir uno arbitrario.

### 10. Plan change confía en `mainItemId` / `currentVariantId` / `currentFrequency` del body
`src/app/api/subscription/plan/route.ts:88-99`
Ownership check verifica que la SUB es del cliente, pero nunca verifica que `mainItemId` pertenece a esa sub. Un cliente malicioso podría pasar un `mainItemId` de otra sub propia y triggear `removeItems` en él.
**Fix:** validar `mainItemId ∈ sub.items` antes de `removeItems`, o refetch server-side.

### 11. `/api/customer` PATCH permite reasignar email sin verificar
`src/app/api/customer/route.ts:42-54`
Acepta `email` del body y lo pasa a `shopifyAdmin.updateCustomer`. Como toda la authorization del portal compara `sub.email` con el email del Shopify customer, cambiar email a uno de víctima hace que en la siguiente request `assertSubscriptionBelongsToCustomer` matchee con la sub de otro cliente.
**Fix:** requerir email-verification challenge antes de persistir, o bloquear cambio de email desde el portal.

### 12. Cancel step 4 no idempotente en retries
`src/app/api/subscription/cancel/route.ts:251-277`
Un retry mientras la row está en `committing` re-ejecuta cancel, vuelve a llamar Klaviyo, y `customer_preferences upsert` lee el `cancelCount` ya incrementado → doble-incremento.
**Fix:** short-circuit al inicio si la cancellation más reciente ya está en `committing`/`confirmed`. Tag Klaviyo con `cancellationId`.

### 13. Sin rate limiting en ningún endpoint
Más peligroso: `/api/subscription/extras` (acumula items sin tope por sub), `/api/subscription/plan` (3 mutations Seal + 500ms sleeps × concurrencia = DoS de quota Seal), `/api/auth/login` (state JWTs sin coste).
**Fix:** token bucket por customer (row Supabase con `last_call_at`) en extras/plan/skip/cancel.

---

## Hallazgos MEDIO

- `withCustomer` devuelve `unauthorized` para "no auth" y "expired bearer" indistintamente. FE no sabe que hay que limpiar `lit_session`, retry forever (`api-helpers.ts:76-85`).
- `auth_sessions` sin `revoked_at`/`rotated_at` ni IP/UA binding. Un token robado vive 30 días desde cualquier IP.
- Logout sin defensa CSRF y POST sin body — XSS same-site puede force-logout.
- `decodeJwtPayload` usa `base64` estándar (no base64url) — payloads con `-`/`_` rompen.
- `console.log` printea `customerId`, `email`, primeros 8 chars de session — termina en Vercel logs / Sentry retention.
- `parseAuthRequest` traga silenciosamente fallos de HMAC. El bearer "rescata" requests con signature tampered. Pierde la señal de audit.
- Dev backdoors `__dev_customer`/`__dev_email` gateados solo por `NODE_ENV==="development"`. Si un preview de Vercel se configura mal, instant impersonation. Añadir un `ALLOW_DEV_BYPASS` extra.
- `subscription/skip/undo` "find most recent skipped" sin que el FE pueda especificar cuál — lógica frágil.
- `subscription/extras` permite `quantity 1..10` por call pero sin cap acumulado por sub.
- Klaviyo `freeText` desde cancel body va raw a Klaviyo property — sin length limit ni PII scrub.
- `auth_sessions.session_id` se guarda en plaintext como PK. Un leak read-only de DB = todas las sesiones vivas. Guardar `SHA-256(session_id)`.
- Email-match-only en `assertSubscriptionBelongsToCustomer` — comment admite un near-incident donde Seal devolvió la sub de otro cliente. Si la fila `subscriptions` se envenena, IDOR silencioso en cancel/skip/plan.
- `subscriptions.customer_id` como PK + `seal_subscription_id unique` — un customer solo puede tener una row, así que re-suscribirse o tener un 2º contrato sobrescribe silenciosamente el mapping.
- Webhook log marca "received" ANTES del handler (`api/webhooks/shopify/route.ts:42-50`); fallos transitorios se deduplican como vistos.

## Hallazgos BAJO

- `subscription/address` no valida `countryCode` formato ISO 2-letter, ni longitud `postalCode`. Errores bubbean por el path crítico de stack leak.
- `subscription/reactivate` coge "most recent sub by order_placed" → podría resucitar una sub cancelada de un account merge anterior.
- `isSafeRelativePath` acepta `/\evil.com` (backslash) que algunos browsers tratan como scheme.
- `state` JWT sin `aud`, sin check de `iat` vs future skew.
- `withCustomer` lanza `.update(last_used_at)` como fire-and-forget — uncaught rejection por cada request.
- RLS habilitada en todas las tablas pero sin policies — defensa solo via service_role bypassing. Si la anon key se usara alguna vez, todo queda locked (incluso recursos públicos como events/moments).
- `barcelona-waitlist` acepta arbitrary email — vector de spam-subscribe a terceros sin rate-limit ni confirmation email.

---

## Top 3 acciones priorizadas

### 1. Stop the bleeding — quitar logs de tokens, stack traces, y leak de session_id
- `auth/shopify/callback/route.ts:99` → quitar `console.log` del `access_token` y rotar el shpat_ token actual.
- `api-helpers.ts:106-112` → no devolver `stack` ni `message` raw en producción.
- `api/auth/callback/route.ts:174-184` → mover `session_id` de query string a URL fragment, y leer en handoff desde `location.hash`.

### 2. Apretar ownership end-to-end
- `verifyOwnershipFast` → filtrar por customer_id Y seal_subscription_id.
- Slow path en plan/skip/cancel → rechazar `sealSubscriptionId` desconocido en lugar de elegir "el primer ACTIVE".
- Plan change → validar `mainItemId ∈ sub.items` antes de `removeItems`.
- Bloquear cambio de email desde `/api/customer` PATCH o requerir email verification.

### 3. Reparar la auth crypto
- Verificar id_token vía Shopify JWKS (iss, aud, exp, nonce) en callback.
- Validar timestamp App Proxy (±60s) en `verifyAppProxyRequest`.
- Derivar keys separadas para HMAC App Proxy y JWT state vía HKDF.
- Fix logout para leer `X-LIT-Session` primero (sin esto, ningún cliente queda realmente logueado out).

---

**Nota:** ninguna falla está siendo explotada activamente. La cuenta de Juan ya está limpia tras los tests de hoy. El backend está en producción pero el portal todavía no ha sido lanzado al cliente final masivamente, por lo que hay ventana para arreglar antes de exposición.
