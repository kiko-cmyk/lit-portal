/**
 * Los dos interruptores de los referidos (fase 0).
 *
 *   npx tsx scripts/test-referral-flag.ts
 *
 * REFERRALS gatea lo que se ve y se emite; REFERRAL_REWARDS, solo aplicar en
 * Seal. Ausente = cerrado; allowlist = literal; on = todos.
 */

import { referralRewardsEnabledFor, referralRewardsScope, referralsEnabledFor, referralsScope } from "../src/lib/flags";

let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`✓ ${name}`);
  else {
    console.error(`✗ ${name}`);
    failed++;
  }
}

function withEnv(env: Record<string, string | undefined>, fn: () => void) {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    prev[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

console.log("\n── REFERRALS ──\n");
withEnv({ REFERRALS: undefined, REFERRALS_ALLOWLIST: "1" }, () => {
  check("ausente = cerrado (aunque haya lista)", !referralsEnabledFor("1"));
  check("ausente: alcance off", referralsScope().mode === "off");
});
withEnv({ REFERRALS: "allowlist", REFERRALS_ALLOWLIST: " 111, 222 " }, () => {
  check("allowlist: dentro", referralsEnabledFor("111") && referralsEnabledFor("222"));
  check("allowlist: fuera", !referralsEnabledFor("333"));
  check("allowlist: literal, sin prefijos", !referralsEnabledFor("11"));
  const s = referralsScope();
  check("allowlist: alcance con los ids limpios", s.mode === "allowlist" && JSON.stringify(s.ids) === '["111","222"]');
});
withEnv({ REFERRALS: "allowlist", REFERRALS_ALLOWLIST: "" }, () => {
  check("allowlist vacía = cerrado", !referralsEnabledFor("111"));
});
withEnv({ REFERRALS: " ON " }, () => {
  check("on (con espacios y mayúsculas) = todos", referralsEnabledFor("999"));
  check("on: alcance on", referralsScope().mode === "on");
});
withEnv({ REFERRALS: "yes" }, () => {
  check("valor desconocido = cerrado", !referralsEnabledFor("1"));
});

console.log("\n── REFERRAL_REWARDS (independiente) ──\n");
withEnv({ REFERRALS: "on", REFERRAL_REWARDS: undefined }, () => {
  check("REFERRALS=on no abre las recompensas", !referralRewardsEnabledFor("1"));
});
withEnv({ REFERRALS: "off", REFERRAL_REWARDS: "allowlist", REFERRAL_REWARDS_ALLOWLIST: "42" }, () => {
  check("allowlist de recompensas: dentro", referralRewardsEnabledFor("42"));
  check("allowlist de recompensas: fuera", !referralRewardsEnabledFor("43"));
});
withEnv({ REFERRAL_REWARDS: "on" }, () => {
  check("on = todos", referralRewardsEnabledFor("43"));
  check("on: alcance on", referralRewardsScope().mode === "on");
});
withEnv({ REFERRAL_REWARDS: "allowlist", REFERRAL_REWARDS_ALLOWLIST: "42, 7" }, () => {
  const s = referralRewardsScope();
  check("allowlist: alcance con los ids", s.mode === "allowlist" && JSON.stringify(s.ids) === '["42","7"]');
});
withEnv({ REFERRAL_REWARDS: undefined }, () => {
  check("ausente: alcance off (la cola ni se lee)", referralRewardsScope().mode === "off");
});

console.log(failed ? `\n${failed} FALLO(S)\n` : "\nTodo bien.\n");
process.exit(failed ? 1 : 0);
