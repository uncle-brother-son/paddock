/**
 * Promo code types and the field checks the promo code screens' functions use (create, update, list).
 * No database access here. Validating a code against a basket and working out its discount is the
 * Worker's (server/rules/promo): the Retool copy of that (applyPromoCode, spreadFixedDiscount and the
 * failure words) had no caller and left at W44.
 *
 * What the fields mean:
 *  - A code is either a percentage off or a fixed amount off.
 *  - `appliesTo` chooses which parts of a basket it discounts: booking seats, standalone
 *    add-ons, products, session passes, event places, or a membership's first payment. Gift cards and
 *    postage are never eligible.
 *  - `appliesOnMemberPrices = false` means the code only applies to lines/seats priced at the
 *    standard price; `true` also discounts member-priced lines.
 *  - min_spend is measured on the eligible items' subtotal before discount.
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
