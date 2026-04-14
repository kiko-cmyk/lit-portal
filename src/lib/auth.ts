import { supabase } from './supabase';
import { v4 as uuidv4 } from 'uuid';

const TTL_MINUTES = parseInt(process.env.AUTH_TOKEN_TTL_MINUTES || '15');

export interface AuthSession {
  email: string;
  customer_name: string | null;
  shopify_customer_id: string | null;
  sessionToken?: string;
}

// Generate a magic link token and store it in Supabase
export async function createMagicToken(email: string): Promise<string> {
  const token = uuidv4();
  const expiresAt = new Date(Date.now() + TTL_MINUTES * 60 * 1000).toISOString();

  // Delete any existing tokens for this email
  await supabase
    .from('auth_tokens')
    .delete()
    .eq('email', email.toLowerCase());

  // Insert new token
  await supabase
    .from('auth_tokens')
    .insert({
      token,
      email: email.toLowerCase(),
      expires_at: expiresAt,
      used: false,
    });

  return token;
}

// Validate a token and return the session
export async function validateToken(token: string): Promise<AuthSession | null> {
  const { data, error } = await supabase
    .from('auth_tokens')
    .select('email, expires_at, used')
    .eq('token', token)
    .single();

  if (error || !data) return null;
  if (data.used) return null;
  if (new Date(data.expires_at) < new Date()) return null;

  // Mark token as used (single-use)
  await supabase
    .from('auth_tokens')
    .update({ used: true })
    .eq('token', token);

  // Create a longer-lived session token for portal navigation
  const sessionToken = uuidv4();
  const sessionExpires = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

  await supabase
    .from('auth_tokens')
    .insert({
      token: sessionToken,
      email: data.email,
      expires_at: sessionExpires,
      used: false,
      is_session: true,
    });

  return {
    email: data.email,
    customer_name: null,
    shopify_customer_id: null,
    sessionToken,
  };
}

// Validate a session token (for portal navigation — reusable)
export async function validateSession(token: string): Promise<AuthSession | null> {
  const { data, error } = await supabase
    .from('auth_tokens')
    .select('email, expires_at, is_session')
    .eq('token', token)
    .eq('is_session', true)
    .single();

  if (error || !data) return null;
  if (new Date(data.expires_at) < new Date()) return null;

  return {
    email: data.email,
    customer_name: null,
    shopify_customer_id: null,
  };
}

// Generate the magic link URL
export function getMagicLinkUrl(token: string): string {
  return `https://portal.litsalt.com?token=${token}`;
}
