# Vercel deploy — guía para Kiko

## TL;DR
Necesito que despliegues la branch `feat/master-spec-rewrite` (o `main` si ya está mergeada) del repo `kiko-cmyk/lit-portal` a tu proyecto Vercel `kiko-5145s-projects/lit-portal`, con las variables de entorno listadas abajo.

## 1. Linkar branch correcta

En Vercel dashboard → proyecto `lit-portal` → **Settings → Git**:

- Production branch: `main` (espera al merge del PR #1) o `feat/master-spec-rewrite` (si quieres deploy preview ya)
- Si solo quieres preview: cualquier push a la branch dispara un Preview deployment automáticamente

## 2. Variables de entorno

Vercel dashboard → proyecto `lit-portal` → **Settings → Environment Variables** → añade cada una de estas para los 3 environments (Production, Preview, Development):

| Variable | Valor | Donde sacarlo |
|---|---|---|
| `SHOPIFY_API_KEY` | `bbe492fa4b576985eeb962b8156118f3` | Partner Dashboard → app LIT → API credentials |
| `SHOPIFY_API_SECRET` | (Juan te lo pasa) | Partner Dashboard → app LIT → API secret |
| `SHOPIFY_WEBHOOK_SECRET` | mismo que SHOPIFY_API_SECRET por ahora | Si configuras webhook secret separado, ese |
| `SHOPIFY_STORE` | `lit-tienda.myshopify.com` | constant |
| `SUPABASE_URL` | `https://iroejgwbuhhtwuvxxmvm.supabase.co` | Supabase → Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | (Juan te lo pasa) | Supabase → Project Settings → API → secret keys |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `sb_publishable_0x7h-0KlKwAFYM1ePb-0aQ_K4esk8cv` | Supabase → Project Settings → API → publishable |
| `SEAL_API_TOKEN` | (Juan te lo pasa) | Seal Settings → General → API |
| `KLAVIYO_PRIVATE_API_KEY` | (Juan te lo pasa) | Klaviyo → Settings → API Keys |
| `NEXT_PUBLIC_PORTAL_BASE_PATH` | `/apps/portal` | constant |

**Importante**: las que llevan `(Juan te lo pasa)` son secrets reales. Juan te los manda por canal seguro (no por chat público).

Las variables `NEXT_PUBLIC_*` se exponen al browser — las otras son server-only.

## 3. Build settings

Vercel debería autodetectar Next.js correctamente. Si no:
- Framework Preset: **Next.js**
- Build Command: `npm run build` (default)
- Output Directory: (vacío, Next.js gestiona)
- Install Command: `npm install` (default)
- Node version: **22.x o 24.x** (Settings → General → Node.js Version)

## 4. Domain

El deploy te dará una URL tipo `lit-portal-xxx.vercel.app`. Para producción, hay 2 caminos:

### Opción A (mejor) — App Proxy de Shopify
La app va detrás del App Proxy de Shopify, así que el dominio público es `litsalt.com/apps/portal/*`. Para esto, en **Shopify Partner Dashboard → app LIT → Configuration → App Proxy**:
- Subpath prefix: `apps`
- Subpath: `portal`
- Proxy URL: `https://lit-portal-xxx.vercel.app` (la URL del Vercel deploy)

Lo configura Juan después del deploy.

### Opción B — Subdominio directo
Si quieres acceder fuera del proxy: añade un dominio custom en Vercel (Settings → Domains) tipo `portal.litsalt.com`.

## 5. Tras el deploy

Pásame por chat la URL del deploy (ej. `https://lit-portal-xxx.vercel.app`) para:
- Confirmar que `/api/health` devuelve 200
- Configurar webhook URLs en Shopify y Seal
- Ajustar `NEXT_PUBLIC_PORTAL_BASE_PATH` si fuera necesario

## Notas

- El proyecto **NO** necesita `DATABASE_URL` configurada en Vercel — la app habla con Supabase vía REST (con service_role_key). El `DATABASE_URL` solo se usa local para correr migraciones.
- La schema ya está aplicada en Supabase (`area-personal-lit`, 18 tablas).
- Cualquier duda: ping a Juan o me escribís por aquí.
