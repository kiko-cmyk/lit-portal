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

/** PROFILE_SURVEY=off | allowlist | on */
function profileSurveyMode(): "off" | "allowlist" | "on" {
  const v = (process.env.PROFILE_SURVEY ?? "off").trim().toLowerCase();
  return v === "on" ? "on" : v === "allowlist" ? "allowlist" : "off";
}

/**
 * Can this customer SEE and SUBMIT the profile survey?
 *
 * Gates showing and sending, never reading: si se apaga el flag, las respuestas
 * ya guardadas se siguen leyendo y sincronizando. Un flag que además escondiera
 * el dato ya recogido convertiría el interruptor de apagado en una pérdida.
 *
 * OJO al probarlo en producción: el dry-run NO cuelga de esta allowlist, cuelga
 * de la de mix (`dryRunAllowedInProdFor` justo debajo). Quien vaya a hacer el
 * paseo de verificación tiene que estar en LAS DOS: `PROFILE_SURVEY_ALLOWLIST`
 * y `MIX_FLAVORS_ALLOWLIST`, con `MIX_FLAVORS=allowlist`.
 */
export function profileSurveyEnabledFor(customerId: string): boolean {
  const mode = profileSurveyMode();
  if (mode === "on") return true;
  if (mode === "off") return false;
  return (process.env.PROFILE_SURVEY_ALLOWLIST ?? "")
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

/**
 * The Shopify customer tag that marks a wholesale account. LIT's store is
 * non-Plus, so there are no Shopify Companies: the whole B2B experience
 * (storefront gate, pricing, portal) hangs off this single tag.
 */
const B2B_TAG = "b2b";

/**
 * B2B_ACCOUNT_ONLY=on|off (default on).
 *
 * Rollback lever: setting it to `off` in Vercel makes every wholesale customer
 * see the portal exactly as it was before B2B mode, with no deploy.
 */
function b2bAccountOnlyEnabled(): boolean {
  return (process.env.B2B_ACCOUNT_ONLY ?? "on").trim().toLowerCase() !== "off";
}

/**
 * Is this a wholesale customer? Compared case-insensitively: Shopify preserves
 * the case a tag was created with (the live tag is `B2B`) and support adds tags
 * by hand, so matching the literal string would be one typo away from silently
 * treating a partner as a retail customer.
 *
 * Resolved SERVER-SIDE and shipped to the browser as one boolean, so the signal
 * can't be forged from the client the way a NEXT_PUBLIC_* flag could.
 */
export function isB2BCustomer(tags: string[] | null | undefined): boolean {
  if (!b2bAccountOnlyEnabled()) return false;
  return (tags ?? []).some((t) => t.trim().toLowerCase() === B2B_TAG);
}
