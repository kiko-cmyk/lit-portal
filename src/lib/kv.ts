/**
 * KV efímero compartido entre invocaciones (tabla `portal_kv`, LIT-470).
 *
 * Best-effort por contrato: NUNCA lanza y NUNCA bloquea al caller más de lo
 * que tarda una consulta corta. Quien lo usa tiene que funcionar igual con
 * `null` (fail-open): hoy lo consume el cooldown de alertas transitorias, y
 * si Supabase no contesta la alerta sale igual, como antes de existir esto.
 *
 * NO es un sitio para secretos: un token de Shopify aquí sería un secreto
 * fuera del `.env` (CLAUDE.md). Para eso sigue valiendo la caché en memoria.
 */
import { supabaseAdmin } from "./supabase";

export interface KvEntry<T> {
  value: T;
  updatedAt: number; // epoch ms
}

export async function kvGet<T>(key: string): Promise<KvEntry<T> | null> {
  try {
    const { data, error } = await supabaseAdmin()
      .from("portal_kv")
      .select("value, expires_at, updated_at")
      .eq("key", key)
      .maybeSingle();
    if (error || !data) return null;
    if (data.expires_at && new Date(data.expires_at).getTime() < Date.now()) return null;
    return { value: data.value as T, updatedAt: new Date(data.updated_at).getTime() };
  } catch {
    return null;
  }
}

export async function kvSet<T>(key: string, value: T, ttlMs: number): Promise<boolean> {
  try {
    const now = new Date();
    const { error } = await supabaseAdmin().from("portal_kv").upsert(
      {
        key,
        value: value as unknown as Record<string, unknown>,
        expires_at: new Date(now.getTime() + ttlMs).toISOString(),
        updated_at: now.toISOString(),
      },
      { onConflict: "key" },
    );
    return !error;
  } catch {
    return false;
  }
}
