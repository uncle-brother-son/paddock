import Stripe from 'stripe'

export type BillingFrequency = 'monthly' | 'yearly'

export interface CreateSubscriptionParams {
  customerId: string
  membershipPlanId: string
  billingFrequency: BillingFrequency
  idempotencyKey?: string
}

export interface CreateSubscriptionSuccess {
  success: true
  subscriptionId: string
  status: string
  currentPeriodStart: string
  currentPeriodEnd: string
  latestInvoiceId: string | null
  paymentIntentId: string | null
  amountPaid: number
}

export interface CreateSubscriptionFailure {
  success: false
  status: number
  error: string
  code?: string
}

export type CreateSubscriptionResult = CreateSubscriptionSuccess | CreateSubscriptionFailure

// The subset of the Stripe client this module needs — kept minimal so tests can pass a plain
// mock instead of a real Stripe instance.
export interface StripeDeps {
  pricesRetrieve: (id: string) => Promise<Stripe.Price>
  customersUpdate: (id: string, params: Stripe.CustomerUpdateParams) => Promise<Stripe.Customer>
  subscriptionsCreate: (
    params: Stripe.SubscriptionCreateParams,
    options?: Stripe.RequestOptions
  ) => Promise<Stripe.Subscription>
  subscriptionsCancel: (id: string) => Promise<Stripe.Subscription>
}

// invoice.payments.data[0].payment.payment_intent is where the PaymentIntent id lives in recent
// API versions (2026-07-29.dahlia) — confirmed against the installed Stripe SDK's types; the
// older top-level invoice.payment_intent field no longer exists on the typed Invoice object at
// all (the only `payment_intent` field left on Invoice-related types belongs to
// Invoice.LastFinalizationError, an unrelated error object). Stripe only expands the LIST
// (`invoice.payments`) here — expanding the nested payment_intent itself would push the expand
// path past Stripe's 4-level limit (`latest_invoice.payments.data.payment.payment_intent`
// errors with "You cannot expand more than 4 levels of a property") — so in practice this is
// always the plain id string, with the object case and a legacy fallback handled defensively.
export function getInvoicePaymentIntentId(invoice: Stripe.Invoice): string | undefined {
  const paymentIntent = invoice.payments?.data?.[0]?.payment?.payment_intent
  if (paymentIntent) {
    return typeof paymentIntent === 'string' ? paymentIntent : paymentIntent.id
  }
  const legacy = (invoice as unknown as { payment_intent?: string | Stripe.PaymentIntent }).payment_intent
  if (legacy) {
    return typeof legacy === 'string' ? legacy : legacy.id
  }
  return undefined
}

export async function createMembershipSubscription(
  params: CreateSubscriptionParams,
  supabase: any,
  stripe: StripeDeps
): Promise<CreateSubscriptionResult> {
  const { customerId, membershipPlanId, billingFrequency, idempotencyKey } = params

  const { data: customer, error: customerError } = await supabase
    .from('customers')
    .select('id, stripe_customer_id, saved_payment_method_id')
    .eq('id', customerId)
    .single()

  if (customerError || !customer) {
    return { success: false, status: 404, error: 'Customer not found' }
  }

  // The reusable card is saved earlier by the existing setup-intent + resolve-saved-card flow —
  // this route only ever reads it, never writes it.
  if (!customer.stripe_customer_id || !customer.saved_payment_method_id) {
    return {
      success: false,
      status: 400,
      error: 'Customer has no saved payment method on file.',
      code: 'no_saved_card',
    }
  }

  const { data: plan, error: planError } = await supabase
    .from('membership_plans')
    .select('id, active, stripe_product_id, stripe_price_id, stripe_price_id_yearly')
    .eq('id', membershipPlanId)
    .single()

  if (planError || !plan) {
    return { success: false, status: 404, error: 'Membership plan not found' }
  }
  if (plan.active === false) {
    return { success: false, status: 400, error: 'Membership plan is not active' }
  }

  const priceId = billingFrequency === 'monthly' ? plan.stripe_price_id : plan.stripe_price_id_yearly
  if (!priceId) {
    return {
      success: false,
      status: 400,
      error: `Plan has no Stripe price for ${billingFrequency} billing.`,
      code: 'plan_not_synced',
    }
  }

  // Never subscribe to a one-off or mismatched price — verify it's actually the recurring
  // interval and currency we expect before touching anything else.
  let price: Stripe.Price
  try {
    price = await stripe.pricesRetrieve(priceId)
  } catch (stripeError) {
    console.error('Error retrieving Stripe price:', membershipPlanId, stripeError instanceof Error ? stripeError.message : stripeError)
    return { success: false, status: 500, error: 'Failed to verify Stripe price' }
  }

  const expectedInterval = billingFrequency === 'monthly' ? 'month' : 'year'
  if (!price.recurring || price.recurring.interval !== expectedInterval || price.currency !== 'gbp') {
    return {
      success: false,
      status: 400,
      error: 'Plan price is not a recurring GBP price matching the requested billing frequency.',
      code: 'price_not_recurring',
    }
  }

  try {
    await stripe.customersUpdate(customer.stripe_customer_id, {
      invoice_settings: { default_payment_method: customer.saved_payment_method_id },
    })
  } catch (stripeError) {
    console.error('Error setting default payment method:', customerId, stripeError instanceof Error ? stripeError.message : stripeError)
    return { success: false, status: 500, error: 'Failed to set default payment method' }
  }

  let subscription: Stripe.Subscription
  try {
    subscription = await stripe.subscriptionsCreate(
      {
        customer: customer.stripe_customer_id,
        items: [{ price: priceId }],
        default_payment_method: customer.saved_payment_method_id,
        off_session: true,
        payment_behavior: 'error_if_incomplete',
        metadata: {
          supabase_customer_id: customerId,
          membership_plan_id: membershipPlanId,
          billing_frequency: billingFrequency,
        },
        expand: ['latest_invoice.payments'],
      },
      idempotencyKey ? { idempotencyKey } : undefined
    )
  } catch (stripeError) {
    const stripeErr = stripeError as Stripe.errors.StripeError
    console.error('Error creating subscription:', customerId, membershipPlanId, stripeErr.code ?? stripeErr.type)

    // payment_behavior: 'error_if_incomplete' means Stripe does not create the subscription at
    // all when the first invoice can't be paid immediately — there is nothing to clean up here.
    // Only an actual card failure is a real decline — everything else (bad params, a Stripe API
    // error, our own expand mistake, etc.) must NOT be mislabelled payment_failed, or a real bug
    // looks identical to "card declined" and hides forever.
    const isCardFailure =
      stripeError instanceof Stripe.errors.StripeCardError || stripeErr.code === 'authentication_required'

    if (!isCardFailure) {
      return { success: false, status: 500, error: stripeErr.message ?? 'Unexpected error creating subscription', code: 'unexpected' }
    }

    let message = stripeErr.message ?? 'Payment failed'
    if (stripeErr.code === 'authentication_required') {
      message = 'This card requires additional authentication — ask the customer to re-enter their card.'
    }
    return { success: false, status: 402, error: message, code: 'payment_failed' }
  }

  // Defensive cleanup: payment_behavior: 'error_if_incomplete' should make this unreachable,
  // but never leave a non-functional subscription behind if Stripe returns one anyway.
  if (subscription.status !== 'active' && subscription.status !== 'trialing') {
    try {
      await stripe.subscriptionsCancel(subscription.id)
    } catch (cancelError) {
      console.error('Error cleaning up non-active subscription:', subscription.id, cancelError instanceof Error ? cancelError.message : cancelError)
    }
    return {
      success: false,
      status: 402,
      error: `Subscription could not be activated (status: ${subscription.status}).`,
      code: 'payment_failed',
    }
  }

  const item = subscription.items.data[0]
  if (!item) {
    console.error('Subscription created with no items:', subscription.id)
    return { success: false, status: 500, error: 'Subscription was created with no items' }
  }

  const invoice = typeof subscription.latest_invoice === 'object' ? subscription.latest_invoice : null
  const paymentIntentId = invoice ? (getInvoicePaymentIntentId(invoice) ?? null) : null

  return {
    success: true,
    subscriptionId: subscription.id,
    status: subscription.status,
    currentPeriodStart: new Date(item.current_period_start * 1000).toISOString(),
    currentPeriodEnd: new Date(item.current_period_end * 1000).toISOString(),
    latestInvoiceId: invoice?.id ?? null,
    paymentIntentId,
    amountPaid: invoice ? invoice.amount_paid / 100 : 0,
  }
}
