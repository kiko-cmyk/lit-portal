-- LIT-470 (2026-09-15): memoria compartida entre invocaciones de Vercel.
--
-- Cada función es un proceso efímero: el dedupe de alertas de `src/lib/alert.ts`
-- vivía en un Map en memoria (60 s, por instancia), así que cuatro timeouts de
-- Shopify en cuatro instancias frías eran cuatro mensajes en #n8n-errors. Aquí
-- viven los cooldowns de las alertas TRANSITORIAS (upstream_timeout:*,
-- rate_limit_rpc_error). Solo service role: RLS activada sin políticas, que es lo
-- que hace que una tabla no nazca abierta.
create table if not exists portal_kv (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  expires_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table portal_kv enable row level security;
comment on table portal_kv is
  'KV efímero del portal (cooldowns de alertas transitorias). Service role only. LIT-470.';
