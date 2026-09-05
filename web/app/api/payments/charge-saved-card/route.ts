import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'

function getStripe() {
  return new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: '2026-07-29.dahlia',
    httpClient: Stripe.createFetchHttpClient(), // Workers' runtime doesn't support the SDK's default Node socket client
  })
}

type LineItemType = 'product' | 'addon' | 'membership' | 'session_pass' | 'gift_card' | 'booking'

interface ChargeLineItem {
  itemType: LineItemType
  quantity: number
  unitPrice: number
  productVariantId?: string
  membershipPlanId?: string
  sessionPassTypeId?: string
  giftCardId?: string
  bookingId?: string
}

interface ChargeSavedCardRequest {
  customerId: string
  amount: number // pounds
  description?: string
  lineItems?: ChargeLineItem[]
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

// order_line_items only has FK columns for these types today — addon has no
// FK column on that table yet, so addon line items are reported back but not
// persisted as individual rows (see skippedLineItems in the response).
function lineItemFkColumn(itemType: LineItemType): string | null {
  switch (itemType) {
    case 'product':
      return 'product_variant_id'
    case 'membership':
      return 'membership_plan_id'
    case 'session_pass':
      return 'session_pass_type_id'
    case 'gift_card':
      return 'gift_card_id'
    case 'booking':
      return 'booking_id'
    default:
      return null
  }
}

function lineItemFkValue(item: ChargeLineItem): string | undefined {
  switch (item.itemType) {
    case 'product':
      return item.productVariantId
    case 'membership':
      return item.membershipPlanId
    case 'session_pass':
      return item.sessionPassTypeId
    case 'gift_card':
      return item.giftCardId
    case 'booking':
      return item.bookingId
    default:
      return undefined
  }
}

export async function POST(request: NextRequest) {
  try {
    if (!verifyRetoolAuth(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body: ChargeSavedCardRequest = await request.json()
    const { customerId, amount, description, lineItems = [] } = body

    if (!customerId || !amount || amount <= 0) {
      return NextResponse.json(
        { error: 'Missing required fields: customerId, amount (must be > 0)' },
        { status: 400 }
      )
    }

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    const { data: customer, error: customerError } = await supabase
      .from('customers')
      .select('id, stripe_customer_id, saved_payment_method_id')
      .eq('id', customerId)
      .single()

    if (customerError || !customer) {
      return NextResponse.json({ error: 'Customer not found' }, { status: 404 })
    }

    if (!customer.stripe_customer_id || !customer.saved_payment_method_id) {
      return NextResponse.json(
        { error: 'Customer has no saved payment method on file.' },
        { status: 400 }
      )
    }

    let paymentIntent: Stripe.PaymentIntent
    try {
      paymentIntent = await getStripe().paymentIntents.create({
        amount: Math.round(amount * 100),
        currency: 'gbp',
        customer: customer.stripe_customer_id,
        payment_method: customer.saved_payment_method_id,
        off_session: true,
        confirm: true,
        description,
      })
    } catch (stripeError) {
      const stripeErr = stripeError as Stripe.errors.StripeError
      if (stripeErr.code === 'authentication_required') {
        return NextResponse.json(
          {
            error:
              'Card requires additional authentication and cannot be charged off-session. Ask the customer to complete a new payment.',
          },
          { status: 402 }
        )
      }
      console.error('Error charging saved card:', stripeError)
      return NextResponse.json(
        { error: 'Failed to charge saved card', details: stripeErr.message ?? 'Unknown error' },
        { status: 500 }
      )
    }

    const { data: order, error: orderError } = await supabase
      .from('orders')
      .insert({
        customer_id: customerId,
        order_total: amount,
        payment_status: 'paid',
        stripe_payment_intent_id: paymentIntent.id,
        order_source: 'staff_created',
      })
      .select()
      .single()

    if (orderError || !order) {
      console.error('Error creating order after successful charge:', orderError)
      // The customer's card has already been charged — surface success but flag
      // manual follow-up rather than pretending the charge failed.
      return NextResponse.json({
        success: true,
        warning: 'Card was charged but order record failed to save — verify manually.',
        paymentIntentId: paymentIntent.id,
      })
    }

    const skippedLineItems: ChargeLineItem[] = []
    const createdLineItems: Record<string, unknown>[] = []

    for (const item of lineItems) {
      const fkColumn = lineItemFkColumn(item.itemType)
      const fkValue = lineItemFkValue(item)

      if (!fkColumn || !fkValue) {
        skippedLineItems.push(item)
        continue
      }

      const { data: lineItem, error: lineItemError } = await supabase
        .from('order_line_items')
        .insert({
          order_id: order.id,
          [fkColumn]: fkValue,
          item_type: item.itemType,
          quantity: item.quantity,
          unit_price: item.unitPrice,
          line_total: item.unitPrice * item.quantity,
        })
        .select()
        .single()

      if (lineItemError) {
        console.error('Error creating order line item:', lineItemError)
        skippedLineItems.push(item)
      } else {
        createdLineItems.push(lineItem)
      }
    }

    return NextResponse.json({
      success: true,
      order,
      paymentIntentId: paymentIntent.id,
      lineItems: createdLineItems,
      skippedLineItems,
    })
  } catch (error) {
    console.error('Error processing saved-card charge:', error)
    return NextResponse.json(
      { error: 'Internal server error', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
