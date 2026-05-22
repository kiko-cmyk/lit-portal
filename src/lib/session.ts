import crypto from "node:crypto";

/**
 * SHA-256 hash of a raw session id, hex-encoded.
 *
 * The raw session_id is the 64-char hex token we hand to the client
 * (via URL fragment in the OAuth handoff, then localStorage). We
 * persist only the HASH in `auth_sessions.session_id_hash`, never
 * the raw value. Reasoning (audit 2026-05-21 finding LOW):
 *
 *   If the DB ever leaks read-only (Supabase admin compromise,
 *   backup leak, support agent table read), the raw tokens are NOT
 *   exposed — only one-way hashes. An attacker would need to brute
 *   force 256 bits of entropy per session to recover a usable token.
 *
 * Used by /api/auth/callback (insert), withCustomer (lookup), and
 * /api/auth/logout (delete).
 */
export function hashSessionId(rawSessionId: string): string {
  return crypto.createHash("sha256").update(rawSessionId).digest("hex");
}
