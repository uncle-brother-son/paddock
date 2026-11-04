import { z } from 'zod'

/**
 * Step B: quotes and availability. Output shapes match the Retool functions field for field,
 * including string numerics (`unit_price`, `band_price`, `discount_percent`), null versus missing
 * and date formats. Inputs are as loose as the old functions where a screen relied on that:
 * `partySize` and `places` are any number, because the rules answer the out-of-range cases.
 */

const id = z.guid()
/** A calendar date, YYYY-MM-DD. */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a date in the form YYYY-MM-DD')
const isoDateTime = z.iso.datetime({ offset: true })

// --- POST /api/v1/staff/quotes/booking-seats

export const bandSeatQuoteSchema = z.object({
  seat_no: z.number(),
  seat_kind: z.enum(['account_holder', 'guest']),
  band_id: z.string(),
  list_price: z.string(),
  unit_price: z.string(),
  credit_eligible: z.boolean(),
  membership_level: z.string().nullable(),
  discount_percent: z.string(),
})
export type BandSeatQuote = z.infer<typeof bandSeatQuoteSchema>

export const sessionBandInfoSchema = z.object({
  band_id: z.string().nullable(),
  band_code: z.string().nullable(),
  band_name: z.string().nullable(),
  band_price: z.string().nullable(),
  band_overridden: z.boolean(),
})
export type SessionBandInfo = z.infer<typeof sessionBandInfoSchema>

export const quoteBookingSeatsInputSchema = z.object({
  sessionId: id,
  customerId: id,
  partySize: z.number(),
  /** "Buy a New Membership" for this booking: seat 1 is quoted under this plan's level. */
  newMembershipPlanId: id.optional(),
})
export type QuoteBookingSeatsInput = z.infer<typeof quoteBookingSeatsInputSchema>

export const quoteBookingSeatsOutputSchema = z.object({
  seats: z.array(bandSeatQuoteSchema),
  band: sessionBandInfoSchema.nullable(),
  /** Sum of the seats' unit prices. */
  paidTotal: z.number(),
  /** True when quote_booking could not price the session. */
  unpriced: z.boolean(),
  error: z.string().optional(),
})
export type QuoteBookingSeatsOutput = z.infer<typeof quoteBookingSeatsOutputSchema>

// --- POST /api/v1/staff/quotes/event

export const eventBlockReasonSchema = z.enum([
  'event_not_found',
  'event_cancelled',
  'event_not_on_sale',
  'event_started',
  'event_members_only',
  'event_not_released_yet',
])
export type EventBlockReason = z.infer<typeof eventBlockReasonSchema>

export const eventQuotePlaceSchema = z.object({
  place_no: z.number(),
  attendee_type: z.enum(['account_holder', 'guest']),
  price_level: z.enum(['public', 'pre_herd', 'herd']),
  unit_price: z.string(),
})
export type EventQuotePlace = z.infer<typeof eventQuotePlaceSchema>

export const quoteEventInputSchema = z.object({
  eventId: id,
  customerId: id,
  places: z.number(),
  accountHolderAttending: z.boolean(),
  /** A membership being bought in the same order: monthly counts as Pre-Herd, yearly as Herd. */
  newMembershipFrequency: z.enum(['monthly', 'yearly']).optional(),
})
export type QuoteEventInput = z.infer<typeof quoteEventInputSchema>

export const quoteEventOutputSchema = z.object({
  blockReason: eventBlockReasonSchema.nullable(),
  blockMessage: z.string().nullable(),
  places: z.array(eventQuotePlaceSchema),
  total: z.number(),
  placesLeft: z.number().nullable(),
})
export type QuoteEventOutput = z.infer<typeof quoteEventOutputSchema>

// --- POST /api/v1/staff/promo-codes/validate

export const promoEligibleLineSchema = z.object({
  /** Opaque caller-chosen key, echoed back per line in the result. */
  key: z.string(),
  itemType: z.string(),
  amount: z.number(),
  isMemberPriced: z.boolean().optional(),
})
export type PromoEligibleLine = z.infer<typeof promoEligibleLineSchema>

export const validatePromoCodeInputSchema = z.object({
  code: z.string(),
  customerId: id,
  lines: z.array(promoEligibleLineSchema).optional(),
})
export type ValidatePromoCodeInput = z.infer<typeof validatePromoCodeInputSchema>

export const promoValidationFailureReasonSchema = z.enum([
  'not_found',
  'inactive',
  'expired',
  'max_uses_reached',
  'already_used_by_customer',
  'not_for_this_customer',
  'below_min_spend',
  'nothing_eligible',
])
export type PromoValidationFailureReason = z.infer<typeof promoValidationFailureReasonSchema>

export const promoDiscountResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    promoId: z.string(),
    code: z.string(),
    discountType: z.enum(['percentage', 'fixed']),
    discountValue: z.number(),
    discountTotal: z.number(),
    perLine: z.array(z.object({ key: z.string(), discount: z.number() })),
  }),
  z.object({
    ok: z.literal(false),
    reason: promoValidationFailureReasonSchema,
    message: z.string(),
  }),
])
export type PromoDiscountResult = z.infer<typeof promoDiscountResultSchema>

// --- GET /api/v1/staff/customers/credit-options

export const membershipCreditCandidateSchema = z.object({
  id: z.string(),
  plan_id: z.string(),
  plan_name: z.string(),
  credits_remaining: z.number().nullable(),
  /** Null when no credit period covers today. */
  is_unlimited: z.boolean().nullable(),
  period_end: z.string().nullable(),
  addon_credits_remaining: z.number(),
  next_renewal_date: z.string().nullable(),
  is_herd: z.boolean(),
  herd_override: z.boolean().nullable(),
})
export type MembershipCreditCandidate = z.infer<typeof membershipCreditCandidateSchema>

export const sessionPassCreditCandidateSchema = z.object({
  id: z.string(),
  pass_type_id: z.string(),
  pass_type_name: z.string(),
  level: z.enum(['core', 'all_access']),
  sessions_remaining: z.number(),
  expiry_date: z.string(),
  covers_session: z.boolean().nullable(),
})
export type SessionPassCreditCandidate = z.infer<typeof sessionPassCreditCandidateSchema>

export const customerCreditOptionsInputSchema = z.object({
  customerId: id,
  /** When given, session passes are limited to those that cover this session. */
  sessionId: id.optional(),
})
export type CustomerCreditOptionsInput = z.infer<typeof customerCreditOptionsInputSchema>

export const customerCreditOptionsOutputSchema = z.object({
  membershipsWithSessionCredit: z.array(membershipCreditCandidateSchema),
  membershipsWithAddonCredit: z.array(membershipCreditCandidateSchema),
  sessionPasses: z.array(sessionPassCreditCandidateSchema),
  sessionPassesNotCoveringSession: z.number(),
  exhaustedMembership: z
    .object({
      id: z.string(),
      plan_id: z.string(),
      plan_name: z.string(),
      stripe_subscription_id: z.string().nullable(),
    })
    .nullable(),
})
export type CustomerCreditOptionsOutput = z.infer<typeof customerCreditOptionsOutputSchema>

// --- GET /api/v1/staff/sessions/available

export const availableSessionsInputSchema = z.object({
  date: isoDate,
  serviceTypeId: id.optional(),
})
export type AvailableSessionsInput = z.infer<typeof availableSessionsInputSchema>

export const availableSessionRowSchema = z.object({
  id: z.string(),
  service_type_id: z.string(),
  service_type_name: z.string(),
  booking_type: z.enum(['public', 'private']).nullable(),
  start_time: z.string(),
  end_time: z.string(),
  capacity: z.number(),
  total_booked: z.number(),
  available: z.number(),
  status: z.string(),
  blocked_reason: z.string().nullable(),
  started: z.boolean(),
  band_id: z.string().nullable(),
  band_code: z.string().nullable(),
  band_name: z.string().nullable(),
  band_price: z.string().nullable(),
  band_overridden: z.boolean().nullable(),
})
export type AvailableSessionRow = z.infer<typeof availableSessionRowSchema>

export const availableSessionsOutputSchema = z.array(availableSessionRowSchema)
export type AvailableSessionsOutput = z.infer<typeof availableSessionsOutputSchema>

// --- GET /api/v1/staff/bookings/day-conflict

export const customerDayConflictInputSchema = z.object({
  customerId: id,
  /** The session being booked: its start_time decides the London calendar day. */
  sessionId: id,
})
export type CustomerDayConflictInput = z.infer<typeof customerDayConflictInputSchema>

export const customerDayConflictOutputSchema = z.object({
  conflict: z.boolean(),
  /** "DD Mon YYYY" of the London day both bookings fall on. */
  date: z.string().optional(),
})
export type CustomerDayConflictOutput = z.infer<typeof customerDayConflictOutputSchema>

// --- GET /api/v1/staff/sessions/time-conflict

export const sessionTimeConflictInputSchema = z.object({
  sessionId: id,
  serviceTypeId: id,
  startTime: isoDateTime,
  endTime: isoDateTime,
})
export type SessionTimeConflictInput = z.infer<typeof sessionTimeConflictInputSchema>

export const sessionTimeConflictOutputSchema = z.object({
  conflict: z.boolean(),
  conflictingSession: z
    .object({
      id: z.string(),
      service_type_name: z.string(),
      start_time: z.string(),
      end_time: z.string(),
    })
    .nullable(),
})
export type SessionTimeConflictOutput = z.infer<typeof sessionTimeConflictOutputSchema>

// --- GET /api/v1/staff/pricing/config

export const pricingConfigOutputSchema = z.object({
  bands: z.array(
    z.object({
      id: z.string(),
      code: z.string(),
      name: z.string(),
      price: z.string(),
      sort_order: z.number(),
      active: z.boolean(),
    })
  ),
  bandRules: z.array(
    z.object({
      id: z.string(),
      band_id: z.string(),
      /** 0 = Sunday .. 6 = Saturday. */
      day_of_week: z.number(),
      from_time: z.string(),
      to_time: z.string(),
    })
  ),
  membershipTerms: z.array(
    z.object({
      id: z.string(),
      membership_level: z.string(),
      band_id: z.string(),
      credit_eligible: z.boolean(),
      discount_percent: z.string(),
    })
  ),
  membershipLevels: z.array(z.string()),
  canManagePricing: z.boolean(),
})
export type PricingConfigOutput = z.infer<typeof pricingConfigOutputSchema>

// --- GET /api/v1/staff/postage/settings

export const postageSettingsOutputSchema = z.object({
  standardPrice: z.number(),
  expressPrice: z.number(),
  freeShippingThreshold: z.number(),
})
export type PostageSettingsOutput = z.infer<typeof postageSettingsOutputSchema>
