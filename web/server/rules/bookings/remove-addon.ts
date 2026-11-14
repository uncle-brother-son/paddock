// New in W22 (D-plan 1.8, 4.3, 4.7, 4.8; brief W22 item 2): removeBookingAddon on the Worker, through W21's refund
// pipeline (refunds.ts). Two calls, as Remove Guest: the quote (a read: what removing the add-on gives back), then the
// removal with the refund staff confirmed (Q18: half a penny either way; the old function took no amount).
//
// R1 is one transaction: the booking locked (LOCK_ORDER: booking, customer, and the membership a credit add-on gives
// its credit back to), the line read again under the lock, the old checks in the old order, then the line claimed
// (removed_at, as cancelBookingAddonLines claimed it), and:
// - inside 24 real hours of the session (the step B londonTime port): nothing back, money or credit; the line stamped
//   'none', with the old note;
// - a credit add-on: its credits back to the membership that paid while it is active (refund_method
//   'credit_returned'), else the old note;
// - a paid add-on refunded to the card or store credit: card first on the order that paid for it (its own order, or a
//   guest's order an older add-on was paid inside, W05c N5), at most what that order's card can still take back, the
//   rest to store credit; the claim written (`booking.refund_claimed`, kind `remove_addon`); with no card part, R2 in the
//   same transaction (the store credit, the line's stamp, the order's status).
// With a card part, it is sent once under `<claimId>:refund:<orderId>`, then R2. The first part refused: R1 undone
// (the add-on back on the booking) with the old words. No clear answer: held; reconcile records it, or puts it on the
// booking as owed (on a cancelled booking, store credit), never sending it again (Q35).
import 'server-only'
import type { ApiErrorCode, RemoveAddonQuote, RemoveBookingAddonInput, RemoveBookingAddonOutput } from '@/contracts'
import { audit } from '@/server/audit'
import type { Db, Queryable, Tx } from '@/server/db'
import { ApiError } from '@/server/http/errors'
import { startsWithinRealHours } from '@/server/rules/time/london-time'
import {
  ADDON_INSIDE_24_HOURS_NOTE,
  addonCardRefundFailedMessage,
  addonMembershipNotActiveNote,
  addonRemovalSummary,
  ISSUE_REFUNDS_NEEDED_MESSAGE,
  REFUND_OPEN_MESSAGE,
  REFUND_WORDS,
  REMOVE_ADDON_NOT_SAVED_MESSAGE,
  REMOVE_ADDON_WORDS,
} from './failure-messages'
import { lockAndLoadBooking, paymentOpen, sessionStartWallClock } from './load-booking'
import { paymentOpenRefusal } from './money-in'
import {
  ADDON_REMOVED,
  addonRemovedDetails,
  finishClaimInTransaction,
  planAddonRefund,
  refundClaimOpen,
  run,
  stampAddonLines,
  writeClaim,
  type AddonClaim,
  type AddonLineStamp,
  type RefundOptions,
  type Started,
} from './refunds'

const round2 = (n: number): number => Math.round(n * 100) / 100
/** Q18: half a penny either way passes. */
const differsByMoreThanHalfAPenny = (a: number, b: number): boolean => Math.round(Math.abs(a - b) * 1e6) / 1e6 > 0.005

export interface RemoveAddonOptions extends RefundOptions {
  /** Issue refunds: needed for a paid add-on refunded to the card or store credit, as before. */
  canIssueRefunds: boolean
}

type RemoveAddonRefusalExtras = { addonQuote?: RemoveAddonQuote; logDetail?: string }

/** A refusal before anything changed (or after a refused first card part put everything back): the old reason and words. */
export function removeAddonRefusal(code: ApiErrorCode, reason: string, message: string | undefined, extras: RemoveAddonRefusalExtras = {}): ApiError {
  const words = message ?? REMOVE_ADDON_WORDS.couldNotRemove
  return new ApiError(code, words, {
    ...(extras.logDetail ? { logDetail: extras.logDetail } : {}),
    details: { reason, message: words, action: 'remove_addon', ...(extras.addonQuote ? { addonQuote: extras.addonQuote } : {}) },
  })
}

interface LineRow {
  id: string
  booking_id: string
  addon_name: string
  quantity: number
  price_at_purchase: string
  redemption_source: string | null
  redeemed_membership_id: string | null
  order_id: string | null
  removed: boolean
  session_started: boolean
}

// As the old lookup: a session counts as started once its London wall-clock start has passed.
const LINE_SQL = `
SELECT aol.id, aol.booking_id, a.name AS addon_name, aol.quantity, aol.price_at_purchase::text AS price_at_purchase,
       aol.redemption_source, aol.redeemed_membership_id, aol.order_id, aol.removed_at IS NOT NULL AS removed,
       (s.start_time AT TIME ZONE 'UTC') <= (now() AT TIME ZONE 'Europe/London') AS session_started
FROM addon_order_lines aol
JOIN addons a ON a.id = aol.addon_id
JOIN bookings b ON b.id = aol.booking_id
JOIN sessions s ON s.id = b.session_id
WHERE aol.id = $1::uuid`

async function readLine(db: Queryable, lineId: string, lock: boolean): Promise<LineRow | null> {
  return (await db.query<LineRow>(lock ? `${LINE_SQL} FOR UPDATE OF aol` : LINE_SQL, [lineId]))[0] ?? null
}

/** The old refusals, in the old order: gone, removed already, the session started. */
function lineToRemove(line: LineRow | null): LineRow {
  if (!line) throw removeAddonRefusal('NOT_FOUND', 'line_not_found', REMOVE_ADDON_WORDS.lineNotFound)
  if (line.removed) throw removeAddonRefusal('CONFLICT', 'already_removed', REMOVE_ADDON_WORDS.alreadyRemoved)
  if (line.session_started) throw removeAddonRefusal('CONFLICT', 'session_started', REMOVE_ADDON_WORDS.sessionStarted)
  return line
}

const isPaid = (line: LineRow): boolean => (line.redemption_source ?? 'paid') !== 'membership_credit'

/** The session's start as the 24-hour rule reads it (London wall clock), from the booking's own session. */
async function sessionStart(db: Queryable, bookingId: string): Promise<string> {
  const start = await sessionStartWallClock(db, bookingId)
  if (start === null) throw removeAddonRefusal('NOT_FOUND', 'line_not_found', REMOVE_ADDON_WORDS.lineNotFound)
  return start
}

/** What removing the line gives back: its price × quantity when paid, £0 of money inside 24 hours. */
async function quoteFor(db: Queryable, line: LineRow): Promise<RemoveAddonQuote> {
  const paid = isPaid(line)
  const amount = round2(Number.parseFloat(line.price_at_purchase) * line.quantity)
  const insideTwentyFourHours = startsWithinRealHours(await sessionStart(db, line.booking_id), 24)
  return { lineId: line.id, bookingId: line.booking_id, paid, amount, insideTwentyFourHours, refund: paid && !insideTwentyFourHours ? amount : 0 }
}

/** The quote (the dialog's first call): reads only. Refused only as the removal would be for the line itself. */
export async function quoteRemoveAddon(db: Db, lineId: string): Promise<RemoveAddonQuote> {
  return quoteFor(db, lineToRemove(await readLine(db, lineId, false)))
}

/** The old function's choice: 'card' or 'credit' refunds a paid add-on; anything else removes it with no refund. */
const refundChoice = (sent: string): 'card' | 'credit' | 'none' => (sent === 'card' || sent === 'credit' ? sent : 'none')

/** The removal (the dialog's second call), with the refund staff confirmed (`confirmed.refund`). */
export async function removeAddon(db: Db, lineId: string, input: RemoveBookingAddonInput, options: RemoveAddonOptions): Promise<RemoveBookingAddonOutput> {
  const found = lineToRemove(await readLine(db, lineId, false))
  const choice = refundChoice(input.refund)
  const result = { notes: [] as string[], creditsReturned: 0, name: found.addon_name, count: 1 }
  const r1 = (tx: Tx, livemode: boolean | null): Promise<Started> => removeR1(tx, found, choice, input, options, livemode, result)
  const firstRefused = (detail: string): ApiError =>
    removeAddonRefusal('PAYMENT_FAILED', 'refund_failed', addonCardRefundFailedMessage(result.name, result.count, detail))
  const notSaved = (logDetail: string): ApiError => removeAddonRefusal('INTERNAL', 'addon_remove_not_saved', REMOVE_ADDON_NOT_SAVED_MESSAGE, { logDetail })
  const card = choice === 'card' && isPaid(found) && (input.confirmed?.refund ?? 0) > 0
  const output = await run(db, card, options, r1, firstRefused, notSaved)
  const cardRefunded = output.cardRefundedAmount
  const storeCredit = output.storeCreditRefundedAmount
  return {
    removed: true,
    summary: addonRemovalSummary({ count: 1, cardRefundedAmount: cardRefunded, storeCreditRefundedAmount: storeCredit, creditsReturned: result.creditsReturned }),
    cancelledLineIds: [lineId],
    refundedAmount: round2(cardRefunded + storeCredit),
    cardRefundedAmount: cardRefunded,
    storeCreditRefundedAmount: storeCredit,
    creditsReturned: result.creditsReturned,
    ...(output.storeCreditBalance !== undefined ? { storeCreditBalance: output.storeCreditBalance } : {}),
    notes: result.notes,
    ...(output.warning ? { warning: output.warning } : output.held ? { warning: output.held.message } : {}),
    ...(output.held ? { held: output.held } : {}),
  }
}

/** The removal's R1: see the file's header. `result` takes the notes and credits for the answer. */
async function removeR1(
  tx: Tx,
  found: LineRow,
  choice: 'card' | 'credit' | 'none',
  input: RemoveBookingAddonInput,
  options: RemoveAddonOptions,
  livemode: boolean | null,
  result: { notes: string[]; creditsReturned: number; name: string }
): Promise<Started> {
  // Rerun safely after a deadlock: the answer's notes start again.
  result.notes.length = 0
  result.creditsReturned = 0
  const bookingId = found.booking_id
  const credit = !isPaid(found)
  const loaded = await lockAndLoadBooking(tx, { bookingId, membershipIds: credit && found.redeemed_membership_id ? [found.redeemed_membership_id] : [] })
  if (!loaded) throw removeAddonRefusal('NOT_FOUND', 'line_not_found', REMOVE_ADDON_WORDS.lineNotFound)
  // Read again under the booking's lock: a second tab that waited for it finds the line removed already.
  const line = lineToRemove(await readLine(tx, found.id, true))
  // An add-on on a payment still being taken hasn't been paid for yet: a refund would give away money never collected.
  if (paymentOpen(loaded.booking)) throw paymentOpenRefusal(loaded.booking, removeAddonRefusal)
  if (await refundClaimOpen(tx, bookingId)) throw removeAddonRefusal('CONFLICT', 'refund_open', REFUND_OPEN_MESSAGE)
  const paid = isPaid(line)
  if (paid && choice !== 'none' && !options.canIssueRefunds) throw removeAddonRefusal('FORBIDDEN', 'no_refund_permission', ISSUE_REFUNDS_NEEDED_MESSAGE)

  const quote = await quoteFor(tx, line)
  const refund = choice === 'none' ? 0 : quote.refund
  const confirmed = input.confirmed?.refund
  // Q18: the refund staff were shown. Missing is £0 (the old dialog sent none, and nothing goes back then).
  if (differsByMoreThanHalfAPenny(typeof confirmed === 'number' && Number.isFinite(confirmed) ? confirmed : 0, refund)) {
    throw removeAddonRefusal('CONFLICT', 'refund_changed', REFUND_WORDS.figuresChanged, { addonQuote: quote })
  }

  // The claim: two staff can never refund the same line twice (the second finds it removed).
  await tx.query('UPDATE addon_order_lines SET removed_at = now(), removed_by = $1::uuid WHERE id = $2::uuid', [options.actor.id, line.id])
  const inside = quote.insideTwentyFourHours
  if (inside && ((choice !== 'none' && paid) || !paid)) result.notes.push(ADDON_INSIDE_24_HOURS_NOTE)

  const removedWithNothingBack = async (stamp: AddonLineStamp): Promise<Started> => {
    await stampAddonLines(tx, [stamp])
    await audit.recordAll(tx, [
      {
        actorType: 'staff',
        actorId: options.actor.id,
        action: ADDON_REMOVED,
        entityType: 'booking',
        entityId: bookingId,
        requestId: options.requestId,
        details: addonRemovedDetails([line.id], { refund: choice, amount: 0, cardRefunded: 0, storeCreditRefunded: 0, owed: 0, creditsReturned: result.creditsReturned }),
      },
    ])
    return { kind: 'done', output: { cardRefundedAmount: 0, storeCreditRefundedAmount: 0 } }
  }

  if (!paid) {
    if (inside || !line.redeemed_membership_id) return removedWithNothingBack({ id: line.id, refunded: 0, card: 0, method: 'none' })
    const released = await tx.query<{ id: string }>(
      `UPDATE customer_memberships
       SET addon_credits_remaining = addon_credits_remaining + $1::int, updated_at = now()
       WHERE id = $2::uuid AND subscription_status = 'active'
         AND (cancel_effective_date IS NULL OR cancel_effective_date >= (now() AT TIME ZONE 'Europe/London')::date)
       RETURNING id`,
      [line.quantity, line.redeemed_membership_id]
    )
    if (released.length === 0) {
      result.notes.push(addonMembershipNotActiveNote(line.addon_name))
      return removedWithNothingBack({ id: line.id, refunded: 0, card: 0, method: 'none' })
    }
    result.creditsReturned = line.quantity
    return removedWithNothingBack({ id: line.id, refunded: 0, card: 0, method: 'credit_returned' })
  }
  if (choice === 'none' || refund <= 0) return removedWithNothingBack({ id: line.id, refunded: 0, card: 0, method: 'none' })

  const lines = [{ id: line.id, amount: refund }]
  const plan = await planAddonRefund(tx, line.order_id, lines, choice)
  const addon: AddonClaim = { lines, described: `${line.quantity}× ${line.addon_name}`, names: line.addon_name, refund: choice }
  const claim = await writeClaim(
    tx,
    bookingId,
    {
      kind: 'remove_addon',
      amount: refund,
      pricePaidBefore: loaded.booking.pricePaid,
      method: choice,
      reason: null,
      worker: true,
      plan,
      livemode: plan.card.length > 0 ? livemode : null,
      addon,
    },
    options
  )
  if (plan.card.length > 0) return { kind: 'card', claim }
  const output = await finishClaimInTransaction(tx, claim, { went: [], owed: 0 }, { actor: options.actor, requestId: options.requestId, how: 'press' })
  if (!output) throw new Error(`Refund claim ${claim.id} was finished in its own transaction.`)
  return { kind: 'done', output }
}
