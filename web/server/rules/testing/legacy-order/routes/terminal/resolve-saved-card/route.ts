import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'

function getStripe() {
  return new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: '2026-07-29.dahlia',
    httpClient: Stripe.createFetchHttpClient(), // Workers' runtime doesn't support the SDK's default Node socket client
  })
}

interface ResolveSavedCardRequest {
  setupIntentId?: string
  paymentIntentId?: string
}

// Verify Retool API key
function verifyRetoolAuth(request: NextRequest): boolean {
  const authHeader = request.headers.get('authorization')
  const retoolApiKey = process.env.RETOOL_API_KEY

  if (!retoolApiKey) {
    console.error('RETOOL_API_KEY not configured')
    return false
  }

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return false
  }

  const token = authHeader.substring(7)
  return token === retoolApiKey
}

interface CardPresentDetails {
  last4: string | null
  brand: string | null
  generated_card?: string | Stripe.PaymentMethod | null
}

// The raw card_present PaymentMethod from a Terminal capture can only be used for another
// in-person Terminal transaction — Stripe rejects it if billed off-session directly. The
// actual reusable, off-session-chargeable id is a separate, Stripe-generated companion
// PaymentMethod, documented here:
//   SetupIntent flow:   SetupAttempt.payment_method_details.card_present.generated_card
//   PaymentIntent flow: Charge.payment_method_details.card_present.generated_card
// It is NEVER present on the standalone PaymentMethod object itself, regardless of expansion —
// confirmed by direct testing against real captures (see terminal card-save incident, Sept 2026).
function extractGeneratedCardId(cardPresent: CardPresentDetails | undefined): string | undefined {
  const generatedCard = cardPresent?.generated_card
  if (!generatedCard) return undefined
  return typeof generatedCard === 'string' ? generatedCard : generatedCard.id
}

export async function POST(request: NextRequest) {
  try {
    if (!verifyRetoolAuth(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body: ResolveSavedCardRequest = await request.json()
    const { setupIntentId, paymentIntentId } = body

    if (!setupIntentId && !paymentIntentId) {
      return NextResponse.json(
        { error: 'Provide one of: setupIntentId, paymentIntentId' },
        { status: 400 }
      )
    }
    if (setupIntentId && paymentIntentId) {
      return NextResponse.json(
        { error: 'Provide only one of: setupIntentId, paymentIntentId — not both' },
        { status: 400 }
      )
    }

    let rawPaymentMethodId: string | undefined
    let cardPresent: CardPresentDetails | undefined

    try {
      if (setupIntentId) {
        const setupIntent = await getStripe().setupIntents.retrieve(setupIntentId, {
          expand: ['latest_attempt'],
        })
        const paymentMethod = setupIntent.payment_method
        rawPaymentMethodId = typeof paymentMethod === 'string' ? paymentMethod : paymentMethod?.id
        const attempt = setupIntent.latest_attempt
        cardPresent =
          typeof attempt === 'object' && attempt !== null
            ? ((attempt.payment_method_details as { card_present?: CardPresentDetails } | null)
                ?.card_present ?? undefined)
            : undefined
      } else {
        const paymentIntent = await getStripe().paymentIntents.retrieve(paymentIntentId!, {
          expand: ['latest_charge'],
        })
        const paymentMethod = paymentIntent.payment_method
        rawPaymentMethodId = typeof paymentMethod === 'string' ? paymentMethod : paymentMethod?.id
        const charge = paymentIntent.latest_charge
        cardPresent =
          typeof charge === 'object' && charge !== null
            ? ((charge.payment_method_details as { card_present?: CardPresentDetails } | null)
                ?.card_present ?? undefined)
            : undefined
      }
    } catch (stripeError) {
      const stripeErr = stripeError as Stripe.errors.StripeError
      console.error('Error resolving saved card from Stripe:', stripeError)
      return NextResponse.json(
        { error: 'Failed to resolve saved card', details: stripeErr.message ?? 'Unknown error' },
        { status: 500 }
      )
    }

    if (!rawPaymentMethodId) {
      return NextResponse.json({ error: 'No payment method found on this intent' }, { status: 400 })
    }

    const generatedCardId = extractGeneratedCardId(cardPresent)

    // The SetupIntent flow's SetupAttempt.card_present carries no last4/brand (only the
    // generated_card id), so read them from the reusable generated card itself when missing.
    let last4 = cardPresent?.last4 ?? null
    let brand = cardPresent?.brand ?? null
    if ((!last4 || !brand) && generatedCardId) {
      try {
        const generated = await getStripe().paymentMethods.retrieve(generatedCardId)
        last4 = last4 ?? generated.card?.last4 ?? null
        brand = brand ?? generated.card?.brand ?? null
      } catch (lookupError) {
        // Card details are display-only — never fail the save because of them.
        console.error('Could not read card details from the generated card:', lookupError)
      }
    }

    return NextResponse.json({
      success: true,
      // The id to actually save. Falls back to the raw card_present id when Stripe hasn't
      // generated a reusable companion (e.g. the simulated Terminal reader in test mode never
      // does) — `reusable: false` flags that this fallback id will be rejected for off-session
      // billing until the card is re-tapped on hardware that does produce a generated_card.
      paymentMethodId: generatedCardId ?? rawPaymentMethodId,
      reusable: Boolean(generatedCardId),
      last4,
      brand,
    })
  } catch (error) {
    console.error('Error resolving saved card:', error)
    return NextResponse.json(
      { error: 'Internal server error', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
