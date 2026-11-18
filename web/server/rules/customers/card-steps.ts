// New in W42a (W42 review S1, S2, L4; W42 report, Noticed 1): the one rule for "a customer's memberships follow their
// saved card", split out of saved-card.ts so that every action that changes which card a membership should renew on
// uses the same steps and the same sends:
//   - the replace press (saved-card.ts, K1): the customer's card is replaced on the reader;
//   - an order's T2 (orders/finalise-order.ts), with `card_moves` on: it wrote a membership (a membership order), or
//     saved a card to the customer (a reader order with "save card").
//
// Leaving the steps (`leaveCardSteps`, `followSavedCard`): in the action's own transaction, under the customer's lock
// and then each of their memberships' locks in id order (LOCK_ORDER: customer before membership), one card step
// (memberships/left.ts, kind `payment_method`) per live membership, wanting the customer's CURRENT saved card. Both
// actions hold the customer's lock, so they take turns: a replace that commits first is the card the order's T2
// reads, and a T2 that commits first has written the membership the replace then finds. Neither can miss the other
// (W42 review S1: before this, an order's T1 read the old card, the replace found no membership yet, and the new
// membership renewed on the old card for good with nothing listed).
//
// S2 (W42 review): no press is refused for a card step still being sent (the newest card must be the one saved), so a
// step can be replaced while its own press is still at Stripe, and that press's send can land after the newer one.
// When a step left here closes a card step that is still inside its press's window and not refused, the new step is
// given W40b's `stale_send` mark in the same transaction. Its own press then leaves the wish again instead of
// closing it `done` (left.ts, `recordStepDone`): it stays listed ("being sent"), and the first run past the window
// reads Stripe and sends the wish if the older card has landed over it.
//
// Sending (`sendCardSteps`), after the transaction, none of it money and each safe to repeat:
//   each subscription's `default_payment_method` first, under its step's key (left.ts, `trySendStep`: read first, sent
//   only if Stripe doesn't show it, and only that one field). A step whose subscription already shows the card is
//   settled by that one read and sends nothing. A step a newer one has replaced since it was left is not sent at all.
//   then the Stripe customer's invoice default (L4: last, so a slow answer there can't use up the time the
//   subscriptions need). Sent once and recorded; see "The invoice default" in saved-card.ts for why it is neither
//   listed nor sent again on its own. W42b (W42a review L3): not sent when the customer's saved card, read again just
//   before, is no longer this action's card: an older action finishing late can't put the invoice default back.
import 'server-only'
import { audit } from '@/server/audit'
import type { Db, Tx } from '@/server/db'
import { leaveStepReplacing, newestOf, openSteps, recordStepDone, trySendStep, type LeftStep, type StepBy } from '@/server/rules/memberships/left'
import type { StripeClient } from '@/server/stripe/client'
import { NoTimeLeft, sendOptions, type StripeTiming } from '@/server/stripe/deadline'
import { readStripeFailure } from '@/server/stripe/outcome'

/** What Stripe said when the Stripe customer's invoice default was set to the customer's saved card. */
export const INVOICE_DEFAULT_ACTION = 'customer.invoice_default'

/** The membership statuses whose renewals move: active, or failing. Anything else has ended (or never started). */
export const LIVE_MEMBERSHIP_STATUSES = ['active', 'past_due'] as const

/** The customer's row lock: every action that leaves card steps holds it, so two of them take turns. */
export const LOCK_CUSTOMER_SQL = 'SELECT id FROM customers WHERE id = $1::uuid FOR NO KEY UPDATE'
/**
 * Every membership of the customer's with a subscription, locked in id order: every action that leaves a step holds
 * its membership's lock (left.ts), and one order means two of these can't deadlock. After the customer's lock, as
 * LOCK_ORDER has it.
 */
const LOCK_MEMBERSHIPS_SQL = 'SELECT id FROM customer_memberships WHERE customer_id = $1::uuid AND stripe_subscription_id IS NOT NULL ORDER BY id FOR NO KEY UPDATE'
const LIVE_MEMBERSHIPS_SQL = `
SELECT id::text AS id, stripe_subscription_id
FROM customer_memberships
WHERE customer_id = $1::uuid AND stripe_subscription_id IS NOT NULL
  AND subscription_status IN (${LIVE_MEMBERSHIP_STATUSES.map((status) => `'${status}'`).join(', ')})
ORDER BY id`
/** Read in its own statement, after the locks: a statement that waited for a lock still sees the rows as they were when it started. */
const SAVED_CARD_SQL = 'SELECT stripe_customer_id, saved_payment_method_id FROM customers WHERE id = $1::uuid'

export interface LiveMembership {
  id: string
  stripe_subscription_id: string
}

/** The card steps an action left, for the sends that follow its commit. */
export interface CardStepsLeft {
  customerId: string
  /** The customer's Stripe customer, whose invoice default is set last. None: only the steps are sent. */
  stripeCustomerId: string | null
  /** The card every step wants: the customer's saved card as the action's transaction read or wrote it. */
  paymentMethodId: string
  steps: LeftStep[]
}

/** The customer's lock, taken before anything of theirs is read or written. False when there is no such customer. */
export async function lockCustomerForCardSteps(tx: Tx, customerId: string): Promise<boolean> {
  return (await tx.query(LOCK_CUSTOMER_SQL, [customerId])).length > 0
}

/** Each of the customer's memberships' locks, in id order. The caller holds the customer's lock. */
export async function lockMemberships(tx: Tx, customerId: string): Promise<void> {
  await tx.query(LOCK_MEMBERSHIPS_SQL, [customerId])
}

/** The customer's live memberships (active or failing, with a subscription), in id order. Asked after the locks. */
export function liveMemberships(tx: Tx, customerId: string): Promise<LiveMembership[]> {
  return tx.query<LiveMembership>(LIVE_MEMBERSHIPS_SQL, [customerId])
}

/**
 * One card step per live membership, wanting `paymentMethodId`. The caller holds the customer's lock and each
 * membership's. A card step still open on a subscription is closed as `replaced` (the newest card wins), and when
 * that one's press may still be sending it, the new step carries the `stale_send` mark (S2, at the top).
 */
export async function leaveCardSteps(tx: Tx, live: readonly LiveMembership[], paymentMethodId: string, by: StepBy): Promise<LeftStep[]> {
  const steps: LeftStep[] = []
  if (live.length === 0) return steps
  // W42b (W42a review L4): the open steps are read once for all of them, not once per membership. Each membership
  // has its own subscription, so a step left for one in this loop is never an older step of another's.
  const open = await openSteps(tx)
  for (const membership of live) {
    const left = await leaveStepReplacing(tx, { membershipId: membership.id, subscriptionId: membership.stripe_subscription_id, kind: 'payment_method', want: { paymentMethod: paymentMethodId } }, by, {}, true, open)
    steps.push(left.step)
  }
  return steps
}

/**
 * The order's part of the rule (finalise-order.ts, T2, after its own writes): a card step for every live membership
 * of the customer's against their current saved card, read here under the locks, never the card the order was placed
 * with. The caller holds the customer's lock (taken before T2 wrote anything of theirs). Null when the customer has
 * no saved card: there is nothing for a membership to follow.
 */
export async function followSavedCard(tx: Tx, customerId: string, by: StepBy): Promise<CardStepsLeft | null> {
  await lockMemberships(tx, customerId)
  const [customer] = await tx.query<{ stripe_customer_id: string | null; saved_payment_method_id: string | null }>(SAVED_CARD_SQL, [customerId])
  if (!customer?.saved_payment_method_id) return null
  const steps = await leaveCardSteps(tx, await liveMemberships(tx, customerId), customer.saved_payment_method_id, by)
  return { customerId, stripeCustomerId: customer.stripe_customer_id, paymentMethodId: customer.saved_payment_method_id, steps }
}

/** W42b: the customer's saved card as it is now, read outside any transaction just before the invoice default is sent. */
const SAVED_CARD_NOW_SQL = 'SELECT saved_payment_method_id FROM customers WHERE id = $1::uuid'

/** W42b: the invoice default was not sent, because the customer's saved card is no longer the one this action left its steps for. */
class CardReplaced extends Error {
  constructor() {
    super("Not sent: the customer's saved card has changed since, and the newer change sets the invoice default.")
    this.name = 'CardReplaced'
  }
}

export interface CardSendOptions extends StepBy {
  /** The press's deadline, from the request's start: every Stripe call ends by it, and one with too little time left isn't made. */
  timing?: StripeTiming | undefined
}

/**
 * The Stripe customer's invoice default set to the saved card, once, with what Stripe said recorded. Never throws:
 * see "The invoice default" in saved-card.ts for why a refusal or no clear answer is neither listed nor sent again.
 * W42b: not sent at all (recorded as `replaced`) when the customer's saved card has changed since the action.
 */
async function setInvoiceDefault(db: Db, stripe: StripeClient, left: CardStepsLeft, stripeCustomerId: string, options: CardSendOptions): Promise<void> {
  let said: { set: true } | { set: false; outcome: 'refused' | 'unclear' | 'replaced'; message: string }
  try {
    // W42b (W42a review L3): the customer's saved card is read again just before the send. If a newer action has
    // changed it since this one's transaction, that action sets the invoice default to its own card, and this older
    // card is not sent after it. If the read fails, the send goes ahead as before.
    const [now] = await db.query<{ saved_payment_method_id: string | null }>(SAVED_CARD_NOW_SQL, [left.customerId]).catch(() => [])
    if (now && now.saved_payment_method_id !== left.paymentMethodId) throw new CardReplaced()
    await stripe.customers.update(stripeCustomerId, { invoice_settings: { default_payment_method: left.paymentMethodId } }, sendOptions(options.timing))
    said = { set: true }
  } catch (err) {
    if (err instanceof CardReplaced) said = { set: false, outcome: 'replaced', message: err.message }
    else if (err instanceof NoTimeLeft) said = { set: false, outcome: 'unclear', message: err.message }
    else {
      const failure = readStripeFailure(err)
      said = { set: false, outcome: failure.outcome === 'definite' ? 'refused' : 'unclear', message: failure.message }
    }
  }
  // A record only: if it can't be written, the card and the steps are already saved and nothing depends on this row.
  await db
    .transaction((tx) =>
      audit.record(tx, {
        actorType: options.actor.type,
        actorId: options.actor.id,
        action: INVOICE_DEFAULT_ACTION,
        entityType: 'customer',
        entityId: left.customerId,
        requestId: options.requestId,
        details: { stripeCustomerId, paymentMethodId: left.paymentMethodId, ...said },
      })
    )
    .catch(() => undefined)
}

/**
 * The sends that follow the action's commit: each step, then the invoice default. Answers how many memberships
 * Stripe now shows on the card and how many are still to move. Never throws: a step Stripe refuses or gives no clear
 * answer for stays left (listed, sent again by reconcile past the window, checked after it closes), and so does one
 * that was never tried because something failed here.
 */
export async function sendCardSteps(db: Db, stripe: StripeClient, left: CardStepsLeft, options: CardSendOptions): Promise<{ moved: number; toMove: number }> {
  const by: StepBy = { actor: options.actor, requestId: options.requestId }
  let moved = 0
  for (const step of left.steps) {
    try {
      // A newer step has replaced this one since it was left (another replace, or an order's T2): its wish is no
      // longer the customer's card, and the newer step's own action sends that one. If this can't be read, the send
      // goes ahead: the newer step's mark (S2) covers a send that lands late.
      const newest = await newestOf(db, step.id).catch(() => step.id)
      if (newest !== step.id) continue
      const answer = await trySendStep(stripe, step, options.timing)
      if (answer.kind !== 'done') continue
      // If the row can't be written the step stays open: reconcile reads Stripe, finds it done, and writes it then.
      await recordStepDone(db, step, by, answer.detail).catch(() => false)
      moved += 1
    } catch {
      // Left as it is: listed, and reconcile's.
    }
  }
  if (left.stripeCustomerId) await setInvoiceDefault(db, stripe, left, left.stripeCustomerId, options).catch(() => undefined)
  return { moved, toMove: left.steps.length - moved }
}
