/**
 * Crea los dos descuentos padre de los cupones de campaña (Juan 2026-10-14):
 * «Cupón perfilado · 5€» y «Cupón Discovery Set · 4,99€». UNA vez.
 *
 * Los códigos de cada cliente (`LIT-XXXXXXXX`) van DENTRO, como los de
 * «Referidos · Amigo 10 €». Configuración en src/lib/coupon-parent.ts; los
 * importes salen de survey-discount.ts y discovery-discount.ts para que no
 * puedan divergir de lo que promete el email.
 *
 * Uso (con el entorno de producción cargado, ver ops/prod-env.sh):
 *   npx tsx scripts/coupons-create-parents.ts           # mira si ya existen, no crea
 *   npx tsx scripts/coupons-create-parents.ts --apply   # los crea (OK explícito antes)
 *
 * Imprime los gid que van a SURVEY_COUPON_PARENT_GID y DISCOVERY_COUPON_PARENT_GID
 * en src/lib/coupon-parent.ts.
 *
 * El código semilla es aleatorio y no se apunta en ningún sitio: Shopify exige un
 * código para crear el descuento, y uno que nadie conoce no regala nada.
 */

import { COUPON_SEED_PREFIX, createCouponParent, type CouponParentDef } from "../src/lib/coupon-parent";
import { DISCOVERY_DISCOUNT_VALUE_EUR } from "../src/lib/discovery-discount";
import { cryptoRandomInt } from "../src/lib/referral-core";
import { shopifyAdmin } from "../src/lib/shopify-admin";
import { DISCOUNT_VALUE_EUR } from "../src/lib/survey-discount";

const apply = process.argv.includes("--apply");

const PARENTS: Array<{ name: string; def: CouponParentDef }> = [
  {
    name: "SURVEY_COUPON_PARENT_GID",
    def: { title: "Cupón perfilado · 5€", amountEur: String(DISCOUNT_VALUE_EUR), appliesOnOneTimePurchase: true },
  },
  {
    name: "DISCOVERY_COUPON_PARENT_GID",
    // NO en compra única: la promesa es devolver los 4,99 € al pedir la caja con
    // envíos programados (ver discovery-discount.ts).
    def: { title: "Cupón Discovery Set · 4,99€", amountEur: String(DISCOVERY_DISCOUNT_VALUE_EUR), appliesOnOneTimePurchase: false },
  },
];

async function findExisting(title: string): Promise<Array<{ id: string; status: string }>> {
  // Búsqueda amplia y filtro EXACTO aquí: el `title:` de la búsqueda de Shopify no
  // es un prefijo fiable (memoria del proyecto, 2026-09).
  const data = await shopifyAdmin.graphql<{
    codeDiscountNodes: { nodes: Array<{ id: string; codeDiscount: { title?: string; status?: string } }> };
  }>(
    `query findCouponParent($q: String!) {
      codeDiscountNodes(first: 50, query: $q) {
        nodes { id codeDiscount { ... on DiscountCodeBasic { title status } } }
      }
    }`,
    { q: "Cupón" },
  );
  return data.codeDiscountNodes.nodes
    .filter((n) => n.codeDiscount?.title === title)
    .map((n) => ({ id: n.id, status: n.codeDiscount.status ?? "" }));
}

async function main() {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  for (const p of PARENTS) {
    const existing = await findExisting(p.def.title);
    if (existing.length) {
      console.log(`Ya existe «${p.def.title}»: ${existing.map((e) => `${e.id} (${e.status})`).join(", ")}`);
      console.log(`  ${p.name} = "${existing[0].id}"`);
      continue;
    }
    if (!apply) {
      console.log(`No existe «${p.def.title}» (${p.def.amountEur} €, compra única: ${p.def.appliesOnOneTimePurchase}). Para crearlo: --apply`);
      continue;
    }
    let seed = COUPON_SEED_PREFIX;
    for (let i = 0; i < 12; i++) seed += alphabet[cryptoRandomInt(alphabet.length)];
    const id = await createCouponParent(p.def, seed);
    console.log(`Creado «${p.def.title}».`);
    console.log(`  ${p.name} = "${id}"`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
