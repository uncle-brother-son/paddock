import type Stripe from 'stripe'

export type LineItemType = 'product' | 'addon' | 'membership' | 'session_pass' | 'gift_card' | 'booking'

export interface ChargeLineItem {
  itemType: LineItemType
  quantity: number
  unitPrice: number
  productVariantId?: string
  membershipPlanId?: string
  sessionPassTypeId?: string
  giftCardId?: string
  bookingId?: string
}

export interface ChargeSavedCardParams {
  customerId: string
  amount: number // pounds
  description?: string
  lineItems?: ChargeLineItem[]
  skipOrderRecord?: boolean
}

export interface ChargeSavedCardSuccess {
  success: true
  paymentIntentId: string
  orderId?: string | null
  order?: Record<string, unknown>
  lineItems?: Record<string, unknown>[]
  skippedLineItems?: ChargeLineItem[]
  warning?: string
}

export interface ChargeSavedCardFailure {
  success: false
  status: number
  error: string
  details?: string
}

export type ChargeSavedCardResult = ChargeSavedCardSuccess | ChargeSavedCardFailure

// The subset of the Stripe client this module needs — kept minimal so tests can pass a plain
// mock instead of a real Stripe instance.
export interface StripeChargeDeps {
  paymentIntentsCreate: (params: Stripe.PaymentIntentCreateParams) => Promise<Stripe.PaymentIntent>
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

export async function chargeSavedCard(
  params: ChargeSavedCardParams,
  supabase: any,
  stripe: StripeChargeDeps
): Promise<ChargeSavedCardResult> {
  const { customerId, amount, description, lineItems = [], skipOrderRecord = false } = params

  if (!customerId || !amount || amount <= 0) {
    return { success: false, status: 400, error: 'Missing required fields: customerId, amount (must be > 0)' }
  }

  const { data: customer, error: customerError } = await supabase
    .from('customers')
    .select('id, stripe_customer_id, saved_payment_method_id')
    .eq('id', customerId)
    .single()

  if (customerError || !customer) {
    return { success: false, status: 404, error: 'Customer not found' }
  }

  if (!customer.stripe_customer_id || !customer.saved_payment_method_id) {
    return { success: false, status: 400, error: 'Customer has no saved payment method on file.' }
  }

  let paymentIntent: Stripe.PaymentIntent
  try {
    paymentIntent = await stripe.paymentIntentsCreate({
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
      return {
        success: false,
        status: 402,
        error:
          'Card requires additional authentication and cannot be charged off-session. Ask the customer to complete a new payment.',
      }
    }
    console.error('Error charging saved card:', stripeError)
    return { success: false, status: 500, error: 'Failed to charge saved card', details: stripeErr.message ?? 'Unknown error' }
  }

  if (skipOrderRecord) {
    return { success: true, paymentIntentId: paymentIntent.id, orderId: null }
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
    return {
      success: true,
      warning: 'Card was charged but order record failed to save — verify manually.',
      paymentIntentId: paymentIntent.id,
    }
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

  return {
    success: true,
    order,
    paymentIntentId: paymentIntent.id,
    lineItems: createdLineItems,
    skippedLineItems,
  }
}
