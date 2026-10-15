/**
 * Crea el descuento padre «Referidos · Amigo 10 €» (referidos, fase 0). UNA vez.
 *
 * Todos los códigos personales (`MARIA27`) cuelgan de él: un único sitio para
 * cambiar el importe o apagar el lado del amigo para todos (`endsAt` = ahora, en
 * el admin de Shopify). Configuración en src/lib/referral-shopify.ts.
 *
 * Uso (con el entorno de producción cargado: set -a; . ./.env.local; set +a):
 *   npx tsx scripts/referral-create-parent-discount.ts           # mira si ya existe, no crea
 *   npx tsx scripts/referral-create-parent-discount.ts --apply   # lo crea (OK explícito antes)
 *
 * Imprime el gid que va a REFERRAL_FRIEND_DISCOUNT_ID en Vercel (y redeploy).
 *
 * El código semilla es aleatorio y no se apunta en ningún sitio: Shopify exige un
 * código para crear el descuento, y uno que nadie conoce no regala nada.
 */

import { cryptoRandomInt } from "../src/lib/referral-core";
import { createFriendParentDiscount, FRIEND_DISCOUNT_TITLE } from "../src/lib/referral-shopify";
import { shopifyAdmin } from "../src/lib/shopify-admin";

const apply = process.argv.includes("--apply");

async function findExisting(): Promise<Array<{ id: string; title: string; status: string }>> {
  // Búsqueda amplia y filtro EXACTO aquí: el `title:` de la búsqueda de Shopify no
  // es un prefijo fiable (memoria del proyecto, 2026-09).
  const data = await shopifyAdmin.graphql<{
    codeDiscountNodes: {
      nodes: Array<{ id: string; codeDiscount: { title?: string; status?: string } }>;
    };
  }>(
    `query findReferralParent($q: String!) {
      codeDiscountNodes(first: 50, query: $q) {
        nodes { id codeDiscount { ... on DiscountCodeBasic { title status } } }
      }
    }`,
    { q: "Referidos" },
  );
  return data.codeDiscountNodes.nodes
    .filter((n) => n.codeDiscount?.title === FRIEND_DISCOUNT_TITLE)
    .map((n) => ({ id: n.id, title: n.codeDiscount.title ?? "", status: n.codeDiscount.status ?? "" }));
}

async function main() {
  const existing = await findExisting();
  if (existing.length) {
    console.log(`Ya existe «${FRIEND_DISCOUNT_TITLE}»:`);
    for (const e of existing) console.log(`  ${e.id}  (${e.status})`);
    console.log("\nNo se crea otro. REFERRAL_FRIEND_DISCOUNT_ID =", existing[0].id);
    return;
  }
  if (!apply) {
    console.log(`No existe «${FRIEND_DISCOUNT_TITLE}». Para crearlo: --apply`);
    return;
  }
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let seed = "REFSEED";
  for (let i = 0; i < 12; i++) seed += alphabet[cryptoRandomInt(alphabet.length)];
  const id = await createFriendParentDiscount(seed);
  console.log(`Creado «${FRIEND_DISCOUNT_TITLE}».`);
  console.log(`REFERRAL_FRIEND_DISCOUNT_ID=${id}`);
  console.log("Ponlo en Vercel (Production) y haz Redeploy.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
