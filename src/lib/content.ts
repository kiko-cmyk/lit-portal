import { supabase } from './supabase';

export interface ContentItem {
  id: string;
  title: string;
  description: string;
  video_url: string;
  thumbnail_url: string;
  required_tier: string;
  required_status: string;
  published: boolean;
  created_at: string;
}

const TIER_HIERARCHY = ['bronze', 'silver', 'gold'];

function tierLevel(tier: string): number {
  return TIER_HIERARCHY.indexOf(tier);
}

// Get accessible content for a customer based on tier and subscription status
export async function getAccessibleContent(
  customerTier: string,
  isActiveSubscriber: boolean
): Promise<{ accessible: ContentItem[]; locked: ContentItem[] }> {
  const { data } = await supabase
    .from('content_items')
    .select('*')
    .eq('published', true)
    .order('created_at', { ascending: false });

  const items = (data || []) as ContentItem[];
  const customerLevel = tierLevel(customerTier);

  const accessible: ContentItem[] = [];
  const locked: ContentItem[] = [];

  for (const item of items) {
    const requiredLevel = tierLevel(item.required_tier);
    const meetsStatus = item.required_status === 'any' || isActiveSubscriber;
    const meetsTier = customerLevel >= requiredLevel;

    if (meetsTier && meetsStatus) {
      accessible.push(item);
    } else {
      locked.push(item);
    }
  }

  return { accessible, locked };
}

// Log content access
export async function logAccess(email: string, contentId: string) {
  await supabase.from('content_access_log').insert({
    customer_email: email.toLowerCase(),
    content_id: contentId,
  });
}
