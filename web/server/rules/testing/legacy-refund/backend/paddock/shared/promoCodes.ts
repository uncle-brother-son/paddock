/**
 * Pure promo-code logic for createOrder.ts (authoritative re-validation inside the order). The
 * staff preview at New Order now comes from the Worker, through validatePromoCode.ts; the order
 * still uses this Retool copy until step C. Until then any promo rule change must be made in both.
 * No database access here: callers supply the promo row, usage counts, the London "today", and
 * the basket's eligible lines.
 *
 * Business rules (decided with the client):
 *  - A code is either a percentage off or a fixed amount off.
 *  - `appliesTo` chooses which parts of a basket it discounts: booking seats, standalone
 *    add-ons, products, session passes, event places, or a membership's first payment. Gift cards and
 *    postage are NEVER eligible (callers simply never pass lines for them).
 *  - `appliesOnMemberPrices = false` means the code only applies to lines/seats priced at the
 *    standard price — lines already at a member price (or a member-discounted booking seat)
 *    are excluded. `true` also discounts member-priced lines.
 *  - min_spend is measured on the ELIGIBLE items' subtotal BEFORE discount.
 */

export type PromoAppliesTo = 'booking' | 'addon' | 'product' | 'session_pass' | 'membership' | 'event'

export const PROMO_APPLIES_TO_VALUES: PromoAppliesTo[] = ['booking', 'addon', 'product', 'session_pass', 'membership', 'event']

/** A promo_codes row as read from the database (numerics as strings, per the SQL driver). */
export interface PromoCodeRow {
  id: string
  code: string
  description: string | null
  discount_type: string
  discount_value: string
  applies_to: string[]
  applies_on_member_prices: boolean
  expires_on: string | null
  max_total_uses: number | null
  one_use_per_customer: boolean
  min_spend: string | null
  restricted_customer_id: string | null
  active: boolean
}

export interface PromoUsageCounts {
  /** Total redemptions across all customers. */
  totalUses: number
  /** Redemptions by the customer trying to use the code now. */
  usesByThisCustomer: number
}

/** One discountable basket line. Booking lines are passed per paid seat so a
 *  member-discounted account-holder seat can be excluded individually. */
export interface PromoEligibleLine {
  /** Opaque caller-chosen key, echoed back per line in the result. */
  key: string
  itemType: PromoAppliesTo
  /** Money for this line before discount. Lines with amount <= 0 should not be passed. */
  amount: number
  /** True when the line is already priced at a member price / member-discounted seat. */
  isMemberPriced: boolean
}

export type PromoValidationFailureReason =
  | 'not_found'
  | 'inactive'
  | 'expired'
  | 'max_uses_reached'
  | 'already_used_by_customer'
  | 'not_for_this_customer'
  | 'below_min_spend'
  | 'nothing_eligible'

export interface PromoDiscountPerLine {
  key: string
  discount: number
}

export interface PromoDiscountSuccess {
  ok: true
  promoId: string
  code: string
  discountType: 'percentage' | 'fixed'
  discountValue: number
  /** Sum of the per-line discounts (exactly, in pounds). */
  discountTotal: number
  perLine: PromoDiscountPerLine[]
}

export interface PromoDiscountFailure {
  ok: false
  reason: PromoValidationFailureReason
  message: string
}

export type PromoDiscountResult = PromoDiscountSuccess | PromoDiscountFailure

/** Staff-friendly failure messages, shared by the preview endpoint and createOrder. */
export const PROMO_FAILURE_MESSAGES: Record<PromoValidationFailureReason, string> = {
  not_found: 'That promo code does not exist.',
  inactive: 'That promo code is not active.',
  expired: 'That promo code has expired.',
  max_uses_reached: 'That promo code has reached its maximum number of uses.',
  already_used_by_customer: 'This customer has already used that promo code.',
  not_for_this_customer: 'That promo code is restricted to a different customer.',
  below_min_spend: 'The eligible items do not reach this code’s minimum spend.',
  nothing_eligible: 'Nothing in this basket is eligible for that promo code.',
}

const round2 = (n: number): number => Math.round(n * 100) / 100

/**
 * Spreads a fixed discount across eligible lines proportionally to their amounts, working in
 * whole pence: each line first gets its floored proportional share, then any leftover pence is
 * distributed to lines with headroom starting from the last line. Every line's discount is
 * clamped to its own amount, and the total never exceeds the eligible subtotal.
 */
export function spreadFixedDiscount(totalFixed: number, amounts: number[]): number[] {
  const subtotalPennies = amounts.reduce((sum, a) => sum + Math.round(a * 100), 0)
  const cappedPennies = Math.min(Math.round(totalFixed * 100), subtotalPennies)
  const result = amounts.map(() => 0)
  if (subtotalPennies <= 0 || cappedPennies <= 0) return result
  let remaining = cappedPennies
  for (let i = 0; i < amounts.length; i++) {
    const cap = Math.round(amounts[i]! * 100)
    const share = Math.floor((cappedPennies * cap) / subtotalPennies)
    const given = Math.min(share, cap)
    result[i] = given
    remaining -= given
  }
  for (let i = amounts.length - 1; i >= 0 && remaining > 0; i--) {
    const cap = Math.round(amounts[i]! * 100)
    const headroom = cap - result[i]!
    const give = Math.min(headroom, remaining)
    result[i] = result[i]! + give
    remaining -= give
  }
  return result.map((p) => p / 100)
}

/**
 * Validates a promo code against the basket and computes the per-line discount. Check order:
 * status/expiry/usage limits/customer restriction first (access), then whether anything in the
 * basket is eligible, then the minimum spend (measured on the eligible subtotal BEFORE
 * discount).
 */
export function applyPromoCode(args: {
  promo: PromoCodeRow
  usage: PromoUsageCounts
  /** London date "YYYY-MM-DD" — expires_on is valid through that date inclusive. */
  todayLondon: string
  customerId: string
  lines: PromoEligibleLine[]
}): PromoDiscountResult {
  const { promo, usage, todayLondon, customerId, lines } = args

  if (!promo.active) {
    return { ok: false, reason: 'inactive', message: PROMO_FAILURE_MESSAGES.inactive }
  }
  if (promo.expires_on && todayLondon > promo.expires_on) {
    return { ok: false, reason: 'expired', message: PROMO_FAILURE_MESSAGES.expired }
  }
  if (promo.max_total_uses !== null && usage.totalUses >= promo.max_total_uses) {
    return { ok: false, reason: 'max_uses_reached', message: PROMO_FAILURE_MESSAGES.max_uses_reached }
  }
  if (promo.restricted_customer_id && promo.restricted_customer_id !== customerId) {
    return { ok: false, reason: 'not_for_this_customer', message: PROMO_FAILURE_MESSAGES.not_for_this_customer }
  }
  if (promo.one_use_per_customer && usage.usesByThisCustomer >= 1) {
    return { ok: false, reason: 'already_used_by_customer', message: PROMO_FAILURE_MESSAGES.already_used_by_customer }
  }

  const allowedTypes = new Set<PromoAppliesTo>(promo.applies_to as PromoAppliesTo[])
  const eligible = lines.filter(
    (line) => allowedTypes.has(line.itemType) && (promo.applies_on_member_prices || !line.isMemberPriced) && line.amount > 0.005
  )
  if (eligible.length === 0) {
    return { ok: false, reason: 'nothing_eligible', message: PROMO_FAILURE_MESSAGES.nothing_eligible }
  }

  const eligibleSubtotal = round2(eligible.reduce((sum, line) => sum + line.amount, 0))
  const minSpend = promo.min_spend !== null ? Number.parseFloat(promo.min_spend) : null
  if (minSpend !== null && eligibleSubtotal + 0.005 < minSpend) {
    return { ok: false, reason: 'below_min_spend', message: PROMO_FAILURE_MESSAGES.below_min_spend }
  }

  const discountType = promo.discount_type === 'fixed' ? 'fixed' : 'percentage'
  const discountValue = Number.parseFloat(promo.discount_value)

  let perLine: PromoDiscountPerLine[]
  let discountTotal: number
  if (discountType === 'percentage') {
    // Percentage: each eligible line rounded to pence individually, so the recorded per-line
    // discounts always sum to the total.
    perLine = eligible.map((line) => ({ key: line.key, discount: round2((line.amount * discountValue) / 100) }))
    discountTotal = round2(perLine.reduce((sum, l) => sum + l.discount, 0))
  } else {
    // Fixed: spread across the eligible lines proportionally (pence-exact), never more than a
    // line's own amount, total never above the eligible subtotal.
    const shares = spreadFixedDiscount(discountValue, eligible.map((line) => line.amount))
    perLine = eligible.map((line, i) => ({ key: line.key, discount: shares[i]! }))
    discountTotal = round2(perLine.reduce((sum, l) => sum + l.discount, 0))
  }

  return {
    ok: true,
    promoId: promo.id,
    code: promo.code,
    discountType,
    discountValue,
    discountTotal,
    perLine,
  }
}

/** Code text rule: letters, digits and dashes, 4–20 characters (stored upper-cased). */
export function normalizePromoCodeText(raw: string): { ok: true; code: string } | { ok: false; message: string } {
  const code = raw.trim().toUpperCase()
  if (!/^[A-Z0-9-]{4,20}$/.test(code)) {
    return {
      ok: false,
      message: 'The code must be 4–20 characters using only letters, numbers and dashes (stored upper-cased).',
    }
  }
  return { ok: true, code }
}

/** Shared create/update field validation — mirrors the table's own CHECK-level rules. */
export function validatePromoCodeFields(fields: {
  discountType: string
  discountValue: number
  appliesTo: string[]
  expiresOn: string | null
  maxTotalUses: number | null
  minSpend: number | null
}): string | null {
  if (fields.discountType !== 'percentage' && fields.discountType !== 'fixed') {
    return 'Discount type must be "percentage" or "fixed".'
  }
  if (!Number.isFinite(fields.discountValue) || fields.discountValue <= 0) {
    return 'The discount value must be greater than 0.'
  }
  if (fields.discountType === 'percentage' && fields.discountValue > 100) {
    return 'A percentage discount cannot exceed 100%.'
  }
  if (fields.appliesTo.length === 0 || fields.appliesTo.some((t) => !PROMO_APPLIES_TO_VALUES.includes(t as PromoAppliesTo))) {
    return 'Choose at least one valid basket part this code applies to (booking, add-on, product, session pass, membership).'
  }
  if (fields.expiresOn !== null && !/^\d{4}-\d{2}-\d{2}$/.test(fields.expiresOn)) {
    return 'The expiry must be a date (YYYY-MM-DD) or empty.'
  }
  if (fields.maxTotalUses !== null && (!Number.isInteger(fields.maxTotalUses) || fields.maxTotalUses < 1)) {
    return 'Maximum total uses must be a whole number of at least 1, or empty for unlimited.'
  }
  if (fields.minSpend !== null && (!Number.isFinite(fields.minSpend) || fields.minSpend < 0)) {
    return 'Minimum spend must be a non-negative amount, or empty for none.'
  }
  return null
}
