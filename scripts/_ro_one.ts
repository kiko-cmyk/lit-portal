import "dotenv/config";
import { seal } from "../src/lib/seal";
import { runAsBackgroundJob } from "../src/lib/http-timeout";
async function main() {
  for (const id of [14682293, 13089232, 15504145, 12486429]) {
    const s: any = await seal.getSubscriptionById(id);
    console.log("=== sub", id, "created", s?.created_at, "status", s?.status, "interval", s?.delivery_interval, s?.delivery_interval_count, "total_value", s?.total_value);
    for (const it of s?.items ?? []) {
      console.log("   item", it.id, "variant", it.variant_id, "qty", it.quantity, "price", it.price, "one_time", it.is_one_time_item, "created", it.created_at, "updated", it.updated_at, "dc", JSON.stringify(it.discount_codes ?? []));
    }
    const bas = (s?.billing_attempts ?? []).filter((b: any) => b.completed_at).sort((a: any,b: any)=>b.date.localeCompare(a.date)).slice(0,4);
    for (const b of bas) console.log("   cobro", b.date, "completed", b.completed_at, "order", b.order_id ?? b.shopify_order_id ?? "-");
  }
}
runAsBackgroundJob(main).catch((e) => { console.error(e); process.exit(1); });
