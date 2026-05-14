# LIT Customer Account UI Extension

Hidden bridge popup used by `litsalt.com/apps/portal/*` to mutate Seal
subscriptions. Renders inside Shopify customer accounts at
`tracking.litsalt.com/account/pages/lit-customer-account`, captures a
Shopify-signed customer JWT, and POSTs it to the LIT backend along with
the mutation params. Backend forwards to Seal's hidden
`edit-subscription-v04.php` endpoint with the JWT.

## Architecture

```
litsalt.com/apps/portal/...                              tracking.litsalt.com/account/...
  (Next.js, custom UI)                                     (Shopify customer accounts)
                                                                    │
   [user clicks "Cambiar plan"]                                     │
        │                                                           │
        └─── window.open(extension URL +                            │
                         ?action=…&payload=…) ───────────────────►  ▼
                                                          ┌──────────────────────┐
                                                          │ Customer Account UI  │
                                                          │ Extension (this dir) │
                                                          │                      │
                                                          │ 1. sessionToken.get()│
                                                          │ 2. POST /api/        │
                                                          │      extension/      │
                                                          │      seal-mutate     │
                                                          │ 3. postMessage(opener│
                                                          │ 4. window.close()    │
                                                          └──────────────────────┘
```

## Files

- `shopify.extension.toml` — extension manifest (target = customer-account.page.render)
- `src/CustomerAccountPage.tsx` — popup React component
- `src/CustomerAccountMenuItem.tsx` — menu link inside customer accounts so customers
  can also reach the page without coming through the popup
- `package.json` — UI Extensions deps

## Deploy

From the repo root `portal-cliente-web/lit-portal`:

```bash
npx @shopify/cli@latest app config link    # one-time: link to LIT Portal v3
npx @shopify/cli@latest app deploy         # push as a new app version
```

The link step will prompt for Partners login and ask which app to link to —
choose **LIT Portal v3** (Client ID `adfffb53532dfc0d31fc0b971e3f23a2`).

After deploy, the extension is live at:

```
https://tracking.litsalt.com/account/pages/lit-customer-account?action=<action>&payload=<json>
```

## Dev / local testing

```bash
npx @shopify/cli@latest app dev
```

The CLI tunnels via Cloudflare and gives you a temporary URL you can hit
while editing locally. Hot reload included.
