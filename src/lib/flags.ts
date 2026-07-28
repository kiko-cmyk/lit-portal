/**
 * Feature flags, resolved SERVER-SIDE.
 *
 * Follows the `SUBSCRIPTION_CACHE_FIRST=off|shadow|on` convention already in
 * .env.example. Deliberately NOT `NEXT_PUBLIC_*`: the cohort changes with a Vercel env
 * edit and no rebuild, and the allowlist never reaches the browser.
 */

/** MIX_FLAVORS=off | allowlist | on */
function mixMode(): "off" | "allowlist" | "on" {
  const v = (process.env.MIX_FLAVORS ?? "off").trim().toLowerCase();
  return v === "on" ? "on" : v === "allowlist" ? "allowlist" : "off";
}

/**
 * Can this customer CREATE a flavor mix?
 *
 * Gates creation only. Reading a mix is deliberately flag-free: if turning the flag
 * off changed how an existing mixed subscription reads, those subscribers would
 * suddenly see a single flavor in the portal and in their emails.
 */
export function mixEnabledForCustomer(customerId: string): boolean {
  const mode = mixMode();
  if (mode === "on") return true;
  if (mode === "off") return false;
  return (process.env.MIX_FLAVORS_ALLOWLIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(String(customerId));
}

/**
 * Whether the dry-run query param is honoured for this customer in PRODUCTION.
 *
 * The portal has no staging: changes go straight to production and are tested in the
 * real portal. So the only way to walk the real UI without writing to Seal is to allow
 * dry-run in prod for the allowlisted cohort. Restricted to the mix allowlist (never
 * `MIX_FLAVORS=on`) so it can never become a public no-op switch that makes every
 * customer's changes silently do nothing.
 */
export function dryRunAllowedInProdFor(customerId: string): boolean {
  if (mixMode() !== "allowlist") return false;
  return mixEnabledForCustomer(customerId);
}
