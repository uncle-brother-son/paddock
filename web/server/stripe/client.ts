import 'server-only'
import Stripe from 'stripe'

/**
 * The one way rules reach Stripe. A rule takes a StripeClient as an argument, so tests pass
 * FakeStripe (fake.ts) and only the route builds the real one. It lists just the calls in use: add
 * to it, and to the fake, when a rule needs another.
 *
 * Stripe calls never go inside db.transaction. Each one that moves money carries a key from
 * stripeIdempotencyKey, built from the order's id. outcome.ts reads what comes back.
 */
export interface StripeClient {
  paymentIntents: {
    create(params: Stripe.PaymentIntentCreateParams, options?: Stripe.RequestOptions): Promise<Stripe.PaymentIntent>
    retrieve(id: string, params?: Stripe.PaymentIntentRetrieveParams): Promise<Stripe.PaymentIntent>
    cancel(id: string): Promise<Stripe.PaymentIntent>
    list(params: Stripe.PaymentIntentListParams): Promise<Stripe.ApiList<Stripe.PaymentIntent>>
  }
  refunds: {
    create(params: Stripe.RefundCreateParams, options?: Stripe.RequestOptions): Promise<Stripe.Refund>
    list(params: Stripe.RefundListParams): Promise<Stripe.ApiList<Stripe.Refund>>
  }
  subscriptions: {
    create(params: Stripe.SubscriptionCreateParams, options?: Stripe.RequestOptions): Promise<Stripe.Subscription>
    cancel(id: string): Promise<Stripe.Subscription>
    list(params: Stripe.SubscriptionListParams): Promise<Stripe.ApiList<Stripe.Subscription>>
  }
  coupons: {
    create(params: Stripe.CouponCreateParams, options?: Stripe.RequestOptions): Promise<Stripe.Coupon>
    del(id: string): Promise<Stripe.DeletedCoupon>
  }
  customers: {
    create(params: Stripe.CustomerCreateParams, options?: Stripe.RequestOptions): Promise<Stripe.Customer>
    update(id: string, params: Stripe.CustomerUpdateParams): Promise<Stripe.Customer>
    search(params: Stripe.CustomerSearchParams): Promise<Stripe.ApiSearchResult<Stripe.Customer>>
  }
  prices: {
    retrieve(id: string): Promise<Stripe.Price>
  }
}

/** The API version every Stripe call in this repo uses. */
export const STRIPE_API_VERSION = '2026-07-29.dahlia'

export function createStripeClient(secretKey: string | undefined = process.env.STRIPE_SECRET_KEY): StripeClient {
  if (!secretKey) throw new Error('STRIPE_SECRET_KEY is not configured.')
  return new Stripe(secretKey, {
    apiVersion: STRIPE_API_VERSION,
    // Workers' runtime doesn't support the SDK's default Node socket client.
    httpClient: Stripe.createFetchHttpClient(),
  })
}
