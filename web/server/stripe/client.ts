import 'server-only'
import Stripe from 'stripe'
import type { StripeLimits } from './limits'

/**
 * The one way rules reach Stripe. A rule takes a StripeClient as an argument, so tests pass
 * FakeStripe (fake.ts) and only the route builds the real one. It lists just the calls in use: add
 * to it, and to the fake, when a rule needs another.
 *
 * Stripe calls never go inside db.transaction. Each one that moves money carries a key from
 * stripeIdempotencyKey, built from the order's id. outcome.ts reads what comes back.
 */
export interface StripeClient {
  /**
   * W11a (review L1): the mode of the key in use, read from the key itself: true for a live key, false
   * for a test key, null when the key doesn't say. Stripe answers 404 for an object made in the other
   * mode, so a 404 is "never existed" only when this matches the mode the object was made in.
   */
  readonly keyLivemode: boolean | null
  paymentIntents: {
    create(params: Stripe.PaymentIntentCreateParams, options?: Stripe.RequestOptions): Promise<Stripe.PaymentIntent>
    retrieve(id: string, params?: Stripe.PaymentIntentRetrieveParams, options?: Stripe.RequestOptions): Promise<Stripe.PaymentIntent>
    cancel(id: string, params?: Stripe.PaymentIntentCancelParams, options?: Stripe.RequestOptions): Promise<Stripe.PaymentIntent>
    list(params: Stripe.PaymentIntentListParams): Promise<Stripe.ApiList<Stripe.PaymentIntent>>
  }
  /** W11: the reader's card-save with no charge (createTerminalSetupIntent), and reading it back (resolve-saved-card). */
  setupIntents: {
    create(params: Stripe.SetupIntentCreateParams, options?: Stripe.RequestOptions): Promise<Stripe.SetupIntent>
    retrieve(id: string, params?: Stripe.SetupIntentRetrieveParams, options?: Stripe.RequestOptions): Promise<Stripe.SetupIntent>
  }
  /** W11: a generated card's last four and brand, when the tap carries none (resolve-saved-card). */
  paymentMethods: {
    retrieve(id: string, params?: Stripe.PaymentMethodRetrieveParams, options?: Stripe.RequestOptions): Promise<Stripe.PaymentMethod>
  }
  /** W11: the reader's connection token (getTerminalConnectionToken). */
  terminal: {
    connectionTokens: {
      create(params?: Stripe.Terminal.ConnectionTokenCreateParams, options?: Stripe.RequestOptions): Promise<Stripe.Terminal.ConnectionToken>
    }
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
    search(params: Stripe.CustomerSearchParams, options?: Stripe.RequestOptions): Promise<Stripe.ApiSearchResult<Stripe.Customer>>
  }
  prices: {
    retrieve(id: string): Promise<Stripe.Price>
  }
}

/** The API version every Stripe call in this repo uses. */
export const STRIPE_API_VERSION = '2026-07-29.dahlia'

// The limits live in limits.ts, which imports nothing from the SDK, so rule code can read them
// without loading this module (W10a: the replay's Stripe stand-in must be installed before it loads).
export { ORDER_STRIPE_LIMITS, READ_STRIPE_LIMITS, type StripeLimits } from './limits'

/** The mode a Stripe key is for, from its prefix (secret or restricted): true live, false test, null when it doesn't say. */
export function keyLivemode(secretKey: string): boolean | null {
  if (/^(sk|rk)_live_/.test(secretKey)) return true
  if (/^(sk|rk)_test_/.test(secretKey)) return false
  return null
}

/** With no limits given, the SDK's own defaults, as every caller before W10 had. */
export function createStripeClient(secretKey: string | undefined = process.env.STRIPE_SECRET_KEY, limits?: StripeLimits): StripeClient {
  if (!secretKey) throw new Error('STRIPE_SECRET_KEY is not configured.')
  const stripe = new Stripe(secretKey, {
    apiVersion: STRIPE_API_VERSION,
    // Workers' runtime doesn't support the SDK's default Node socket client.
    httpClient: Stripe.createFetchHttpClient(),
    ...(limits ? { timeout: limits.timeoutMs, maxNetworkRetries: limits.networkRetries } : {}),
  })
  return Object.assign(stripe, { keyLivemode: keyLivemode(secretKey) })
}
