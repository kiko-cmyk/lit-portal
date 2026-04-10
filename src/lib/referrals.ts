import { supabase } from './supabase';

// Generate a unique referral code for a customer
export async function getOrCreateReferralCode(email: string): Promise<string> {
  const lowerEmail = email.toLowerCase();

  // Check existing
  const { data } = await supabase
    .from('referral_codes')
    .select('code')
    .eq('customer_email', lowerEmail)
    .single();

  if (data) return data.code;

  // Generate code from email: first part + random 4 chars
  const prefix = lowerEmail.split('@')[0].slice(0, 6).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const suffix = Math.random().toString(36).substring(2, 6).toUpperCase();
  const code = `${prefix}${suffix}`;

  await supabase.from('referral_codes').insert({
    code,
    customer_email: lowerEmail,
  });

  return code;
}

// Get referral stats for a customer
export async function getReferralStats(email: string) {
  const lowerEmail = email.toLowerCase();

  const { data: codeData } = await supabase
    .from('referral_codes')
    .select('code')
    .eq('customer_email', lowerEmail)
    .single();

  if (!codeData) return { code: null, conversions: [], totalPoints: 0 };

  const { data: conversions } = await supabase
    .from('referral_conversions')
    .select('*')
    .eq('referrer_code', codeData.code)
    .order('created_at', { ascending: false });

  const totalPoints = (conversions || []).reduce((sum, c) => sum + (c.points_awarded || 0), 0);

  return {
    code: codeData.code,
    conversions: conversions || [],
    totalPoints,
  };
}
