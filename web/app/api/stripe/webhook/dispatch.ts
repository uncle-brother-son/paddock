import Stripe from 'stripe'
import { readStripeFailure } from '@/server/stripe/outcome'

export interface DispatchResult {
  outcome: 'processed' | 'ignored'
  /** What the database function answered, or why the event was ignored. */
  detail: Record<string, unknown> | null
}

/** What Supabase's client answers for a database function: it never throws; a failure comes back as `error`. */
export interface RpcAnswer {
  data: unknown
  error: unknown
}

// The only part of the Supabase client dispatchStripeEvent needs — kept minimal so tests can
// pass a plain mock instead of a real SupabaseClient. W46: typed (Supabase's builder is thenable, not a Promise).
export interface RpcClient {
  rpc(fn: string, params?: Record<string, unknown>): PromiseLike<RpcAnswer>
}

// invoice.parent.subscription_details.subscription is where the subscription id lives on
// recent API versions (2026-07-29.dahlia and later) — confirmed against the installed Stripe
// SDK's own type declarations. The older top-level invoice.subscription field is no longer part
// of the typed Invoice object at all, but is read here defensively as a runtime fallback in case
// an older-shaped payload still carries it.
export function getInvoiceSubscriptionId(invoice: Stripe.Invoice): string | undefined {
  const fromParent = invoice.parent?.subscription_details?.subscription
  if (fromParent) {
    return typeof fromParent === 'string' ? fromParent : fromParent.id
  }
  const legacy = (invoice as unknown as { subscription?: string | Stripe.Subscription }).subscription
  if (legacy) {
    return typeof legacy === 'string' ? legacy : legacy.id
  }
  return undefined
}

// subscription.items.data[0].current_period_end is where the period end lives on recent API
// versions — confirmed against the installed SDK's types (current_period_end only exists on
// SubscriptionItem, not on Subscription itself, in this version). Same defensive runtime
// fallback as above for an older-shaped payload.
export function getSubscriptionPeriodEnd(subscription: Stripe.Subscription): number | undefined {
  const fromItem = subscription.items?.data?.[0]?.current_period_end
  if (typeof fromItem === 'number') return fromItem
  const legacy = (subscription as unknown as { current_period_end?: number }).current_period_end
  return typeof legacy === 'number' ? legacy : undefined
}

// W46b (W46 review B1): the subscription's newest invoice, as an id. `retrieve` answers it as an id unless it is asked
// to expand it; read either way.
export function getSubscriptionLatestInvoiceId(subscription: Stripe.Subscription): string | undefined {
  const latest = subscription.latest_invoice
  if (!latest) return undefined
  return typeof latest === 'string' ? latest : latest.id
}

/**
 * W46b (W46 review B1): whether `invoiceId` is the newest invoice Stripe has for the subscription. At a renewal Stripe
 * moves the period on at once and holds the new invoice as a draft for about an hour, and the subscription still
 * reads `active` in that hour. An older invoice's `invoice.paid` handled then (one Stripe is sending again) must not
 * be recorded: the period Stripe shows is the one the draft has not been paid for yet.
 */
const isLatestInvoice = (subscription: Stripe.Subscription, invoiceId: string | undefined): boolean => Boolean(invoiceId) && getSubscriptionLatestInvoiceId(subscription) === invoiceId

function unixSecondsToIso(seconds: number): string {
  return new Date(seconds * 1000).toISOString()
}

// W45a (W45 audit S1): the one Stripe read the handlers make. An event carries the subscription as it was when the
// event was made, and events are not handled in the order things happened: a delivery that failed is sent again up to
// days later, and two deliveries can be handled at once. So what is written to a membership comes from the
// subscription as Stripe holds it now, never from the event. Kept to the one call, so tests pass the fake Stripe
// (server/stripe/fake.ts) and the route passes the real client.
export interface SubscriptionReader {
  subscriptions: { retrieve(id: string): Promise<Stripe.Subscription> }
}

/** A subscription whose latest payment is still owed: what an invoice.payment_failed event must find to act. */
const BEHIND_ON_PAYMENT: readonly Stripe.Subscription.Status[] = ['past_due', 'unpaid']
/** W46: a subscription that is paid up (`trialing`: the days a payment date change adds): what an invoice.paid event must find to act. */
const PAID_UP: readonly Stripe.Subscription.Status[] = ['active', 'trialing']

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** One call of a membership function: its name and what it is given. */
interface MembershipWrite {
  fn: string
  params: Record<string, unknown>
}

const sameWrite = (a: MembershipWrite, b: MembershipWrite): boolean => a.fn === b.fn && JSON.stringify(a.params) === JSON.stringify(b.params)

/**
 * What a subscription's payment state asks of its membership, for the event of one invoice (`invoiceId`): paid up
 * with that invoice its newest, the payment recorded with the period's end as Stripe has it; behind, marked past due;
 * anything else (ended, never started, paused, or paid up with a newer invoice), nothing.
 * W46b (W46 review B1): a payment is recorded only for the subscription's newest invoice. Paid up with a newer one,
 * the period Stripe shows belongs to that newer invoice (a draft in the hour before a renewal is charged), and its own
 * events say whether it was paid.
 */
function paymentWrite(subscriptionId: string, subscription: Stripe.Subscription, invoiceId: string | undefined): MembershipWrite | null {
  if (PAID_UP.includes(subscription.status)) {
    if (!isLatestInvoice(subscription, invoiceId)) return null
    const periodEndSeconds = getSubscriptionPeriodEnd(subscription)
    if (!periodEndSeconds) return null
    return { fn: 'membership_mark_paid', params: { p_stripe_subscription_id: subscriptionId, p_period_end: unixSecondsToIso(periodEndSeconds) } }
  }
  if (BEHIND_ON_PAYMENT.includes(subscription.status)) return { fn: 'membership_mark_payment_failed', params: { p_stripe_subscription_id: subscriptionId } }
  return null
}

/** What a subscription's end asks of its membership: its `cancel_at`, `cancel_at_period_end` and period end, as Stripe has them. */
function cancelDateWrite(subscriptionId: string, subscription: Stripe.Subscription): MembershipWrite | null {
  const periodEndSeconds = getSubscriptionPeriodEnd(subscription)
  if (!periodEndSeconds) return null
  return {
    fn: 'membership_sync_cancel_at_period_end',
    params: {
      p_stripe_subscription_id: subscriptionId,
      p_cancel_at_period_end: subscription.cancel_at_period_end,
      p_cancel_at: subscription.cancel_at ? unixSecondsToIso(subscription.cancel_at) : null,
      p_period_end: unixSecondsToIso(periodEndSeconds),
    },
  }
}

type SubscriptionRead = { subscription: Stripe.Subscription } | { missing: string }

/**
 * One read of a subscription. W46 (W45a "Noticed" 3): for a test-mode event, Stripe answering that it has no such
 * subscription (`resource_missing`: test data since deleted) is an answer, not a failure: the same event sent again
 * would get it again, for three days. Any other failure throws, so the event is recorded as an error and Stripe sends
 * it again.
 * W46b (W46 review S1): only for a test-mode event (`livemode` false on the event itself). Stripe signed a live event
 * for a subscription it has, so "no such subscription" for one means the key in use is not the live account's (the
 * test key still in place at go-live, say). That is a failure like any other: it throws, the event is answered 500,
 * and Stripe sends it again for three days, by when the key has been put right. Ignored, each payment and failed
 * payment in those hours would be dropped for good.
 */
async function readSubscription(stripe: SubscriptionReader, subscriptionId: string, livemode: boolean): Promise<SubscriptionRead> {
  try {
    return { subscription: await stripe.subscriptions.retrieve(subscriptionId) }
  } catch (err) {
    const failure = readStripeFailure(err)
    if (failure.code === 'resource_missing' && livemode === false) return { missing: failure.message }
    throw err
  }
}

/** The reason a test-mode event is ignored when Stripe can't find its subscription with the key in use. */
export const SUBSCRIPTION_MISSING = 'subscription_missing'

const missing = (subscriptionId: string, message: string): DispatchResult => ({ outcome: 'ignored', detail: { reason: SUBSCRIPTION_MISSING, subscription: subscriptionId, message } })

async function call(supabase: RpcClient, write: MembershipWrite): Promise<unknown> {
  const { data, error } = await supabase.rpc(write.fn, write.params)
  if (error) throw error
  return data
}

/** The reason an invoice.paid event is ignored when the subscription has a newer invoice than the event's (W46b). */
export const NOT_LATEST_INVOICE = 'not_latest_invoice'

/** A membership function's answer that it wrote nothing and never will: no membership has the subscription, or the membership has ended. */
const nothingToWriteTo = (data: unknown): boolean => isRecord(data) && (data.found === false || data.action === 'ignored_cancelled')

/**
 * W46 (lead call L8): how many more times one event writes when Stripe keeps showing something else after its write.
 * A subscription that changes after each of three writes inside one request is not settling: the event is left as an
 * error, and Stripe sends it again.
 */
export const MOST_WRITES_AGAIN = 2

/**
 * W46 (lead call L8; W45a "Noticed" 2). The read and the write are not one step: another event's handler can read
 * Stripe after this one did and write before this one does, and this one's older values then land last. So after the
 * write the subscription is read again, and while it asks for something other than what was last written (`wants`),
 * that is written, and read again. Every write is followed by a read that agrees with it, so the last write to a
 * membership is one Stripe still showed afterwards.
 * - Nothing was written to a live membership (none has the subscription, or it has ended): no second read.
 * - The second read finds the subscription gone (a test-mode event only, W46b): the write stands, and the answer says
 *   so (`read_again`).
 * - The second read fails any other way (for a live event, "no such subscription" too): it throws, the event is an
 *   error, and Stripe sends it again.
 * - Stripe then shows a state that asks nothing of the membership (ended, or no period end): the write stands. An
 *   ended subscription has its own event.
 */
async function writeAndConfirm(
  stripe: SubscriptionReader,
  supabase: RpcClient,
  subscriptionId: string,
  livemode: boolean,
  first: MembershipWrite,
  wants: (subscription: Stripe.Subscription) => MembershipWrite | null
): Promise<DispatchResult> {
  let written = first
  let data = await call(supabase, written)
  let again = 0
  let readAgain: string | null = null
  while (!nothingToWriteTo(data)) {
    const read = await readSubscription(stripe, subscriptionId, livemode)
    if ('missing' in read) {
      readAgain = SUBSCRIPTION_MISSING
      break
    }
    const wanted = wants(read.subscription)
    if (!wanted || sameWrite(wanted, written)) break
    if (again >= MOST_WRITES_AGAIN) {
      throw new Error(`Subscription ${subscriptionId} showed something else after each of ${again + 1} writes: the event is left for Stripe to send again.`)
    }
    written = wanted
    data = await call(supabase, written)
    again += 1
  }
  const outcome = isRecord(data) && data.found === false ? 'ignored' : 'processed'
  if (again === 0 && readAgain === null) return { outcome, detail: isRecord(data) ? data : null }
  return {
    outcome,
    detail: { ...(isRecord(data) ? data : {}), ...(again > 0 ? { written_again: again, last_write: written.fn } : {}), ...(readAgain ? { read_again: readAgain } : {}) },
  }
}

export async function dispatchStripeEvent(event: Stripe.Event, supabase: RpcClient, stripe: SubscriptionReader): Promise<DispatchResult> {
  // W46b (S1): the event's own mode, as Stripe signed it. Anything but `false` is treated as live.
  const livemode = event.livemode
  switch (event.type) {
    case 'invoice.paid': {
      const invoice = event.data.object as Stripe.Invoice
      // The membership row and its first credit period are created by the checkout/Retool
      // flow, not by this webhook — the invoice for that initial charge must be skipped.
      if (invoice.billing_reason === 'subscription_create') {
        return { outcome: 'ignored', detail: { reason: 'first_invoice' } }
      }
      const subscriptionId = getInvoiceSubscriptionId(invoice)
      if (!subscriptionId) {
        return { outcome: 'ignored', detail: { reason: 'no_subscription_id' } }
      }
      // W46 (W45a "Noticed" 1): an invoice.paid handled late, after a later payment failed, must not mark a member
      // who owes that payment as paid, restore their flagged credit bookings and write an older period's end as the
      // next payment date. The date change's £0 invoice, then the first full payment failing, is two invoices inside
      // the three days Stripe keeps sending an event. The subscription is read now: only one Stripe shows as paid up
      // records the payment, and the next payment date is the period's end as Stripe has it, not the invoice's.
      const read = await readSubscription(stripe, subscriptionId, livemode)
      if ('missing' in read) return missing(subscriptionId, read.missing)
      if (!PAID_UP.includes(read.subscription.status)) {
        return { outcome: 'ignored', detail: { reason: 'subscription_not_paid_up', status: read.subscription.status } }
      }
      // W46b (W46 review B1): and only when the event's invoice is the subscription's newest. In the hour Stripe holds
      // a renewal's invoice as a draft the subscription reads active with its period already moved on; an older
      // invoice.paid handled then (sent again after a failed delivery) wrote next month's date, and the renewal's
      // failure an hour later then flagged nothing (migration 030 goes by that date). The newer invoice's own events
      // set the state.
      if (!isLatestInvoice(read.subscription, invoice.id)) {
        return { outcome: 'ignored', detail: { reason: NOT_LATEST_INVOICE } }
      }
      const write = paymentWrite(subscriptionId, read.subscription, invoice.id)
      if (!write) {
        return { outcome: 'ignored', detail: { reason: 'no_period_end' } }
      }
      // The same holds for the read after the write (L8): a payment whose second read lands in the next renewal's
      // draft hour must not write that renewal's date.
      return writeAndConfirm(stripe, supabase, subscriptionId, livemode, write, (subscription) => paymentWrite(subscriptionId, subscription, invoice.id))
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice
      if (invoice.billing_reason === 'subscription_create') {
        return { outcome: 'ignored', detail: { reason: 'first_invoice' } }
      }
      const subscriptionId = getInvoiceSubscriptionId(invoice)
      if (!subscriptionId) {
        return { outcome: 'ignored', detail: { reason: 'no_subscription_id' } }
      }
      // W45a (audit S1): a failed payment handled late, after the payment that followed it went through, must not
      // mark a paid member past due and flag their credit bookings. The subscription is read now, and only one
      // still behind on its payment marks the membership. A read that fails throws: the event is recorded as an
      // error and answered 500, so Stripe sends it again. (W46, W46b: except "no such subscription" for a test-mode
      // event, which is ignored.)
      const read = await readSubscription(stripe, subscriptionId, livemode)
      if ('missing' in read) return missing(subscriptionId, read.missing)
      if (!BEHIND_ON_PAYMENT.includes(read.subscription.status)) {
        return { outcome: 'ignored', detail: { reason: 'subscription_not_past_due', status: read.subscription.status } }
      }
      // W46 (L8): if the payment goes through between that read and the write, the second read shows it and the
      // payment is recorded, as its own invoice.paid would. W46b (B1): only when the invoice that failed is still the
      // subscription's newest, which a retry that goes through leaves it.
      return writeAndConfirm(stripe, supabase, subscriptionId, livemode, { fn: 'membership_mark_payment_failed', params: { p_stripe_subscription_id: subscriptionId } }, (subscription) =>
        paymentWrite(subscriptionId, subscription, invoice.id)
      )
    }

    case 'customer.subscription.deleted': {
      // W45a: no read here. Only the subscription's id is taken from the event (the end date is worked out in the
      // database from the membership's own rows), and a subscription that has ended never comes back, so this event
      // is still true however late it is handled.
      const subscription = event.data.object as Stripe.Subscription
      const data = await call(supabase, { fn: 'membership_mark_cancelled_by_stripe', params: { p_stripe_subscription_id: subscription.id } })
      return { outcome: isRecord(data) && data.found === false ? 'ignored' : 'processed', detail: isRecord(data) ? data : null }
    }

    case 'customer.subscription.updated': {
      // W45a (audit S1): the event only says which subscription changed. Its own cancel_at, cancel_at_period_end and
      // period end are what the subscription showed when the event was made; handled after a newer event (Cancel,
      // then Undo, with the Cancel's event last) they left the membership ending on a date Stripe no longer had.
      // The subscription is read now and its current values are passed. A read that fails throws: the event is
      // recorded as an error and answered 500, so Stripe sends it again; nothing is written from the event.
      // (W46, W46b: except "no such subscription" for a test-mode event, which is ignored.)
      const subscriptionId = (event.data.object as Stripe.Subscription).id
      const read = await readSubscription(stripe, subscriptionId, livemode)
      if ('missing' in read) return missing(subscriptionId, read.missing)
      const write = cancelDateWrite(subscriptionId, read.subscription)
      if (!write) {
        return { outcome: 'ignored', detail: { reason: 'no_period_end' } }
      }
      return writeAndConfirm(stripe, supabase, subscriptionId, livemode, write, (subscription) => cancelDateWrite(subscriptionId, subscription))
    }

    default:
      return { outcome: 'ignored', detail: { reason: 'unhandled_event_type' } }
  }
}
