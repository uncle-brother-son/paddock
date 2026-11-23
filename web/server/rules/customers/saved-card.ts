// New in W42 (F-plan 4.7; Q19; Wayne's Q45; W11 F4 / FB17; lead call L11): a customer's card saved or replaced, and
// each of their live memberships' renewals moved to it. Behind its own switch kind, `card_moves`
// (memberships/membership-switch.ts): off, the route refuses the save and nothing here runs (W68, H5).
//
//   read which reusable card the tap left (as before: stripe/saved-card.ts), refusing one that can't be charged later
//   K1 (one transaction, under the customer's lock, then each of their memberships' locks in id order)
//      F4 / FB17: refused, with nothing written, unless the intent's Stripe customer is this customer's
//      the card on the customer (customers.saved_*), exactly as resolved
//      audit row `customer.card_saved`, naming the card it replaced and the subscriptions it is to move
//      one card step (memberships/left.ts, kind `payment_method`) per live subscription: a membership that is active
//      or failing (`past_due`), with a subscription. An ended one is left alone. A card step still open on that
//      subscription (an earlier replace Stripe never confirmed) is closed as `replaced`: the newest card wins
//   then Stripe, each safe to repeat, none of it money (card-steps.ts, `sendCardSteps`):
//      each subscription's `default_payment_method` -> the new card, under the step's key (left.ts, `trySendStep`:
//      read first, sent only if Stripe doesn't show it, and only that one field)
//        went              : the step is marked done
//        refused or unclear: the step stays left. It is listed on the Orders page, sent again by reconcile once it is
//                            past the press's window, and checked 20 minutes after it closes (left.ts, W40 to W40d).
//                            A refusal reconcile itself gets is recorded as refused for a person, with Mark sorted.
//      the Stripe customer's invoice default -> the new card, last (W42a, W42 review L4; see "The invoice default")
//   answers the customer's row, how many memberships moved and how many are still to move
//
// The card is saved whatever Stripe says about a membership: the customer has a working card, and the stuck list shows
// the membership until it has moved. Nothing here is ever put back.
//
// Q45 (Wayne, 15 Nov): a failing membership is moved like any other and no payment is taken here; Stripe's own next
// try of the failed payment then uses the subscription's new card.
// L11: the old card stays attached in Stripe: detaching it while a membership is still to move would break that
// membership's next payment.
//
// Two replaces close together. The second's K1 waits for the first's (the customer's lock), then closes the first's
// open steps as `replaced` and leaves its own. No press is refused for a step still being sent (a cancel is: W40 S1):
// the customer is standing at the reader, and the newest card must be the one saved. W42a (W42 review S2): the first
// press may still be at Stripe then, and its send can land after the second's. So the second's step carries the
// `stale_send` mark (card-steps.ts): when its own send is done the wish is left again instead of closed, it stays
// listed, and the first run past the window reads Stripe and sends the newest card if the older one landed over it.
// A press also sends nothing for a step that has been replaced by the time it comes to send it. The check 20 minutes
// after the closing (left.ts, W40c) is still the net under both.
//
// W42a (W42 review S1; W42 report, Noticed 1): the step-leaving and the sends live in card-steps.ts, and an order's
// T2 runs the same rule (orders/finalise-order.ts) when it writes a membership or saves a card on the reader, so a
// membership made, or a card saved, by an order at the same moment as a replace still ends on the customer's card.
//
// The invoice default (brief W42 item 2, "decide; say why"). It is sent once, by the press, and its outcome is
// recorded (`customer.invoice_default`). When Stripe refuses it or gives no clear answer it is NOT listed and NOT sent
// again on its own, because nothing is charged from it: Stripe only falls back to a customer's invoice default for a
// subscription with no card of its own, and after K1 every live subscription has a card step that gives it one (a
// step is left even where Stripe shows no card on the subscription today). The saved-card charges name their card
// outright. It is set again by the next thing that needs it: a new membership order sets it itself before it makes
// the subscription (orders/membership.ts, `startSubscription`), and so does the next replace.
//
// Other writers of a subscription's card (W40 review L5, W40c review L6): only `subscriptionRequest`
// (orders/membership.ts), which makes a new subscription with its card. W42a: with `card_moves` on, the order's T2
// then leaves a card step for it against the customer's saved card, so it is held to that card like any other.
// Nothing else in the Worker sends `default_payment_method` to a subscription (saved-card.test.ts holds the list).
import 'server-only'
import type { SavedCardRouteOutput, SaveCustomerCardInput, SaveCustomerCardOutput } from '@/contracts'
import { audit } from '@/server/audit'
import type { Db, Tx } from '@/server/db'
import { ApiError } from '@/server/http/errors'
import { accountRefusal } from '@/server/rules/account/refusal'
import type { StepBy } from '@/server/rules/memberships/left'
import type { StripeClient } from '@/server/stripe/client'
import { sendOptions, type StripeTiming } from '@/server/stripe/deadline'
import { notReusableMessage, resolveSavedCard, SavedCardError, type CardSource, type ResolvedCard } from '@/server/stripe/saved-card'
import { leaveCardSteps, liveMemberships, lockCustomerForCardSteps, lockMemberships, sendCardSteps, type CardStepsLeft } from './card-steps'
import { SAVED_CARD_WORDS } from './failure-messages'

export { INVOICE_DEFAULT_ACTION, LIVE_MEMBERSHIP_STATUSES } from './card-steps'

export const CARD_SAVED_ACTION = 'customer.card_saved'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface ReplaceCardOptions {
  actor: { type: 'staff' | 'customer' | 'system'; id: string | null }
  requestId: string
  /** The press's deadline, from the request's start: every Stripe call ends by it, and one with too little time left isn't made. */
  timing?: StripeTiming
}

/** What K1 wrote: the customer's row, and the card step left for each live subscription. */
interface Saved {
  row: SaveCustomerCardOutput
  left: CardStepsLeft
}

/** Read in its own statement, after the locks: a statement that waited for a lock still sees the rows as they were when it started. */
const CUSTOMER_SQL = 'SELECT stripe_customer_id, saved_payment_method_id FROM customers WHERE id = $1::uuid'

/**
 * K1. F4 / FB17 first, under the customer's lock and before anything is written: the card is only saved to the
 * customer whose Stripe customer the intent was made for. A customer with no Stripe customer, or an intent that
 * names none, can't match, and is refused the same way.
 */
async function saveAndLeave(tx: Tx, customerId: string, card: ResolvedCard, source: CardSource, by: StepBy): Promise<Saved> {
  if (!(await lockCustomerForCardSteps(tx, customerId))) throw new ApiError('NOT_FOUND', 'Customer not found')
  await lockMemberships(tx, customerId)
  const [before] = await tx.query<{ stripe_customer_id: string | null; saved_payment_method_id: string | null }>(CUSTOMER_SQL, [customerId])
  if (!before) throw new ApiError('NOT_FOUND', 'Customer not found')
  if (!before.stripe_customer_id || !card.stripeCustomerId || before.stripe_customer_id !== card.stripeCustomerId) {
    throw accountRefusal('CONFLICT', 'saved_card', 'other_customer', SAVED_CARD_WORDS.otherCustomer)
  }

  const [row] = await tx.query<SaveCustomerCardOutput>(
    `UPDATE customers
     SET saved_payment_method_id = $1, saved_card_last4 = $2, saved_card_brand = $3, updated_at = now()
     WHERE id = $4::uuid
     RETURNING id, stripe_customer_id, saved_payment_method_id, saved_card_last4, saved_card_brand`,
    [card.paymentMethodId, card.last4, card.brand, customerId]
  )
  if (!row) throw new Error(`Customer ${customerId} was locked but not updated.`)

  const live = await liveMemberships(tx, customerId)
  await audit.record(tx, {
    actorType: by.actor.type,
    actorId: by.actor.id,
    action: CARD_SAVED_ACTION,
    entityType: 'customer',
    entityId: row.id,
    requestId: by.requestId,
    // As before W42, with the card it replaced and the subscriptions it is to move (each one's step row follows, under this request).
    details: { paymentMethodId: card.paymentMethodId, last4: card.last4, brand: card.brand, ...source, replaced: before.saved_payment_method_id, subscriptions: live.map((membership) => membership.stripe_subscription_id) },
  })
  const steps = await leaveCardSteps(tx, live, card.paymentMethodId, by)
  return { row, left: { customerId: row.id, stripeCustomerId: before.stripe_customer_id, paymentMethodId: card.paymentMethodId, steps } }
}

/**
 * saveCustomerCardOnFile. The checks of what was sent, the reading of the tap and the refusal of a card that can't be
 * charged later are the old function's, word for word (`saveCustomerCard`, W11's port, until W68).
 */
export async function replaceCustomerCard(db: Db, stripe: StripeClient, input: SaveCustomerCardInput, options: ReplaceCardOptions): Promise<SavedCardRouteOutput> {
  const { customerId, paymentIntentId, setupIntentId } = input
  if (!customerId) throw new ApiError('VALIDATION', 'customerId is required')
  if (!paymentIntentId && !setupIntentId) throw new ApiError('VALIDATION', 'Either paymentIntentId or setupIntentId is required')
  if (paymentIntentId && setupIntentId) throw new ApiError('VALIDATION', 'Pass either paymentIntentId or setupIntentId, not both')
  const source: CardSource = paymentIntentId ? { paymentIntentId } : { setupIntentId: setupIntentId as string }

  let card: ResolvedCard
  try {
    card = await resolveSavedCard(stripe, source, () => sendOptions(options.timing))
  } catch (err) {
    if (!(err instanceof SavedCardError)) throw err
    throw new ApiError(err.message.startsWith('No payment method') ? 'VALIDATION' : 'INTERNAL', err.message)
  }
  if (!card.reusable) throw new ApiError('VALIDATION', notReusableMessage(source, card.paymentMethodId))
  if (!UUID.test(customerId)) throw new ApiError('NOT_FOUND', 'Customer not found')

  const by: StepBy = { actor: options.actor, requestId: options.requestId }
  const saved = await db.transaction((tx) => saveAndLeave(tx, customerId, card, source, by))

  const sent = await sendCardSteps(db, stripe, saved.left, { ...by, timing: options.timing })
  return { ...saved.row, membershipsMoved: sent.moved, membershipsToMove: sent.toMove }
}
