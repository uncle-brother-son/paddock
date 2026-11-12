import { isHtmlErrorPage } from '../../../../legacy-booking/backend/paddock/shared/isHtmlErrorPage'
import { extractStructuredApiError } from '../../../../legacy-booking/backend/paddock/shared/extractStructuredApiError'
import { extractApiErrorMessage } from '../../../../legacy-booking/backend/paddock/shared/extractApiErrorMessage'

export type MembershipSubscriptionBillingFrequency = 'monthly' | 'yearly'

/** The failure codes the deployed backend's create-subscription route can return. */
export type MembershipSubscriptionFailureCode =
  | 'no_saved_card'
  | 'plan_not_synced'
  | 'price_not_recurring'
  | 'payment_failed'
  | 'discount_exceeds_total'
  | 'invalid_discount'
  | 'unexpected'

/** Maps each backend failure code to the createOrder.ts failure `reason` the frontend's
 *  FAILURE_MESSAGES map has a staff-facing entry for. */
export const MEMBERSHIP_SUBSCRIPTION_FAILURE_REASONS: Record<MembershipSubscriptionFailureCode, string> = {
  no_saved_card: 'membership_no_saved_card',
  plan_not_synced: 'membership_plan_not_synced',
  price_not_recurring: 'membership_price_not_recurring',
  payment_failed: 'membership_payment_failed',
  discount_exceeds_total: 'membership_discount_exceeds_total',
  invalid_discount: 'membership_discount_invalid',
  unexpected: 'membership_subscription_failed',
}

export interface MembershipSubscriptionSuccess {
  subscriptionId: string
  status: string | null
  currentPeriodStart: string | null
  currentPeriodEnd: string | null
  latestInvoiceId: string | null
  /** The PaymentIntent for the card-charged part of the first invoice — null when the discount
   *  covered the whole first payment (a 0-amount invoice has no PaymentIntent). */
  paymentIntentId: string | null
  /** What the card was actually charged for the first invoice (can be 0 when fully covered). */
  amountPaid: number
  /** The discount the Worker applied to the first invoice — absent when the Worker predates the
   *  discountAmount parameter (tolerated: treated as no discount). */
  discountApplied?: number
}

export interface CreateMembershipSubscriptionParams {
  customerId: string
  membershipPlanId: string
  billingFrequency: MembershipSubscriptionBillingFrequency
  /** Stable per-basket key so a retried checkout can never create a second subscription. */
  idempotencyKey?: string
  /** Optional pounds taken off the FIRST invoice only (one-off Stripe coupon created by the
   *  Worker) — store credit / gift card applied to the membership's first payment. The card is
   *  charged the remainder; renewals are undiscounted. May equal the whole first payment (the
   *  first invoice is then £0 — used when the reader already took the payment). */
  discountAmount?: number
  /** Optional name for the one-off Stripe coupon (max 40 chars), e.g. 'Paid on card reader'. */
  discountLabel?: string
}

export type CreateMembershipSubscriptionResult =
  | { ok: true; subscription: MembershipSubscriptionSuccess }
  | { ok: false; code: MembershipSubscriptionFailureCode; message: string }

interface SubscriptionApiResponse {
  subscriptionId?: string
  subscription_id?: string
  status?: string
  subscription_status?: string
  currentPeriodStart?: string
  current_period_start?: string
  currentPeriodEnd?: string
  current_period_end?: string
  latestInvoiceId?: string
  latest_invoice_id?: string
  paymentIntentId?: string
  payment_intent_id?: string
  amountPaid?: number | string
  amount_paid?: number | string
  discountApplied?: number | string
  discount_applied?: number | string
  error?: string
  details?: string
  code?: string
  success?: boolean
  message?: string
}

/** Clear, staff-facing message for each known failure code — these explain what to DO next,
 *  not just what went wrong (requirement: every code maps to a message staff can act on). */
function staffMessageForCode(code: MembershipSubscriptionFailureCode, rawMessage: string): string {
  switch (code) {
    case 'no_saved_card':
      return 'This customer has no saved card. A membership is charged by Stripe, so take a card on the reader to save it first, then retry checkout.'
    case 'plan_not_synced':
      return 'This membership plan has no Stripe price synced for that billing frequency yet. Sync the plan in Stripe, then retry checkout.'
    case 'price_not_recurring':
      return "The Stripe price for this membership plan isn't a recurring price of the right interval — check the plan's Stripe price setup, then retry checkout."
    case 'payment_failed':
      return "The customer's card was declined when Stripe tried to take the first membership payment. No money was taken and nothing was recorded — use a different card or retry."
    case 'discount_exceeds_total':
      return 'The gift card / store credit applied exceeds the membership first payment — reduce the amounts and retry.'
    case 'invalid_discount':
      return 'The discount amount for the membership first payment was invalid — check the gift card / store credit amounts and retry.'
    case 'unexpected':
      return rawMessage || 'Failed to create the membership subscription — nothing was recorded.'
  }
}

function normalizeCode(rawCode: unknown): MembershipSubscriptionFailureCode {
  if (typeof rawCode === 'string') {
    const normalized = rawCode.trim()
    if (
      normalized === 'no_saved_card' ||
      normalized === 'plan_not_synced' ||
      normalized === 'price_not_recurring' ||
      normalized === 'payment_failed' ||
      normalized === 'discount_exceeds_total' ||
      normalized === 'invalid_discount'
    ) {
      return normalized
    }
  }
  return 'unexpected'
}

function parseAmount(raw: number | string | undefined): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string') {
    const parsed = Number.parseFloat(raw)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

/**
 * Creates a real Stripe subscription for a membership purchase by calling the deployed
 * backend's POST /api/memberships/create-subscription route. The route reads the customer's
 * stripe_customer_id and saved_payment_method_id, verifies the plan's Stripe price is a
 * recurring GBP price of the right interval, sets the default payment method, and creates the
 * subscription with payment_behavior 'error_if_incomplete' (off_session) so the first invoice
 * is charged immediately. It writes NOTHING to Postgres — the caller owns all DB writes and
 * must only make them after this succeeds.
 *
 * Both response shapes are handled: a returned `{ error, code }` body (the route returns 400s
 * as JSON, which the REST client resolves normally) and a thrown error for non-2xx responses
 * where the client attaches the body to the error.
 */
export default async function createMembershipSubscription(
  params: CreateMembershipSubscriptionParams
): Promise<CreateMembershipSubscriptionResult> {
  const { customerId, membershipPlanId, billingFrequency, idempotencyKey, discountAmount, discountLabel } = params
  if (!customerId || !membershipPlanId) {
    return { ok: false, code: 'unexpected', message: 'customerId and membershipPlanId are required.' }
  }

  const buildFailure = (code: MembershipSubscriptionFailureCode, rawMessage: string): CreateMembershipSubscriptionResult => ({
    ok: false,
    code,
    // For known codes the staff-facing guidance is authoritative; the raw API error is kept
    // only when it adds nothing (unknown codes surface the raw text verbatim).
    message: code === 'unexpected' ? rawMessage : `${staffMessageForCode(code, rawMessage)}`,
  })

  try {
    const response = await paddockBackendApi2.rawRequest<SubscriptionApiResponse>({
      path: '/api/memberships/create-subscription',
      method: 'POST',
      body: {
        customerId,
        membershipPlanId,
        billingFrequency,
        ...(idempotencyKey ? { idempotencyKey } : {}),
        ...(discountAmount !== undefined && discountAmount > 0 ? { discountAmount } : {}),
        ...(discountLabel ? { discountLabel } : {}),
      },
    })
    if (isHtmlErrorPage(response.data)) {
      return {
        ok: false,
        code: 'unexpected',
        message:
          'The membership subscription endpoint returned an HTML page instead of a JSON response, which means the ' +
          'request never reached a real payments API — no subscription was created and nothing was charged.',
      }
    }
    const structuredError = extractStructuredApiError(response.data)
    if (structuredError) {
      return buildFailure(normalizeCode(response.data.code), structuredError)
    }
    const subscriptionId = response.data.subscriptionId ?? response.data.subscription_id
    if (!subscriptionId) {
      return {
        ok: false,
        code: 'unexpected',
        message: 'The membership subscription endpoint did not return a subscription id.',
      }
    }
    return {
      ok: true,
      subscription: {
        subscriptionId,
        status: response.data.status ?? response.data.subscription_status ?? null,
        currentPeriodStart: response.data.currentPeriodStart ?? response.data.current_period_start ?? null,
        currentPeriodEnd: response.data.currentPeriodEnd ?? response.data.current_period_end ?? null,
        latestInvoiceId: response.data.latestInvoiceId ?? response.data.latest_invoice_id ?? null,
        // A fully-discounted first payment produces a 0-amount invoice with no PaymentIntent —
        // null is a valid outcome here, not a failure.
        paymentIntentId: response.data.paymentIntentId ?? response.data.payment_intent_id ?? null,
        amountPaid: parseAmount(response.data.amountPaid ?? response.data.amount_paid),
        ...(response.data.discountApplied !== undefined || response.data.discount_applied !== undefined
          ? { discountApplied: parseAmount((response.data.discountApplied ?? response.data.discount_applied) as number | string | undefined) }
          : {}),
      },
    }
  } catch (err) {
    // The REST client throws for non-2xx responses and may attach the parsed body — recover
    // the structured { error, code } shape from it before falling back to the message text.
    if (err instanceof Error) {
      const anyErr = err as unknown as Record<string, unknown>
      const nestedData = (anyErr['response'] as Record<string, unknown> | undefined)?.['data'] ?? anyErr['data']
      if (nestedData && typeof nestedData === 'object') {
        const body = nestedData as SubscriptionApiResponse
        const structuredError = extractStructuredApiError(body)
        if (structuredError) return buildFailure(normalizeCode(body.code), structuredError)
      }
    }
    return buildFailure('unexpected', extractApiErrorMessage(err, 'Failed to create the membership subscription'))
  }
}
