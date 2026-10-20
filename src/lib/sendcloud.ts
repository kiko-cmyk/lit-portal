/**
 * Cliente mínimo de Sendcloud (2026-10-20): solo lee el seguimiento de un envío.
 *
 * Las etiquetas de GLS salen por Sendcloud, y es la única fuente que sabe cuándo
 * llega un paquete al punto de recogida y cuándo lo recoge el cliente. Shopify no
 * lo sabe: `fulfillment.events` está vacío y `displayStatus` es siempre FULFILLED.
 * Su `deliveredAt` sí coincide al minuto con la recogida, pero falta en 3 de cada 18
 * (medido el 20-oct con los pedidos a punto de recogida ya recogidos desde el 21-sep).
 *
 * API v3, `GET /parcels/tracking/{tracking_number}`, con autenticación básica
 * (clave pública y secreta de la integración). Los eventos llevan `phase`, que
 * Sendcloud normaliza entre transportistas: `pup` es «en el punto, listo para
 * recoger» y `delivered`, «entregado». Ver https://sendcloud.dev/docs/parcel-tracking/retrieve-tracking-info
 *
 * Solo lectura: nada de aquí escribe en Sendcloud.
 */

import { fetchDeadline } from "./http-timeout";

const SENDCLOUD_API_BASE = "https://panel.sendcloud.sc/api/v3";
const ATTEMPT_TIMEOUT_MS = 8_000;
const MAX_RETRIES = 2;
const BACKOFF_MS = 500;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface SendcloudTrackingEvent {
  event_at: string;
  /** `carrier`, `calculated`, `internal` o `claim`. */
  event_type?: string | null;
  phase?: string | null;
  exception?: string | null;
  sub_status?: string | null;
  description?: string | null;
  status_type?: string | null;
}

export interface SendcloudAddress {
  company_name?: string | null;
  name?: string | null;
  address_line_1?: string | null;
  address_line_2?: string | null;
  house_number?: string | null;
  postal_code?: string | null;
  city?: string | null;
  country_code?: string | null;
}

export interface SendcloudTracking {
  created_at?: string;
  announced_at?: string | null;
  details?: { is_to_service_point?: boolean | null; is_return?: boolean | null } | null;
  /** De más nuevo a más viejo, según la documentación. No nos fiamos: se reordena. */
  events: SendcloudTrackingEvent[];
  to_address?: SendcloudAddress | null;
  tracking_numbers?: Array<{ carrier_code?: string; tracking_number?: string; tracking_url?: string }>;
}

export class SendcloudError extends Error {
  constructor(
    message: string,
    public status: number | null,
  ) {
    super(message);
    this.name = "SendcloudError";
  }
}

export function sendcloudConfigured(): boolean {
  return Boolean(process.env.SENDCLOUD_PUBLIC_KEY && process.env.SENDCLOUD_SECRET_KEY);
}

function authHeader(): string {
  const pub = process.env.SENDCLOUD_PUBLIC_KEY;
  const secret = process.env.SENDCLOUD_SECRET_KEY;
  if (!pub || !secret) throw new SendcloudError("SENDCLOUD_PUBLIC_KEY / SENDCLOUD_SECRET_KEY not set", null);
  return `Basic ${Buffer.from(`${pub}:${secret}`).toString("base64")}`;
}

/**
 * Seguimiento de un envío por su número. `null` si Sendcloud no lo conoce (404):
 * pasa con los envíos que no salieron por Sendcloud, como los de CTT.
 */
export async function getSendcloudTracking(trackingNumber: string): Promise<SendcloudTracking | null> {
  const url = `${SENDCLOUD_API_BASE}/parcels/tracking/${encodeURIComponent(trackingNumber)}`;
  for (let attempt = 0; ; attempt++) {
    const { signal, timedOut } = fetchDeadline(ATTEMPT_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, { headers: { Authorization: authHeader(), accept: "application/json" }, signal });
    } catch (err) {
      if (attempt < MAX_RETRIES && !(err instanceof SendcloudError)) {
        await sleep(BACKOFF_MS * (attempt + 1));
        continue;
      }
      if (timedOut()) throw new SendcloudError(`Sendcloud timed out after ${ATTEMPT_TIMEOUT_MS}ms`, null);
      throw err;
    }
    if (res.status === 404) return null;
    if (!res.ok) {
      if (attempt < MAX_RETRIES && (res.status === 429 || res.status >= 500)) {
        await sleep(BACKOFF_MS * (attempt + 1));
        continue;
      }
      const body = await res.text().catch(() => "");
      throw new SendcloudError(`Sendcloud ${res.status}: ${body.slice(0, 300)}`, res.status);
    }
    const json = (await res.json()) as Partial<SendcloudTracking>;
    return { ...json, events: Array.isArray(json.events) ? json.events : [] } as SendcloudTracking;
  }
}
