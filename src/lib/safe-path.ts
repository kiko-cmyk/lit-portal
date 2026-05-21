/**
 * Single source of truth for "is this user-supplied path safe to use
 * as a redirect target?". Used by /api/auth/login (return_to), /api/auth/
 * callback (state.r), and the handoff page (?to).
 *
 * Hardened 2026-05-21 after audit: reject backslashes and percent-encoded
 * schemes. Pre-fix `/\evil.com` passed validation because the original
 * regex only checked the prefix.
 */
export function isSafeRelativePath(p: string): boolean {
  if (typeof p !== "string" || p.length === 0) return false;
  if (!p.startsWith("/")) return false;
  if (p.startsWith("//")) return false;       // protocol-relative
  if (p.startsWith("/\\")) return false;      // backslash-relative (some browsers treat as scheme)
  if (p.includes("\\")) return false;         // backslash anywhere
  if (p.includes("://")) return false;        // scheme injection
  if (/^\/%2f/i.test(p)) return false;        // encoded "//"
  if (/^\/%5c/i.test(p)) return false;        // encoded "\"
  return true;
}
