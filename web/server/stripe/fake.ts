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
}

interface FakeRefund {
  id: string
  object: 'refund'
  amount: number
  payment_intent: string
  status: 'succeeded'
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
  latest_invoice: string | FakeInvoice
  invoice: FakeInvoice
}

interface FakeInvoice {
  id: string
  object: 'invoice'
  amount_paid: number
  payments: { data: Array<{ payment: { payment_intent: string | null } }> }
}

const clone = <T>(value: T): T => (value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T))
const seconds = () => Math.floor(Date.now() / 1000)
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

  private readonly saved = new Map<string, SavedAnswer>()
  private readonly faults = new Map<string, FakeFault[]>()
  private readonly intents = new Map<string, FakePaymentIntent>()
  private readonly refunded = new Map<string, number>()
  private readonly refundsMade: FakeRefund[] = []
  private readonly generatedCards = new Map<string, string>()
  private readonly subs = new Map<string, FakeSubscription>()
  private readonly couponsById = new Map<string, Stripe.Coupon>()
  private readonly customersById = new Map<string, Record<string, unknown>>()
  private readonly pricesById = new Map<string, Record<string, unknown>>()
  private sequence = 0

  private nextId(prefix: string): string {
    this.sequence += 1
    return `${prefix}_fake_${String(this.sequence).padStart(4, '0')}`
  }

  // Set-up, for tests.

  addCustomer(id: string, fields: Record<string, unknown> = {}): void {
    this.customersById.set(id, { id, object: 'customer', metadata: {}, ...fields })
  }

  addPrice(id: string, unitAmount: number, interval: 'month' | 'year' | null, currency = 'gbp'): void {
    this.pricesById.set(id, {
      id,
      object: 'price',
      unit_amount: unitAmount,
      currency,
      recurring: interval ? { interval } : null,
    })
  }

  /** An active subscription that already exists, as a membership bought earlier would have. */
  addSubscription(id: string, customer: string, priceId: string): void {
    const start = seconds()
    const interval = (this.pricesById.get(priceId)?.['recurring'] as { interval: string } | null | undefined)?.interval ?? 'month'
    const invoice: FakeInvoice = { id: this.nextId('in'), object: 'invoice', amount_paid: 0, payments: { data: [] } }
    this.subs.set(id, {
      id,
      object: 'subscription',
      status: 'active',
      customer,
      metadata: {},
      items: { data: [{ price: { id: priceId }, current_period_start: start, current_period_end: addPeriod(start, interval) }] },
      latest_invoice: invoice.id,
      invoice,
    })
  }

  /** Stripe keeps a key for at least 24 hours, then may drop it: a repeat after that is a new
   *  request. This drops them all, as if that time had passed. */
  forgetIdempotencyKeys(): void {
    this.saved.clear()
  }

  /** The next call to this method (e.g. 'paymentIntents.create') meets this fault. */
  failNext(method: string, fault: FakeFault): void {
    this.faults.set(method, [...(this.faults.get(method) ?? []), fault])
  }

  /**
   * The customer taps the reader: the PaymentIntent succeeds, as the Terminal flow would. A tap that
   * saves the card names the reusable card Stripe generates for it.
   */
  completeReaderPayment(id: string, options: { generatedCard?: string } = {}): void {
    const intent = this.intents.get(id)
    if (!intent) throw new Error(`The fake has no PaymentIntent ${id}.`)
    intent.status = 'succeeded'
    intent.amount_received = intent.amount
    intent.latest_charge = this.nextId('ch')
    if (options.generatedCard) {
      intent.payment_method = `${id}_card_present`
      this.generatedCards.set(id, options.generatedCard)
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
      remember({ error: fault.error })
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
    if (!intent) throw fakeStripeErrors.missing(`payment_intent: '${id}'`)
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
          ...(confirmed ? { status: 'succeeded' as const, amount_received: params.amount, latest_charge: this.nextId('ch') } : {}),
        })
      }) as unknown as Promise<Stripe.PaymentIntent>,

    retrieve: (id, params) =>
      this.run('paymentIntents.retrieve', { id, ...params }, undefined, () => {
        const intent = this.intent(id)
        if (!params?.expand) return intent
        if (params.expand.join() !== 'latest_charge') throw new Error('The fake has not modelled expanding anything but latest_charge.')
        const card_present = { last4: '4242', brand: 'visa', generated_card: this.generatedCards.get(id) ?? null }
        return { ...intent, latest_charge: intent.latest_charge && { id: intent.latest_charge, payment_method_details: { card_present } } }
      }) as unknown as Promise<Stripe.PaymentIntent>,

    cancel: (id) =>
      this.run('paymentIntents.cancel', { id }, undefined, () => {
        const intent = this.intent(id)
        if (intent.status === 'succeeded' || intent.status === 'canceled') {
          throw fakeStripeErrors.invalid('payment_intent_unexpected_state', `This PaymentIntent could not be canceled: it is ${intent.status}.`)
        }
        intent.status = 'canceled'
        return intent
      }) as unknown as Promise<Stripe.PaymentIntent>,

    list: (params) =>
      this.run('paymentIntents.list', params, undefined, () =>
        list(newestFirst([...this.intents.values()].filter((i) => !params.customer || i.customer === params.customer)))
      ) as unknown as Promise<Stripe.ApiList<Stripe.PaymentIntent>>,
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
        this.refunded.set(intent.id, already + amount)
        const refund: FakeRefund = {
          id: this.nextId('re'),
          object: 'refund',
          amount,
          payment_intent: intent.id,
          status: 'succeeded',
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
    return { ...rest, latest_invoice: expand?.includes('latest_invoice.payments') ? invoice : invoice.id }
  }

  readonly subscriptions: StripeClient['subscriptions'] = {
    create: (params, options) =>
      this.run('subscriptions.create', params, options, () => {
        const customer = String(params.customer)
        this.customer(customer)
        const priceId = params.items?.[0]?.price
        const price = priceId === undefined ? undefined : this.pricesById.get(priceId)
        if (!price) throw fakeStripeErrors.missing(`price: '${String(priceId)}'`)

        const discount = params.discounts?.[0]
        const coupon = typeof discount === 'object' ? discount.coupon : undefined
        const amountOff = coupon ? (this.couponsById.get(coupon)?.amount_off ?? null) : 0
        if (amountOff === null) throw fakeStripeErrors.missing(`coupon: '${String(coupon)}'`)
        const due = Math.max(0, Number(price['unit_amount']) - amountOff)
        const paid =
          due > 0
            ? this.addIntent({ amount: due, currency: String(price['currency']), customer, status: 'succeeded', amount_received: due })
            : null

        const start = seconds()
        const interval = (price['recurring'] as { interval: string } | null)?.interval ?? 'month'
        const invoice: FakeInvoice = {
          id: this.nextId('in'),
          object: 'invoice',
          amount_paid: due,
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
        }
        this.subs.set(sub.id, sub)
        return this.publicSubscription(sub, params.expand)
      }) as unknown as Promise<Stripe.Subscription>,

    cancel: (id) =>
      this.run('subscriptions.cancel', { id }, undefined, () => {
        const sub = this.subs.get(id)
        if (!sub) throw fakeStripeErrors.missing(`subscription: '${id}'`)
        if (sub.status === 'canceled') throw new Error('The fake has not modelled cancelling a cancelled subscription.')
        sub.status = 'canceled'
        return this.publicSubscription(sub, undefined)
      }) as unknown as Promise<Stripe.Subscription>,

    list: (params) =>
      this.run('subscriptions.list', params, undefined, () =>
        list(
          newestFirst(
            [...this.subs.values()]
              .filter((s) => !params.customer || s.customer === params.customer)
              .map((s) => this.publicSubscription(s, undefined))
          )
        )
      ) as unknown as Promise<Stripe.ApiList<Stripe.Subscription>>,
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

    del: (id) =>
      this.run('coupons.del', { id }, undefined, () => {
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

    update: (id, params) =>
      this.run('customers.update', { id, ...params }, undefined, () => Object.assign(this.customer(id), params)) as unknown as Promise<Stripe.Customer>,

    search: (params) =>
      this.run('customers.search', params, undefined, () => {
        const match = /metadata\['supabase_customer_id'\]:'([^']+)'/.exec(params.query)
        if (!match) throw new Error(`The fake has not modelled this customer search: ${params.query}`)
        const found = [...this.customersById.values()].filter(
          (c) => (c['metadata'] as Record<string, string> | undefined)?.['supabase_customer_id'] === match[1]
        )
        return { object: 'search_result', data: found, has_more: false, url: '/fake', next_page: null }
      }) as unknown as Promise<Stripe.ApiSearchResult<Stripe.Customer>>,
  }

  readonly prices: StripeClient['prices'] = {
    retrieve: (id) =>
      this.run('prices.retrieve', { id }, undefined, () => {
        const price = this.pricesById.get(id)
        if (!price) throw fakeStripeErrors.missing(`price: '${id}'`)
        return price
      }) as unknown as Promise<Stripe.Price>,
  }
}
