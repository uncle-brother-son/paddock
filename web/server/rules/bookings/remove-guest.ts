// New in W22 (D-plan 1.5, 4.3, 4.7, 4.8; brief W22 item 1): removeBookingGuest on the Worker, through W21's refund
// pipeline (refunds.ts). Two calls, as before: the quote (a read: what removing the guest gives back), then the removal
// with the amount staff confirmed.
//
// R1 is one transaction: the booking locked (LOCK_ORDER: booking, customer, its session), the guest read again under
// the lock, the old checks in the old order, the confirmed amount (Q18: half a penny either way, where the old code
// allowed a penny), then the guest deleted, a public place released, the party size lowered and price_paid lowered by
// the refund, the refund planned and the claim written (`booking.refund_claimed`, kind `remove_guest`). Deleting the
// guest is the claim (W02 finding 11): a second tab waits for the lock, then finds the guest gone and refunds nothing.
// With no card part, R1 also gives the store credit and finishes the claim (R2 in the same transaction), stamping the
// guest's line. With card parts, each is sent once under `<claimId>:refund:<orderId>`, then R2.
// - The first card part refused: R1 undone (the guest back as they were, with their place and money), old words.
// - A later part refused: it and the rest to store credit (today's rule).
// - No clear answer: held; the guest stays removed, and reconcile records what went and puts what never went on the
//   booking as owed (Refund the rest), never sending it again (Q35).
// Private guests have no seat price, so removing one never refunds (Wayne's Q38: Part refund for a tier drop), nor do
// credit and pre-band seats. Issue refunds only when money goes back.
// W22a (Wayne's decision, 13 Nov): the 24-hour rule, as Cancel & Refund and Remove add-on. Inside 24 real hours of the
// session (startsWithinRealHours, the add-on's check) the guest is removed with nothing back: the quote is £0, the
// place is still released, no claim, no Issue refunds needed, and `booking.guest_remove` names the reason. Part refund
// gives something back if staff want to.
import 'server-only'
import type { ApiErrorCode, RemoveGuestInput, RemoveGuestOutput, RemoveGuestQuote } from '@/contracts'
import { audit } from '@/server/audit'
import type { Db, Queryable, Tx } from '@/server/db'
import { ApiError } from '@/server/http/errors'
import {
  AMOUNT_CHANGED_MESSAGE,
  cardRefundFailedMessage,
  REFUND_OPEN_MESSAGE,
  REMOVE_GUEST_NOT_SAVED_MESSAGE,
  removeGuestRefundFailedMessage,
  staffSees,
} from './failure-messages'
import { startsWithinRealHours } from '@/server/rules/time/london-time'
import { loadBooking, lockAndLoadBooking, paymentOpen, sessionStartWallClock, type LoadedBooking } from './load-booking'
import { paymentOpenRefusal } from './money-in'
import {
  finishClaimInTransaction,
  GUEST_REMOVED,
  guestRemovedDetails,
  planRefund,
  refundClaimOpen,
  run,
  stampRemovedGuestLine,
  writeClaim,
  type ClaimDetails,
  type GuestClaim,
  type RefundOptions,
  type Started,
} from './refunds'

const round2 = (n: number): number => Math.round(n * 100) / 100
/** Q18 (W02 finding 12): half a penny either way passes; the old code allowed a penny. */
const differsByMoreThanHalfAPenny = (a: number, b: number): boolean => Math.round(Math.abs(a - b) * 1e6) / 1e6 > 0.005

export interface RemoveGuestOptions extends RefundOptions {
  /** The signed-in staff member's Issue refunds switch (checked only when money goes back, as before). */
  canIssueRefunds: boolean
}

/** W22a: `booking.guest_remove`'s reason when a paid seat gave nothing back because the session is inside 24 hours. */
export const GUEST_REMOVED_INSIDE_24_HOURS = 'inside_24_hours'

type RemoveGuestRefusalExtras = { quote?: RemoveGuestQuote; blockedByRefundPermission?: boolean; logDetail?: string }

/**
 * A refusal before anything changed: the old reason, and the old function's words when it sent some (else the
 * dialog's own words for the reason, marked `screenWords` so the wrapper leaves them out as the old answer did).
 */
export function removeGuestRefusal(code: ApiErrorCode, reason: string, message: string | undefined, extras: RemoveGuestRefusalExtras = {}): ApiError {
  const words = message ?? staffSees('remove_guest', reason)
  return new ApiError(code, words, {
    ...(extras.logDetail ? { logDetail: extras.logDetail } : {}),
    details: {
      reason,
      message: words,
      action: 'remove_guest',
      ...(message === undefined ? { screenWords: true } : {}),
      ...(extras.quote ? { quote: extras.quote } : {}),
      ...(extras.blockedByRefundPermission ? { blockedByRefundPermission: true } : {}),
    },
  })
}

interface GuestRow {
  id: string
  booking_id: string
  guest_type: string
  guest_name: string
  unit_price: string | null
  pay_by: string | null
}

const GUEST_SQL = 'SELECT id, booking_id, guest_type, guest_name, unit_price::text AS unit_price, pay_by FROM booking_guests WHERE id = $1::uuid'

async function readGuest(db: Queryable, guestId: string, lock: boolean): Promise<GuestRow | null> {
  return (await db.query<GuestRow>(lock ? `${GUEST_SQL} FOR UPDATE` : GUEST_SQL, [guestId]))[0] ?? null
}

/** W22a: inside 24 real hours of the booking's session (the add-on's check, on the same wall-clock start). */
async function insideTwentyFourHoursOf(db: Queryable, bookingId: string): Promise<boolean> {
  const start = await sessionStartWallClock(db, bookingId)
  return start !== null && startsWithinRealHours(start, 24)
}

/**
 * What removing the guest gives back, as the old quote: the seat's stored price, stopped at what is left on the
 * booking (price paid less money owed, which isn't this seat's); £0 for a seat not paid with money (credit, a pre-band
 * row with no price) and for any private seat (Q38); W22a: £0 inside 24 hours of the session (Wayne's decision).
 */
function quoteFor(
  booking: LoadedBooking,
  guest: GuestRow,
  insideTwentyFourHours: boolean
): RemoveGuestQuote & { seatPrice: number | null; withheldInside24Hours: number } {
  const bookingType = booking.session.bookingType === 'private' ? 'private' : 'public'
  const seatPrice = guest.unit_price === null ? null : Number.parseFloat(guest.unit_price)
  const refundable = guest.pay_by === 'paid' && seatPrice !== null && bookingType === 'public'
  const moneyLeft = booking.pricePaid - booking.refundOwed
  const seatMoney = refundable && seatPrice !== null ? round2(Math.min(seatPrice, Math.max(moneyLeft, 0))) : 0
  // What the 24-hour rule keeps back (£0 when the seat's money had all gone back already: then the old rule applies).
  const withheldInside24Hours = insideTwentyFourHours ? seatMoney : 0
  const refundAmount = insideTwentyFourHours ? 0 : seatMoney
  return { bookingId: booking.id, bookingType, refundAmount, refundable, insideTwentyFourHours, partySize: booking.partySize, seatPrice, withheldInside24Hours }
}

/** The quote as the dialog has it (the seat's price and what the 24-hour rule kept back stay inside the rule). */
const publicQuote = (quote: RemoveGuestQuote): RemoveGuestQuote => ({
  bookingId: quote.bookingId,
  bookingType: quote.bookingType,
  refundAmount: quote.refundAmount,
  refundable: quote.refundable,
  insideTwentyFourHours: quote.insideTwentyFourHours,
  partySize: quote.partySize,
})

/** The old function's first checks after the account holder's (answered as data): the guest, the booking. */
function bookingToRemoveFrom(guest: GuestRow | null, booking: LoadedBooking | null): LoadedBooking {
  if (!guest) throw removeGuestRefusal('NOT_FOUND', 'guest_not_found', undefined)
  if (!booking) throw removeGuestRefusal('NOT_FOUND', 'booking_not_found', undefined)
  if (booking.status === 'cancelled') throw removeGuestRefusal('CONFLICT', 'booking_cancelled', undefined)
  return booking
}

/** The quote (the dialog's first call): reads only, never refused for an open payment or a held refund (as before). */
export async function quoteRemoveGuest(db: Db, guestId: string): Promise<RemoveGuestOutput> {
  const guest = await readGuest(db, guestId, false)
  if (guest?.guest_type === 'account_holder') return { removed: false, blocked: true, guestId }
  const booking = bookingToRemoveFrom(guest, guest ? await loadBooking(db, guest.booking_id) : null)
  const inside = await insideTwentyFourHoursOf(db, booking.id)
  return { removed: false, blocked: false, guestId, quote: publicQuote(quoteFor(booking, guest as GuestRow, inside)) }
}

/** The removal (the dialog's second call), with the refund staff confirmed. */
export async function removeGuest(db: Db, guestId: string, input: RemoveGuestInput, options: RemoveGuestOptions): Promise<RemoveGuestOutput> {
  // The booking is the lock (LOCK_ORDER), so it is found first; the guest is read again under it.
  const found = await readGuest(db, guestId, false)
  if (!found) throw removeGuestRefusal('NOT_FOUND', 'guest_not_found', undefined)
  if (found.guest_type === 'account_holder') return { removed: false, blocked: true, guestId }
  if (input.confirmedRefundAmount === undefined || input.confirmedRefundAmount === null) return quoteRemoveGuest(db, guestId)
  const confirmed = input.confirmedRefundAmount
  const method = input.refundMethod === 'card' || input.refundMethod === 'credit' ? input.refundMethod : null

  const r1 = (tx: Tx, livemode: boolean | null): Promise<Started> => removeR1(tx, found.booking_id, guestId, confirmed, method, options, livemode)
  const firstRefused = (detail: string): ApiError => {
    const given = cardRefundFailedMessage(detail)
    return removeGuestRefusal('PAYMENT_FAILED', `refund_failed: ${given}`, removeGuestRefundFailedMessage(given, ''))
  }
  const notSaved = (logDetail: string): ApiError => removeGuestRefusal('INTERNAL', 'guest_remove_not_saved', REMOVE_GUEST_NOT_SAVED_MESSAGE, { logDetail })
  const card = method === 'card' && confirmed > 0
  const output = await run(db, card, options, () => Promise.resolve(r1), firstRefused, notSaved)
  const cardRefunded = output.cardRefundedAmount
  const storeCredit = output.storeCreditRefundedAmount
  return {
    removed: true,
    blocked: false,
    guestId,
    refundedAmount: round2(cardRefunded + storeCredit),
    cardRefundedAmount: cardRefunded,
    storeCreditRefundedAmount: storeCredit,
    ...(output.storeCreditBalance !== undefined ? { storeCreditBalance: output.storeCreditBalance } : {}),
    ...(output.warning ? { warning: output.warning } : {}),
    ...(output.held ? { held: output.held } : {}),
  }
}

/** The removal's R1: see the file's header. The guest was an additional guest when it was found (a type never changes). */
async function removeR1(
  tx: Tx,
  bookingId: string,
  guestId: string,
  confirmed: number,
  method: 'card' | 'credit' | null,
  options: RemoveGuestOptions,
  livemode: boolean | null
): Promise<Started> {
  const loaded = await lockAndLoadBooking(tx, { bookingId, ownSession: true })
  // Read again under the booking's lock: a second tab that waited for it finds the guest gone (W02 finding 11).
  const locked = await readGuest(tx, guestId, true)
  const guest = locked && locked.booking_id === bookingId ? locked : null
  const booking = bookingToRemoveFrom(guest, loaded?.booking ?? null)
  if (!guest) throw removeGuestRefusal('NOT_FOUND', 'guest_not_found', undefined)
  if (paymentOpen(booking)) throw paymentOpenRefusal(booking, removeGuestRefusal)
  // A refund on the booking still held (no clear answer yet): no other refund, nor a removal, until reconcile settles it.
  if (await refundClaimOpen(tx, bookingId)) throw removeGuestRefusal('CONFLICT', 'refund_open', REFUND_OPEN_MESSAGE)
  const full = quoteFor(booking, guest, await insideTwentyFourHoursOf(tx, bookingId))
  const quote = publicQuote(full)
  if (full.refundable && confirmed > 0 && !options.canIssueRefunds) {
    throw removeGuestRefusal('FORBIDDEN', 'no_refund_permission', undefined, { blockedByRefundPermission: true })
  }
  // Not only for a refundable seat: one that stopped being refundable would otherwise be removed with nothing back.
  if (typeof confirmed !== 'number' || !Number.isFinite(confirmed) || differsByMoreThanHalfAPenny(confirmed, quote.refundAmount)) {
    throw removeGuestRefusal('CONFLICT', 'refund_amount_mismatch', AMOUNT_CHANGED_MESSAGE, { quote })
  }
  if (full.refundable && confirmed > 0 && !method) throw removeGuestRefusal('VALIDATION', 'refund_method_required', undefined, { quote })

  const give = quote.refundAmount
  const plan = give > 0 && method ? await planRefund(tx, bookingId, give, method) : null
  // With card parts the guest's row is kept in the claim, so the undo after a refused first part puts it back as it was.
  const restore =
    plan && plan.card.length > 0
      ? ((await tx.query<{ row: Record<string, unknown> }>('SELECT to_jsonb(g) AS row FROM booking_guests g WHERE g.id = $1::uuid', [guestId]))[0]?.row ?? null)
      : null
  const placeReleased = quote.bookingType === 'public'
  await tx.query('DELETE FROM booking_guests WHERE id = $1::uuid', [guestId])
  if (placeReleased) {
    await tx.query('UPDATE sessions SET total_booked = GREATEST(total_booked - 1, 0), updated_at = now() WHERE id = $1::uuid', [booking.sessionId])
  }
  await tx.query('UPDATE bookings SET party_size = GREATEST(party_size - 1, 1), price_paid = price_paid - $1::numeric, updated_at = now() WHERE id = $2::uuid', [give, bookingId])

  if (!plan || !method) {
    // Nothing goes back (a credit, pre-band or private seat, nothing left on the booking, or inside 24 hours): no
    // claim, as before. A paid seat's line is still stamped when its money had all gone back already
    // (stampRemovedGuestLine); when the 24-hour rule kept its money on the booking, its line is not stamped.
    const insideRule = full.withheldInside24Hours > 0
    if (full.refundable && !insideRule && full.seatPrice !== null) await stampRemovedGuestLine(tx, bookingId, full.seatPrice)
    await audit.recordAll(tx, [
      {
        actorType: 'staff',
        actorId: options.actor.id,
        action: GUEST_REMOVED,
        entityType: 'booking',
        entityId: bookingId,
        requestId: options.requestId,
        details: {
          ...guestRemovedDetails(guestId, { refundAmount: 0, method: null, cardRefunded: 0, storeCreditRefunded: 0, owed: 0 }),
          ...(insideRule ? { reason: GUEST_REMOVED_INSIDE_24_HOURS } : {}),
        },
      },
    ])
    return { kind: 'done', output: { cardRefundedAmount: 0, storeCreditRefundedAmount: 0 } }
  }

  const guestClaim: GuestClaim = {
    id: guestId,
    name: guest.guest_name,
    seatPrice: full.seatPrice ?? give,
    placeReleased,
    ...(restore ? { restore } : {}),
  }
  const details: ClaimDetails = {
    kind: 'remove_guest',
    amount: give,
    pricePaidBefore: booking.pricePaid,
    method,
    reason: null,
    worker: true,
    plan,
    livemode: plan.card.length > 0 ? livemode : null,
    guest: guestClaim,
  }
  const claim = await writeClaim(tx, bookingId, details, options)
  if (plan.card.length > 0) return { kind: 'card', claim }
  const output = await finishClaimInTransaction(tx, claim, { went: [], extraToStoreCredit: 0, owed: 0 }, { actor: options.actor, requestId: options.requestId, how: 'press' })
  if (!output) throw new Error(`Refund claim ${claim.id} was finished in its own transaction.`)
  return { kind: 'done', output }
}
