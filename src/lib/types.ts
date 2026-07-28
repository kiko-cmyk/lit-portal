/**
 * Shared types — mirror BACKEND_CONTRACT.md response shapes.
 * Single source of truth for API contracts between FE and BE.
 */

import type {
  FlavorComposition,
  SubscriptionLine,
  SubscriptionShape,
} from "./mix";

export type { FlavorComposition, SubscriptionLine, SubscriptionShape };

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
  | "dont_like"
  | "other";

/**
 * Why a customer is skipping their next order. Captured in the skip retention
 * flow to route the offer (e.g. "too much product" → fewer boxes / longer
 * cadence) and to measure skip reasons + save rate in Klaviyo.
 */
export type SkipReason =
  | "too_much_product"
  | "not_using_enough"
  | "taking_a_break"
  | "traveling_or_break"
  | "budget"
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
  /**
   * Seal item id of the MAIN subscription line (non-one-time). Exposed so
   * the FE can pass it directly to `/api/subscription/plan` and the
   * backend can skip the 33-page Seal pagination scan when looking up the
   * sub. Saves ~5 s per plan-change call.
   */
  mainItemId: number;
  /** Current variant id of the main item. Exposed for the same reason. */
  currentVariantId: string;
  /** TOTAL boxes per shipment = Σ over lines of (variant box count × quantity). */
  boxCount: number;
  /**
   * Every recurring Seal line, dominant (most boxes) first.
   *
   * A subscription holds one line per flavor when the customer splits their boxes
   * ("2× Salty Lemon + 1× Salty Watermelon"). `mainItemId` / `currentVariantId` /
   * `flavor` describe lines[0] only, and exist for clients that predate the mix.
   * Required, not optional, so tsc finds all 3 producers of this type.
   */
  lines: SubscriptionLine[];
  /** Boxes per flavor, aggregated. One entry = a single flavor; 2+ = a mix. */
  composition: FlavorComposition[];
  /** `packed` = one pack-variant line (what every single-flavor sub uses).
   *  `split`  = one 1-box-variant line per flavor, with distributed unit prices. */
  shape: SubscriptionShape;
  /** Customer-facing flavor text: "Salty Lemon" or "2× Lemon · 1× Watermelon".
   *  Use this for display; `flavor` is the dominant label kept for back-compat. */
  flavorSummary: string;
  /** Σ quantity × unit price over recurring lines, in cents. Compared against the
   *  tier price to detect Seal dropping a custom price. */
  chargeTotalCents: number;
  frequency: Frequency;
  frequencyLabel: string;
  /** DOMINANT flavor label. Unchanged for a single-flavor sub. */
  flavor: string;
  nextShipDate: string | null; // ISO
  nextBoxNumber: number | null;
  status: SubscriptionStatus;
  createdAt: string;
  withinCutoff: boolean;
  cutoffEndsAt: string | null;
  shippingAddress: SubscriptionAddress | null;
  payment: {
    cardExpiryMonth: string | null;
    cardExpiryYear: string | null;
    sealEditUrl: string | null;
  };
}

export interface SubscriptionAddress {
  firstName: string;
  lastName: string;
  address1: string;
  address2: string | null;
  city: string;
  postalCode: string;
  province: string | null;
  provinceCode: string | null;
  country: string;
  countryCode: string;
  phone: string | null;
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

export interface ChargeNowResponse {
  charged: boolean;
  // Estimada (hoy + un ciclo). El calendario real lo reconcilia el re-poll
  // tras la regeneración asíncrona de billing_attempts en Seal.
  newNextShipDate: string | null;
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
  /**
   * True when the customer keeps ANOTHER active subscription after this
   * cancel — the server preserves their sessions in that case, so the FE
   * must NOT log them out of the portal (audit 2026-07-08). Optional for
   * back-compat; absent → treat as false (single-sub exit behaviour).
   */
  retainsActiveSub?: boolean;
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

export interface OrderAddress {
  firstName: string;
  lastName: string;
  address1: string;
  address2: string | null;
  city: string;
  postalCode: string;
  province: string | null;
  country: string;
  phone: string | null;
}

export interface OrderItem {
  id: string;
  title: string;
  variantTitle: string | null;
  quantity: number;
  price: number;
  imageUrl: string | null;
  sku: string | null;
}

export interface OrderFulfillmentStatus {
  status: "fulfilled" | "in_transit" | "pending" | "cancelled";
  shippedAt: string | null;
  deliveredAt: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  carrier: string | null;
}

export interface OrderDetail extends OrderHistoryItem {
  /** Same as `date` (createdAt) — labelled explicitly so the UI can show a "Fecha de confirmación" row. */
  confirmationDate: string;
  contact: { name: string; email: string; phone: string | null };
  shippingAddress: OrderAddress | null;
  billingAddress: OrderAddress | null;
  items: OrderItem[];
  subtotal: number;
  shippingPrice: number;
  tax: number;
  /** `total` from OrderHistoryItem is already the grand total; this is here for explicitness. */
  fulfillment: OrderFulfillmentStatus | null;
  shippingMethodTitle: string | null;
  cancelledAt: string | null;
  /** True when the order can be re-purchased (not cancelled + customer eligible). */
  canReorder: boolean;
}

// ============ Hub ============

export interface UpcomingShipment {
  /** ISO date of the scheduled shipment (from Seal billing_attempts). */
  date: string;
  /** Box # the customer will receive when this attempt completes. */
  boxNumber: number;
}

export interface HubDashboard {
  subscription: Subscription;
  drops: {
    balance: number;
    tierEarned: boolean;
    activeReward: PuzzleState | null;
    /** When the tier was earned — drives the TierPill "first seen" animation. */
    tierEarnedAt?: string | null;
    /**
     * Post-cancel only: when the 90-day drops hold releases
     * (cancellations.drops_release_at). Null/absent when there is no hold
     * (active sub, 2nd+ cancel, or another sub retained).
     */
    dropsReleaseAt?: string | null;
  };
  nextEvent: EventListItem | null;
  /**
   * All upcoming shipments Seal has scheduled (pending billing attempts).
   * Excludes the next one already surfaced via `subscription.nextShipDate`.
   * Sorted by date ascending. Seal typically pre-schedules 5–6 in advance.
   */
  upcomingShipments: UpcomingShipment[];
  /**
   * True while a re-anchor intent is still pending for this customer — i.e. a
   * frequency change is in flight and Seal hasn't finished regenerating +
   * re-anchoring the cadence yet. The Hub shows the "updating your calendar"
   * banner while this is true and keeps silently re-polling until it clears.
   */
  reanchorPending?: boolean;
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
