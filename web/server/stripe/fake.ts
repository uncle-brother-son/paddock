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
  private readonly generatedCards = new Map<string, string>()
  private readonly setupIntentsById = new Map<string, FakeSetupIntent>()
  /** The reusable cards Stripe generated for a tap, as payment methods: what paymentMethods.retrieve finds. */
  private readonly cardsById = new Map<string, { last4: string; brand: string }>()
  private readonly subs = new Map<string, FakeSubscription>()
  private readonly couponsById = new Map<string, Stripe.Coupon>()
  private readonly customersById = new Map<string, Record<string, unknown>>()
  private readonly pricesById = new Map<string, Record<string, unknown>>()
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

  /**
   * W12: refunds made from now on are answered `pending`, as Stripe answers some (a card that takes
   * longer, or one Stripe is still checking); settleRefund later says how each ended.
   */
  refundsStayPending = false

  /** W12: a pending refund ends: `succeeded`, or `failed` / `canceled` (its money is back on the payment). */
  settleRefund(id: string, status: 'succeeded' | 'failed' | 'canceled'): void {
    const refund = this.refundsMade.find((r) => r.id === id)
    if (!refund) throw new Error(`The fake has no refund ${id}.`)
    if (refund.status !== 'pending') throw new Error(`The fake's refund ${id} is ${refund.status}, not pending.`)
    refund.status = status
    if (status !== 'succeeded') this.refunded.set(refund.payment_intent, (this.refunded.get(refund.payment_intent) ?? 0) - refund.amount)
  }

  /** W12: an intent Stripe is still processing (a card that takes longer): it can't be cancelled, and may yet succeed. */
  markProcessing(id: string): void {
    const intent = this.intents.get(id)
    if (!intent) throw new Error(`The fake has no PaymentIntent ${id}.`)
    intent.status = 'processing'
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
    intent.latest_charge = this.nextId('ch')
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
    setupIntent.latest_attempt = this.nextId('setatt')
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
        return { ...setupIntent, latest_attempt: setupIntent.latest_attempt && { id: setupIntent.latest_attempt, payment_method_details: { card_present } } }
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
        this.refunded.set(intent.id, already + amount)
        const refund: FakeRefund = {
          id: this.nextId('re'),
          object: 'refund',
          amount,
          payment_intent: intent.id,
          status: this.refundsStayPending ? 'pending' : 'succeeded',
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
