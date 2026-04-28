/**
 * Shared types — mirror BACKEND_CONTRACT.md response shapes.
 * Single source of truth for API contracts between FE and BE.
 */

export type SubscriptionStatus =
  | "active"
  | "paused"
  | "post_cancel"
  | "reactivating"
  | "expired";

export type Frequency =
  | "15d"
  | "1mo"
  | "45d"
  | "2mo"
  | "3mo"
  | "4mo"
  | "5mo"
  | "6mo";

export type CancellationReason =
  | "too_expensive"
  | "too_much_product"
  | "not_using_enough"
  | "taking_a_break"
  | "other";

export type DropsAction =
  | "box_shipped"
  | "referral_converted"
  | "monthly_streak"
  | "product_review"
  | "social_share"
  | "whatsapp_optin"
  | "event_checkin"
  | "reward_claim"
  | "cancel_reset"
  | "manual_adjustment";

export type RewardId = "bottle_500" | "merch_1000" | "event_2500";

export type MerchOption = "socks" | "tee" | "hoodie";

// ============ Subscription ============

export interface Subscription {
  customerId: string;
  sealSubscriptionId: string;
  boxCount: number;
  frequency: Frequency;
  frequencyLabel: string;
  flavor: string;
  nextShipDate: string | null; // ISO
  nextBoxNumber: number | null;
  status: SubscriptionStatus;
  createdAt: string;
  withinCutoff: boolean;
  cutoffEndsAt: string | null;
}

export interface PricingResponse {
  currency: "EUR";
  perBox: readonly number[];
  isPlaceholder: boolean;
  lastUpdated: string;
}

export interface SkipResponse {
  skipped: boolean;
  newNextShipDate: string;
  undoExpiresAt: string;
}

export interface CancelStep1Response {
  step: 1;
  data: {
    boxes: number;
    cards: number;
    drops: number;
    monthsInCircle: number;
  };
}

export interface CancelStep4Response {
  cancelled: true;
  lastShipDate: string;
  dropsHeldUntil: string | null; // null if 2nd cancel (immediate reset)
  cardsKept: number;
  cancelCount: number;
}

// ============ Drops ============

export interface DropsBalance {
  balance: number;
  lifetimeEarned: number;
  tierEarned: boolean;
  tierEarnedAt: string | null;
  streakMonths: number;
  claimableRewards: { rewardId: RewardId; threshold: number }[];
}

export interface PuzzleState {
  rewardId: RewardId;
  rewardThreshold: number;
  currentDrops: number;
  piecesRevealed: number;
  totalPieces: 16;
  percentComplete: number;
}

export interface ClaimResponse {
  claimed: true;
  fulfillmentMethod: "next_shipment" | "seat_reserved";
  remainingDrops: number;
}

// ============ Referral ============

export interface ReferralCodeResponse {
  code: string;
  shareUrl: string;
  conversions: number;
  dropsEarned: number;
}

// ============ The World ============

export interface EventListItem {
  id: string;
  city: "madrid" | "barcelona";
  title: string; // localized at API boundary
  description: string;
  datetime: string;
  heroImage: string | null;
  ticketUrl: string | null;
  saved: boolean;
}

export interface EventsResponse {
  city: "madrid" | "barcelona";
  heroEvent: EventListItem | null;
  upcoming: EventListItem[];
}

export interface MomentItem {
  id: string;
  imageUrl: string;
  caption: string;
}

export interface StoryItem {
  id: string;
  type: "feature" | "letter" | "recap";
  title: string;
  slug: string;
  coverImage: string | null;
  excerpt: string | null;
}

export interface BarcelonaWaitlistResponse {
  joined: true;
  position: number;
}

// ============ Account ============

export interface CustomerProfile {
  name: string;
  email: string;
  phone: string | null;
  memberSince: string;
  boxesReceived: number;
  languagePref: "en" | "es";
  tierEarned: boolean;
}

export interface ShippingAddress {
  street: string;
  city: string;
  postalCode: string;
  country: string;
}

export interface PaymentMethod {
  type: string; // "visa", "mastercard", etc.
  last4: string;
  shopifyUpdateUrl: string;
}

export interface OrderHistoryItem {
  id: string;
  orderNumber: string;
  date: string;
  total: number;
  currency: string;
  status: string;
  invoiceUrl: string | null;
}

// ============ Hub ============

export interface HubDashboard {
  subscription: Subscription;
  drops: { balance: number; tierEarned: boolean; activeReward: PuzzleState | null };
  nextEvent: EventListItem | null;
}

export interface TimelineEntry {
  shipmentId: string;
  status: "scheduled" | "shipped" | "delivered";
  shippedAt: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  deliveredAt: string | null;
  boxNumber: number;
}

// ============ Tier ============

export interface TierResponse {
  earned: boolean;
  earnedAt: string | null;
  name: "INNER_CIRCLE";
}

// ============ Errors ============

export interface ApiError {
  error: string;
  message?: string;
}
