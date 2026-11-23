import Stripe from 'stripe'
import { readStripeFailure } from '@/server/stripe/outcome'

export interface DispatchResult {
  outcome: 'processed' | 'ignored'
  /** What the database function answered, or why the event was ignored. */
  detail: Record<string, unknown> | null
}

/** What a database function answers (database.ts, as Supabase's client did until W66): it never throws; a failure comes back as `error`. */
export interface RpcAnswer {
  data: unknown
  error: unknown
}

// The only part of the database dispatchStripeEvent needs: one of the four membership functions, by name. W66 (H8):
// on the Worker's own connection (database.ts, membershipFunctions), where it was Supabase's client; "Try the payment
// again now" passes its own (retry-payment.ts, membershipRpc).
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
  /** W47r-b: one more read, made only for an invoice whose subscription has ended (recordInvoicePaid): when it was paid. */
  invoices?: { retrieve(id: string): Promise<Stripe.Invoice> }
}

/** A subscription whose latest payment is still owed: what an invoice.payment_failed event must find to act. */
const BEHIND_ON_PAYMENT: readonly Stripe.Subscription.Status[] = ['past_due', 'unpaid']
/** W46: a subscription that is paid up (`trialing`: the days a payment date change adds): what an invoice.paid event must find to act. */
const PAID_UP: readonly Stripe.Subscription.Status[] = ['active', 'trialing']

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** W47r-b: a subscription Stripe has ended for good. Nothing brings it back, so a payment of its invoice taken afterwards has nothing to pay for. */
export const ENDED_IN_STRIPE: readonly Stripe.Subscription.Status[] = ['canceled', 'incomplete_expired']

/**
 * W47r-b (W47r-a "Noticed" 1): an invoice Stripe shows as paid, with money taken, whose subscription Stripe shows
 * as ended, where the payment was not before the end. Times in seconds, as Stripe gives them; null when it gave none.
 */
export interface PaidAfterEndFound {
  subscriptionId: string
  invoiceId: string
  /** The subscription's status: `canceled` or `incomplete_expired`. */
  status: string
  /** Pence taken for the invoice (`amount_paid`). */
  amountPaid: number
  /** The invoice's `status_transitions.paid_at`. */
  paidAt: number | null
  /** The subscription's `ended_at`, or its `canceled_at` when Stripe gives no `ended_at`. */
  endedAt: number | null
  livemode: boolean
  /**
   * W47r-c (W47r-b "Noticed" 2): the subscription is still live in Stripe and it is the membership's row here that
   * has ended (the write answered `ignored_cancelled`). `status` is then the live subscription's and `endedAt` is
   * null: the listing sets the payment against the row's last day instead, which only it can read.
   */
  cancelledHere?: true
  /**
   * W47r-d (W47r-c "Noticed" 2): the payment was taken BEFORE the subscription ended in Stripe (`paidAt` earlier than
   * `endedAt`), which until W47r-d was the end of it: owed, not listed. But the end in Stripe can be a manager
   * cancelling there after the payment, for a membership whose last day here had already passed. So the listing is
   * still asked, and lists only when the row has a last day and the payment was on or after it (London's date).
   */
  beforeStripeEnd?: true
}

/** What the listing answered: whether this call wrote the line, and if not why (it is listed already, or held another way). */
export interface PaidAfterEndListed {
  listed: boolean
  why: string
  [key: string]: unknown
}

/**
 * W47r-b: writes the line for a person (server/rules/memberships/paid-after-end.ts, on the Worker's own database
 * connection: the audit row, once for an invoice). Given by the webhook's route and by "Try the payment again now".
 * A caller that gives none (a test of something else) gets recordInvoicePaid as it was before W47r-b.
 */
export type ListPaidAfterEnd = (found: PaidAfterEndFound) => Promise<PaidAfterEndListed>

/** The reason a `customer.subscription.updated` event is ignored when a cancel pressed here still wants the membership's last day (W47r-e). */
export const CANCEL_WANTED_HERE = 'cancel_wanted_here'

/** W47r-e: a membership's last day left as it is, and the open cancel step that asks for it. */
export interface CancelDateKept {
  membershipId: string
  /** The last day kept (YYYY-MM-DD). */
  lastDay: string
  stepId: string
  /** `left`: still being sent by the automatic check. `refused`: Stripe said no for good, and it is listed for a person. */
  stepState: 'left' | 'refused'
  /** The last day the step's own end gives. */
  stepLastDay: string | null
}

/**
 * W47r-e (brief item 1; W47r-d "Noticed" 1, fix a): the write of an update notice for a subscription Stripe shows
 * with NO end, made on the Worker's own database connection (server/rules/memberships/cancel-kept.ts): one
 * transaction under the membership's lock that looks for an open cancel step wanting an end and, with none, calls
 * the sync function as the webhook does (`data`: its answer). With one, nothing is written (`kept`): a cancel
 * pressed here that Stripe doesn't have yet is not undone by Stripe's notice. Given by the webhook's route. A caller
 * that gives none (a test of something else) gets the handler as it was before W47r-e.
 */
export type SyncCancelDate = (params: { p_stripe_subscription_id: string; p_cancel_at_period_end: boolean; p_cancel_at: string | null; p_period_end: string }) => Promise<{ kept: CancelDateKept } | { data: unknown }>

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
function cancelDateWrite(subscriptionId: string, subscription: Stripe.Subscription): (MembershipWrite & { params: Parameters<SyncCancelDate>[0] }) | null {
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

/**
 * W47r-e: the answer of a write that was held back because a cancel pressed here still wants the last day. Shaped as
 * a membership function's answer (`found`), with the reason and what was kept, so the event's row says why.
 */
const cancelKept = (kept: CancelDateKept): Record<string, unknown> => ({
  found: true,
  reason: CANCEL_WANTED_HERE,
  membership: kept.membershipId,
  last_day: kept.lastDay,
  step: kept.stepId,
  step_state: kept.stepState,
  step_last_day: kept.stepLastDay,
})

const wasKept = (data: unknown): boolean => isRecord(data) && data.reason === CANCEL_WANTED_HERE

/**
 * W47r-e: how an update notice's write is made. Stripe showing an end (a date to set or move) is written as always,
 * by the database's function through `functions`. Stripe showing NO end goes through `sync` when the route gave one:
 * the same function, called under the membership's lock only when no cancel pressed here still wants the last day.
 */
function cancelDateSend(functions: RpcClient, sync: SyncCancelDate | undefined): (write: MembershipWrite) => Promise<unknown> {
  return async (write) => {
    const params = write.params as Parameters<SyncCancelDate>[0]
    const showsNoEnd = params.p_cancel_at === null && params.p_cancel_at_period_end !== true
    if (!sync || write.fn !== 'membership_sync_cancel_at_period_end' || !showsNoEnd) return call(functions, write)
    const synced = await sync(params)
    return 'kept' in synced ? cancelKept(synced.kept) : synced.data
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

/**
 * W47 (W46 review L2): the row says which mode the event was (`livemode`), so the Orders page's banner can list a live
 * event left like this and leave test data alone (stuck-list.ts). Only a test-mode event gets here today (W46b).
 */
const missing = (subscriptionId: string, message: string, livemode: boolean): DispatchResult => ({ outcome: 'ignored', detail: { reason: SUBSCRIPTION_MISSING, subscription: subscriptionId, message, livemode } })

async function call(functions: RpcClient, write: MembershipWrite): Promise<unknown> {
  const { data, error } = await functions.rpc(write.fn, write.params)
  if (error) throw error
  return data
}

/** The reason an invoice.paid event is ignored when the subscription has a newer invoice than the event's (W46b). */
export const NOT_LATEST_INVOICE = 'not_latest_invoice'

/**
 * A membership function's answer that it wrote nothing and never will: no membership has the subscription, or the
 * membership has ended. W47r-e: or the write was held back for a cancel pressed here (`cancelKept`): nothing was
 * written, so there is nothing for a second read to agree with.
 */
const nothingToWriteTo = (data: unknown): boolean => isRecord(data) && (data.found === false || data.action === 'ignored_cancelled' || wasKept(data))

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
 * - W47r-e: a write held back for a cancel pressed here (an update notice only, `send`) wrote nothing: no second read.
 */
async function writeAndConfirm(
  stripe: SubscriptionReader,
  functions: RpcClient,
  subscriptionId: string,
  livemode: boolean,
  first: MembershipWrite,
  wants: (subscription: Stripe.Subscription) => MembershipWrite | null,
  /** W47r-e: how each write is made; absent, the database function through `functions`, as always. */
  send: (write: MembershipWrite) => Promise<unknown> = (write) => call(functions, write)
): Promise<DispatchResult> {
  let written = first
  let data = await send(written)
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
    data = await send(written)
    again += 1
  }
  // W47r-e: a notice whose only write was held back wrote nothing: ignored, with the reason. One that wrote a date
  // first and was then held back (Stripe's end went between the two reads) did write, and is processed.
  const outcome = isRecord(data) && (data.found === false || (again === 0 && wasKept(data))) ? 'ignored' : 'processed'
  if (again === 0 && readAgain === null) return { outcome, detail: isRecord(data) ? data : null }
  return {
    outcome,
    detail: { ...(isRecord(data) ? data : {}), ...(again > 0 ? { written_again: again, last_write: written.fn } : {}), ...(readAgain ? { read_again: readAgain } : {}) },
  }
}

/**
 * W47r-b: the invoice of a subscription that has ended, read now, and listed for a refund when its payment was not
 * before the end. Answers what it found, for the event's row.
 * W47r-c: and the invoice of a live subscription whose membership has ended here (`cancelledHere`), by the same read.
 * Stripe gives no end to set that payment against: the listing reads the row's last day under the membership's lock
 * and answers `paid_before_last_day` (owed, not listed) for a payment before it.
 * - Not paid, or paid with nothing taken (a £0 invoice): nothing to give back.
 * - Paid before the subscription ended (`paid_at` earlier than `ended_at`; `canceled_at` only when Stripe gives no
 *   `ended_at`): the money was owed. The same second counts as after: Stripe's times are whole seconds, so the order
 *   inside one can't be told, and a line a person looks at is the safe side.
 *   W47r-d (W47r-c "Noticed" 2): unless the membership's row here had a last day and the payment was on or after it.
 *   Cancel pressed here, the cancel never reaching Stripe, Stripe renewing the day after the last day, and a manager
 *   then cancelling in Stripe leaves exactly that: paid "before the end" by Stripe's times, for time the member never
 *   had. Only the listing can read the row, so it is asked (`beforeStripeEnd`) and answers `paid_before_end` itself
 *   when the row has no last day or the payment was before it.
 * - A time Stripe didn't give: listed. It can't be shown the payment came first.
 * - The invoice can't be read: thrown, so the event is an error and Stripe sends it again (the retry holds its
 *   record, or its press says to try again). Except "no such invoice" for a test-mode event: test data since deleted.
 */
async function paidAfterEnd(
  stripe: SubscriptionReader,
  subscriptionId: string,
  subscription: Stripe.Subscription,
  invoiceId: string,
  livemode: boolean,
  list: ListPaidAfterEnd,
  cancelledHere = false
): Promise<PaidAfterEndListed> {
  if (!stripe.invoices) throw new Error(`${cancelledHere ? `The membership of subscription ${subscriptionId} has ended here` : `Subscription ${subscriptionId} has ended`} and its invoice ${invoiceId} can't be read: no invoice read was given.`)
  let invoice: Stripe.Invoice
  try {
    invoice = await stripe.invoices.retrieve(invoiceId)
  } catch (err) {
    if (readStripeFailure(err).code === 'resource_missing' && livemode === false) return { listed: false, why: 'invoice_missing' }
    throw err
  }
  if (invoice.status !== 'paid' || !(invoice.amount_paid > 0)) return { listed: false, why: 'nothing_taken', invoice_status: invoice.status ?? null, amount_paid: invoice.amount_paid ?? 0 }
  const paidAt = invoice.status_transitions?.paid_at ?? null
  if (cancelledHere) {
    const listed = await list({ subscriptionId, invoiceId, status: subscription.status, amountPaid: invoice.amount_paid, paidAt, endedAt: null, livemode, cancelledHere: true })
    return { ...listed, cancelled_here: true, paid_at: paidAt }
  }
  const endedAt = subscription.ended_at ?? subscription.canceled_at ?? null
  const beforeStripeEnd = paidAt !== null && endedAt !== null && paidAt < endedAt
  const listed = await list({ subscriptionId, invoiceId, status: subscription.status, amountPaid: invoice.amount_paid, paidAt, endedAt, livemode, ...(beforeStripeEnd ? { beforeStripeEnd: true as const } : {}) })
  return { ...listed, paid_at: paidAt, ended_at: endedAt }
}

/**
 * An invoice's payment recorded on its membership: what `invoice.paid` does once it knows the subscription (W47r: its
 * own lines, moved here unchanged, so that a caller that has just seen an invoice paid in Stripe, without the event,
 * records it by the same rule. "Try the payment again now" does, at the press and from reconcile: the member's flagged
 * credit bookings then go back to confirmed at once, and the event itself, when it arrives, changes nothing).
 * `livemode`: the event's own mode; a caller with no event gives the mode of the key it reads with.
 *
 * W47r-b (W47r-a "Noticed" 1; the lead's call, 19 Nov): money taken for a subscription that had already ended is
 * always listed for a refund, and this is where, so the webhook and the retry go by one rule. When the subscription
 * reads `canceled` or `incomplete_expired`, the invoice is read (one more read, on this path only), and when Stripe
 * shows it paid with money taken at or after the moment the subscription ended, `list` writes the line: once for an
 * invoice, however many times the event is sent or the press is made, and not at all while a retry's own record holds
 * the same invoice. An invoice paid BEFORE the subscription ended is not listed: that payment was for time the member
 * had (a late or re-sent notice for a month already paid for, or a cancel just after a renewal). The answer says what
 * was found (`detail.paid_after_end`).
 *
 * W47r-c (W47r-b "Noticed" 2; Wayne's rule: a cancelled member is never charged with nothing listed): a renewal
 * Stripe takes on a subscription that is still live there, for a membership whose row has ended here (a cancel that
 * never reached Stripe). The write answers `ignored_cancelled` and, until W47r-c, that was all. Now the invoice is
 * read (one more read, on this answer only) and, paid with money taken, listed by the same line, once for an
 * invoice. Not listed when it was paid before the row's last day (`cancel_effective_date`, by London's date): a late
 * or re-sent notice for a month the member had. On the last day itself, after it, or with no last day on the row: listed.
 *
 * W47r-d (W47r-c "Noticed" 1 and 2). Migration 031: `membership_mark_paid` answers `ignored_cancelled` for a row
 * whose last day has passed too (Cancel pressed here leaves the status `active` until Stripe ends the subscription),
 * so that renewal is listed by the lines above. Before 031 is applied the write still records it, as it always did.
 * And an invoice paid before its subscription ended in Stripe is listed all the same when the row's last day shows
 * the payment was on or after it (paidAfterEnd, `beforeStripeEnd`).
 */
export async function recordInvoicePaid(
  stripe: SubscriptionReader,
  functions: RpcClient,
  subscriptionId: string,
  invoiceId: string | undefined,
  livemode: boolean,
  list?: ListPaidAfterEnd
): Promise<DispatchResult> {
  // W46 (W45a "Noticed" 1): an invoice.paid handled late, after a later payment failed, must not mark a member
  // who owes that payment as paid, restore their flagged credit bookings and write an older period's end as the
  // next payment date. The date change's £0 invoice, then the first full payment failing, is two invoices inside
  // the three days Stripe keeps sending an event. The subscription is read now: only one Stripe shows as paid up
  // records the payment, and the next payment date is the period's end as Stripe has it, not the invoice's.
  const read = await readSubscription(stripe, subscriptionId, livemode)
  if ('missing' in read) return missing(subscriptionId, read.missing, livemode)
  if (!PAID_UP.includes(read.subscription.status)) {
    const detail = { reason: 'subscription_not_paid_up', status: read.subscription.status }
    if (!list || !invoiceId || !ENDED_IN_STRIPE.includes(read.subscription.status)) return { outcome: 'ignored', detail }
    return { outcome: 'ignored', detail: { ...detail, paid_after_end: await paidAfterEnd(stripe, subscriptionId, read.subscription, invoiceId, livemode, list) } }
  }
  // W46b (W46 review B1): and only when the event's invoice is the subscription's newest. In the hour Stripe holds
  // a renewal's invoice as a draft the subscription reads active with its period already moved on; an older
  // invoice.paid handled then (sent again after a failed delivery) wrote next month's date, and the renewal's
  // failure an hour later then flagged nothing (migration 030 goes by that date). The newer invoice's own events
  // set the state.
  if (!isLatestInvoice(read.subscription, invoiceId)) {
    return { outcome: 'ignored', detail: { reason: NOT_LATEST_INVOICE } }
  }
  const write = paymentWrite(subscriptionId, read.subscription, invoiceId)
  if (!write) {
    return { outcome: 'ignored', detail: { reason: 'no_period_end' } }
  }
  // The same holds for the read after the write (L8): a payment whose second read lands in the next renewal's
  // draft hour must not write that renewal's date.
  const result = await writeAndConfirm(stripe, functions, subscriptionId, livemode, write, (subscription) => paymentWrite(subscriptionId, subscription, invoiceId))
  // W47r-c: the membership's row has ended here, and Stripe has just shown its subscription paid up with this invoice.
  if (!list || !invoiceId || result.detail?.['action'] !== 'ignored_cancelled') return result
  return { ...result, detail: { ...result.detail, paid_after_end: await paidAfterEnd(stripe, subscriptionId, read.subscription, invoiceId, livemode, list, true) } }
}

export async function dispatchStripeEvent(event: Stripe.Event, functions: RpcClient, stripe: SubscriptionReader, list?: ListPaidAfterEnd, syncCancelDate?: SyncCancelDate): Promise<DispatchResult> {
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
      // W47r: the handler's steps from here on are `recordInvoicePaid`, unchanged, so that "Try the payment again now"
      // (server/rules/memberships/retry-payment.ts) records a payment by the very same rule.
      // W47r-b: `list` is the line for a person when the invoice was paid after its subscription had ended.
      return recordInvoicePaid(stripe, functions, subscriptionId, invoice.id, livemode, list)
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
      if ('missing' in read) return missing(subscriptionId, read.missing, livemode)
      if (!BEHIND_ON_PAYMENT.includes(read.subscription.status)) {
        return { outcome: 'ignored', detail: { reason: 'subscription_not_past_due', status: read.subscription.status } }
      }
      // W46 (L8): if the payment goes through between that read and the write, the second read shows it and the
      // payment is recorded, as its own invoice.paid would. W46b (B1): only when the invoice that failed is still the
      // subscription's newest, which a retry that goes through leaves it.
      let latest = read.subscription
      const result = await writeAndConfirm(stripe, functions, subscriptionId, livemode, { fn: 'membership_mark_payment_failed', params: { p_stripe_subscription_id: subscriptionId } }, (subscription) => {
        latest = subscription
        return paymentWrite(subscriptionId, subscription, invoice.id)
      })
      // W47r-d (brief item 1, "every caller of membership_mark_paid"): the read after the write found the payment had
      // gone through, and the paid write it then made answered `ignored_cancelled`: the membership has ended here
      // (with migration 031, its last day has passed). Money was taken for it, so it is listed by the same line as
      // the invoice's own `invoice.paid` notice lists it, whichever of the two is handled first (once for an invoice).
      if (!list || !invoice.id || result.detail?.['action'] !== 'ignored_cancelled' || result.detail?.['last_write'] !== 'membership_mark_paid') return result
      return { ...result, detail: { ...result.detail, paid_after_end: await paidAfterEnd(stripe, subscriptionId, latest, invoice.id, livemode, list, true) } }
    }

    case 'customer.subscription.deleted': {
      // W45a: no read here. Only the subscription's id is taken from the event (the end date is worked out in the
      // database from the membership's own rows), and a subscription that has ended never comes back, so this event
      // is still true however late it is handled.
      const subscription = event.data.object as Stripe.Subscription
      const data = await call(functions, { fn: 'membership_mark_cancelled_by_stripe', params: { p_stripe_subscription_id: subscription.id } })
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
      if ('missing' in read) return missing(subscriptionId, read.missing, livemode)
      const write = cancelDateWrite(subscriptionId, read.subscription)
      if (!write) {
        return { outcome: 'ignored', detail: { reason: 'no_period_end' } }
      }
      // W47r-e (brief item 1; W47r-d "Noticed" 1, fix a): Stripe showing no end must not clear a last day that a
      // cancel pressed here still wants. Stripe sends this notice at every renewal (the period moved on), about an
      // hour before it takes the money: for a cancel that never reached Stripe it cleared the last day just before
      // the renewal, so the payment was recorded as any member's and nothing was listed (031 goes by the last day).
      // With an open cancel step that wants an end (left, or refused and listed for a person) the notice writes
      // nothing and is answered `ignored`, `cancel_wanted_here`: the step settles it. An Undo pressed here, a cancel
      // that finished in Stripe, and one a person marked sorted are written as before (cancel-kept.ts).
      return writeAndConfirm(stripe, functions, subscriptionId, livemode, write, (subscription) => cancelDateWrite(subscriptionId, subscription), cancelDateSend(functions, syncCancelDate))
    }

    default:
      return { outcome: 'ignored', detail: { reason: 'unhandled_event_type' } }
  }
}
