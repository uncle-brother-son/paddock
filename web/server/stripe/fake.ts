import Stripe from 'stripe'
import { stableStringify } from '@/server/http/idempotency'
import type { StripeClient } from './client'

/**
 * Stripe for tests: what we believe Stripe does, written down. It holds real state, so a test can
 * ask what was charged, and it records every call in order for the replay harness. W15's real
 * test-mode runs are the check that it matches.
 *
 * Modelled because step C depends on it:
 * - An idempotency key replays its saved answer, a decline or a 500 included, and the same key with
 *   different parameters is refused.
 * - A refund leaves the PaymentIntent reading `succeeded` (W03a), and refunding too much is refused.
 * - A failure can be set to happen before Stripe sees the call, or after it took effect with the
 *   response lost, which are the two things a timeout can mean.
 *
 * W47r: a renewal's invoice, for "Try the payment again now" (the test-only calls from `startRenewal` on, and
 * `invoices` below). Where a line there is a guess about Stripe, its comment says so.
 *
 * Anything else throws "not modelled", so a test can't pass on behaviour nobody wrote down.
 */

export interface FakeStripeCall {
  method: string
  params: unknown
  idempotencyKey: string | null
}

export type FakeFault =
  /** Stripe answered with this error. Saved against the key, as Stripe does. */
  | { kind: 'error'; error: Error }
  /** The call never reached Stripe: nothing happened and the key isn't used up. */
  | { kind: 'unreachable' }
  /** The call took effect, but the answer never came back. */
  | { kind: 'lost_response' }
  /** Nothing goes wrong: queued first, so that the fault after it hits the second call. */
  | { kind: 'none' }
  /** Another request with the same key is still running at Stripe: a 409, and nothing is saved
   *  against the key, so the request that is running decides what the key holds. */
  | { kind: 'key_in_use' }

export const fakeStripeErrors = {
  cardDeclined: () =>
    new Stripe.errors.StripeCardError({ type: 'card_error', code: 'card_declined', message: 'Your card was declined.' }),
  authenticationRequired: () =>
    new Stripe.errors.StripeCardError({
      type: 'card_error',
      code: 'authentication_required',
      message: 'This payment requires authentication.',
    }),
  server: () => new Stripe.errors.StripeAPIError({ type: 'api_error', message: 'An error occurred with our API.' }),
  connection: () =>
    new Stripe.errors.StripeConnectionError({ type: 'api_error', message: 'An error occurred with our connection to Stripe.' }),
  invalid: (code: string, message: string) =>
    new Stripe.errors.StripeInvalidRequestError({ type: 'invalid_request_error', code, message }),
  missing: (what: string) =>
    new Stripe.errors.StripeInvalidRequestError({ type: 'invalid_request_error', code: 'resource_missing', message: `No such ${what}` }),
  idempotency: () =>
    new Stripe.errors.StripeIdempotencyError({
      type: 'idempotency_error',
      message: 'Keys for idempotent requests can only be used with the same parameters they were first used with.',
    }),
  /** A 401: the key is wrong, expired or rolled. The SDK makes it a StripeAuthenticationError (generateV1Error). */
  authentication: () =>
    new Stripe.errors.StripeAuthenticationError({
      type: 'invalid_request_error',
      statusCode: 401,
      message: 'Invalid API Key provided: sk_live_****wxyz',
    }),
  /** A 403: a restricted key without the permission. The SDK makes it a StripePermissionError. */
  permission: () =>
    new Stripe.errors.StripePermissionError({
      type: 'invalid_request_error',
      statusCode: 403,
      message: "The provided key 'rk_live_****wxyz' does not have the required permissions for this endpoint.",
    }),
  /** A 409: the SDK makes it a StripeAPIError, so outcome.ts reads it as unknown, which it is. */
  keyInUse: () =>
    new Stripe.errors.StripeAPIError({
      type: 'invalid_request_error',
      code: 'idempotency_key_in_use',
      statusCode: 409,
      message:
        'There is currently another in-progress request using this Idempotent Key (that probably means you submitted twice, and the other request is still going through). Please try again later.',
    }),
}

interface SavedAnswer {
  method: string
  params: string
  result?: unknown
  error?: Error
}

interface FakePaymentIntent {
  id: string
  object: 'payment_intent'
  status: Stripe.PaymentIntent.Status
  amount: number
  amount_received: number
  currency: string
  customer: string | null
  payment_method: string | null
  description: string | null
  metadata: Record<string, string>
  client_secret: string
  setup_future_usage: string | null
  created: number
  latest_charge: string | null
  /** The mode of the key it was made with (W11a). */
  livemode: boolean
}

/** W11: a reader card-save with no charge (createTerminalSetupIntent's). */
interface FakeSetupIntent {
  id: string
  object: 'setup_intent'
  status: Stripe.SetupIntent.Status
  customer: string | null
  payment_method: string | null
  payment_method_types: string[]
  usage: string
  client_secret: string
  created: number
  latest_attempt: string | null
}

interface FakeRefund {
  id: string
  object: 'refund'
  amount: number
  payment_intent: string
  /** W12: Stripe answers some refunds `pending` and settles them later (settleRefund). */
  status: 'succeeded' | 'pending' | 'failed' | 'canceled'
  metadata: Record<string, string>
  created: number
}

/** W32: a customer balance transaction (a membership compensation's put-back of the customer's balance). */
interface FakeBalanceTransaction {
  id: string
  object: 'customer_balance_transaction'
  customer: string
  amount: number
  currency: string
  ending_balance: number
  metadata: Record<string, string>
  created: number
}

interface FakeSubscription {
  id: string
  object: 'subscription'
  status: Stripe.Subscription.Status
  customer: string
  metadata: Record<string, string>
  items: { data: Array<{ price: { id: string }; current_period_start: number; current_period_end: number }> }
  /** The id of its newest invoice: the one it was made with (`invoice`), until a test gives it a later one (W46b). */
  latest_invoice: string
  /** The invoice it was made with. */
  invoice: FakeInvoice
  /** W13: the mode of the key it was made with, as an intent's (W11a). */
  livemode: boolean
  created: number
  /** W36: when it is set to end (a scheduled cancellation), in seconds; null when none is set. */
  cancel_at: number | null
  /**
   * W59 (W45a "Noticed" 7): whether it ends at the end of its period, as set (Stripe keeps it; the fake answered
   * false always). Set true, `cancel_at` becomes the period's end; a `cancel_at` set by itself sets it false.
   */
  cancel_at_period_end: boolean
  /** W36: the end of a no-charge period set on it (a payment date change), in seconds; null when none. */
  trial_end: number | null
  /** W36: the moment its billing periods are counted from. */
  billing_cycle_anchor: number
  /** W36: the card its invoices are charged to; null means the customer's own default. */
  default_payment_method: string | null
  /**
   * W47r-b: when it ended, and when its cancellation was asked for, in seconds; null while it is live. Stripe's
   * `ended_at` is the moment the subscription stopped; `canceled_at` is the cancel request's time, which for a
   * scheduled cancel is earlier than the end (Stripe's API reference, the Subscription object).
   */
  ended_at: number | null
  canceled_at: number | null
}

interface FakeInvoice {
  id: string
  object: 'invoice'
  /** W13a: after the coupon, before the customer's balance. */
  total: number
  /** W13a: the customer's balance when the invoice was made (positive: they owe; negative: credit). */
  starting_balance: number
  /** W13a: what was due once the balance was applied, and the balance it left. */
  amount_due: number
  ending_balance: number
  amount_paid: number
  payments: { data: Array<{ payment: { payment_intent: string | null } }> }
}

/**
 * W47r: an invoice Stripe made after the one a subscription was made with: a renewal's. A draft for its first hour
 * (`startRenewal`); then finalised and charged (`renewalFails`: open, with its payment declined). `paymentIntent` is
 * the one payment Stripe makes for it, tried again by each later attempt; null while it is a draft.
 */
interface FakeRenewalInvoice {
  id: string
  object: 'invoice'
  status: 'draft' | 'open' | 'paid' | 'void' | 'uncollectible'
  customer: string
  subscription: string
  currency: string
  amount_due: number
  amount_paid: number
  amount_remaining: number
  attempt_count: number
  livemode: boolean
  created: number
  paymentIntent: string | null
  /** W47r-b: when it was paid, in seconds (Stripe's `status_transitions.paid_at`); null until it is. */
  status_transitions: { paid_at: number | null }
}

/**
 * W13a (S1): Stripe's minimum charge per currency, in its smallest unit (30p in GBP). An invoice whose amount due
 * is above nothing but below it is marked paid with nothing taken, and the amount goes onto the customer's
 * balance, to be added to their next invoice (Stripe's docs: invoicing overview, "Open invoices"; customer
 * balance, `invoice_too_small`; read by the W13 review, 10 Nov 2026).
 */
const MINIMUM_CHARGE: Readonly<Record<string, number>> = { gbp: 30 }

const clone = <T>(value: T): T => (value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T))
const seconds = () => Math.floor(Date.now() / 1000)
/** W48: the id of a subscription's one item, as the fake shows it. */
const subscriptionItemId = (subscriptionId: string) => `si_${subscriptionId}`
const list = <T>(data: T[]) => ({ object: 'list' as const, data, has_more: false, url: '/fake' })
const newestFirst = <T>(rows: T[]) => [...rows].reverse()

function addPeriod(start: number, interval: string): number {
  const end = new Date(start * 1000)
  if (interval === 'year') end.setUTCFullYear(end.getUTCFullYear() + 1)
  else end.setUTCMonth(end.getUTCMonth() + 1)
  return Math.floor(end.getTime() / 1000)
}

export class FakeStripe implements StripeClient {
  /** Every call that reached the client, in order, including ones that failed. */
  readonly calls: FakeStripeCall[] = []

  /**
   * The mode of the key in use (W11a): a test key by default. A test may change it, as a Worker
   * redeployed with the other mode's key: intents made before are then answered as missing, as Stripe does.
   */
  keyLivemode: boolean | null = false

  private readonly saved = new Map<string, SavedAnswer>()
  private readonly faults = new Map<string, FakeFault[]>()
  private readonly intents = new Map<string, FakePaymentIntent>()
  private readonly refunded = new Map<string, number>()
  private readonly refundsMade: FakeRefund[] = []
  /** W32: every customer balance transaction made, oldest first. */
  private readonly balanceTransactionsMade: FakeBalanceTransaction[] = []
  private readonly generatedCards = new Map<string, string>()
  /** W42b: when each charge or card-save attempt was made (Stripe's `created`, seconds), by its id: the tap's time. */
  private readonly tapTimes = new Map<string, number>()
  private tapped(id: string): string {
    this.tapTimes.set(id, seconds())
    return id
  }
  private readonly setupIntentsById = new Map<string, FakeSetupIntent>()
  /** The reusable cards Stripe generated for a tap, as payment methods: what paymentMethods.retrieve finds. */
  private readonly cardsById = new Map<string, { last4: string; brand: string }>()
  private readonly subs = new Map<string, FakeSubscription>()
  /** W47r: renewal invoices, by id. */
  private readonly renewalInvoices = new Map<string, FakeRenewalInvoice>()
  /** W47r: how the next `invoices.pay` of an invoice ends at the bank, when not at once (`nextPayEnds`). */
  private readonly payEndings = new Map<string, 'processing' | 'requires_action'>()
  /** W47r: cards the bank declines (`declineCard`). */
  private readonly decliningCards = new Set<string>()
  private readonly couponsById = new Map<string, Stripe.Coupon>()
  private readonly customersById = new Map<string, Record<string, unknown>>()
  private readonly pricesById = new Map<string, Record<string, unknown>>()
  /** W48: catalogue products, by id (what the legacy /api/catalog routes made and switched on and off; since W61 only their frozen copy). */
  private readonly productsById = new Map<string, Record<string, unknown>>()
  private sequence = 0

  /**
   * W12: `idTag` goes into every id this fake makes (`pi_fake_<tag>_0001`). Migration 022 lets one
   * PaymentIntent be on one order only, so tests that run many fakes against one database (the real
   * Postgres races) give each its own tag. Without one, ids are as before (the golden files name them).
   */
  constructor(private readonly options: { idTag?: string } = {}) {}

  private nextId(prefix: string): string {
    this.sequence += 1
    const tag = this.options.idTag ? `${this.options.idTag}_` : ''
    return `${prefix}_fake_${tag}${String(this.sequence).padStart(4, '0')}`
  }

  // Set-up, for tests.

  addCustomer(id: string, fields: Record<string, unknown> = {}): void {
    this.customersById.set(id, { id, object: 'customer', metadata: {}, ...fields })
  }

  addPrice(id: string, unitAmount: number, interval: 'month' | 'year' | null, currency = 'gbp', active = true): void {
    this.pricesById.set(id, {
      id,
      object: 'price',
      active,
      unit_amount: unitAmount,
      currency,
      recurring: interval ? { interval } : null,
    })
  }

  /** W48: a product that already exists in Stripe, as a catalogue item synced earlier has. */
  addProduct(id: string, fields: Record<string, unknown> = {}): void {
    this.productsById.set(id, { id, object: 'product', active: true, metadata: {}, ...fields })
  }

  /** W48: a product as Stripe holds it now, for tests. */
  product(id: string): Record<string, unknown> | null {
    const product = this.productsById.get(id)
    return product ? clone(product) : null
  }

  /** W48: a price as Stripe holds it now, for tests (whether it is archived, say). */
  price(id: string): Record<string, unknown> | null {
    const price = this.pricesById.get(id)
    return price ? clone(price) : null
  }

  /** W13: a subscription as Stripe holds it now, for tests (its status after a cancel, say). */
  subscription(id: string): { status: Stripe.Subscription.Status; metadata: Record<string, string>; customer: string; amountPaid: number; total: number } | null {
    const sub = this.subs.get(id)
    return sub ? { status: sub.status, metadata: { ...sub.metadata }, customer: sub.customer, amountPaid: sub.invoice.amount_paid, total: sub.invoice.total } : null
  }

  /** W13a: a customer's Stripe balance, in pence (positive: they owe it, added to their next invoice; negative: credit). */
  customerBalance(id: string): number {
    return Number(this.customer(id)['balance'] ?? 0)
  }

  /** W13a: a balance the customer already has in Stripe (an earlier invoice under the minimum, say, or a credit). */
  setCustomerBalance(id: string, pence: number): void {
    this.customer(id)['balance'] = pence
  }

  /** W13: every subscription made, oldest first, as tests read them. */
  get subscriptionsMade(): string[] {
    return [...this.subs.keys()]
  }

  /** W13: a coupon as Stripe holds it, for tests. */
  coupon(id: string): Stripe.Coupon | null {
    return this.couponsById.get(id) ?? null
  }

  /** An active subscription that already exists, as a membership bought earlier would have. */
  addSubscription(id: string, customer: string, priceId: string): void {
    const start = seconds()
    const interval = (this.pricesById.get(priceId)?.['recurring'] as { interval: string } | null | undefined)?.interval ?? 'month'
    const invoice: FakeInvoice = { id: this.nextId('in'), object: 'invoice', total: 0, starting_balance: 0, amount_due: 0, ending_balance: 0, amount_paid: 0, payments: { data: [] } }
    this.subs.set(id, {
      id,
      object: 'subscription',
      status: 'active',
      customer,
      metadata: {},
      items: { data: [{ price: { id: priceId }, current_period_start: start, current_period_end: addPeriod(start, interval) }] },
      latest_invoice: invoice.id,
      invoice,
      livemode: this.keyLivemode === true,
      created: start,
      cancel_at: null,
      cancel_at_period_end: false,
      trial_end: null,
      billing_cycle_anchor: start,
      default_payment_method: null,
      ended_at: null,
      canceled_at: null,
    })
  }

  /**
   * W36: what a subscription is set to, for tests: its scheduled end, its no-charge period's end, its current
   * period's end (all in seconds) and the card it charges.
   */
  subscriptionSettings(id: string): { status: Stripe.Subscription.Status; cancelAt: number | null; trialEnd: number | null; periodEnd: number | null; defaultPaymentMethod: string | null } | null {
    const sub = this.subs.get(id)
    return sub
      ? { status: sub.status, cancelAt: sub.cancel_at, trialEnd: sub.trial_end, periodEnd: sub.items.data[0]?.current_period_end ?? null, defaultPaymentMethod: sub.default_payment_method }
      : null
  }

  /**
   * W36: a subscription as Stripe might already hold it, set up for a test with no call recorded: its status, a
   * scheduled end, or its current period's end (all times in seconds).
   */
  setSubscription(
    id: string,
    fields: { status?: Stripe.Subscription.Status; cancelAt?: number | null; periodEnd?: number; latestInvoice?: string; endedAt?: number | null; canceledAt?: number | null }
  ): void {
    const sub = this.subs.get(id)
    if (!sub) throw new Error(`The fake has no subscription ${id}.`)
    if (fields.status !== undefined) {
      sub.status = fields.status
      // W47r-b: a subscription that ends has the moment it ended, as Stripe gives it: now, unless the test says when
      // (`endedAt`, `canceledAt`; null for "Stripe gave none"). One set live again has neither.
      const ended = fields.status === 'canceled' || fields.status === 'incomplete_expired'
      if (ended && sub.ended_at === null) sub.ended_at = seconds()
      if (ended && sub.canceled_at === null) sub.canceled_at = sub.ended_at
      if (!ended) {
        sub.ended_at = null
        sub.canceled_at = null
      }
    }
    if (fields.endedAt !== undefined) sub.ended_at = fields.endedAt
    if (fields.canceledAt !== undefined) sub.canceled_at = fields.canceledAt
    if (fields.cancelAt !== undefined) sub.cancel_at = fields.cancelAt
    if (fields.periodEnd !== undefined) for (const item of sub.items.data) item.current_period_end = fields.periodEnd
    // W46b: its newest invoice, by id (a later invoice than the one it was made with: a renewal's, a date change's).
    if (fields.latestInvoice !== undefined) sub.latest_invoice = fields.latestInvoice
  }

  /** W46b: the id of a subscription's newest invoice, as a read of it answers `latest_invoice`. */
  latestInvoice(id: string): string {
    const sub = this.subs.get(id)
    if (!sub) throw new Error(`The fake has no subscription ${id}.`)
    return sub.latest_invoice
  }

  /**
   * W46b (W46 review B1): a renewal as Stripe shows it in the hour before it charges. The period has moved on (to
   * `periodEnd`, or one of the price's periods after the old end), the subscription still reads `active`, and its
   * newest invoice is a new one, a draft nothing has been taken for. Answers the draft's id. What follows is the
   * test's to set: `past_due` when the charge fails, `active` still when it goes through; the invoice stays the
   * newest either way.
   */
  startRenewal(id: string, periodEnd?: number): string {
    const sub = this.subs.get(id)
    if (!sub) throw new Error(`The fake has no subscription ${id}.`)
    const interval = (this.pricesById.get(sub.items.data[0]?.price.id ?? '')?.['recurring'] as { interval: string } | null | undefined)?.interval ?? 'month'
    for (const item of sub.items.data) {
      const start = item.current_period_end
      item.current_period_start = start
      item.current_period_end = periodEnd ?? addPeriod(start, interval)
    }
    sub.status = 'active'
    sub.trial_end = null
    sub.latest_invoice = this.nextId('in')
    // W47r: the draft itself, for the price's amount, so it can be finalised and paid (`renewalFails`, `invoices`).
    const price = this.pricesById.get(sub.items.data[0]?.price.id ?? '')
    this.renewalInvoices.set(sub.latest_invoice, {
      id: sub.latest_invoice,
      object: 'invoice',
      status: 'draft',
      customer: sub.customer,
      subscription: sub.id,
      currency: String(price?.['currency'] ?? 'gbp'),
      amount_due: Number(price?.['unit_amount'] ?? 0),
      amount_paid: 0,
      amount_remaining: Number(price?.['unit_amount'] ?? 0),
      attempt_count: 0,
      livemode: sub.livemode,
      created: seconds(),
      paymentIntent: null,
      status_transitions: { paid_at: null },
    })
    return sub.latest_invoice
  }

  private renewalInvoice(id: string): FakeRenewalInvoice {
    const invoice = this.renewalInvoices.get(id)
    if (!invoice) throw new Error(`The fake has no renewal invoice ${id}.`)
    return invoice
  }

  /**
   * W47r: the draft's hour is up. Stripe finalises the renewal's invoice and tries its charge on the subscription's
   * card, which the bank declines: the invoice is `open` with all of it still to pay, its one payment is at
   * `requires_payment_method` (nothing taken), and the subscription reads `past_due`. The subscription's newest
   * invoice must be a draft made by `startRenewal`. Answers the invoice and its payment.
   */
  renewalFails(subscriptionId: string): { invoice: string; paymentIntent: string } {
    const sub = this.subs.get(subscriptionId)
    if (!sub) throw new Error(`The fake has no subscription ${subscriptionId}.`)
    const invoice = this.renewalInvoice(sub.latest_invoice)
    if (invoice.status !== 'draft') throw new Error(`The fake's invoice ${invoice.id} is ${invoice.status}: only a draft is finalised.`)
    const intent = this.addIntent({ amount: invoice.amount_due, currency: invoice.currency, customer: invoice.customer, payment_method: sub.default_payment_method })
    invoice.status = 'open'
    invoice.attempt_count = 1
    invoice.paymentIntent = intent.id
    sub.status = 'past_due'
    return { invoice: invoice.id, paymentIntent: intent.id }
  }

  /** W47r: a renewal invoice as Stripe holds it now, for tests: its status, what was paid, its payment and the card that payment was last tried on. */
  invoiceState(id: string): { status: FakeRenewalInvoice['status']; amountPaid: number; paymentIntent: string | null; paymentStatus: Stripe.PaymentIntent.Status | null; paymentMethod: string | null } {
    const invoice = this.renewalInvoice(id)
    const intent = invoice.paymentIntent ? this.intents.get(invoice.paymentIntent) : undefined
    return { status: invoice.status, amountPaid: invoice.amount_paid, paymentIntent: invoice.paymentIntent, paymentStatus: intent?.status ?? null, paymentMethod: intent?.payment_method ?? null }
  }

  /** W47r-b: when a paid invoice was paid, as Stripe has it (seconds), for a test that sets the order of a payment and a cancel to the second. */
  setInvoicePaidAt(id: string, paidAt: number | null): void {
    const invoice = this.renewalInvoice(id)
    if (invoice.status !== 'paid') throw new Error(`The fake's invoice ${id} is ${invoice.status}: only a paid one has a time it was paid.`)
    invoice.status_transitions.paid_at = paidAt
  }

  /** W47r: an invoice someone voided or wrote off in Stripe's dashboard. Nothing is taken for it by that. */
  setInvoiceStatus(id: string, status: 'void' | 'uncollectible'): void {
    this.renewalInvoice(id).status = status
  }

  /** W47r: the bank declines this card from now on (`false`: it takes it again). */
  declineCard(paymentMethod: string, declines = true): void {
    if (declines) this.decliningCards.add(paymentMethod)
    else this.decliningCards.delete(paymentMethod)
  }

  /**
   * W47r: the next `invoices.pay` of this invoice doesn't end at once. `processing`: the bank is still working on it
   * (the invoice stays open; `settleInvoicePayment` says how it ended). `requires_action`: the bank wants the
   * customer to approve it, which nobody at the desk can do: Stripe answers the pay with an error and leaves the
   * payment waiting.
   */
  nextPayEnds(invoiceId: string, how: 'processing' | 'requires_action'): void {
    this.renewalInvoice(invoiceId)
    this.payEndings.set(invoiceId, how)
  }

  /** The invoice paid in full by its payment: the money taken on `paymentMethod`, and a subscription that was behind on it paid up. */
  private takeInvoicePayment(invoice: FakeRenewalInvoice, paymentMethod: string | null): void {
    const intent = invoice.paymentIntent ? this.intents.get(invoice.paymentIntent) : undefined
    if (!intent) throw new Error(`The fake's invoice ${invoice.id} has no payment to take.`)
    intent.status = 'succeeded'
    intent.amount_received = intent.amount
    intent.payment_method = paymentMethod
    intent.latest_charge = this.tapped(this.nextId('ch'))
    invoice.status = 'paid'
    invoice.amount_paid = invoice.amount_due
    invoice.amount_remaining = 0
    invoice.status_transitions.paid_at = seconds()
    // Stripe: paying the newest invoice of a subscription that is behind on it makes the subscription `active`
    // (docs, "How subscriptions work", past_due, read 19 Nov 2026). One that has ended stays ended.
    const sub = this.subs.get(invoice.subscription)
    if (sub && sub.latest_invoice === invoice.id && (sub.status === 'past_due' || sub.status === 'unpaid')) sub.status = 'active'
  }

  /**
   * W47r: a payment `nextPayEnds` left unfinished ends: `succeeded` (the invoice is paid), or `failed` / `canceled`
   * (nothing taken: the payment is back at `requires_payment_method`, or cancelled, and the invoice stays open).
   */
  settleInvoicePayment(invoiceId: string, how: 'succeeded' | 'failed' | 'canceled'): void {
    const invoice = this.renewalInvoice(invoiceId)
    const intent = invoice.paymentIntent ? this.intents.get(invoice.paymentIntent) : undefined
    if (!intent || (intent.status !== 'processing' && intent.status !== 'requires_action')) throw new Error(`The fake's invoice ${invoiceId} has no payment still going.`)
    if (how === 'succeeded') this.takeInvoicePayment(invoice, intent.payment_method)
    else intent.status = how === 'failed' ? 'requires_payment_method' : 'canceled'
  }

  /**
   * W47r: one of Stripe's own retries of an open invoice (Smart Retries) goes through, on the subscription's card:
   * no call of ours is recorded. The invoice is paid and a subscription behind on it reads `active`.
   */
  stripeRetryPays(invoiceId: string): void {
    const invoice = this.renewalInvoice(invoiceId)
    if (invoice.status !== 'open') throw new Error(`The fake's invoice ${invoiceId} is ${invoice.status}: only an open one is retried.`)
    invoice.attempt_count += 1
    this.takeInvoicePayment(invoice, this.subs.get(invoice.subscription)?.default_payment_method ?? null)
  }

  /** Stripe keeps a key for at least 24 hours, then may drop it: a repeat after that is a new
   *  request. This drops them all, as if that time had passed. */
  forgetIdempotencyKeys(): void {
    this.saved.clear()
  }

  /**
   * W12: refunds made from now on are answered `pending`, as Stripe answers some (a card that takes
   * longer, or one Stripe is still checking); settleRefund later says how each ended.
   */
  refundsStayPending = false

  /**
   * W13a: refunds made from now on are answered `failed` at once (Stripe can, for a card that can't take it back),
   * and no money moves.
   */
  refundsFailAtOnce = false

  /**
   * W12: a pending refund ends: `succeeded`, or `failed` / `canceled` (its money is back on the payment).
   * W32a (W32 review L4): a refund Stripe answered `succeeded` can fail afterwards (its "refund fails" test card,
   * 4000 0000 0000 5126: "its status begins as succeeded… transitions to failed"): `succeeded` to `failed`, with its
   * amount back on the payment in the same way. Nothing else moves: an ended refund stays ended.
   */
  settleRefund(id: string, status: 'succeeded' | 'failed' | 'canceled'): void {
    const refund = this.refundsMade.find((r) => r.id === id)
    if (!refund) throw new Error(`The fake has no refund ${id}.`)
    const failsLater = refund.status === 'succeeded' && status === 'failed'
    if (refund.status !== 'pending' && !failsLater) throw new Error(`The fake's refund ${id} is ${refund.status}: only a pending refund ends, and only a succeeded one can fail afterwards.`)
    refund.status = status
    if (status !== 'succeeded') this.refunded.set(refund.payment_intent, (this.refunded.get(refund.payment_intent) ?? 0) - refund.amount)
  }

  /** W12: an intent Stripe is still processing (a card that takes longer): it can't be cancelled, and may yet succeed. */
  markProcessing(id: string): void {
    const intent = this.intents.get(id)
    if (!intent) throw new Error(`The fake has no PaymentIntent ${id}.`)
    intent.status = 'processing'
  }

  /**
   * W47: a charge waiting for the customer to approve it with their bank (`requires_action`): nothing taken, it never
   * ends on its own, and it can be cancelled.
   */
  markRequiresAction(id: string): void {
    const intent = this.intents.get(id)
    if (!intent) throw new Error(`The fake has no PaymentIntent ${id}.`)
    intent.status = 'requires_action'
    intent.amount_received = 0
    intent.latest_charge = null
  }

  /**
   * W13b: a charge Stripe has authorised but not yet captured (`requires_capture`): nothing taken yet, and it
   * can still be cancelled, or succeed (completeReaderPayment, which works for any intent).
   */
  markRequiresCapture(id: string): void {
    const intent = this.intents.get(id)
    if (!intent) throw new Error(`The fake has no PaymentIntent ${id}.`)
    intent.status = 'requires_capture'
    intent.amount_received = 0
    intent.latest_charge = null
  }

  /** W32: every customer balance transaction made, oldest first, as tests read them. */
  get balanceTransactions(): ReadonlyArray<Readonly<FakeBalanceTransaction>> {
    return this.balanceTransactionsMade
  }

  /** W12: every refund made, oldest first, as tests read them. */
  get refundsSent(): ReadonlyArray<Readonly<FakeRefund>> {
    return this.refundsMade
  }

  /** The next call to this method (e.g. 'paymentIntents.create') meets this fault. */
  failNext(method: string, fault: FakeFault): void {
    this.faults.set(method, [...(this.faults.get(method) ?? []), fault])
  }

  /**
   * The customer taps the reader: the PaymentIntent succeeds, as the Terminal flow would. A tap that
   * saves the card names the reusable card Stripe generates for it.
   */
  completeReaderPayment(
    id: string,
    options: {
      generatedCard?: string
      /** W11: the simulated reader, which leaves a card_present card but never a reusable one (W03-plan Q16). */
      simulatedReader?: boolean
      /** W11: pence the tap actually took, when not the intent's amount (a reader that took another figure). */
      amount?: number
    } = {}
  ): void {
    const intent = this.intents.get(id)
    if (!intent) throw new Error(`The fake has no PaymentIntent ${id}.`)
    intent.status = 'succeeded'
    if (options.amount !== undefined) intent.amount = options.amount
    intent.amount_received = intent.amount
    intent.latest_charge = this.tapped(this.nextId('ch'))
    if (options.generatedCard || options.simulatedReader) intent.payment_method = `${id}_card_present`
    if (options.generatedCard) {
      this.generatedCards.set(id, options.generatedCard)
      this.cardsById.set(options.generatedCard, { last4: '4242', brand: 'visa' })
    }
  }

  /**
   * W11: the customer taps the reader to save a card with no charge: the SetupIntent succeeds. Its
   * attempt names the reusable card Stripe generates (none on the simulated reader). As Stripe, the
   * attempt's card_present carries no last four or brand: those are on the generated card.
   */
  completeReaderSetup(id: string, options: { generatedCard?: string } = {}): void {
    const setupIntent = this.setupIntentsById.get(id)
    if (!setupIntent) throw new Error(`The fake has no SetupIntent ${id}.`)
    setupIntent.status = 'succeeded'
    setupIntent.payment_method = `${id}_card_present`
    setupIntent.latest_attempt = this.tapped(this.nextId('setatt'))
    if (options.generatedCard) {
      this.generatedCards.set(id, options.generatedCard)
      this.cardsById.set(options.generatedCard, { last4: '1881', brand: 'mastercard' })
    }
  }

  // What happened, for tests.

  /** Pence actually taken, after refunds. */
  get netPence(): number {
    let total = 0
    for (const intent of this.intents.values()) total += intent.amount_received - (this.refunded.get(intent.id) ?? 0)
    return total
  }

  /** Pence each PaymentIntent actually took, by id, before refunds. */
  get chargedByIntent(): Map<string, number> {
    return new Map([...this.intents.values()].filter((i) => i.amount_received > 0).map((i) => [i.id, i.amount_received]))
  }

  /** Pence refunded on each PaymentIntent, by id: what really left Stripe for it. */
  get refundedByIntent(): Map<string, number> {
    return new Map(this.refunded)
  }

  /** Pence refunded in all: what really left Stripe, however many calls asked for it. */
  get refundedPence(): number {
    return [...this.refunded.values()].reduce((sum, pence) => sum + pence, 0)
  }

  get liveSubscriptions(): string[] {
    return [...this.subs.values()].filter((s) => s.status === 'active').map((s) => s.id)
  }

  /**
   * W13: a request whose key Stripe ignores (a DELETE: "Don't send idempotency keys in GET and DELETE
   * requests because it has no effect", Stripe's API reference). The call is recorded with the key it
   * was sent with, but nothing is saved against it or replayed from it.
   */
  private runIgnoringKey<T>(method: string, params: unknown, options: Stripe.RequestOptions | undefined, work: () => T): Promise<T> {
    const answer = this.run(method, params, undefined, work)
    const call = this.calls.at(-1)
    if (call && options?.idempotencyKey) call.idempotencyKey = options.idempotencyKey
    return answer
  }

  // The shared path: records the call, then applies faults and the idempotency rules.

  private async run<T>(method: string, params: unknown, options: Stripe.RequestOptions | undefined, work: () => T): Promise<T> {
    const key = options?.idempotencyKey ?? null
    this.calls.push({ method, params: clone(params), idempotencyKey: key })

    const queued = this.faults.get(method) ?? []
    const fault = queued.shift()
    if (fault?.kind === 'unreachable') throw fakeStripeErrors.connection()

    const fingerprint = stableStringify(params ?? null)
    const saved = key === null ? undefined : this.saved.get(key)
    // Only while the other request hasn't finished: once it has, its answer is saved and replayed.
    if (fault?.kind === 'key_in_use' && !saved) throw fakeStripeErrors.keyInUse()
    if (saved) {
      if (saved.method !== method || saved.params !== fingerprint) throw fakeStripeErrors.idempotency()
      if (saved.error) throw saved.error
      if (fault?.kind === 'lost_response') throw fakeStripeErrors.connection()
      return clone(saved.result) as T
    }

    const remember = (answer: Pick<SavedAnswer, 'result' | 'error'>) => {
      if (key !== null) this.saved.set(key, { method, params: fingerprint, ...answer })
    }

    if (fault?.kind === 'error') {
      // W12a: a refused key (401) or a missing permission (403) is turned away before any endpoint runs, so
      // Stripe saves nothing against the key ("we save results only after the execution of an endpoint
      // begins", Stripe's idempotency docs, read 10 Nov 2026): the same key sent again once the key works
      // is a first send.
      const refused = fault.error instanceof Stripe.errors.StripeAuthenticationError || fault.error instanceof Stripe.errors.StripePermissionError
      if (!refused) remember({ error: fault.error })
      throw fault.error
    }

    let result: T
    try {
      result = work()
    } catch (err) {
      remember({ error: err as Error })
      throw err
    }
    remember({ result: clone(result) })
    if (fault?.kind === 'lost_response') throw fakeStripeErrors.connection()
    return clone(result)
  }

  private intent(id: string): FakePaymentIntent {
    const intent = this.intents.get(id)
    // As Stripe: an intent made in the other mode is answered as missing (W11a, review L1).
    if (!intent || intent.livemode !== (this.keyLivemode === true)) throw fakeStripeErrors.missing(`payment_intent: '${id}'`)
    return intent
  }

  private addIntent(fields: Partial<FakePaymentIntent> & { amount: number; currency: string }): FakePaymentIntent {
    const id = this.nextId('pi')
    const intent: FakePaymentIntent = {
      id,
      object: 'payment_intent',
      status: 'requires_payment_method',
      amount_received: 0,
      customer: null,
      payment_method: null,
      description: null,
      metadata: {},
      client_secret: `${id}_secret`,
      setup_future_usage: null,
      created: seconds(),
      latest_charge: null,
      livemode: this.keyLivemode === true,
      ...fields,
    }
    this.intents.set(id, intent)
    return intent
  }

  readonly paymentIntents: StripeClient['paymentIntents'] = {
    create: (params, options) =>
      this.run('paymentIntents.create', params, options, () => {
        const confirmed = params.confirm === true
        const customer = typeof params.customer === 'string' ? params.customer : null
        if (customer !== null) this.customer(customer)
        return this.addIntent({
          amount: params.amount,
          currency: params.currency,
          customer,
          payment_method: typeof params.payment_method === 'string' ? params.payment_method : null,
          description: params.description ?? null,
          metadata: (params.metadata ?? {}) as Record<string, string>,
          setup_future_usage: params.setup_future_usage ?? null,
          ...(confirmed ? { status: 'succeeded' as const, amount_received: params.amount, latest_charge: this.tapped(this.nextId('ch')) } : {}),
        })
      }) as unknown as Promise<Stripe.PaymentIntent>,

    retrieve: (id, params) =>
      this.run('paymentIntents.retrieve', { id, ...params }, undefined, () => {
        const intent = this.intent(id)
        if (!params?.expand) return intent
        if (params.expand.join() !== 'latest_charge') throw new Error('The fake has not modelled expanding anything but latest_charge.')
        const card_present = { last4: '4242', brand: 'visa', generated_card: this.generatedCards.get(id) ?? null }
        return { ...intent, latest_charge: intent.latest_charge && { id: intent.latest_charge, created: this.tapTimes.get(intent.latest_charge) ?? intent.created, payment_method_details: { card_present } } }
      }) as unknown as Promise<Stripe.PaymentIntent>,

    cancel: (id) =>
      this.run('paymentIntents.cancel', { id }, undefined, () => {
        const intent = this.intent(id)
        // W12: Stripe can't cancel a processing intent either (the W11 review's observation: the fake allowed it).
        if (intent.status === 'succeeded' || intent.status === 'canceled' || intent.status === 'processing') {
          throw fakeStripeErrors.invalid('payment_intent_unexpected_state', `This PaymentIntent could not be canceled: it is ${intent.status}.`)
        }
        intent.status = 'canceled'
        return intent
      }) as unknown as Promise<Stripe.PaymentIntent>,

    // W12: as Stripe lists them (reconcile): newest first, a page at a time (10 unless `limit` says,
    // `starting_after` the last one seen), only the key's own mode, by customer and by `created`
    // (gte, gt, lte, lt, in seconds) when asked.
    list: (params) =>
      this.run('paymentIntents.list', params, undefined, () => {
        const created = typeof params.created === 'object' ? params.created : params.created === undefined ? {} : { gte: params.created, lte: params.created }
        const all = newestFirst(
          [...this.intents.values()].filter(
            (i) =>
              i.livemode === (this.keyLivemode === true) &&
              (!params.customer || i.customer === params.customer) &&
              (created.gte === undefined || i.created >= created.gte) &&
              (created.gt === undefined || i.created > created.gt) &&
              (created.lte === undefined || i.created <= created.lte) &&
              (created.lt === undefined || i.created < created.lt)
          )
        )
        const from = params.starting_after ? all.findIndex((i) => i.id === params.starting_after) + 1 : 0
        const limit = params.limit ?? 10
        return { ...list(all.slice(from, from + limit)), has_more: from + limit < all.length }
      }) as unknown as Promise<Stripe.ApiList<Stripe.PaymentIntent>>,
  }

  // W11: the reader's card-save with no charge, a generated card's details, and the reader's connection token.

  readonly setupIntents: StripeClient['setupIntents'] = {
    create: (params, options) =>
      this.run('setupIntents.create', params, options, () => {
        const customer = typeof params.customer === 'string' ? params.customer : null
        if (customer !== null) this.customer(customer)
        const id = this.nextId('seti')
        const setupIntent: FakeSetupIntent = {
          id,
          object: 'setup_intent',
          status: 'requires_payment_method',
          customer,
          payment_method: null,
          payment_method_types: params.payment_method_types ?? ['card'],
          usage: params.usage ?? 'off_session',
          client_secret: `${id}_secret`,
          created: seconds(),
          latest_attempt: null,
        }
        this.setupIntentsById.set(id, setupIntent)
        return setupIntent
      }) as unknown as Promise<Stripe.SetupIntent>,

    retrieve: (id, params) =>
      this.run('setupIntents.retrieve', { id, ...params }, undefined, () => {
        const setupIntent = this.setupIntentsById.get(id)
        if (!setupIntent) throw fakeStripeErrors.missing(`setupintent: '${id}'`)
        if (!params?.expand) return setupIntent
        if (params.expand.join() !== 'latest_attempt') throw new Error('The fake has not modelled expanding anything but latest_attempt.')
        const card_present = { generated_card: this.generatedCards.get(id) ?? null }
        return { ...setupIntent, latest_attempt: setupIntent.latest_attempt && { id: setupIntent.latest_attempt, created: this.tapTimes.get(setupIntent.latest_attempt) ?? setupIntent.created, payment_method_details: { card_present } } }
      }) as unknown as Promise<Stripe.SetupIntent>,
  }

  readonly paymentMethods: StripeClient['paymentMethods'] = {
    retrieve: (id) =>
      this.run('paymentMethods.retrieve', { id }, undefined, () => {
        const card = this.cardsById.get(id)
        if (!card) throw fakeStripeErrors.missing(`payment_method: '${id}'`)
        return { id, object: 'payment_method', type: 'card', card: { ...card } }
      }) as unknown as Promise<Stripe.PaymentMethod>,
  }

  readonly terminal: StripeClient['terminal'] = {
    connectionTokens: {
      create: (params, options) =>
        this.run('terminal.connectionTokens.create', params ?? {}, options, () => ({
          object: 'terminal.connection_token',
          secret: `pst_test_${this.nextId('token')}`,
          ...(params?.location ? { location: params.location } : {}),
        })) as unknown as Promise<Stripe.Terminal.ConnectionToken>,
    },
  }

  readonly refunds: StripeClient['refunds'] = {
    create: (params, options) =>
      this.run('refunds.create', params, options, () => {
        const intent = this.intent(String(params.payment_intent))
        const already = this.refunded.get(intent.id) ?? 0
        const left = intent.amount_received - already
        if (left <= 0) {
          throw fakeStripeErrors.invalid('charge_already_refunded', `Charge ${intent.latest_charge ?? ''} has already been refunded.`)
        }
        const amount = params.amount ?? left
        if (amount > left) {
          throw fakeStripeErrors.invalid('parameter_invalid_integer', 'Refund amount is greater than unrefunded amount on charge.')
        }
        if (!this.refundsFailAtOnce) this.refunded.set(intent.id, already + amount)
        const refund: FakeRefund = {
          id: this.nextId('re'),
          object: 'refund',
          amount,
          payment_intent: intent.id,
          status: this.refundsFailAtOnce ? 'failed' : this.refundsStayPending ? 'pending' : 'succeeded',
          metadata: { ...((params.metadata ?? {}) as Record<string, string>) },
          created: seconds(),
        }
        this.refundsMade.push(refund)
        return refund
      }) as unknown as Promise<Stripe.Refund>,

    // Newest first, as Stripe lists them, a page at a time.
    list: (params) =>
      this.run('refunds.list', params, undefined, () => {
        if (!params.payment_intent) throw new Error('The fake has only modelled listing the refunds of one PaymentIntent.')
        this.intent(params.payment_intent)
        const all = newestFirst(this.refundsMade.filter((r) => r.payment_intent === params.payment_intent))
        const from = params.starting_after ? all.findIndex((r) => r.id === params.starting_after) + 1 : 0
        const limit = params.limit ?? 10
        const page = all.slice(from, from + limit)
        return { ...list(page), has_more: from + limit < all.length }
      }) as unknown as Promise<Stripe.ApiList<Stripe.Refund>>,
  }

  private publicSubscription(sub: FakeSubscription, expand: readonly string[] | undefined) {
    const { invoice, ...rest } = sub
    const expanded = expand?.includes('latest_invoice.payments') || expand?.includes('data.latest_invoice.payments')
    // W36: each item with its price as Stripe shows it (what it takes and how often) and its quantity, which the
    // payment date change reads; and whether it ends at the period's end (never set by anything here).
    const items = {
      data: sub.items.data.map((item) => {
        const price = this.pricesById.get(item.price.id)
        const recurring = price?.['recurring'] as { interval: string } | null | undefined
        return {
          // W48: the item's id, which a price switch names (`items: [{ id, price }]`). One item, so one id, from the subscription's.
          id: subscriptionItemId(sub.id),
          ...item,
          quantity: 1,
          price: { id: item.price.id, unit_amount: price ? Number(price['unit_amount']) : null, recurring: recurring ? { interval: recurring.interval, interval_count: 1 } : null },
        }
      }),
    }
    // W46b: the newest invoice by id. Expanded, only the invoice it was made with is modelled (what the order flows read).
    if (expanded && sub.latest_invoice !== invoice.id) throw new Error('The fake has only modelled expanding the invoice a subscription was made with, not a later one.')
    return { ...rest, items, latest_invoice: expanded ? invoice : sub.latest_invoice }
  }

  /** As Stripe: a subscription made in the other mode is answered as missing (W13, as an intent, W11a). */
  private sub(id: string): FakeSubscription {
    const sub = this.subs.get(id)
    if (!sub || sub.livemode !== (this.keyLivemode === true)) throw fakeStripeErrors.missing(`subscription: '${id}'`)
    return sub
  }

  readonly subscriptions: StripeClient['subscriptions'] = {
    create: (params, options) =>
      this.run('subscriptions.create', params, options, () => {
        const customer = String(params.customer)
        this.customer(customer)
        const priceId = params.items?.[0]?.price
        const price = priceId === undefined ? undefined : this.pricesById.get(priceId)
        if (!price) throw fakeStripeErrors.missing(`price: '${String(priceId)}'`)

        // W13: as Stripe, an archived price can't start a subscription.
        if (price['active'] === false) throw fakeStripeErrors.invalid('price_inactive', `The price ${String(priceId)} is not active.`)
        // W57 (brief item 5): nor can an active price whose product is off sale (archived). Stripe's documents say an
        // archived product's existing subscriptions keep running and its payment links stop; they don't say what a new
        // subscription on its price does. The fake refuses it, the cautious reading, so the Worker keeps a plan's row
        // and its Stripe product in step whichever way Stripe answers. The lead checks it in test mode at preview.
        const product = typeof price['product'] === 'string' ? this.productsById.get(price['product']) : undefined
        if (product && product['active'] === false) throw fakeStripeErrors.invalid('product_inactive', `The product ${String(price['product'])} of price ${String(priceId)} is not active.`)
        const discount = params.discounts?.[0]
        const coupon = typeof discount === 'object' ? discount.coupon : undefined
        const amountOff = coupon ? (this.couponsById.get(coupon)?.amount_off ?? null) : 0
        if (amountOff === null) throw fakeStripeErrors.missing(`coupon: '${String(coupon)}'`)
        const total = Math.max(0, Number(price['unit_amount']) - amountOff)
        // W13a (S1): the customer's balance is applied (a debit added, a credit taken off), and an amount due under
        // Stripe's minimum charge is marked paid with nothing taken and carried to the customer's balance.
        const currency = String(price['currency'])
        const record = this.customer(customer)
        const startingBalance = Number(record['balance'] ?? 0)
        const owed = total + startingBalance
        const due = Math.max(0, owed)
        const tooSmall = due > 0 && due < (MINIMUM_CHARGE[currency] ?? 0)
        const taken = tooSmall ? 0 : due
        const endingBalance = tooSmall ? due : Math.min(0, owed)
        record['balance'] = endingBalance
        // The first invoice's PaymentIntent carries none of the subscription's metadata, as Stripe's doesn't.
        const paid = taken > 0 ? this.addIntent({ amount: taken, currency, customer, status: 'succeeded', amount_received: taken }) : null

        const start = seconds()
        const interval = (price['recurring'] as { interval: string } | null)?.interval ?? 'month'
        const invoice: FakeInvoice = {
          id: this.nextId('in'),
          object: 'invoice',
          total,
          starting_balance: startingBalance,
          amount_due: due,
          ending_balance: endingBalance,
          amount_paid: taken,
          // As before W13a (the golden files hold it): one entry, with no PaymentIntent when nothing was taken.
          payments: { data: [{ payment: { payment_intent: paid?.id ?? null } }] },
        }
        const sub: FakeSubscription = {
          id: this.nextId('sub'),
          object: 'subscription',
          status: 'active',
          customer,
          metadata: (params.metadata ?? {}) as Record<string, string>,
          items: { data: [{ price: { id: String(priceId) }, current_period_start: start, current_period_end: addPeriod(start, interval) }] },
          latest_invoice: invoice.id,
          invoice,
          livemode: this.keyLivemode === true,
          created: start,
          cancel_at: null,
          cancel_at_period_end: false,
          trial_end: null,
          billing_cycle_anchor: start,
          default_payment_method: typeof params.default_payment_method === 'string' ? params.default_payment_method : null,
          ended_at: null,
          canceled_at: null,
        }
        this.subs.set(sub.id, sub)
        return this.publicSubscription(sub, params.expand)
      }) as unknown as Promise<Stripe.Subscription>,

    // W13: read back, with its first invoice when asked (`latest_invoice.payments`).
    retrieve: (id, params) =>
      this.run('subscriptions.retrieve', { id, ...params }, undefined, () => this.publicSubscription(this.sub(id), params?.expand)) as unknown as Promise<Stripe.Subscription>,

    // W36: the three changes the membership actions make, and nothing else. `cancel_at` sets when it ends ('' clears
    // it); `trial_end` with `proration_behavior: 'none'` starts a no-charge period to that moment, which moves the
    // billing anchor and the current period's end there and reads `trialing` until then (Stripe's "change the billing
    // period using a trial period"); `default_payment_method` is the card its invoices charge. A cancelled
    // subscription can't be changed: Stripe's words are "A canceled subscription can only update its
    // cancellation_details and metadata." W40's and W41's test-mode runs check these against real Stripe.
    update: (id, params, options) =>
      this.run('subscriptions.update', { id, ...params }, options, () => {
        const sub = this.sub(id)
        // W48: and `items: [{ id, price }]` with `proration_behavior: 'none'`, which is what the legacy update-price
        // route sends to move a member to a plan's new price from their next renewal (G-plan GB1).
        const known = new Set(['cancel_at', 'cancel_at_period_end', 'trial_end', 'proration_behavior', 'default_payment_method', 'items'])
        const unknown = Object.keys(params ?? {}).filter((name) => !known.has(name))
        if (unknown.length > 0) throw new Error(`The fake has not modelled updating a subscription's ${unknown.join(', ')}.`)
        if (sub.status === 'canceled') {
          throw fakeStripeErrors.invalid('subscription_canceled', 'A canceled subscription can only update its cancellation_details and metadata.')
        }
        if (params?.cancel_at !== undefined) {
          if (params.cancel_at !== '' && typeof params.cancel_at !== 'number') throw new Error('The fake has only modelled cancel_at as a timestamp or an empty string.')
          sub.cancel_at = typeof params.cancel_at === 'number' ? params.cancel_at : null
          sub.cancel_at_period_end = false
        }
        // W59 (W45a "Noticed" 7): kept as set, as Stripe keeps it; true ends it at the period's end.
        if (params?.cancel_at_period_end !== undefined) {
          if (typeof params.cancel_at_period_end !== 'boolean') throw new Error('The fake has only modelled cancel_at_period_end as true or false.')
          sub.cancel_at_period_end = params.cancel_at_period_end
          sub.cancel_at = params.cancel_at_period_end ? (sub.items.data[0]?.current_period_end ?? null) : null
        }
        if (params?.trial_end !== undefined) {
          if (typeof params.trial_end !== 'number') throw new Error('The fake has only modelled trial_end as a timestamp.')
          if (params.proration_behavior !== 'none') throw new Error('The fake has only modelled trial_end with proration_behavior none.')
          if (params.trial_end <= seconds()) throw fakeStripeErrors.invalid('invalid_trial_end', 'Invalid timestamp: must be an integer Unix timestamp in the future.')
          sub.trial_end = params.trial_end
          sub.billing_cycle_anchor = params.trial_end
          sub.status = 'trialing'
          for (const item of sub.items.data) {
            item.current_period_start = seconds()
            item.current_period_end = params.trial_end
          }
        }
        if (params?.items !== undefined) {
          const [item, ...more] = params.items
          if (!item || more.length > 0) throw new Error('The fake has only modelled switching the price of a subscription with one item.')
          if (params.proration_behavior !== 'none') throw new Error('The fake has only modelled a price switch with proration_behavior none.')
          if (item.id !== subscriptionItemId(sub.id)) throw fakeStripeErrors.missing(`subscription_item: '${String(item.id)}'`)
          if (typeof item.price !== 'string' || !this.pricesById.has(item.price)) throw fakeStripeErrors.missing(`price: '${String(item.price)}'`)
          // W49 + W54 (W48 review S2): as Stripe, and as subscriptions.create above, an archived price can't be
          // switched to. Without this a move onto a plan's old, archived price would pass every test here.
          if (this.pricesById.get(item.price)?.['active'] === false) throw fakeStripeErrors.invalid('price_inactive', `The price ${item.price} is not active.`)
          // W57a (W57 review S1): Stripe takes a switch to a price with another interval, but restarts the billing period
          // and charges the new price at once, which a move "from the next renewal" must never do. The fake has not
          // modelled that charge: it fails loudly, so a send without the Worker's interval guard can't pass a test.
          const intervalOf = (priceId: string): string => (this.pricesById.get(priceId)?.['recurring'] as { interval: string } | null | undefined)?.interval ?? 'month'
          const from = sub.items.data[0]?.price.id
          if (from !== undefined && intervalOf(from) !== intervalOf(item.price)) {
            throw new Error(`The fake has not modelled a price switch across intervals (${intervalOf(from)} to ${intervalOf(item.price)}): Stripe would restart the period and charge at once.`)
          }
          for (const one of sub.items.data) one.price = { id: item.price }
        }
        if (params?.default_payment_method !== undefined) {
          if (typeof params.default_payment_method !== 'string') throw new Error('The fake has only modelled default_payment_method as a card id.')
          sub.default_payment_method = params.default_payment_method === '' ? null : params.default_payment_method
        }
        return this.publicSubscription(sub, undefined)
      }) as unknown as Promise<Stripe.Subscription>,

    // A DELETE: Stripe ignores a key on it (runIgnoringKey). What Stripe answers to cancelling a subscription
    // already cancelled is not documented where we looked; the fake refuses it as an invalid request, and the
    // code never relies on that answer (it reads the subscription back after any failed cancel). W15's
    // test-mode runs check it.
    cancel: (id, params, options) =>
      this.runIgnoringKey('subscriptions.cancel', { id, ...params }, options, () => {
        const sub = this.sub(id)
        if (sub.status === 'canceled') throw fakeStripeErrors.invalid('subscription_canceled', `The subscription ${id} has already been canceled.`)
        sub.status = 'canceled'
        // W47r-b: cancelled now, so it ended now.
        sub.ended_at = seconds()
        sub.canceled_at = sub.ended_at
        return this.publicSubscription(sub, undefined)
      }) as unknown as Promise<Stripe.Subscription>,

    // W13: as Stripe lists them: newest first, a page at a time (10 unless `limit` says, `starting_after`
    // the last one seen), only the key's own mode, by customer when asked, and without the cancelled ones
    // unless `status: 'all'` (Stripe's default leaves cancelled subscriptions out).
    list: (params) =>
      this.run('subscriptions.list', params, undefined, () => {
        const all = newestFirst(
          [...this.subs.values()].filter(
            (s) =>
              s.livemode === (this.keyLivemode === true) &&
              (!params.customer || s.customer === params.customer) &&
              (params.status === 'all' ? true : params.status ? s.status === params.status : s.status !== 'canceled')
          )
        )
        const from = params.starting_after ? all.findIndex((s) => s.id === params.starting_after) + 1 : 0
        const limit = params.limit ?? 10
        return { ...list(all.slice(from, from + limit).map((s) => this.publicSubscription(s, params.expand))), has_more: from + limit < all.length }
      }) as unknown as Promise<Stripe.ApiList<Stripe.Subscription>>,
  }

  /** A renewal invoice as Stripe answers it: with its payments only when asked to include them. */
  private publicInvoice(invoice: FakeRenewalInvoice, expand: readonly string[] | undefined) {
    if (expand && expand.join() !== 'payments') throw new Error('The fake has not modelled expanding anything of an invoice but payments.')
    const { paymentIntent, subscription, ...rest } = invoice
    const payments = paymentIntent
      ? [{ id: `inpay_${invoice.id}`, object: 'invoice_payment', is_default: true, status: invoice.status === 'paid' ? 'paid' : 'open', payment: { type: 'payment_intent', payment_intent: paymentIntent } }]
      : []
    return { ...rest, billing_reason: 'subscription_cycle', parent: { subscription_details: { subscription } }, ...(expand ? { payments: list(payments) } : {}) }
  }

  /** As Stripe: an invoice made in the other mode is answered as missing (as an intent, W11a). Only renewal invoices are modelled. */
  private invoiceFor(id: string): FakeRenewalInvoice {
    const invoice = this.renewalInvoices.get(id)
    if (!invoice) {
      if ([...this.subs.values()].some((sub) => sub.invoice.id === id)) throw new Error('The fake has only modelled reading or paying an invoice made by a renewal, not the one a subscription was made with.')
      throw fakeStripeErrors.missing(`invoice: '${id}'`)
    }
    if (invoice.livemode !== (this.keyLivemode === true)) throw fakeStripeErrors.missing(`invoice: '${id}'`)
    return invoice
  }

  // W47r: "Try the payment again now" (server/rules/memberships/retry-payment.ts).
  readonly invoices: StripeClient['invoices'] = {
    retrieve: (id, params) =>
      this.run('invoices.retrieve', { id, ...params }, undefined, () => this.publicInvoice(this.invoiceFor(id), params?.expand)) as unknown as Promise<Stripe.Invoice>,

    // An attempt to pay an open invoice now, off session, on the card named (`payment_method`), else the
    // subscription's default card. The invoice's one payment is tried again on that card. A POST, so its answer, a
    // decline included, is saved against the key.
    // - Paid: the invoice is `paid`, and a subscription behind on it reads `active`. A subscription that has ended
    //   stays ended and the money is taken all the same (Stripe leaves a cancelled subscription's invoices open and
    //   payable: the retry's own checks are what stop that).
    // - Declined: a card error, the invoice still open, the payment back at `requires_payment_method`.
    // - An invoice already paid: refused. NOT CHECKED against Stripe: the words ("Invoice is already paid") are as
    //   remembered and the code is a guess. The rule doesn't go by either: after any refusal it reads the invoice.
    // - A payment still at the bank from an earlier attempt: refused. NOT CHECKED against Stripe either, and again
    //   the rule reads the invoice and its payment rather than the refusal.
    // - `nextPayEnds`: left `processing` (answered 200 with the invoice still open), or waiting on the customer
    //   (`requires_action`, with Stripe's documented error code `invoice_payment_intent_requires_action`).
    pay: (id, params, options) =>
      this.run('invoices.pay', { id, ...params }, options, () => {
        const known = new Set(['payment_method', 'off_session'])
        const unknown = Object.keys(params ?? {}).filter((name) => !known.has(name))
        if (unknown.length > 0) throw new Error(`The fake has not modelled paying an invoice with ${unknown.join(', ')}.`)
        if (params?.off_session === false) throw new Error('The fake has only modelled paying an invoice off session.')
        const invoice = this.invoiceFor(id)
        if (invoice.status === 'paid') throw fakeStripeErrors.invalid('invoice_already_paid', 'Invoice is already paid')
        if (invoice.status !== 'open') throw new Error(`The fake has not modelled paying an invoice that is ${invoice.status}.`)
        const intent = invoice.paymentIntent ? this.intents.get(invoice.paymentIntent) : undefined
        if (!intent) throw new Error(`The fake's open invoice ${id} has no payment.`)
        if (intent.status === 'processing') throw fakeStripeErrors.invalid('payment_intent_unexpected_state', "This invoice's payment is still processing.")
        const card = params?.payment_method ?? this.subs.get(invoice.subscription)?.default_payment_method ?? null
        if (card === null) throw new Error('The fake has only modelled paying an invoice with a card: one named, or the subscription\'s default.')
        invoice.attempt_count += 1
        intent.payment_method = card
        if (this.decliningCards.has(card)) {
          intent.status = 'requires_payment_method'
          throw fakeStripeErrors.cardDeclined()
        }
        const ending = this.payEndings.get(id)
        this.payEndings.delete(id)
        if (ending === 'requires_action') {
          intent.status = 'requires_action'
          throw new Stripe.errors.StripeCardError({
            type: 'card_error',
            code: 'invoice_payment_intent_requires_action',
            message: 'This payment requires additional user action before it can be completed successfully. Payment can be completed using the PaymentIntent associated with the invoice.',
          })
        }
        if (ending === 'processing') intent.status = 'processing'
        else this.takeInvoicePayment(invoice, card)
        return this.publicInvoice(invoice, undefined)
      }) as unknown as Promise<Stripe.Invoice>,
  }

  readonly coupons: StripeClient['coupons'] = {
    create: (params, options) =>
      this.run('coupons.create', params, options, () => {
        const id = params.id ?? this.nextId('coupon')
        if (this.couponsById.has(id)) throw fakeStripeErrors.invalid('resource_already_exists', 'Coupon already exists.')
        const coupon = { object: 'coupon', ...params, id } as unknown as Stripe.Coupon
        this.couponsById.set(id, coupon)
        return coupon
      }),

    del: (id, _params, options) =>
      this.run('coupons.del', { id }, options?.idempotencyKey ? options : undefined, () => {
        if (!this.couponsById.delete(id)) throw fakeStripeErrors.missing(`coupon: '${id}'`)
        return { id, object: 'coupon', deleted: true } as Stripe.DeletedCoupon
      }),
  }

  private customer(id: string): Record<string, unknown> {
    const customer = this.customersById.get(id)
    if (!customer) throw fakeStripeErrors.missing(`customer: '${id}'`)
    return customer
  }

  readonly customers: StripeClient['customers'] = {
    create: (params, options) =>
      this.run('customers.create', params, options, () => {
        const id = this.nextId('cus')
        this.addCustomer(id, params as Record<string, unknown>)
        return this.customer(id)
      }) as unknown as Promise<Stripe.Customer>,

    update: (id, params, options) =>
      this.run('customers.update', { id, ...params }, options, () => Object.assign(this.customer(id), params)) as unknown as Promise<Stripe.Customer>,

    search: (params) =>
      this.run('customers.search', params, undefined, () => {
        const match = /metadata\['supabase_customer_id'\]:'([^']+)'/.exec(params.query)
        if (!match) throw new Error(`The fake has not modelled this customer search: ${params.query}`)
        const found = [...this.customersById.values()].filter(
          (c) => (c['metadata'] as Record<string, string> | undefined)?.['supabase_customer_id'] === match[1]
        )
        return { object: 'search_result', data: found, has_more: false, url: '/fake', next_page: null }
      }) as unknown as Promise<Stripe.ApiSearchResult<Stripe.Customer>>,

    // W32: a customer balance transaction adds its amount to the customer's balance (below 0: credit), as Stripe's.
    createBalanceTransaction: (id, params, options) =>
      this.run('customers.createBalanceTransaction', { id, ...params }, options, () => {
        const record = this.customer(id)
        const ending = Number(record['balance'] ?? 0) + params.amount
        record['balance'] = ending
        const transaction: FakeBalanceTransaction = {
          id: this.nextId('cbtxn'),
          object: 'customer_balance_transaction',
          customer: id,
          amount: params.amount,
          currency: params.currency,
          ending_balance: ending,
          metadata: { ...((params.metadata ?? {}) as Record<string, string>) },
          created: seconds(),
        }
        this.balanceTransactionsMade.push(transaction)
        return transaction
      }) as unknown as Promise<Stripe.CustomerBalanceTransaction>,

    // Newest first, as Stripe lists them, a page at a time.
    listBalanceTransactions: (id, params) =>
      this.run('customers.listBalanceTransactions', { id, ...params }, undefined, () => {
        this.customer(id)
        const all = newestFirst(this.balanceTransactionsMade.filter((t) => t.customer === id))
        const from = params?.starting_after ? all.findIndex((t) => t.id === params.starting_after) + 1 : 0
        const limit = params?.limit ?? 10
        return { ...list(all.slice(from, from + limit)), has_more: from + limit < all.length }
      }) as unknown as Promise<Stripe.ApiList<Stripe.CustomerBalanceTransaction>>,
  }

  // W48 (brief item 4): `create` and `update` are what the seven legacy /api/catalog routes sent (since W61 only their
  // frozen copy sends them), so step G's golden
  // files can be recorded through them with this fake. W57: they are on the Worker's StripeClient for membership plans
  // only (G-plan L2), with keys, and `list` finds a price by its product (and `metadata`, which the caller reads). A
  // new price is live, takes its amount, currency, product, metadata and (for a plan) how often; an update sets
  // `active` (archiving) only. A list is newest first, a page at a time (10 unless `limit` says, at most 100;
  // `starting_after` the last one seen), every price of the product unless `active` says which.
  readonly prices: StripeClient['prices'] = {
    retrieve: (id, _params, options) =>
      this.run('prices.retrieve', { id }, options?.idempotencyKey ? options : undefined, () => {
        const price = this.pricesById.get(id)
        if (!price) throw fakeStripeErrors.missing(`price: '${id}'`)
        return price
      }) as unknown as Promise<Stripe.Price>,

    create: (params, options) =>
      this.run('prices.create', params, options, () => {
        if (typeof params.product !== 'string' || !this.productsById.has(params.product)) throw fakeStripeErrors.missing(`product: '${String(params.product)}'`)
        if (!Number.isInteger(params.unit_amount) || Number(params.unit_amount) < 0) throw fakeStripeErrors.invalid('parameter_invalid_integer', 'Invalid integer: unit_amount must be a non-negative whole number of pence.')
        const id = this.nextId('price')
        const price = {
          id,
          object: 'price',
          active: true,
          product: params.product,
          unit_amount: params.unit_amount,
          currency: params.currency,
          recurring: params.recurring ? { interval: params.recurring.interval } : null,
          metadata: { ...(params.metadata ?? {}) },
        }
        this.pricesById.set(id, price)
        return clone(price)
      }) as unknown as Promise<Stripe.Price>,

    update: (id, params, options) =>
      this.run('prices.update', { id, ...params }, options, () => {
        const price = this.pricesById.get(id)
        if (!price) throw fakeStripeErrors.missing(`price: '${id}'`)
        const unknown = Object.keys(params ?? {}).filter((name) => name !== 'active')
        if (unknown.length > 0) throw new Error(`The fake has not modelled updating a price's ${unknown.join(', ')}.`)
        if (params.active !== undefined) price['active'] = params.active
        return clone(price)
      }) as unknown as Promise<Stripe.Price>,

    list: (params) =>
      this.run('prices.list', params, undefined, () => {
        const all = newestFirst([...this.pricesById.values()]).filter(
          (price) => (params.product === undefined || price['product'] === params.product) && (params.active === undefined || price['active'] === params.active)
        )
        return pageOf(all, params.limit, params.starting_after)
      }) as unknown as Promise<Stripe.ApiList<Stripe.Price>>,
  }

  // W48: as `prices.create` above, for the legacy routes only. A new product takes what sync-stripe sends (name,
  // description, images, active, metadata); an update sets `active` only, which is all toggle-active sends. W57: on
  // the Worker's StripeClient for membership plans, with `retrieve` and a `list` (newest first, a page at a time, as
  // `prices.list`).
  readonly products: StripeClient['products'] = {
    create: (params, options) =>
      this.run('products.create', params, options, () => {
        const id = this.nextId('prod')
        const product = { id, object: 'product', name: params.name, description: params.description ?? null, images: params.images ?? [], active: params.active ?? true, metadata: { ...(params.metadata ?? {}) } }
        this.productsById.set(id, product)
        return clone(product)
      }) as unknown as Promise<Stripe.Product>,

    update: (id, params, options) =>
      this.run('products.update', { id, ...params }, options, () => {
        const product = this.productsById.get(id)
        if (!product) throw fakeStripeErrors.missing(`product: '${id}'`)
        const unknown = Object.keys(params ?? {}).filter((name) => name !== 'active')
        if (unknown.length > 0) throw new Error(`The fake has not modelled updating a product's ${unknown.join(', ')}.`)
        if (params.active !== undefined) product['active'] = params.active
        return clone(product)
      }) as unknown as Promise<Stripe.Product>,

    retrieve: (id) =>
      this.run('products.retrieve', { id }, undefined, () => {
        const product = this.productsById.get(id)
        if (!product) throw fakeStripeErrors.missing(`product: '${id}'`)
        return clone(product)
      }) as unknown as Promise<Stripe.Product>,

    list: (params) =>
      this.run('products.list', params, undefined, () => {
        const all = newestFirst([...this.productsById.values()]).filter((product) => params.active === undefined || product['active'] === params.active)
        return pageOf(all, params.limit, params.starting_after)
      }) as unknown as Promise<Stripe.ApiList<Stripe.Product>>,
  }
}

/** W57: one page of a list, as Stripe gives it: `limit` (10 unless said, at most 100) after `startingAfter`, and whether more follow. */
function pageOf<T extends Record<string, unknown>>(all: T[], limit: number | undefined, startingAfter: string | undefined) {
  const from = startingAfter === undefined ? 0 : all.findIndex((row) => row['id'] === startingAfter) + 1
  const size = Math.min(Math.max(limit ?? 10, 1), 100)
  const page = all.slice(from, from + size)
  return { object: 'list' as const, data: page.map((row) => clone(row)), has_more: from + size < all.length, url: '/fake' }
}
