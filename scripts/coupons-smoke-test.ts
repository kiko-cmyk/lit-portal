/**
 * Prueba de humo de los descuentos padre de los cupones de campaña: da de alta
 * un código de prueba en cada padre, comprueba que resuelve a ese padre, lo
 * borra y comprueba que ha desaparecido. No toca ningún código de cliente.
 *
 *   npx tsx scripts/coupons-smoke-test.ts   (con el entorno de producción cargado)
 */
import {
  addCouponCode,
  DISCOVERY_COUPON_PARENT_GID,
  removeCouponCode,
  SURVEY_COUPON_PARENT_GID,
} from "../src/lib/coupon-parent";
import { cryptoRandomInt } from "../src/lib/referral-core";
import { findCodeDiscountNodeId } from "../src/lib/referral-shopify";

async function main() {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let failed = 0;
  for (const [name, parent] of [["perfilado", SURVEY_COUPON_PARENT_GID], ["discovery", DISCOVERY_COUPON_PARENT_GID]] as const) {
    let code = "LIT-";
    for (let i = 0; i < 8; i++) code += alphabet[cryptoRandomInt(alphabet.length)];
    const t0 = Date.now();
    await addCouponCode(parent, code);
    const addMs = Date.now() - t0;
    const owner = await findCodeDiscountNodeId(code);
    const removed = await removeCouponCode(parent, code);
    const after = await findCodeDiscountNodeId(code);
    const ok = owner === parent && removed && after === null;
    if (!ok) failed++;
    console.log(`${ok ? "✓" : "✗"} ${name}: alta en ${addMs} ms, resuelve al padre: ${owner === parent}, borrado: ${removed}, ya no existe: ${after === null}`);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
