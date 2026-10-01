import { NextResponse, type NextRequest } from "next/server";
import { CronAuthError, requireCron } from "@/lib/cron-auth";
import { shopifyAdmin } from "@/lib/shopify-admin";

/**
 * GET /apps/portal/api/cron/survey-discount-cleanup
 *
 * Diario: borra de Shopify los cupones de campaña (perfilado y Discovery Set)
 * que ya han caducado Y no ha usado nadie.
 *
 * ── Por qué existe ──
 *
 * La campaña B va a ~4.068 personas. Con una respuesta del 15-20% son 600-800
 * cupones, uno por cliente y para siempre. Un cupón caducado NO puede canjearse
 * (Shopify lo marca EXPIRED y el checkout lo rechaza), así que esto no arregla
 * ningún agujero: es higiene. Sin ella, la lista de descuentos del admin queda
 * inservible para buscar cualquier otra cosa.
 *
 * ── Las tres guardas, y ninguna sobra ──
 *
 * 1. SOLO LOS SUYOS. Filtra por los prefijos que ponen `issueSurveyDiscount`
 *    ("Perfilado ") e `issueDiscoveryDiscount` ("Discovery "). Un cron que
 *    borra descuentos y se equivoca de filtro se lleva por delante los de una
 *    campaña de marketing, y eso no se deshace: hay que recrearlos a mano y los
 *    que estaban en emails ya enviados quedan muertos.
 *
 *    Por eso, además del `query:` que manda Shopify, el título se REVERIFICA
 *    aquí contra esos dos prefijos antes de borrar nada: un `query` de Shopify
 *    que ensanche (o un prefijo nuevo que alguien añada sin mirar) no puede
 *    convertirse en un borrado de cupones ajenos.
 *
 * 2. SOLO LOS EXPIRED, según el `status` que devuelve Shopify. Nunca por una
 *    fecha calculada aquí: una diferencia de zona horaria borraría cupones
 *    vivos el último día, que es justo cuando la gente los usa.
 *
 * 3. SOLO LOS NO USADOS (`asyncUsageCount === 0`). Los canjeados se quedan:
 *    son los que aparecen en pedidos reales y los que permiten medir cuánto
 *    convirtió la campaña. Borrarlos ahorraría ruido y costaría el dato.
 *
 * La fila de `profile_survey_answers` NO se toca: conserva el código, así que
 * si alguien reclama se puede comprobar que existió y cuándo se emitió.
 */

export const maxDuration = 60;

/** Tope por tirada. Con ~800 cupones a 30 días vista, el goteo diario es de
 *  decenas: 200 sobra y evita que una acumulación inesperada agote la función. */
const MAX_DELETES = 200;

/** Los prefijos de título de NUESTROS cupones de campaña. Cualquier descuento
 *  cuyo título no empiece por uno de estos no lo toca este cron. */
const CAMPAIGN_PREFIXES = ["Perfilado ", "Discovery "];

interface DiscountNode {
  id: string;
  codeDiscount: {
    title?: string;
    status?: string;
    asyncUsageCount?: number;
  };
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    requireCron(req);
  } catch (err) {
    if (err instanceof CronAuthError) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    throw err;
  }

  let scanned = 0;
  let deleted = 0;
  let keptInUse = 0;
  let failed = 0;
  let cursor: string | null = null;

  for (let page = 0; page < 40; page++) {
    const data: {
      codeDiscountNodes: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: DiscountNode[];
      };
    } = await shopifyAdmin.graphql(
      `query expiredSurveyDiscounts($cursor: String) {
        codeDiscountNodes(first: 50, after: $cursor, query: "title:Perfilado* OR title:Discovery*") {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            codeDiscount {
              ... on DiscountCodeBasic { title status asyncUsageCount }
            }
          }
        }
      }`,
      { cursor },
    );

    const { nodes, pageInfo } = data.codeDiscountNodes;
    scanned += nodes.length;

    for (const n of nodes) {
      const d = n.codeDiscount ?? {};
      // Guarda 1, revalidada en casa: solo títulos que empiezan por uno de
      // NUESTROS prefijos. El `query:` de Shopify ya filtra, pero es una
      // sintaxis laxa (y este repo ya se ha encontrado con filtros de Shopify
      // que se ignoran en silencio y devuelven TODO). Si alguna vez devolviera
      // de más, aquí se para antes del delete.
      if (!CAMPAIGN_PREFIXES.some((pre) => d.title?.startsWith(pre))) continue;
      if (d.status !== "EXPIRED") continue;
      if ((d.asyncUsageCount ?? 0) > 0) {
        keptInUse++;
        continue;
      }
      if (deleted >= MAX_DELETES) break;

      try {
        const res = await shopifyAdmin.graphql<{
          discountCodeDelete: {
            deletedCodeDiscountId: string | null;
            userErrors: Array<{ message: string }>;
          };
        }>(
          `mutation deleteSurveyDiscount($id: ID!) {
            discountCodeDelete(id: $id) {
              deletedCodeDiscountId
              userErrors { field message code }
            }
          }`,
          { id: n.id },
        );
        if (res.discountCodeDelete.userErrors?.length) {
          failed++;
          console.warn(
            `[survey-discount-cleanup] ${d.title}: ${res.discountCodeDelete.userErrors
              .map((e) => e.message)
              .join("; ")}`,
          );
        } else {
          deleted++;
        }
      } catch (err) {
        // Un fallo suelto no puede abortar la tirada: mañana se reintenta,
        // porque el cupón sigue EXPIRED y sin usar.
        failed++;
        console.warn(`[survey-discount-cleanup] ${d.title} falló:`, err);
      }
    }

    if (!pageInfo.hasNextPage || deleted >= MAX_DELETES) break;
    cursor = pageInfo.endCursor;
  }

  return NextResponse.json({ ok: true, scanned, deleted, keptInUse, failed });
}
