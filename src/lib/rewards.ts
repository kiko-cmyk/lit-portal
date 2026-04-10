import { supabase } from './supabase';

export interface RewardsBalance {
  customer_email: string;
  total_points: number;
  current_tier: string;
  updated_at: string;
}

export interface RewardsTier {
  name: string;
  min_points: number;
  benefits_json: string[];
}

// Get or create balance for a customer
export async function getBalance(email: string): Promise<RewardsBalance> {
  const { data } = await supabase
    .from('rewards_balances')
    .select('*')
    .eq('customer_email', email.toLowerCase())
    .single();

  if (data) return data;

  // Create default balance
  const newBalance = {
    customer_email: email.toLowerCase(),
    total_points: 0,
    current_tier: 'bronze',
  };

  await supabase.from('rewards_balances').insert(newBalance);
  return { ...newBalance, updated_at: new Date().toISOString() };
}

// Get all tiers
export async function getTiers(): Promise<RewardsTier[]> {
  const { data } = await supabase
    .from('rewards_tiers')
    .select('*')
    .order('min_points', { ascending: true });

  return data || [];
}

// Get events for a customer
export async function getEvents(email: string, limit = 20) {
  const { data } = await supabase
    .from('rewards_events')
    .select('*')
    .eq('customer_email', email.toLowerCase())
    .order('created_at', { ascending: false })
    .limit(limit);

  return data || [];
}

// Add points and recalculate tier
export async function addPoints(
  email: string,
  eventType: string,
  points: number,
  metadata: Record<string, unknown> = {}
) {
  const lowerEmail = email.toLowerCase();

  // Insert event
  await supabase.from('rewards_events').insert({
    customer_email: lowerEmail,
    event_type: eventType,
    points,
    metadata,
  });

  // Get current balance
  const balance = await getBalance(lowerEmail);
  const newTotal = balance.total_points + points;

  // Determine new tier
  const tiers = await getTiers();
  let newTier = 'bronze';
  for (const tier of tiers) {
    if (newTotal >= tier.min_points) {
      newTier = tier.name;
    }
  }

  // Update balance
  await supabase
    .from('rewards_balances')
    .upsert({
      customer_email: lowerEmail,
      total_points: newTotal,
      current_tier: newTier,
      updated_at: new Date().toISOString(),
    });

  return { total_points: newTotal, current_tier: newTier };
}
