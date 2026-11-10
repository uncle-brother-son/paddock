import 'server-only'
import type { BasketQuoteInput, EventQuotePlace } from '@/contracts'
import type { Queryable, SqlParam } from '@/server/db'
import type { PromoCodeRow } from '@/server/rules/promo/promo-codes'
import { MAX_GUESTS_PER_PRIVATE_BOOKING } from './guest-validation'
import { PROCESSING_MINUTES } from './pending-order'

/**
 * Everything a basket's price depends on, read in ONE statement. A database round trip through
 * Hyperdrive costs about 20 ms, and every id a basket needs is in the request, so nothing has to
 * wait for an earlier answer. One statement is also one snapshot: a price can't change between two
 * reads of the same quote.
 *
 * quote_booking and quote_event raise on what they can't price. An error would lose the whole read,
 * so each call sits behind a CASE that tests what the function raises on, and "no seats" or
 * "no places" in the answer means it couldn't be priced. Money is read as text, as the old code got
 * it, because a number in JSON would lose its trailing zeros.
 */

export interface BasketCustomerFacts {
  id: string
  store_credit_balance: string
  has_saved_card: boolean
  has_active_membership: boolean
  /** The saved card's Stripe customer and payment method, for the charge (W10). */
  stripe_customer_id: string | null
  saved_payment_method_id: string | null
  /**
   * An order of theirs still pending: a Worker card order (`reader_payment.method` 'card') however old,
   * until T2 or the undo settles it; any other pending order for 15 minutes (W03-decisions Q10, as
   * changed by "W10 review calls").
   */
  has_order_processing: boolean
}

export interface BasketSeatFacts {
  seat_no: number
  seat_kind: 'account_holder' | 'guest'
  list_price: string
  unit_price: string
  credit_eligible: boolean
  discount_percent: string
}

export interface BasketSessionFacts {
  id: string
  status: string
  capacity: number
  total_booked: number
  band_id: string | null
  booking_type: 'public' | 'private' | null
  started: boolean
  band_list_price: string | null
  band_code: string | null
  band_name: string | null
  time_conflict: boolean
  duplicate_day: boolean
  /** The private tier for this party size. Null when none matches; its price can be null. */
  private_tier: { price: string | null } | null
  /** From quote_booking. Null when the session can't be priced. */
  seats: BasketSeatFacts[] | null
  /** The new plan's terms for this session, when one is being bought. */
  plan_seat: { credit_eligible: boolean; discount_percent: string; list_price: string; unit_price: string } | null
}

export interface BasketPlanFacts {
  id: string
  name: string
  price_monthly: string | null
  price_yearly: string | null
  active: boolean | null
  is_unlimited: boolean
  sessions_included: number | null
  addons_included: number | null
}

export interface BasketPassTypeFacts {
  id: string
  name: string
  price: string | null
  active: boolean | null
  sessions_included: number | null
  /** How long a pass bought today lasts (W07: the pass row's expiry date). */
  expiry_months: number | null
  covers_session: boolean
}

export interface BasketMembershipCreditFacts {
  id: string
  is_unlimited: boolean | null
  credits_remaining: number | null
}

export interface BasketPassCreditFacts {
  id: string
  sessions_remaining: number
  expiry_date: string
  covers_session: boolean
}

export interface BasketExhaustedFacts {
  subscription_status: string
  cancel_effective_date: string | null
  is_unlimited: boolean | null
  credits_remaining: number | null
}

export interface BasketAddonFacts {
  id: string
  name: string
  active: boolean | null
  member_price: string | null
  sale_price: string | null
  base_price: string | null
}

export interface BasketVariantFacts {
  id: string
  stock_quantity: number
  product_name: string
  product_active: boolean | null
  fulfillment_method: string | null
  member_price: string | null
  sale_price: string | null
  base_price: string | null
  price_override: string | null
}

export interface BasketAddonCreditFacts {
  id: string
  /** Belongs to this customer, active and not past a scheduled cancellation. */
  usable: boolean
  is_herd: boolean
  addon_credits_remaining: number
}

export interface BasketEventFacts {
  id: string
  name: string
  /** The London date of the event. */
  event_date: string | null
  public_release_at: string | null
  price_public: string | null
  active: boolean
  cancelled: boolean
  places_left: number | null
  prices_set: boolean
  block_reason: string | null
  /** From quote_event. Null when it couldn't be priced. */
  places: EventQuotePlace[] | null
}

export interface BasketFacts {
  /** The London date, from the database's clock. */
  today: string
  customer: BasketCustomerFacts | null
  session: BasketSessionFacts | null
  plan: BasketPlanFacts | null
  pass_type: BasketPassTypeFacts | null
  membership_credit: BasketMembershipCreditFacts | null
  pass_credit: BasketPassCreditFacts | null
  exhausted: BasketExhaustedFacts | null
  addons: BasketAddonFacts[] | null
  variants: BasketVariantFacts[] | null
  addon_credits: BasketAddonCreditFacts[] | null
  event: BasketEventFacts | null
  /** expiry_months is the preset's type's (W07: the gift card's expiry date). */
  gift_card_preset: { amount: string; active: boolean; expiry_months: number | null } | null
  gift_card_type: {
    active: boolean
    custom_amount_enabled: boolean
    custom_amount_min: string | null
    custom_amount_max: string | null
    expiry_months: number | null
  } | null
  redeemed_gift_card: { id: string; remaining_balance: string; voided: boolean | null; expiry_date: string } | null
  promo: (PromoCodeRow & { total_uses: number; customer_uses: number }) | null
  postage: { standard_price: string; express_price: string; free_shipping_threshold: string } | null
}

const FACTS_SQL = `
WITH london AS (SELECT (now() AT TIME ZONE 'Europe/London')::date AS today)
SELECT
  (SELECT today::text FROM london) AS today,

  (SELECT jsonb_build_object(
            'id', c.id,
            'store_credit_balance', c.store_credit_balance::text,
            'has_saved_card', COALESCE(c.saved_payment_method_id, '') <> '',
            'has_active_membership', EXISTS (
              SELECT 1 FROM customer_memberships cm
              WHERE cm.customer_id = c.id AND cm.subscription_status = 'active'
                AND (cm.cancel_effective_date IS NULL OR cm.cancel_effective_date >= (SELECT today FROM london))),
            'stripe_customer_id', c.stripe_customer_id,
            'saved_payment_method_id', c.saved_payment_method_id,
            'has_order_processing', EXISTS (
              SELECT 1 FROM orders o
              WHERE o.customer_id = c.id AND o.payment_status = 'pending'
                AND (o.reader_payment->>'method' = 'card' OR o.created_at > now() - interval '${PROCESSING_MINUTES} minutes')))
   FROM customers c WHERE c.id = $1::uuid) AS customer,

  (SELECT jsonb_build_object(
            'id', s.id,
            'status', s.status,
            'capacity', s.capacity,
            'total_booked', s.total_booked,
            'band_id', s.band_id,
            'booking_type', st.booking_type,
            'started', (s.start_time AT TIME ZONE 'UTC') <= (now() AT TIME ZONE 'Europe/London'),
            'band_list_price', sb.price::text,
            'band_code', sb.code,
            'band_name', sb.name,
            'time_conflict', EXISTS (
              SELECT 1 FROM sessions s2
              JOIN bookings b2 ON b2.session_id = s2.id AND b2.status IN ('confirmed', 'pending', 'payment_needed')
              WHERE s2.service_type_id <> s.service_type_id AND s2.start_time < s.end_time AND s2.end_time > s.start_time),
            'duplicate_day', EXISTS (
              SELECT 1 FROM bookings b3
              JOIN sessions s3 ON s3.id = b3.session_id
              WHERE b3.customer_id = $1::uuid
                AND b3.status IN ('pending', 'confirmed', 'payment_needed')
                AND (s3.start_time AT TIME ZONE 'UTC')::date = (s.start_time AT TIME ZONE 'UTC')::date),
            'private_tier', (
              SELECT jsonb_build_object('price', t.price::text)
              FROM service_type_price_tiers t
              WHERE t.service_type_id = s.service_type_id AND t.band_id = s.band_id
                AND t.min_people <= $3::int AND t.max_people >= $3::int
              LIMIT 1),
            'seats', CASE WHEN s.type = 'public' AND s.band_id IS NOT NULL AND $3::int >= 1 THEN (
              SELECT jsonb_agg(jsonb_build_object(
                       'seat_no', q.seat_no,
                       'seat_kind', q.seat_kind,
                       'list_price', q.list_price::text,
                       'unit_price', q.unit_price::text,
                       'credit_eligible', q.credit_eligible,
                       'discount_percent', q.discount_percent::text) ORDER BY q.seat_no)
              FROM quote_booking(s.id, $1::uuid, $3::int) q) END,
            'plan_seat', (
              SELECT jsonb_build_object(
                       'credit_eligible', p.credit_eligible,
                       'discount_percent', p.discount_percent::text,
                       'list_price', p.list_price::text,
                       'unit_price', p.unit_price::text)
              FROM plan_seat_terms($4::uuid, s.id) p))
   FROM sessions s
   LEFT JOIN service_types st ON st.id = s.service_type_id
   LEFT JOIN session_bands sb ON sb.id = s.band_id
   WHERE s.id = $2::uuid) AS session,

  (SELECT jsonb_build_object(
            'id', mp.id, 'name', mp.name,
            'price_monthly', mp.price_monthly::text, 'price_yearly', mp.price_yearly::text,
            'active', mp.active, 'is_unlimited', mp.is_unlimited,
            'sessions_included', mp.sessions_included, 'addons_included', mp.addons_included)
   FROM membership_plans mp WHERE mp.id = $4::uuid) AS plan,

  (SELECT jsonb_build_object(
            'id', spt.id, 'name', spt.name, 'price', spt.price::text, 'active', spt.active,
            'sessions_included', spt.sessions_included, 'expiry_months', spt.expiry_months,
            'covers_session', pass_covers_session(spt.id, $2::uuid))
   FROM session_pass_types spt WHERE spt.id = $6::uuid) AS pass_type,

  (SELECT jsonb_build_object('id', cm.id, 'is_unlimited', mcc.is_unlimited, 'credits_remaining', mcc.credits_remaining)
   FROM customer_memberships cm
   LEFT JOIN membership_current_credits mcc ON mcc.membership_id = cm.id
   WHERE cm.id = $7::uuid AND cm.customer_id = $1::uuid AND cm.subscription_status = 'active'
     AND (cm.cancel_effective_date IS NULL OR cm.cancel_effective_date >= (SELECT today FROM london))) AS membership_credit,

  (SELECT jsonb_build_object(
            'id', csp.id, 'sessions_remaining', csp.sessions_remaining, 'expiry_date', csp.expiry_date::text,
            'covers_session', pass_covers_session(csp.pass_type_id, $2::uuid))
   FROM customer_session_passes csp WHERE csp.id = $8::uuid AND csp.customer_id = $1::uuid) AS pass_credit,

  (SELECT jsonb_build_object(
            'subscription_status', cm.subscription_status,
            'cancel_effective_date', cm.cancel_effective_date::text,
            'is_unlimited', mcc.is_unlimited,
            'credits_remaining', mcc.credits_remaining)
   FROM customer_memberships cm
   LEFT JOIN membership_current_credits mcc ON mcc.membership_id = cm.id
   WHERE cm.id = $9::uuid AND cm.customer_id = $1::uuid) AS exhausted,

  (SELECT jsonb_agg(jsonb_build_object(
            'id', a.id, 'name', a.name, 'active', a.active,
            'member_price', a.member_price::text, 'sale_price', a.sale_price::text, 'base_price', a.base_price::text))
   FROM addons a WHERE a.id = ANY($10::uuid[])) AS addons,

  (SELECT jsonb_agg(jsonb_build_object(
            'id', pv.id, 'stock_quantity', pv.stock_quantity,
            'product_name', p.name, 'product_active', p.active, 'fulfillment_method', p.fulfillment_method,
            'member_price', p.member_price::text, 'sale_price', p.sale_price::text, 'base_price', p.base_price::text,
            'price_override', pv.price_override::text))
   FROM product_variants pv JOIN products p ON p.id = pv.product_id WHERE pv.id = ANY($11::uuid[])) AS variants,

  (SELECT jsonb_agg(jsonb_build_object(
            'id', cm.id,
            'usable', cm.customer_id IS NOT DISTINCT FROM $1::uuid AND cm.subscription_status = 'active'
                      AND (cm.cancel_effective_date IS NULL OR cm.cancel_effective_date >= (SELECT today FROM london)),
            'is_herd', cm.is_herd,
            'addon_credits_remaining', cm.addon_credits_remaining))
   FROM customer_memberships cm WHERE cm.id = ANY($12::uuid[])) AS addon_credits,

  (SELECT jsonb_build_object(
            'id', e.id, 'name', e.name,
            'event_date', (e.starts_at AT TIME ZONE 'UTC')::date::text,
            'public_release_at', e.public_release_at,
            'price_public', e.price_public::text,
            'active', e.active,
            'cancelled', e.cancelled_at IS NOT NULL,
            'places_left', e.capacity - e.places_booked,
            'prices_set', e.price_public IS NOT NULL AND e.price_pre_herd IS NOT NULL AND e.price_herd IS NOT NULL,
            'block_reason', event_booking_block_reason(e.id, $1::uuid, $5::text),
            'places', CASE WHEN $14::int >= 1 AND e.price_public IS NOT NULL AND e.price_pre_herd IS NOT NULL AND e.price_herd IS NOT NULL THEN (
              SELECT jsonb_agg(jsonb_build_object(
                       'place_no', q.place_no,
                       'attendee_type', q.attendee_type,
                       'price_level', q.price_level,
                       'unit_price', q.unit_price::text) ORDER BY q.place_no)
              FROM quote_event(e.id, $1::uuid, $14::int, $15::boolean, $5::text) q) END)
   FROM events e WHERE e.id = $13::uuid) AS event,

  (SELECT jsonb_build_object('amount', gp.amount::text, 'active', gp.active, 'expiry_months', gpt.expiry_months)
   FROM gift_card_presets gp LEFT JOIN gift_card_types gpt ON gpt.id = gp.gift_card_type_id
   WHERE gp.id = $16::uuid) AS gift_card_preset,

  (SELECT jsonb_build_object(
            'active', gt.active, 'custom_amount_enabled', gt.custom_amount_enabled,
            'custom_amount_min', gt.custom_amount_min::text, 'custom_amount_max', gt.custom_amount_max::text,
            'expiry_months', gt.expiry_months)
   FROM gift_card_types gt WHERE gt.id = $17::uuid) AS gift_card_type,

  (SELECT jsonb_build_object(
            'id', g.id, 'remaining_balance', g.remaining_balance::text, 'voided', g.voided, 'expiry_date', g.expiry_date::text)
   FROM gift_cards g WHERE g.id = $18::uuid) AS redeemed_gift_card,

  (SELECT jsonb_build_object(
            'id', pc.id, 'code', pc.code, 'description', pc.description,
            'discount_type', pc.discount_type, 'discount_value', pc.discount_value::text,
            'applies_to', pc.applies_to, 'applies_on_member_prices', pc.applies_on_member_prices,
            'expires_on', pc.expires_on::text, 'max_total_uses', pc.max_total_uses,
            'one_use_per_customer', pc.one_use_per_customer, 'min_spend', pc.min_spend::text,
            'restricted_customer_id', pc.restricted_customer_id, 'active', pc.active,
            'total_uses', (SELECT count(*) FROM promo_code_redemptions r WHERE r.promo_code_id = pc.id),
            'customer_uses', (SELECT count(*) FROM promo_code_redemptions r WHERE r.promo_code_id = pc.id AND r.customer_id = $1::uuid))
   FROM promo_codes pc WHERE upper(pc.code) = upper($19::text) LIMIT 1) AS promo,

  (SELECT jsonb_build_object(
            'standard_price', ps.standard_price::text, 'express_price', ps.express_price::text,
            'free_shipping_threshold', ps.free_shipping_threshold::text)
   FROM postage_settings ps LIMIT 1) AS postage
`

function validFrequency(value: string | null | undefined): 'monthly' | 'yearly' | null {
  return value === 'monthly' || value === 'yearly' ? value : null
}

/** One read for the whole basket, whatever is in it. */
export async function loadBasketFacts(q: Queryable, input: BasketQuoteInput): Promise<BasketFacts> {
  const { booking, event, giftCard } = input
  const attached = booking?.addons ?? []
  const addonLines = [...attached, ...(input.standaloneAddons ?? [])]
  const addonIds = [...new Set(addonLines.map((line) => line.addonId))]
  const variantIds = [...new Set((input.products ?? []).map((line) => line.productVariantId))]
  const creditIds = [...new Set(attached.flatMap((line) => (line.membershipId ? [line.membershipId] : [])))]
  // Past the largest party nothing can be booked, so the rule refuses it before using any price.
  const partySize = Math.min(booking?.guests.length ?? 0, MAX_GUESTS_PER_PRIVATE_BOOKING + 1)
  const eventPlaces = Math.min(event?.attendees.length ?? 0, 1_000)
  const params: SqlParam[] = [
    input.customerId ?? null,
    booking?.sessionId ?? null,
    partySize,
    input.membershipPlanId ?? null,
    input.membershipPlanId ? validFrequency(input.membershipBillingFrequency) : null,
    input.sessionPassTypeId ?? null,
    booking?.redemptionSource === 'membership_credit' ? booking.membershipId ?? null : null,
    booking?.redemptionSource === 'session_pass_credit' ? booking.sessionPassId ?? null : null,
    booking?.cancelExhaustedMembershipId ?? null,
    addonIds,
    variantIds,
    creditIds,
    event?.eventId ?? null,
    eventPlaces,
    event?.accountHolderAttending === true,
    giftCard?.giftCardPresetId ?? null,
    giftCard?.giftCardTypeId ?? null,
    input.payment?.giftCard?.giftCardId ?? null,
    input.promoCode?.trim() || null,
  ]
  const rows = await q.query<BasketFacts>(FACTS_SQL, params)
  return rows[0] as BasketFacts
}
