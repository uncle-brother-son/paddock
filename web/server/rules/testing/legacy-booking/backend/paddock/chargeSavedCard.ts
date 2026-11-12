export type ChargeLineItemType = 'booking' | 'product' | 'membership' | 'session_pass' | 'gift_card' | 'addon'

import { isHtmlErrorPage } from './shared/isHtmlErrorPage'
import { extractStructuredApiError } from './shared/extractStructuredApiError'
import { resolveStaffId } from './shared/resolveStaffId'

export interface ChargeSavedCardLineItem {
  itemType: ChargeLineItemType
  quantity: number
  unitPrice: number
  // Exactly one of these should be set, matching itemType (bookingId for 'booking',
  // productVariantId for 'product', etc.). 'addon' has no matching database column yet on
  // the backend, so those lines come back under `skippedLineItems` in the response rather
  // than being dropped or erroring.
  bookingId?: string
  productVariantId?: string
  membershipPlanId?: string
  sessionPassTypeId?: string
  giftCardId?: string
  addonId?: string
}

export interface ChargeSavedCardParams {
  customerId: string
  amount: number
  description: string
  lineItems?: ChargeSavedCardLineItem[]
  /** When true the route charges the card but creates NO orders row or line items, returning
   *  { success, paymentIntentId, orderId: null }. For callers that record the payment on their
   *  own order row (createOrder) — without it every saved-card charge produced a second,
   *  line-less duplicate orders row. Defaults to false: moveBooking, addBookingGuest and
   *  settleLapsedBooking rely on the route's row as their only payment record. */
  skipOrderRecord?: boolean
  /** Stripe answers a repeat of the key with the first PaymentIntent, and the Worker doesn't write
   *  a second order for it. See shared/bookingCardCharge. */
  idempotencyKey?: string
}

// Verified live against the deployed backend (2026-09-05): a bare { error: "message" } comes
// back for a failure, e.g. "Customer not found" for a customer with no stripe_customer_id on
// file. `skippedLineItems` on a real success has not been directly observed yet, since no
// customer in this database has a saved payment method to actually complete a charge with.
export interface ChargeSavedCardResponse {
  skippedLineItems?: Array<{ itemType: string; [key: string]: unknown }>
  [key: string]: unknown
}

/** No clear answer came back, so the card may have been charged. `code` is Stripe's, when the Worker
 *  passed one on. */
class ChargeUnsureError extends Error {
  constructor(
    message: string,
    readonly code: string | null = null
  ) {
    super(message)
  }
}

export function isChargeUnsure(err: unknown): boolean {
  return err instanceof ChargeUnsureError
}

/** Stripe's answer was that another request with the same key was still running: the money may move
 *  through that one. */
export function isChargeKeyInUse(err: unknown): boolean {
  return err instanceof ChargeUnsureError && err.code === 'idempotency_key_in_use'
}

function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    // Some REST clients attach the parsed response body to the error (e.g. `.response.data`
    // or `.data`). Try to pull a human-readable message out of that shape first, since that's
    // where an endpoint's own error text (like the 402 "needs additional authentication"
    // message) would live; fall back to the error's own message otherwise.
    const anyErr = err as unknown as Record<string, unknown>
    const nestedData = (anyErr['response'] as Record<string, unknown> | undefined)?.['data'] ?? anyErr['data']
    if (nestedData && typeof nestedData === 'object') {
      const message = (nestedData as Record<string, unknown>)['message'] ?? (nestedData as Record<string, unknown>)['error']
      if (typeof message === 'string' && message.trim()) return message
    }
    return err.message
  }
  return 'Failed to charge saved card'
}

/** The work itself, for functions that have already refused an inactive account at their start,
 *  so nothing new can fail in the middle of their payment flow. */
export async function chargeSavedCardUnguarded(
  req: { params: ChargeSavedCardParams }
): Promise<ChargeSavedCardResponse> {
  const { customerId, amount, description, lineItems, skipOrderRecord, idempotencyKey } = req.params

  if (!customerId) {
    throw new Error('customerId is required')
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('amount must be a positive number')
  }
  if (!description.trim()) {
    throw new Error('description is required')
  }

  // Auth: this endpoint requires `Authorization: Bearer <RETOOL_API_KEY>`. That token must be
  // configured on the "Paddock Backend API" REST resource itself (its authentication settings
  // in Retool), not hardcoded here — same as createProductVariant.ts and refundBooking.ts.
  //
  // The endpoint enforces off-session charge eligibility itself (returning 402 when the card
  // needs additional authentication) — this function does not re-implement that check. Any
  // rejection is thrown here with as much of the endpoint's own message preserved as possible,
  // for the caller to surface verbatim to staff.
  let refusal: Error
  try {
    const response = await paddockBackendApi2.rawRequest<ChargeSavedCardResponse>({
      path: '/api/payments/charge-saved-card',
      method: 'POST',
      body: {
        customerId,
        amount,
        description: description.trim(),
        ...(lineItems && lineItems.length > 0 ? { lineItems } : {}),
        ...(skipOrderRecord ? { skipOrderRecord: true } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      },
    })
    // This resource's rawRequest never throws on a non-2xx status and never exposes the status
    // code — so a request that actually hit the wrong host (e.g. the business's public marketing
    // site instead of a real payments API) comes back looking like a normal, successful response.
    // The only signal available is that the body is an HTML page rather than real JSON — treat
    // that as a hard failure instead of reporting a charge that never happened as a success.
    if (isHtmlErrorPage(response.data)) {
      throw new ChargeUnsureError(
        'The payment endpoint returned an HTML page instead of a JSON response, so it can\'t be told ' +
          'whether the card was charged: check Stripe. If this keeps happening, the "Paddock Backend ' +
          'API" resource may be misconfigured (its base URL pointing at the business\'s public ' +
          'website, not a backend server).'
      )
    }
    const structuredError = extractStructuredApiError(response.data)
    if (structuredError) {
      if (response.data['unsure'] === true) {
        const code = response.data['code']
        throw new ChargeUnsureError(structuredError, typeof code === 'string' ? code : null)
      }
      refusal = new Error(structuredError)
    } else {
      return response.data
    }
  } catch (err) {
    if (err instanceof ChargeUnsureError) throw err
    // The call itself failed: the Worker may have charged the card and lost the way back.
    throw new ChargeUnsureError(extractErrorMessage(err))
  }
  throw refusal
}

export default async function chargeSavedCard(req: { params: ChargeSavedCardParams; user: User }): Promise<ChargeSavedCardResponse> {
  // Refuses an inactive account before anything happens.
  await resolveStaffId(req.user.email)
  return chargeSavedCardUnguarded(req)
}
