import { isHtmlErrorPage } from '@retool-app/backend/paddock/shared/isHtmlErrorPage'
import { extractStructuredApiError } from '@retool-app/backend/paddock/shared/extractStructuredApiError'
import { extractApiErrorMessage } from '@retool-app/backend/paddock/shared/extractApiErrorMessage'

export interface SaveCustomerCardOnFileParams {
  customerId: string
  /**
   * The PaymentIntent id from a reader charge with "save card" checked (chargeViaReader.ts).
   * Mutually exclusive with setupIntentId — exactly one of the two ids is required.
   */
  paymentIntentId?: string
  /**
   * The SetupIntent id from the reader card-saving flow without a charge
   * (createTerminalSetupIntent.ts → collectSetupIntentPaymentMethod + confirmSetupIntent on the
   * reader → this). Used when a card must be saved for future off-session billing (e.g. a
   * membership subscription) without taking a reader payment at the same time. The real,
   * reusable payment method id is always resolved server-side from whichever intent id is
   * passed, via the "Paddock Backend API" Worker's /api/terminal/resolve-saved-card endpoint —
   * never the raw client-side payment_method id, since a Terminal capture's own PaymentMethod
   * is type card_present, which Stripe will not let this app charge off-session later
   * (confirmed live: attempting to reuse one directly fails with "The provided PaymentMethod
   * type (card_present) cannot be reused").
   */
  setupIntentId?: string
  /** Brief W14a: the Worker route's Idempotency-Key, made here per call when the caller sends none. */
  idempotencyKey?: string
}

export interface SaveCustomerCardOnFileResult {
  id: string
  stripe_customer_id: string | null
  saved_payment_method_id: string | null
  saved_card_last4: string | null
  saved_card_brand: string | null
}

interface ResolveSavedCardResponse {
  success?: boolean
  paymentMethodId?: string
  reusable?: boolean
  last4?: string | null
  brand?: string | null
  error?: string
  details?: string
}

// Verified live against the deployed Worker (2026-09-22): POST { paymentIntentId } returns
// { success: true, paymentMethodId, reusable, last4, brand } on success (last4/brand can
// legitimately come back null when the card's details didn't carry through for that particular
// capture), or { error, details } on failure (e.g. "No such payment_intent: '...'" for a bad/
// expired id, or "No payment method found on this intent" for an abandoned/never-confirmed
// intent).
/** The work itself, for functions that have already refused an inactive account at their start,
 *  so nothing new can fail in the middle of their payment flow. */
export async function saveCustomerCardOnFileUnguarded(
  req: { params: SaveCustomerCardOnFileParams }
): Promise<SaveCustomerCardOnFileResult> {
  const { customerId, paymentIntentId, setupIntentId } = req.params
  if (!customerId) {
    throw new Error('customerId is required')
  }
  if (!paymentIntentId && !setupIntentId) {
    throw new Error('Either paymentIntentId or setupIntentId is required')
  }
  if (paymentIntentId && setupIntentId) {
    throw new Error('Pass either paymentIntentId or setupIntentId, not both')
  }

  let resolved: ResolveSavedCardResponse
  try {
    const response = await paddockBackendApi2.rawRequest<ResolveSavedCardResponse>({
      path: '/api/terminal/resolve-saved-card',
      method: 'POST',
      body: paymentIntentId ? { paymentIntentId } : { setupIntentId },
    })
    if (isHtmlErrorPage(response.data)) {
      throw new Error(
        'The resolve-saved-card endpoint returned an HTML page instead of a JSON response — the "Paddock ' +
          'Backend API" resource is very likely misconfigured.'
      )
    }
    const structuredError = extractStructuredApiError(response.data)
    if (structuredError) {
      throw new Error(structuredError)
    }
    resolved = response.data
  } catch (err) {
    throw new Error(extractApiErrorMessage(err, 'Failed to resolve the saved card'))
  }

  if (!resolved.success || !resolved.paymentMethodId) {
    throw new Error(
      `The resolve-saved-card endpoint did not return a payment method id (intent: ${paymentIntentId ?? setupIntentId}).`
    )
  }
  // reusable: false means Stripe reports this specific payment method cannot be charged
  // off-session later (e.g. a card_present capture with no reusable companion) — refuse to save
  // it rather than silently writing an id that "Charge Saved Card" would only fail on later.
  if (!resolved.reusable) {
    throw new Error(
      'This card cannot be saved for future off-session charges — Stripe reports the captured payment ' +
        `method is not reusable (intent: ${paymentIntentId ?? setupIntentId}, resolved payment method: ${resolved.paymentMethodId}).`
    )
  }

  // The Worker returns the card details top-level ({ last4, brand } — verified live against a
  // reader PaymentIntent); read a nested `card` object too so a setup-intent response that
  // nests them is still stored rather than silently NULLed.
  const nestedCard = (resolved as { card?: { last4?: string | null; brand?: string | null } }).card
  const resolvedLast4 = resolved.last4 ?? nestedCard?.last4 ?? null
  const resolvedBrand = resolved.brand ?? nestedCard?.brand ?? null

  // Deliberately NOT using COALESCE to preserve a previous last4/brand when this call doesn't
  // have one — that could show a stale card's digits next to a different, newly-saved payment
  // method id. Always reflect exactly what's known about the id being saved right now, even if
  // that means NULL (unknown) until/unless a future save provides it.
  const result = await paddockData.query<SaveCustomerCardOnFileResult>(
    `UPDATE customers
     SET saved_payment_method_id = $1,
         saved_card_last4 = $2,
         saved_card_brand = $3,
         updated_at = now()
     WHERE id = $4
     RETURNING id, stripe_customer_id, saved_payment_method_id, saved_card_last4, saved_card_brand`,
    [resolved.paymentMethodId, resolvedLast4 ?? null, resolvedBrand ?? null, customerId]
  )
  const row = result.data[0]
  if (!row) {
    throw new Error('Customer not found')
  }
  return row
}
