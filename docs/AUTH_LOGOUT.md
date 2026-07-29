# Cerrar sesión y cambiar de cuenta

Escrito el 2026-07-29, cuando el portal dejó de ser un callejón sin salida para
quien entra con la cuenta equivocada.

## Por qué existe esto

Shopify crea un customer vacío **al vuelo** cada vez que alguien entra con un
email que no tiene pedidos: una errata en el checkout, el email de "Login with
Shop", el correo del trabajo. Ese cliente aterriza en una cuenta que no es la
suya, ve la pantalla de "Bienvenido a LIT / Suscríbete" aunque tenga una
suscripción activa en su otra cuenta, y hasta hoy no tenía forma de salir.

Entre el 2026-05-27 y el 2026-07-29, **25 clientes distintos** intentaron
arreglarlo por el único hueco que encontraron, el campo de email de Cuenta, con
hasta 5 reintentos cada uno. **Ninguno lo consiguió**, y no lo habrían
conseguido igualmente: Shopify no deja mover el email de un customer a una
dirección que ya pertenece a otro, que es justo el caso.

El botón de cerrar sesión se había quitado el 2026-05-22 con la premisa de que
"nadie pulsa logout en un portal post-compra personal". La premisa era correcta
para el caso del dispositivo compartido y falsa para el que de verdad ocurre.

## Las tres sesiones

Cerrar sesión de verdad significa matar tres cosas independientes. Matar solo
una deja al cliente medio dentro, que es peor que no hacer nada porque parece
que ha funcionado.

| # | Sesión | Dónde vive | Quién la mata |
|---|--------|-----------|---------------|
| 1 | La nuestra | fila en `auth_sessions` + `lit_session` en localStorage | `POST /api/auth/logout` + el cliente |
| 2 | Customer Account (Shopify) | cookie de Shopify | solo el `end_session` OIDC |
| 3 | Storefront clásica | cookie `_shopify_essential` en litsalt.com | `GET /account/logout` |

La 3 importa porque `withCustomer` confía en el `logged_in_customer_id` que
inyecta App Proxy **antes** que en nuestro token: con esa cookie viva, el
portal sigue reconociendo al cliente aunque las otras dos estén muertas. La
mata la página `/signed-out` con un fetch same-origin.

## El contrato de Shopify (verificado, no deducido)

- **`end_session` exige `id_token_hint` y lo valida de verdad.** Medido contra
  `tracking.litsalt.com/authentication/logout` el 2026-07-29: sin el parámetro
  devuelve **400**, con un token malformado devuelve **401**. No es una pista
  opcional pese al nombre.
- **El refresh NO renueva el `id_token`.** La respuesta del grant
  `refresh_token` está tipada en los docs de Shopify como
  `Omit<AccessTokenResponse, 'id_token'>`, y Hydrogen arrastra a mano el
  id_token original precisamente por eso. Guardar un refresh_token no sirve
  para el logout. Si alguien vuelve a proponerlo, esta línea es la respuesta.
- **El `id_token` dura ~10 minutos y nuestra sesión 14 días**, así que en un
  logout real el guardado siempre está caducado. Si Shopify aceptaría un hint
  caducado no está documentado (la spec OIDC dice que el OP *debería*), y
  equivocarse deja al cliente en una página de error, así que no lo jugamos.
- **`prompt=none` sí está documentado**: si hay sesión devuelve un code sin
  enseñar nada, y si no la hay devuelve `error=login_required`. Esa es la
  pieza que hace que todo esto funcione.
- **El logout tiene que ser una navegación del navegador.** Con cualquier
  `Accept` que no sea `text/html`, la ruta de logout responde 406 y no cierra
  nada. El fallo es del peor tipo: parece que ha ido bien y el cliente sigue
  dentro. Nunca hagas `fetch` del `logoutUrl`.
- **`post_logout_redirect_uri` se compara por coincidencia exacta** contra lo
  registrado (la spec lo exige como MUST). Sin query strings, sin barra final
  de más. Si no casa, Shopify **igualmente cierra la sesión** pero suelta al
  cliente en www.shopify.com en vez de en el portal.

## El flujo

```
Cliente pulsa "Entrar con otro correo"
  → POST /api/auth/logout
      borra la fila de auth_sessions
      ¿el id_token guardado sigue fresco (>30s)?
        sí  → devuelve la URL de end_session directamente (atajo, raro)
        no  → devuelve una URL de /authorize con prompt=none y el claim lo=1
  → el navegador la sigue (navegación real, nunca fetch)
  → Shopify, sin enseñar nada:
        hay sesión      → vuelve a /api/auth/callback con ?code
        no hay sesión   → vuelve con ?error=login_required
  → /api/auth/callback ve lo=1 y NO crea sesión:
        con code  → canjea, verifica firma y nonce, y redirige al end_session
                    con el id_token recién emitido
        con error → va directo a la página de sesión cerrada
  → Shopify cierra su sesión y redirige al post_logout_redirect_uri
  → /signed-out limpia localStorage, mata la cookie de storefront y ofrece
    entrar con otro correo. Es la única página del portal que NO dispara
    el login automáticamente.
```

## Qué hay que tener registrado en Shopify

Canal **Headless → la aplicación → Application setup** (verificado en el panel
el 2026-07-29):

| Campo | Valor |
|-------|-------|
| Callback URI(s) | `https://litsalt.com/apps/portal/api/auth/callback` |
| Javascript origin(s) | `https://litsalt.com` |
| Logout URI | `https://litsalt.com/apps/portal/es/mi-lit` (de mayo) **+ `https://litsalt.com/apps/portal/es/sesion-cerrada`** |

El campo Logout URI admite una LISTA, así que la nueva se añade sin quitar la
vieja. Aun así el código manda siempre la ruta en español como
`post_logout_redirect_uri`, con una sola entrada registrada de por medio: a
los clientes en inglés los rebota la propia página a `/en/signed-out` usando
la pista de idioma que su navegador dejó antes de salir. Es a propósito. Si
dependiéramos de registrar también la URI inglesa, olvidarla no daría un aviso
sino un cliente aterrizando en www.shopify.com, y ese fallo solo se ve cuando
un cliente en inglés cierra sesión, o sea casi nunca y siempre tarde.

Si el valor registrado acaba siendo otro, **no hay que tocar código**: la
variable de entorno `SHOPIFY_POST_LOGOUT_URI` en Vercel lo sobrescribe. Es el
único URL de OAuth del portal que se puede mover sin desplegar, y está así a
propósito, porque es el que hay que cuadrar a mano con un panel de Shopify.

## Cómo probarlo

1. Entra en el portal con una cuenta.
2. Cuenta → Mis datos → "Entrar con otro correo".
3. Tienes que acabar en la página de sesión cerrada, no en un error ni en
   www.shopify.com (si acabas ahí, el Logout URL no está registrado o no
   coincide carácter a carácter).
4. Pulsa "Entrar con otro correo" y comprueba que Shopify **te pide el email**.
   Si entra solo, la sesión de Customer Accounts no ha muerto y algo del paso
   del `prompt=none` ha fallado; mira los logs de `[oauth-callback] logout`.
