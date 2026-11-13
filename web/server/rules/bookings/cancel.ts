// New in W23 (D-plan 1.6, 1.7, 3 N4/N5, 4.3, 4.7, 4.8; brief W23 items 2 to 4): refundBooking's Cancel & Refund and
// cancelCreditBooking (Cancel & return credit, Cancel on a payment-needed booking) on the Worker, through W21's refund
// pipeline (refunds.ts). Each has a quote (a read: what cancelling gives back, and what a press would be refused with
// now), then the press with the figures staff confirmed (Q18: half a penny each; the old functions took none).
//
// R1 is one transaction: the booking locked (LOCK_ORDER: booking, customer, its session, the pass a credit goes back
// to, the memberships ticked add-on credits go back to), the ticked add-on lines read again under the lock, the old
// checks in the old order (a payment still being taken and a Worker refund still being checked refuse every press),
// then everything the cancel changes:
// - the booking cancelled (Cancel & Refund also clears what is owed: it gives that back too); its places given back to
//   the session (a private booking's whole session, a public one's party);
// - Cancel & return credit: a session pass's session given back while the pass is unexpired, and whether the credit
//   can be used again (N4: the old function did these in separate statements after the cancel);
// - the ticked add-on lines claimed (removed_at): credit lines give their credits back to the membership while it is
//   active, paid lines are refunded (Cancel & Refund always, with its method; Cancel & return credit when staff chose
//   card or store credit, with Issue refunds), and inside 24 hours nothing comes back (only reachable on a payment-needed
//   booking, which is exempt from the 24-hour rule itself);
// - the refund planned: the seat money (Cancel & Refund: price paid, money owed included, so the booking ends with
//   nothing owed) and the paid add-ons in ONE plan, one card part per order (item 1), the rest to store credit, and the
//   claim written (`booking.refund_claimed`, kind `cancel` or `cancel_credit`). With no card part, R2 runs in the same
//   transaction; with no money at all, there is no claim and R1 writes the cancel's own row.
// With card parts, each is sent once under `<claimId>:refund:<orderId>`, then R2. The first part refused: R1 undone
// exactly (the booking back to its status with its places, pass session, credits and add-on lines). A later part
// refused: it and the rest to store credit. No clear answer: held (the booking stays cancelled); reconcile records what
// went and gives what Stripe never received as store credit (a cancelled booking has no Refund the rest), never
// sending it again. Gift card and store credit money goes back as store credit, as before; cash back is Part refund's.
//
// W23a (Wayne, 13 Nov): when the club cancels (Block Session, Block Day: `clubCancelled`), the 24-hour rule doesn't
// apply. The whole booking comes back at any time before the session starts (Cancel & Refund: everything paid; Cancel &
// return credit: the credit, a pass session and add-on credits back, ticked paid add-ons refunded); after it starts, the
// club's cancel is refused (`session_already_started`). Money back still needs Issue refunds. The claim's `cancel`
// record and the cancel's own audit row carry `clubCancelled: true`. A cancel from the booking page keeps the rule.
import 'server-only'
import type {
  ApiErrorCode,
  CancelAddonsOutcome,
  CancelAndRefundInput,
  CancelAndRefundOutput,
  CancelCreditBookingInput,
  CancelCreditBookingOutput,
  CancelQuote,
  RefundBookingOutput,
} from '@/contracts'
import { audit } from '@/server/audit'
import type { Db, Queryable, Tx } from '@/server/db'
import { ApiError } from '@/server/http/errors'
import { startsWithinRealHours } from '@/server/rules/time/london-time'
import {
  ADDON_INSIDE_24_HOURS_NOTE,
  addonMembershipNotActiveNote,
  addonRemovalSummary,
  addonsAlreadyRemovedNote,
  CANCEL_CREDIT_WORDS,
  CANCEL_NOT_SAVED_MESSAGE,
  cancelCreditAddonRefundFailedMessage,
  cancelCreditGuestRefundFailedMessage,
  PAID_GUESTS_REFUND_METHOD_MESSAGE,
  ISSUE_REFUNDS_NEEDED_MESSAGE,
  notCancellableMessage,
  REFUND_METHOD_WORDS,
  REFUND_OPEN_MESSAGE,
  REFUND_WORDS,
  CLUB_CANCEL_SESSION_STARTED_MESSAGE,
  WITHIN_24_HOURS_MESSAGE,
} from './failure-messages'
import { loadBooking, lockAndLoadBooking, paymentOpen, sessionStartWallClock, type LoadedBooking } from './load-booking'
import { paymentOpenRefusal } from './money-in'
import { recordOrderPaymentStatus, withCashAndLine } from './money-left'
import {
  cancelActionRow,
  finishClaimInTransaction,
  planRefund,
  refundClaimOpen,
  run,
  seatMoneyAllBack,
  stampAddonLines,
  stampCancelledBookingLines,
  stampLinesIfSeatMoneyAllBack,
  writeClaim,
  type AddonLineStamp,
  type AddonRefundLine,
  type CancelAddonLine,
  type CancelClaim,
  type RefundOptions,
  type Started,
} from './refunds'

export type CancelKind = 'cancel' | 'cancel_credit'

const round2 = (n: number): number => Math.round(n * 100) / 100
const sum = (amounts: readonly number[]): number => round2(amounts.reduce((total, n) => total + n, 0))
/** Q18: half a penny either way passes. */
const differsByMoreThanHalfAPenny = (a: number, b: number): boolean => Math.round(Math.abs(a - b) * 1e6) / 1e6 > 0.005
const confirmedAmount = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

export interface CancelOptions extends RefundOptions {
  /** Issue refunds: Cancel & return credit needs it when ticked paid add-ons are refunded (Cancel & Refund's route checks it). */
  canIssueRefunds: boolean
}

type CancelRefusalExtras = { cancelQuote?: CancelQuote; logDetail?: string; field?: string }

/** A refusal before anything changed (or after a refused first card part put everything back): the old reason and words. */
function cancelRefusal(kind: CancelKind) {
  return (code: ApiErrorCode, reason: string, message: string | undefined, extras: CancelRefusalExtras = {}): ApiError => {
    const words = message ?? (kind === 'cancel' ? REFUND_WORDS.couldNotRefund : 'Failed to cancel the booking.')
    return new ApiError(code, words, {
      ...(extras.logDetail ? { logDetail: extras.logDetail } : {}),
      ...(extras.field ? { field: extras.field } : {}),
      details: { reason, message: words, action: kind === 'cancel' ? 'cancel_and_refund' : 'cancel_credit', ...(extras.cancelQuote ? { cancelQuote: extras.cancelQuote } : {}) },
    })
  }
}

// --- The ticked add-on lines

interface AddonRow {
  id: string
  order_id: string | null
  quantity: number
  price_at_purchase: string
  redemption_source: string | null
  redeemed_membership_id: string | null
  addon_name: string
  refunded_amount: string
  card_refunded_amount: string
  refund_method: string | null
}

const ADDON_LINES_SQL = `
SELECT aol.id, aol.order_id, aol.quantity, aol.price_at_purchase::text AS price_at_purchase, aol.redemption_source,
       aol.redeemed_membership_id, a.name AS addon_name, aol.refunded_amount::text AS refunded_amount,
       aol.card_refunded_amount::text AS card_refunded_amount, aol.refund_method
FROM addon_order_lines aol
JOIN addons a ON a.id = aol.addon_id
WHERE aol.booking_id = $1::uuid AND aol.id = ANY($2::uuid[]) AND aol.removed_at IS NULL
ORDER BY aol.created_at, aol.id`

/** The ticked lines still on this booking, in line order (`lock`: under R1's locks, so a second tab finds them gone). */
async function readAddonLines(db: Queryable, bookingId: string, lineIds: readonly string[], lock: boolean): Promise<AddonRow[]> {
  if (lineIds.length === 0) return []
  return db.query<AddonRow>(lock ? `${ADDON_LINES_SQL} FOR UPDATE OF aol` : ADDON_LINES_SQL, [bookingId, [...lineIds]])
}

const isCreditLine = (row: AddonRow): boolean => row.redemption_source === 'membership_credit'
const lineAmount = (row: AddonRow): number => round2(Number.parseFloat(row.price_at_purchase) * row.quantity)

/**
 * Where the booking's session start stands: `inside` 24 hours of it (or past it), and `started`. W23a: the 24-hour rule
 * (`ruleApplies`) is off for the club's cancel, which is refused only once the session has started.
 */
interface StartCheck {
  inside: boolean
  started: boolean
  club: boolean
  ruleApplies: boolean
}

async function startCheckOf(db: Queryable, bookingId: string, club: boolean): Promise<StartCheck> {
  const start = await sessionStartWallClock(db, bookingId)
  const inside = start !== null && startsWithinRealHours(start, 24)
  const started = start !== null && startsWithinRealHours(start, 0)
  return { inside, started, club, ruleApplies: inside && !club }
}

/** W23a: the club's cancel after its session started (the club gives everything back only before then). */
const clubCancelTooLate = (kind: CancelKind, at: StartCheck): ApiError | null =>
  at.club && at.started ? cancelRefusal(kind)('CONFLICT', 'session_already_started', CLUB_CANCEL_SESSION_STARTED_MESSAGE) : null

// --- The checks (the quote's `blocked`, and R1's refusals), in the old functions' order

/** Cancel & Refund's checks after the booking is found (refundBooking, then cancelAndRefundBooking). */
async function cancelAndRefundRefusal(db: Queryable, booking: LoadedBooking, at: StartCheck): Promise<ApiError | null> {
  const refuse = cancelRefusal('cancel')
  if (paymentOpen(booking)) return paymentOpenRefusal(booking, refuse)
  if (await refundClaimOpen(db, booking.id)) return refuse('CONFLICT', 'refund_open', REFUND_OPEN_MESSAGE)
  if (booking.status === 'cancelled') return refuse('CONFLICT', 'already_cancelled', REFUND_WORDS.alreadyCancelled)
  const tooLate = clubCancelTooLate('cancel', at)
  if (tooLate) return tooLate
  if (at.ruleApplies) return refuse('CONFLICT', 'within_24_hours', WITHIN_24_HOURS_MESSAGE)
  return null
}

const CREDIT_SOURCES: ReadonlySet<string> = new Set(['membership_credit', 'session_pass_credit'])

/** A credit booking whose money is its paid guests' (seat 1 is covered by the credit): "remove paid guests first". */
function paidGuestsOnACreditSeat(booking: LoadedBooking): boolean {
  if (!(booking.pricePaid > 0)) return false
  const seat1 = booking.seats[0]
  const seat1CreditCovered = booking.creditPeriodId !== null || seat1?.payBy === 'membership_credit' || seat1?.payBy === 'session_pass_credit'
  return seat1CreditCovered && booking.seats.some((seat) => seat.guestType === 'additional_guest' && (seat.unitPrice ?? 0) > 0)
}

/**
 * W25 (W23a "for later"; Wayne, 13 Nov: when the club cancels, everything comes back): the club's Cancel & return
 * credit on a credit booking with paid guests refunds those guests in full (the booking's price paid, which is theirs
 * alone), instead of refusing until they are removed one by one (Remove Guest gives £0 inside 24 hours).
 */
const clubRefundsPaidGuests = (kind: CancelKind, booking: LoadedBooking, club: boolean): boolean => kind === 'cancel_credit' && club && paidGuestsOnACreditSeat(booking)

/** Cancel & return credit's checks after the booking is found (cancelCreditBooking's, in its order). */
async function cancelCreditRefusal(db: Queryable, booking: LoadedBooking, at: StartCheck): Promise<ApiError | null> {
  const refuse = cancelRefusal('cancel_credit')
  const paymentNeeded = booking.status === 'payment_needed'
  if (!paymentNeeded && !CREDIT_SOURCES.has(booking.redemptionSource ?? '')) return refuse('CONFLICT', 'not_credit_booking', CANCEL_CREDIT_WORDS.notCreditBooking)
  if (booking.status !== 'confirmed' && booking.status !== 'pending' && !paymentNeeded) {
    return refuse('CONFLICT', 'not_cancellable', notCancellableMessage(booking.status))
  }
  // A reader tap on this booking would still go through after the cancel, and charge for add-ons on a booking that has gone.
  if (paymentOpen(booking)) return paymentOpenRefusal(booking, refuse)
  if (await refundClaimOpen(db, booking.id)) return refuse('CONFLICT', 'refund_open', REFUND_OPEN_MESSAGE)
  // A money payment must be refunded, not dropped: only when seat 1 itself is credit-covered and the money is from paid
  // guests does "remove guests first" apply (N5: a pass booking with paid guests now shows this button and these words).
  // W25: not when the club is cancelling: its cancel refunds the paid guests itself (clubRefundsPaidGuests).
  if (booking.pricePaid > 0) {
    if (!paidGuestsOnACreditSeat(booking)) return refuse('CONFLICT', 'money_paid', CANCEL_CREDIT_WORDS.moneyPaid)
    if (!at.club) return refuse('CONFLICT', 'paid_guests_present', CANCEL_CREDIT_WORDS.paidGuestsPresent)
  }
  const tooLate = clubCancelTooLate('cancel_credit', at)
  if (tooLate) return tooLate
  // Payment-needed bookings are exempt: their clock is the payment deadline, not the session start.
  if (!paymentNeeded && at.ruleApplies) return refuse('CONFLICT', 'within_24_hours', WITHIN_24_HOURS_MESSAGE)
  return null
}

const refusalFor = (kind: CancelKind, db: Queryable, booking: LoadedBooking, at: StartCheck): Promise<ApiError | null> =>
  kind === 'cancel' ? cancelAndRefundRefusal(db, booking, at) : cancelCreditRefusal(db, booking, at)

// --- The quote

/**
 * What cancelling gives back with these ticked lines: the figures both the quote and R1 work out. Inside 24 hours the
 * paid add-ons give nothing back (`ruleApplies`; never for the club's cancel, W23a).
 */
async function figuresFor(db: Queryable, kind: CancelKind, booking: LoadedBooking, rows: readonly AddonRow[], ruleApplies: boolean, paidRefunded: boolean, club: boolean) {
  // The booking's own money: Cancel & Refund's, and (W25) the paid guests' on the club's Cancel & return credit.
  const seatMoney = kind === 'cancel' || clubRefundsPaidGuests(kind, booking, club)
  const refund = seatMoney ? round2(booking.pricePaid) : 0
  const owed = seatMoney ? round2(booking.refundOwed) : 0
  const paidLines: AddonRefundLine[] =
    paidRefunded && !ruleApplies ? rows.filter((row) => !isCreditLine(row) && lineAmount(row) > 0).map((row) => ({ id: row.id, orderId: row.order_id, amount: lineAmount(row) })) : []
  return { refund, owed, paidLines, addonsRefund: sum(paidLines.map((line) => line.amount)) }
}

async function quoteFor(db: Queryable, kind: CancelKind, booking: LoadedBooking, rows: readonly AddonRow[], at: StartCheck, blocked: ApiError | null): Promise<CancelQuote> {
  const { refund, owed, paidLines, addonsRefund } = await figuresFor(db, kind, booking, rows, at.ruleApplies, true, at.club)
  const plan = await planRefund(db, booking.id, refund, 'card', paidLines)
  const card = sum(plan.card.map((part) => part.amount))
  const figures = await withCashAndLine(db, booking.id, booking.figures)
  const details = blocked?.details as { reason?: string; message?: string } | undefined
  return {
    bookingId: booking.id,
    status: booking.status,
    refund,
    owed,
    addonsRefund,
    addonLineIds: rows.map((row) => row.id),
    parts: { card, storeCredit: round2(refund + addonsRefund - card) },
    cardRefundAvailable: card > 0,
    insideTwentyFourHours: at.inside,
    paidLine: figures.paidLine,
    blocked: blocked ? { reason: details?.reason ?? 'refused', message: details?.message ?? blocked.message } : null,
  }
}

/**
 * The quote (each dialog's first call, and again when the ticks change): reads only, never refused for a payment
 * still being taken or a refund still being checked (`blocked` says so, with the words). Refused only for a missing
 * booking. `addonLineIds` missing: none ticked, as the press reads it. W23a: `clubCancelled` (Block Session, Block Day)
 * shows the whole amount inside 24 hours too (`insideTwentyFourHours` still says where the session stands).
 */
export async function quoteCancel(db: Db, kind: CancelKind, bookingId: string, addonLineIds: readonly string[] | undefined, clubCancelled = false): Promise<CancelQuote> {
  const booking = await loadBooking(db, bookingId)
  if (!booking) throw cancelRefusal(kind)('NOT_FOUND', 'booking_not_found', kind === 'cancel' ? REFUND_WORDS.bookingNotFound : CANCEL_CREDIT_WORDS.bookingNotFound)
  const rows = await readAddonLines(db, bookingId, addonLineIds ?? [], false)
  const at = await startCheckOf(db, bookingId, clubCancelled)
  return quoteFor(db, kind, booking, rows, at, await refusalFor(kind, db, booking, at))
}

// --- R1

/** What R1 found and did, for the answer (the notes, the credits, the lines claimed). Reset when R1 runs again. */
interface R1Result {
  notes: string[]
  addons: CancelAddonLine[]
  sent: boolean
  creditUsableAgain: boolean
  bookingStatus: string
  /** W25: the booking's own money a Cancel & return credit gives back (the club's cancel with paid guests). */
  seatRefund: number
}

const newResult = (): R1Result => ({ notes: [], addons: [], sent: false, creditUsableAgain: false, bookingStatus: 'cancelled', seatRefund: 0 })

interface R1Input {
  kind: CancelKind
  bookingId: string
  lineIds: string[]
  /** Paid lines' refund: Cancel & Refund's method; Cancel & return credit's addonRefund (null: paid lines left alone). */
  method: 'card' | 'credit' | null
  confirmed: { refund: number; addonsRefund: number }
  /** W23a: the club is cancelling (Block Session, Block Day): no 24-hour rule, refused once the session has started. */
  clubCancelled: boolean
}

async function cancelR1(tx: Tx, input: R1Input, options: CancelOptions, livemode: boolean | null, result: R1Result): Promise<Started> {
  Object.assign(result, newResult())
  const { kind, bookingId, lineIds, method } = input
  const refuse = cancelRefusal(kind)
  // The memberships the ticked credit add-ons go back to, read before the lock (a line's membership never changes), so
  // they are locked in LOCK_ORDER with the rest.
  const before = await readAddonLines(tx, bookingId, lineIds, false)
  const memberships = before.filter((row) => isCreditLine(row) && row.redeemed_membership_id).map((row) => row.redeemed_membership_id as string)
  const passId = kind === 'cancel_credit' ? ((await tx.query<{ id: string | null }>('SELECT redeemed_session_pass_id AS id FROM bookings WHERE id = $1::uuid', [bookingId]))[0]?.id ?? null) : null
  const loaded = await lockAndLoadBooking(tx, { bookingId, ownSession: true, membershipIds: memberships, sessionPassId: passId })
  if (!loaded) throw refuse('NOT_FOUND', 'booking_not_found', kind === 'cancel' ? REFUND_WORDS.bookingNotFound : CANCEL_CREDIT_WORDS.bookingNotFound)
  const { booking } = loaded
  // Read again under the booking's lock: a second tab that waited for it finds them removed (and the booking cancelled).
  const rows = await readAddonLines(tx, bookingId, lineIds, true)
  const paidTicked = rows.some((row) => !isCreditLine(row))
  // Cancel & return credit: refunding paid add-ons moves money, so Issue refunds first, as the old function checked it.
  if (kind === 'cancel_credit' && method && paidTicked && !options.canIssueRefunds) throw refuse('FORBIDDEN', 'no_refund_permission', ISSUE_REFUNDS_NEEDED_MESSAGE)
  // W25: the club's cancel refunding paid guests moves money too, and needs to know where it goes.
  const guestsRefunded = clubRefundsPaidGuests(kind, booking, input.clubCancelled)
  if (guestsRefunded && !options.canIssueRefunds) throw refuse('FORBIDDEN', 'no_refund_permission', ISSUE_REFUNDS_NEEDED_MESSAGE)
  const at = await startCheckOf(tx, bookingId, input.clubCancelled)
  // Inside 24 hours nothing comes back (only reachable on a payment-needed booking), unless the club is cancelling.
  const inside = at.ruleApplies
  const refused = await refusalFor(kind, tx, booking, at)
  if (refused) throw refused
  if (guestsRefunded && method === null) throw refuse('CONFLICT', 'refund_method_required', PAID_GUESTS_REFUND_METHOD_MESSAGE)

  // Cancel & return credit leaves the paid lines alone without a method (the old includePaidLines).
  const claimed = rows.filter((row) => isCreditLine(row) || method !== null)
  const { refund, paidLines, addonsRefund } = await figuresFor(tx, kind, booking, claimed, inside, method !== null, input.clubCancelled)
  result.seatRefund = kind === 'cancel_credit' ? refund : 0
  // Q18: what staff confirmed, half a penny each way (missing counts as £0).
  if (differsByMoreThanHalfAPenny(input.confirmed.refund, refund) || differsByMoreThanHalfAPenny(input.confirmed.addonsRefund, addonsRefund)) {
    throw refuse('CONFLICT', 'refund_changed', REFUND_WORDS.figuresChanged, { cancelQuote: await quoteFor(tx, kind, booking, rows, at, null) })
  }
  if (claimed.length < lineIds.length && method !== null) result.notes.push(addonsAlreadyRemovedNote(lineIds.length - claimed.length))
  // With nothing left to give, only earlier refunds can make the lines refunded: read before any write.
  const allBackAlready = kind === 'cancel' && refund <= 0 ? await seatMoneyAllBack(tx, bookingId) : false

  // The cancel. Cancel & Refund gives what is owed too, so nothing stays owed; price_paid stays, as on every cancelled booking.
  // W25: so does the club's Cancel & return credit when it refunds paid guests (their money, what is owed included).
  await tx.query(
    kind === 'cancel' || guestsRefunded
      ? "UPDATE bookings SET status = 'cancelled', cancelled_at = now(), refund_owed_amount = 0, updated_at = now() WHERE id = $1::uuid"
      : "UPDATE bookings SET status = 'cancelled', cancelled_at = now(), updated_at = now() WHERE id = $1::uuid",
    [bookingId]
  )
  // Its places: a private booking holds the whole session; a public one its party.
  const totalBefore = booking.session.totalBooked
  const totalAfter = (
    await tx.query<{ total_booked: number }>(
      'UPDATE sessions SET total_booked = CASE WHEN $1::boolean THEN 0 ELSE GREATEST(total_booked - $2::int, 0) END, updated_at = now() WHERE id = $3::uuid RETURNING total_booked',
      [booking.session.bookingType === 'private', booking.partySize, booking.sessionId]
    )
  )[0]?.total_booked
  const placesReleased = Math.max(0, totalBefore - Number(totalAfter ?? totalBefore))

  // Cancel & return credit: the credit. A membership credit needs no write (its use is counted from bookings that aren't
  // cancelled) and is usable again only while its period still covers today; a pass's session goes back while the pass
  // is unexpired (an expired pass's credit is lost).
  let passReturned: string | null = null
  if (kind === 'cancel_credit') {
    if (booking.redemptionSource === 'membership_credit') {
      const period = (
        await tx.query<{ usable: boolean }>(
          `SELECT (mcc.is_unlimited IS TRUE OR mcc.period_end >= (now() AT TIME ZONE 'Europe/London')::date) AS usable
           FROM membership_current_credits mcc WHERE mcc.period_id = $1::uuid`,
          [booking.creditPeriodId]
        )
      )[0]
      result.creditUsableAgain = period?.usable === true
    } else if (booking.redemptionSource === 'session_pass_credit' && booking.redeemedSessionPassId) {
      passReturned =
        (
          await tx.query<{ id: string }>(
            `UPDATE customer_session_passes SET sessions_remaining = sessions_remaining + 1, updated_at = now()
             WHERE id = $1::uuid AND expiry_date >= (now() AT TIME ZONE 'Europe/London')::date RETURNING id`,
            [booking.redeemedSessionPassId]
          )
        )[0]?.id ?? null
      result.creditUsableAgain = passReturned !== null
    }
  }

  // The ticked add-on lines: claimed, then credits back (while the membership is active), or nothing inside 24 hours.
  if (claimed.length > 0) {
    await tx.query('UPDATE addon_order_lines SET removed_at = now(), removed_by = $1::uuid WHERE id = ANY($2::uuid[])', [options.actor.id, claimed.map((row) => row.id)])
  }
  const creditLines = claimed.filter(isCreditLine)
  if (inside && ((method !== null && claimed.some((row) => !isCreditLine(row))) || creditLines.length > 0)) result.notes.push(ADDON_INSIDE_24_HOURS_NOTE)
  const refunded = new Set(paidLines.map((line) => line.id))
  const stamps: AddonLineStamp[] = []
  for (const row of claimed) {
    const line: CancelAddonLine = {
      id: row.id,
      orderId: row.order_id,
      paid: refunded.has(row.id),
      amount: refunded.has(row.id) ? lineAmount(row) : 0,
      described: `${row.quantity}× ${row.addon_name}`,
      name: row.addon_name,
      creditsReturned: 0,
      membershipId: isCreditLine(row) ? row.redeemed_membership_id : null,
      stamp: null,
      was: { refunded: row.refunded_amount, card: row.card_refunded_amount, method: row.refund_method },
    }
    if (isCreditLine(row) && !inside && row.redeemed_membership_id) {
      const back = await tx.query<{ id: string }>(
        `UPDATE customer_memberships
         SET addon_credits_remaining = addon_credits_remaining + $1::int, updated_at = now()
         WHERE id = $2::uuid AND subscription_status = 'active'
           AND (cancel_effective_date IS NULL OR cancel_effective_date >= (now() AT TIME ZONE 'Europe/London')::date)
         RETURNING id`,
        [row.quantity, row.redeemed_membership_id]
      )
      if (back.length > 0) {
        line.creditsReturned = row.quantity
        line.stamp = 'credit_returned'
      } else {
        result.notes.push(addonMembershipNotActiveNote(row.addon_name))
        line.stamp = 'none'
      }
    } else if (!line.paid) {
      line.stamp = 'none'
    }
    if (line.stamp) stamps.push({ id: line.id, refunded: 0, card: 0, method: line.stamp })
    result.addons.push(line)
  }
  await stampAddonLines(tx, stamps)

  const cancel: CancelClaim = {
    status: booking.status,
    cancelledAt: booking.cancelledAt,
    refundOwed: booking.refundOwed,
    sessionId: booking.sessionId,
    placesReleased,
    passReturned,
    seatAmount: refund,
    allBackAlready,
    addons: result.addons,
    addonRefund: method !== null && paidLines.length > 0 ? method : kind === 'cancel' ? method : null,
    ...(kind === 'cancel_credit' ? { creditUsableAgain: result.creditUsableAgain } : {}),
    ...(input.clubCancelled ? { clubCancelled: true as const } : {}),
  }
  const total = round2(refund + addonsRefund)
  const by = { actor: options.actor, requestId: options.requestId, how: 'press' as const }

  if (total <= 0 || !method) {
    // Nothing goes back: no claim. The lines are stamped as the old functions stamped them, the orders' status worked
    // out again, and the cancel's own row written.
    const recount = new Set<string>()
    if (kind === 'cancel') {
      await stampCancelledBookingLines(tx, bookingId, allBackAlready)
      const orders = await tx.query<{ order_id: string }>("SELECT DISTINCT order_id FROM order_line_items WHERE booking_id = $1::uuid AND item_type = 'booking'", [bookingId])
      for (const row of orders) recount.add(row.order_id)
    } else {
      for (const orderId of await stampLinesIfSeatMoneyAllBack(tx, bookingId)) recount.add(orderId)
    }
    for (const orderId of recount) await recordOrderPaymentStatus(tx, orderId)
    await audit.recordAll(tx, [
      {
        actorType: 'staff',
        actorId: options.actor.id,
        entityType: 'booking',
        entityId: bookingId,
        requestId: options.requestId,
        ...cancelActionRow(kind, method, cancel, { cardRefunded: 0, storeCreditRefunded: 0, owed: 0 }),
      },
    ])
    return { kind: 'done', output: { cardRefundedAmount: 0, storeCreditRefundedAmount: 0, ...(cancel.addons.length > 0 ? { addons: { cardRefundedAmount: 0, storeCreditRefundedAmount: 0 } } : {}) } }
  }

  const plan = await planRefund(tx, bookingId, refund, method, paidLines)
  const claim = await writeClaim(
    tx,
    bookingId,
    {
      kind,
      amount: total,
      pricePaidBefore: booking.pricePaid,
      method,
      reason: null,
      worker: true,
      plan,
      livemode: plan.card.length > 0 ? livemode : null,
      cancel,
    },
    options
  )
  result.sent = true
  if (plan.card.length > 0) return { kind: 'card', claim }
  const output = await finishClaimInTransaction(tx, claim, { went: [], extraToStoreCredit: 0, owed: 0 }, by)
  if (!output) throw new Error(`Refund claim ${claim.id} was finished in its own transaction.`)
  return { kind: 'done', output }
}

// --- The two presses

/** The ticked add-ons' outcome in the old shape (cancelBookingAddonLines' result and its summary). */
function addonsOutcome(result: R1Result, output: RefundBookingOutput): CancelAddonsOutcome {
  const card = output.addons?.cardRefundedAmount ?? 0
  const storeCredit = output.addons?.storeCreditRefundedAmount ?? 0
  const creditsReturned = result.addons.reduce((total, line) => total + line.creditsReturned, 0)
  const cancelledLineIds = result.addons.map((line) => line.id)
  return {
    cancelledLineIds,
    refundedAmount: round2(card + storeCredit),
    cardRefundedAmount: card,
    storeCreditRefundedAmount: storeCredit,
    creditsReturned,
    ...(output.addons?.storeCreditBalance !== undefined ? { storeCreditBalance: output.addons.storeCreditBalance } : {}),
    notes: result.notes,
    summary: addonRemovalSummary({ count: cancelledLineIds.length, cardRefundedAmount: card, storeCreditRefundedAmount: storeCredit, creditsReturned }),
  }
}

const notSavedFor = (kind: CancelKind) => (logDetail: string): ApiError => cancelRefusal(kind)('INTERNAL', 'cancel_not_saved', CANCEL_NOT_SAVED_MESSAGE, { logDetail })

/**
 * Cancel & Refund (refundBooking without an amount), with the figures staff confirmed. Issue refunds (the route).
 */
export async function cancelAndRefund(db: Db, bookingId: string, input: CancelAndRefundInput, options: CancelOptions): Promise<CancelAndRefundOutput> {
  const method = input.refundMethod
  if (method !== 'card' && method !== 'credit') throw cancelRefusal('cancel')('VALIDATION', 'refund_method_invalid', REFUND_METHOD_WORDS, { field: 'refundMethod' })
  const result = newResult()
  const r1Input: R1Input = {
    kind: 'cancel',
    bookingId,
    lineIds: [...new Set(input.addonLineIds ?? [])],
    method,
    confirmed: { refund: confirmedAmount(input.confirmed?.refund), addonsRefund: confirmedAmount(input.confirmed?.addonsRefund) },
    clubCancelled: input.clubCancelled === true,
  }
  const card = method === 'card' && r1Input.confirmed.refund + r1Input.confirmed.addonsRefund > 0
  const output = await run(db, card, options, (tx, livemode) => cancelR1(tx, r1Input, options, livemode, result), undefined, notSavedFor('cancel'))
  return {
    cancelled: true,
    cardRefundedAmount: output.cardRefundedAmount,
    storeCreditRefundedAmount: output.storeCreditRefundedAmount,
    ...(output.storeCreditBalance !== undefined ? { storeCreditBalance: output.storeCreditBalance } : {}),
    ...(r1Input.lineIds.length > 0 ? { addons: addonsOutcome(result, output) } : {}),
    ...(output.warning ? { warning: output.warning } : {}),
    ...(output.held ? { held: output.held } : {}),
  }
}

/**
 * Cancel & return credit, and Cancel on a payment-needed booking (cancelCreditBooking), with the add-ons' figure staff
 * confirmed. One transaction (N4); paid add-ons refunded through the pipeline when staff chose card or store credit.
 */
export async function cancelCredit(db: Db, bookingId: string, input: CancelCreditBookingInput, options: CancelOptions): Promise<CancelCreditBookingOutput> {
  const method = input.addonRefund === 'card' || input.addonRefund === 'credit' ? input.addonRefund : null
  const result = newResult()
  const r1Input: R1Input = {
    kind: 'cancel_credit',
    bookingId,
    lineIds: [...new Set(input.addonLineIds ?? [])],
    method,
    // W25: `refund` is the paid guests' money on the club's cancel; £0 (or missing) on every other.
    confirmed: { refund: confirmedAmount(input.confirmed?.refund), addonsRefund: confirmedAmount(input.confirmed?.addonsRefund) },
    clubCancelled: input.clubCancelled === true,
  }
  const firstRefused = (detail: string): ApiError => {
    const names = result.addons.filter((line) => line.paid).map((line) => line.name).join(', ')
    const words = result.seatRefund > 0 ? cancelCreditGuestRefundFailedMessage(detail) : cancelCreditAddonRefundFailedMessage(names, detail)
    return cancelRefusal('cancel_credit')('PAYMENT_FAILED', 'refund_failed', words)
  }
  const card = method === 'card' && r1Input.confirmed.addonsRefund + r1Input.confirmed.refund > 0
  const output = await run(db, card, options, (tx, livemode) => cancelR1(tx, r1Input, options, livemode, result), firstRefused, notSavedFor('cancel_credit'))
  const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
  return {
    cancelled: true,
    creditUsableAgain: result.creditUsableAgain,
    booking: { id: bookingId, status: result.bookingStatus },
    ...(reason ? { message: reason } : {}),
    // W25: the paid guests' money the club's cancel gave back.
    ...(result.seatRefund > 0
      ? {
          cardRefundedAmount: output.cardRefundedAmount,
          storeCreditRefundedAmount: output.storeCreditRefundedAmount,
          ...(output.storeCreditBalance !== undefined ? { storeCreditBalance: output.storeCreditBalance } : {}),
        }
      : {}),
    ...(r1Input.lineIds.length > 0 ? { addons: addonsOutcome(result, output) } : {}),
    ...(output.warning ? { warning: output.warning } : {}),
    ...(output.held ? { held: output.held } : {}),
  }
}
