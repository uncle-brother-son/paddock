// Ported from app/api/terminal/resolve-saved-card/route.ts (new in W11): which reusable card a reader
// tap or a reader card-save leaves the customer with. The legacy route stays until W16 for the old code.
import 'server-only'
import type Stripe from 'stripe'
import type { StripeClient } from './client'

/** What a tap leaves to save: the id to charge later, whether Stripe will let it be charged off-session, and what to show. */
export interface ResolvedCard {
  paymentMethodId: string
  /** False when Stripe made no reusable companion card (the simulated reader never does). */
  reusable: boolean
  last4: string | null
  brand: string | null
}

/** The tap: a reader charge with "save card" ticked, or a reader card-save (SetupIntent) with no charge. */
export type CardSource = { paymentIntentId: string } | { setupIntentId: string }

/** A card that couldn't be resolved, with the words the old code showed for it. */
export class SavedCardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SavedCardError'
  }
}

interface CardPresentDetails {
  last4?: string | null
  brand?: string | null
  generated_card?: string | Stripe.PaymentMethod | null
}

const cardPresentOf = (details: unknown): CardPresentDetails | undefined =>
  (details as { card_present?: CardPresentDetails } | null | undefined)?.card_present ?? undefined

const idOf = (value: string | { id: string } | null | undefined): string | undefined => (typeof value === 'string' ? value : value?.id)

/**
 * The legacy route's reading, step for step. A Terminal tap's own PaymentMethod is `card_present`, which
 * Stripe won't charge off-session; the reusable one is the companion Stripe generates
 * (`card_present.generated_card` on the PaymentIntent's charge, or on the SetupIntent's attempt). With
 * none, the raw id is answered with `reusable: false`, and the caller refuses to save it. The card's
 * last four and brand come from the tap, or from the generated card when the tap has none (a
 * SetupIntent's attempt carries none); they are for display, so failing to read them is not a failure.
 *
 * `send` gives each call its options (the deadline's time left). Throws SavedCardError with the old
 * words; a call that wasn't sent for lack of time throws as Stripe failing would.
 */
export async function resolveSavedCard(stripe: StripeClient, source: CardSource, send: () => Stripe.RequestOptions = () => ({})): Promise<ResolvedCard> {
  let rawPaymentMethodId: string | undefined
  let cardPresent: CardPresentDetails | undefined
  try {
    if ('setupIntentId' in source) {
      const setupIntent = await stripe.setupIntents.retrieve(source.setupIntentId, { expand: ['latest_attempt'] }, send())
      rawPaymentMethodId = idOf(setupIntent.payment_method)
      const attempt = setupIntent.latest_attempt
      cardPresent = typeof attempt === 'object' && attempt !== null ? cardPresentOf(attempt.payment_method_details) : undefined
    } else {
      const paymentIntent = await stripe.paymentIntents.retrieve(source.paymentIntentId, { expand: ['latest_charge'] }, send())
      rawPaymentMethodId = idOf(paymentIntent.payment_method)
      const charge = paymentIntent.latest_charge
      cardPresent = typeof charge === 'object' && charge !== null ? cardPresentOf(charge.payment_method_details) : undefined
    }
  } catch (err) {
    throw new SavedCardError(`Failed to resolve saved card: ${err instanceof Error ? err.message : 'Unknown error'}`)
  }

  if (!rawPaymentMethodId) throw new SavedCardError('No payment method found on this intent')

  const generatedCardId = idOf(cardPresent?.generated_card)
  let last4 = cardPresent?.last4 ?? null
  let brand = cardPresent?.brand ?? null
  if ((!last4 || !brand) && generatedCardId) {
    try {
      const generated = await stripe.paymentMethods.retrieve(generatedCardId, undefined, send())
      last4 = last4 ?? generated.card?.last4 ?? null
      brand = brand ?? generated.card?.brand ?? null
    } catch {
      // Display only: never fail the save because of them, as the legacy route didn't.
    }
  }

  return { paymentMethodId: generatedCardId ?? rawPaymentMethodId, reusable: Boolean(generatedCardId), last4, brand }
}

/** The old words for a card Stripe won't let the club charge later (saveCustomerCardOnFile.ts). */
export function notReusableMessage(source: CardSource, paymentMethodId: string): string {
  const intent = 'setupIntentId' in source ? source.setupIntentId : source.paymentIntentId
  return (
    'This card cannot be saved for future off-session charges — Stripe reports the captured payment ' +
    `method is not reusable (intent: ${intent}, resolved payment method: ${paymentMethodId}).`
  )
}
