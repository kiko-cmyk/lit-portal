/**
 * Cliente mínimo de la API de Hive (2026-10-20): solo LEE el estado de entrega de los envíos.
 *
 * Hive es el almacén que prepara y manda los pedidos. El portal no se integra con
 * Hive (decisión del 27-abr: todo lo cubren Seal y Shopify). Esto es una excepción,
 * para el aviso de punto de recogida (SUB-08, pedido por Juan el 20-oct), porque Hive
 * es el único que sabe si un paquete espera en el punto: Shopify no guarda la llegada
 * y Klaviyo solo se entera de la recogida. Solo GET: nada de aquí escribe en Hive.
 *
 * Merchant API v2, `GET https://app.hive.app/merchant_api/v2/shipments`, con la clave
 * de la integración como Bearer (`HIVE_API_KEY`). `merchant_order_id` es el id de
 * pedido de Shopify. Límite de 100 peticiones por minuto. El filtro por varios pedidos
 * va con los ids separados por comas: la forma repetida (`merchant_order_id[in][]=`)
 * devuelve 500 (comprobado el 20-oct). Ver https://developers.hive.app
 */

import { fetchDeadline } from "./http-timeout";

const HIVE_API_BASE = "https://app.hive.app/merchant_api/v2";
const ATTEMPT_TIMEOUT_MS = 8_000;
const MAX_RETRIES = 2;
const BACKOFF_MS = 600;
/** Ids por petición. 50 ids de Shopify son unos 750 caracteres de URL. */
const IDS_PER_REQUEST = 50;
const MAX_PAGES = 10;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type HiveDeliveryStatus =
  | "action_required"
  | "awaiting_customer_pickup"
  | "delivered"
  | "in_transit"
  | "information_transmitted"
  | "other"
  | "out_for_delivery"
  | "return_initiated"
  | "returned_to_sender";

export interface HiveShipment {
  id: number;
  merchant_order_id: string;
  /** `shipped` cuando sale del almacén; el estado del transportista va en `delivery_status`. */
  status: string;
  delivery_status: HiveDeliveryStatus | null;
  /** «GLS ES», «CTT», «Correos ES». */
  shipment_provider: string | null;
  /** «GLS ES Parcel Point Mainland», «CTT Express ES Madrid»… */
  shipping_method: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  shipped_at: string | null;
  delivered_at: string | null;
  /** Con zona horaria: «2026-10-16T15:26:10.529+02:00». */
  updated_at: string;
}

export class HiveError extends Error {
  constructor(
    message: string,
    public status: number | null,
  ) {
    super(message);
    this.name = "HiveError";
  }
}

export function hiveConfigured(): boolean {
  return Boolean(process.env.HIVE_API_KEY);
}

async function getJson(url: string): Promise<{ data?: HiveShipment[]; pagination?: { next_page_url?: string | null } }> {
  const key = process.env.HIVE_API_KEY;
  if (!key) throw new HiveError("HIVE_API_KEY not set", null);
  for (let attempt = 0; ; attempt++) {
    const { signal, timedOut } = fetchDeadline(ATTEMPT_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${key}`, accept: "application/json" }, signal });
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        await sleep(BACKOFF_MS * (attempt + 1));
        continue;
      }
      if (timedOut()) throw new HiveError(`Hive timed out after ${ATTEMPT_TIMEOUT_MS}ms`, null);
      throw err;
    }
    if (!res.ok) {
      if (attempt < MAX_RETRIES && (res.status === 429 || res.status >= 500)) {
        await sleep(BACKOFF_MS * (attempt + 1));
        continue;
      }
      const body = await res.text().catch(() => "");
      throw new HiveError(`Hive ${res.status}: ${body.slice(0, 300)}`, res.status);
    }
    return (await res.json()) as { data?: HiveShipment[]; pagination?: { next_page_url?: string | null } };
  }
}

/** Los envíos de Hive de estos pedidos de Shopify (ids numéricos), de todas las páginas. */
export async function getHiveShipmentsByOrderIds(orderIds: string[]): Promise<HiveShipment[]> {
  const ids = [...new Set(orderIds.filter((id) => /^\d+$/.test(id)))];
  const out: HiveShipment[] = [];
  for (let i = 0; i < ids.length; i += IDS_PER_REQUEST) {
    const chunk = ids.slice(i, i + IDS_PER_REQUEST);
    let url: string | null =
      `${HIVE_API_BASE}/shipments?limit=100&merchant_order_id%5Bin%5D=${chunk.join(",")}`;
    for (let page = 0; url && page < MAX_PAGES; page++) {
      const json = await getJson(url);
      out.push(...(json.data ?? []));
      url = json.pagination?.next_page_url ?? null;
    }
  }
  return out;
}
