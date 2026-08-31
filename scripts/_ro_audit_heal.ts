// SOLO LECTURA. No escribe nada en ningun sistema.
import "dotenv/config";
import { seal, getLines, getBoxCount, getComposition, getChargeTotalCents, mapStatus, getNextBillingAttempt } from "../src/lib/seal";
import { repriceInPlace, ladderTotalCents, MAX_BOXES, planTargetLines, diffLines, chargeTotalCents } from "../src/lib/mix";
import { BOX_COUNT_BY_VARIANT } from "../src/lib/seal-plans";
import { runAsBackgroundJob } from "../src/lib/http-timeout";

const PRICES = { oneBoxCents: 2835, pack4Cents: 8505 };

async function main() {
  const subs = await seal.listAllSubscriptions();
  console.log("total subs en el libro:", subs.length);
  let active = 0, over = 0, under = 0, atTier = 0, blockedClamp = 0, blockedUnmapped = 0;
  const rows: string[] = [];
  for (const s of subs) {
    if (mapStatus(s) !== "active") continue;
    active++;
    const lines = getLines(s);
    if (!lines.length) continue;
    const boxCount = getBoxCount(s);
    const realBoxes = lines.reduce((a, l) => a + l.boxes, 0);
    const unmapped = lines.map((l) => String(l.variantId)).filter((v) => BOX_COUNT_BY_VARIANT[v] === undefined);
    const actual = getChargeTotalCents(s);
    if (realBoxes !== boxCount || realBoxes > MAX_BOXES) { blockedClamp++; continue; }
    if (unmapped.length) { blockedUnmapped++; continue; }
    const expected = ladderTotalCents(boxCount, PRICES);
    if (Math.abs(actual - expected) <= lines.length) { atTier++; continue; }
    if (actual < expected) { under++; continue; }
    over++;
    const comp = getComposition(s);
    let isNew = false;
    try {
      const plan = planTargetLines(comp, PRICES);
      const d = diffLines(lines, plan.lines);
      isNew = !d.adds.length && !d.removes.length;
    } catch (e) { isNew = false; }
    const rp = isNew ? null : repriceInPlace(lines, expected);
    const oneTime = (s.items ?? []).filter((it: any) => it.is_one_time_item).length;
    const dcodes = (s.items ?? []).flatMap((it: any) => (it.discount_codes ?? []).map((d: any) => d.code));
    const post = isNew ? expected : (rp ? rp.totalCents : null);
    const wouldVerifyOk = post === null ? null : Math.abs(post - expected) <= lines.length;
    const next = getNextBillingAttempt(s);
    rows.push([
      `sub ${s.id}`,
      `cajas=${realBoxes}`,
      `lineas=${lines.length}`,
      `actual=${actual}`,
      `tramo=${expected}`,
      `modelo=${isNew ? "nuevo" : "viejo"}`,
      `post=${post}`,
      `verifyOK=${wouldVerifyOk}`,
      `sube1linea=${rp ? rp.raisesAnyLine : "-"}`,
      `oneTime=${oneTime}`,
      `descuentos=[${dcodes.join(",")}]`,
      `cobro=${next?.date?.slice(0,10) ?? "-"}`,
      `lineset=${lines.map((l) => `${l.variantId}x${l.quantity}@${l.unitPrice}(b${l.boxes})`).join(" + ")}`,
    ].join(" | "));
  }
  console.log({ active, atTier, under, over, blockedClamp, blockedUnmapped });
  console.log("\n=== SUBS QUE EL HEAL TOCARIA ===");
  for (const r of rows) console.log(r);
}
runAsBackgroundJob(main).catch((e) => { console.error(e); process.exit(1); });
