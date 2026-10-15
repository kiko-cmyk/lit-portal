/**
 * Operación a mano de los referidos (fase 0).
 *
 * Uso (con el entorno de producción cargado: set -a; . ./.env.local; set +a):
 *   npx tsx scripts/referral-admin.ts status
 *   npx tsx scripts/referral-admin.ts review                       # las que esperan a una persona
 *   npx tsx scripts/referral-admin.ts approve <conversionId> --apply
 *   npx tsx scripts/referral-admin.ts reject <conversionId> <motivo> --apply
 *   npx tsx scripts/referral-admin.ts requeue <rewardId> --apply      # failed → en cola (si le corresponde)
 *   npx tsx scripts/referral-admin.ts requeue <rewardId> --force --apply  # motivos «el código pudo quedarse sin verse», tras mirarlo en Seal
 *   npx tsx scripts/referral-admin.ts detach-all [--apply]         # EMERGENCIA: quita todos los LITREF de Seal
 *
 * Sin --apply no escribe nada.
 *
 * detach-all: apagar ANTES `REFERRAL_REWARDS` (y Redeploy). Si no, la pasada siguiente
 * del cron (cada 4 h) vuelve a aplicar lo que se acaba de quitar.
 */

import {
  approveReviewedConversion,
  detachAllRewards,
  rejectConversion,
  requeueFailedReward,
} from "../src/lib/referral-reward";
import { supabaseAdmin } from "../src/lib/supabase";

const [cmd, ...rest] = process.argv.slice(2);
const apply = rest.includes("--apply");
const force = rest.includes("--force");
const positional = rest.filter((a) => !a.startsWith("--"));

async function countBy(table: string): Promise<Record<string, number>> {
  const { data, error } = await supabaseAdmin().from(table).select("status");
  if (error) throw new Error(`${table}: ${error.message}`);
  const out: Record<string, number> = {};
  for (const r of data ?? []) out[r.status as string] = (out[r.status as string] ?? 0) + 1;
  return out;
}

async function main() {
  switch (cmd) {
    case "status": {
      console.log("referral_codes:      ", await countBy("referral_codes"));
      console.log("referral_conversions:", await countBy("referral_conversions"));
      console.log("referral_rewards:    ", await countBy("referral_rewards"));
      return;
    }
    case "review": {
      const { data, error } = await supabaseAdmin()
        .from("referral_conversions")
        .select("id, referrer_customer_id, friend_customer_id, friend_order_name, purchase_type, reason, converted_at")
        .eq("status", "review")
        .order("converted_at", { ascending: true });
      if (error) throw new Error(error.message);
      console.table(data ?? []);
      return;
    }
    case "approve": {
      const id = positional[0];
      if (!id) throw new Error("falta el id de la conversión");
      if (!apply) return console.log(`Se aprobaría ${id} (review → qualified + recompensa + aviso). Añade --apply.`);
      await approveReviewedConversion(id);
      console.log(`Aprobada ${id}.`);
      return;
    }
    case "reject": {
      const [id, reason] = positional;
      if (!id || !reason) throw new Error("uso: reject <conversionId> <motivo>");
      if (!apply) return console.log(`Se rechazaría ${id} (${reason}). Añade --apply.`);
      await rejectConversion(id, reason);
      console.log(`Rechazada ${id}.`);
      return;
    }
    case "requeue": {
      const id = positional[0];
      if (!id) throw new Error("falta el id de la recompensa");
      if (!apply) {
        return console.log(
          `Se reencolaría ${id} (failed → queued), quitando antes su código de Seal si se ve. Si ya se cobró, se cierra como consumida en vez de reencolarse. Solo si le corresponde. Añade --apply${force ? "" : " (y --force si el motivo lo pide)"}.`,
        );
      }
      console.log(await requeueFailedReward(id, { force }));
      return;
    }
    case "detach-all": {
      if (apply && (process.env.REFERRAL_REWARDS ?? "off").trim().toLowerCase() !== "off") {
        console.warn(
          "AVISO: REFERRAL_REWARDS no está en «off» en este entorno. Apágalo en Vercel (y Redeploy) o la pasada siguiente del cron (cada 4 h) vuelve a aplicar.",
        );
      }
      const res = await detachAllRewards({ dryRun: !apply });
      console.table(res);
      if (!apply) console.log("Nada tocado. Para quitarlos de verdad: --apply (con REFERRAL_REWARDS=off antes).");
      return;
    }
    default:
      console.log("Comandos: status | review | approve <id> | reject <id> <motivo> | requeue <rewardId> [--force] | detach-all");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
