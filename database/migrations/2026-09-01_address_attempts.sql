-- 2026-09-01 — Guardar cada intento de cambio de dirección, con su resultado
--
-- Contexto, y es literalmente el mismo dos veces. El 2026-07-06 un cliente no
-- pudo cambiar su dirección, escribió a soporte, se le cambió en la ficha de
-- Shopify creyendo que bastaba, y su caja salió dos meses a la dirección vieja.
-- Seis semanas después, al ir a contestar qué le había fallado, resultó que no
-- se podía saber: los logs de runtime de Vercel en plan Hobby duran UNA HORA,
-- así que las dos fechas que interesaban llevaban semanas borradas. Y no se
-- arregla subiendo de plan, porque lo que ya se tiró no vuelve.
--
-- Lo que teníamos para reconstruirlo era `rate_buckets`, que es un CONTADOR:
-- una fila por (cliente, endpoint) que se resetea en sitio al expirar la
-- ventana. Sirve para "este cliente llegó a la función alguna vez" y para nada
-- más: no dice qué pidió, ni si se guardó, ni por qué no. Y solo cubre la ruta
-- del cliente, porque la entrada máquina a máquina del bot de WhatsApp ni
-- siquiera pasa por el limitador.
--
-- El aviso a Slack del PR #104 avisa en el momento, que es lo que hacía falta
-- para no perder a nadie más. Esto es la otra mitad: poder contestar seis
-- semanas después. Son cosas distintas y las dos hacen falta.
--
-- QUÉ SE GUARDA Y QUÉ NO
-- Se guarda lo que permite contestar "quién intentó qué, cuándo, y qué pasó":
-- cliente, suscripción, ruta, resultado, código de error y latencia. Del
-- destino solo CP y ciudad, que es lo que distingue una mudanza real de una
-- errata y lo que permite a soporte arreglarlo. NO se guarda calle, número,
-- nombre ni teléfono: para eso ya está Seal, que es la fuente de verdad, y una
-- copia nuestra de la dirección completa sería PII que no necesitamos para
-- responder ninguna de las preguntas que nos hemos hecho.
--
-- Volumen: ~50 clientes han usado el formulario en tres meses. Esto son
-- decenas de filas al mes, no miles. La retención de 180 días es holgada a
-- propósito: la pregunta que originó todo esto se hizo seis semanas después del
-- hecho, y 90 días habrían llegado justos.
--
-- Aditiva e idempotente: se puede aplicar en cualquier momento, ANTES de
-- desplegar el código. Se aplica con `npm run migrate` o pegándola en el editor
-- SQL de Supabase contra el session pooler.

create table if not exists address_attempts (
  id            bigserial primary key,
  attempted_at  timestamptz not null default now(),
  -- 'portal' (el cliente) | 'internal' (el bot de WhatsApp vía lit-webhooks)
  source        text        not null,
  -- 'read' | 'dry_run' | 'write' — solo la entrada interna usa los dos primeros
  mode          text,
  customer_id   text,
  seal_subscription_id text,
  -- true = la dirección quedó escrita en Seal
  ok            boolean     not null,
  -- el MISMO código que ve el cliente entre paréntesis en el overlay, para
  -- poder cruzar una fila con un correo de soporte sin abrir ningún log
  error_code    text,
  -- solo CP y ciudad del destino pedido. Ver arriba: nada de calle ni nombre.
  postal_code   text,
  city          text,
  duration_ms   integer,
  purge_after   timestamptz not null default (now() + interval '180 days')
);

-- La consulta que se hace de verdad es "qué pasó con este cliente", y en
-- segundo lugar "qué ha fallado últimamente".
create index if not exists idx_address_attempts_customer
  on address_attempts (customer_id, attempted_at desc);

create index if not exists idx_address_attempts_recent
  on address_attempts (attempted_at desc);

-- Los fallos son una fracción pequeña de las filas y son lo que se rastrea:
-- índice parcial para que contar cutoff_passed de los últimos 60 días, que es
-- justo la pregunta que bloqueó una decisión de producto, sea inmediato.
create index if not exists idx_address_attempts_failures
  on address_attempts (error_code, attempted_at desc)
  where ok = false;

-- Barrido de retención sin cron: cualquier limpieza futura puede hacer
-- delete from address_attempts where purge_after < now().
create index if not exists idx_address_attempts_purge
  on address_attempts (purge_after);

-- RLS ON + cero políticas = solo service_role. Es el patrón obligatorio de toda
-- tabla nueva del portal y se restablece aquí para que aplicar este fichero
-- suelto contra una base desviada no pueda dejarla legible por la clave anon.
alter table address_attempts enable row level security;
