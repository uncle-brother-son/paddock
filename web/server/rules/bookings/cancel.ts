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
// refused: it and the rest owed on the cancelled booking (W26a). No clear answer: held (the booking stays cancelled);
// reconcile records what went and leaves what Stripe never received owed on the cancelled booking (W26b; Refund the
// rest to store credit, or It already arrived, run there since W25), never sending it again. Gift card and store
// credit money goes back as store credit, as before; cash back is Part refund's.
//
// W23a (Wayne, 13 Nov): when the club cancels (Block Session, Block Day: `clubCancelled`), the 24-hour rule doesn't
// apply. The whole booking comes back at any time before the session starts (Cancel & Refund: everything paid; Cancel &
// return credit: the credit, a pass session and add-on credits back, ticked paid add-ons refunded); after it starts, the
// club's cancel is refused (`session_already_started`). Money back still needs Issue refunds. The claim's `cancel`
// record and the cancel's own audit row carry `clubCancelled: true`. A cancel from the booking page keeps the rule.
//
// W33 (E-plan 4.11; Wayne's Q44, 15 Nov): the same R1 on the customer channel, for the website's cancel (the words and
// the answer's shape are server/rules/customer/cancels.ts). The signed-in customer cancels their own booking, whole:
// - which cancel it is comes from the booking (customerKindOf): a credit, pass or payment-needed booking is Cancel &
//   return credit (the credit back, a payment-needed booking simply cancelled); anything else is Cancel & Refund;
// - every add-on line still on the booking goes with it, and the method is always store credit: everything paid
//   (the seats, paid guests on a credit booking, paid add-ons; card, cash and gift card money alike) goes to store
//   credit, so there is never a card part, no Stripe client is made, and the claim is finished in R1's transaction;
// - the 24-hour rule as staff have it from the booking page (no club cancel); no Issue refunds, no reason; the total
//   the customer confirmed is required and checked (Q18);
// - refused: someone else's booking (as not found), a cancelled, finished or still-pending booking, and one with
//   card refund money still owed on it (Q39: that is staff's to settle);
// - the rows are the customer's (`actor_type` customer; `removed_by` and the store credit row's staff are null), and
//   the claim's `cancel` record and the cancel's own row carry `channel: 'customer'`.
//
// W33a (the W33 review; Wayne, 15 Nov), all on the customer channel only:
// - a private booking can be cancelled online like any other, 24 hours or more before: it is always a paid booking, so
//   it is Cancel & Refund to store credit (the whole tier price and every paid add-on), and its whole session is freed;
// - S1: a payment-needed booking keeps its exemption from the 24-hour rule only when nothing comes back. With money on
//   it (a paid guest, a paid add-on) it is refused inside 24 hours, and once the session has started the customer is
//   refused whatever the booking (customerTooLate);
// - S2: a pass booking that holds money which isn't recognised as its paid guests' would go through Cancel & Refund,
//   which never gives the pass session back: refused, and staff handle it (customerCannotCancel).
//
// W43 (F-plan 4.8; Wayne's Q48, 15 Nov; bugs FB18 and FB19): the same R1 on the system channel, for the lapse sweep
// (lapse-sweep.ts): a payment-needed booking past its deadline is cancelled, whole, as any lapsed booking.
// - Checked again under the booking's lock: still payment needed, its deadline passed (so Settle, a staff cancel or the
//   database's own sweep getting there first leaves nothing to do), no payment being taken and no refund being checked;
// - nothing paid: cancelled and its places released, as the database's sweep leaves it (the reason `membership_lapsed`
//   included), with every add-on line still on it removed;
// - money on it, 24 hours or more before the session: everything paid (the paid guests, paid add-ons) to store credit,
//   through the same claim as the customer's online cancel, and add-on credits back while the membership is active;
// - inside 24 hours, or the session started: cancelled with nothing back. The money is kept: the cancelled booking
//   keeps its price paid, and `booking.lapsed` says what was kept (`pricePaid`, `addonsKept`). No refund button takes
//   it from there (Part refund refuses every cancelled booking); goodwill is Adjust store credit (Wayne, 18 Nov);
// - W43a (the W43 review's S1): card refund money still owed on it (Q39) is never turned into store credit by the
//   system and never cleared by a lapse: it stays owed on the cancelled booking for staff (Refund the rest, It
//   already arrived). 24 hours or more before, the rest goes back as above: the price paid less what is owed, and
//   every paid add-on;
// - never a card part and never a Stripe call; the rows are the system's (`actor_type` system, no id; `removed_by` and
//   the store credit row's staff are null); the cancel's record and its own row carry `channel: 'system'` and what
//   the lapse decided, and `booking.lapsed` is written with every lapse.
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
import { audit, type AuditEntry } from '@/server/audit'
import type { Db, Queryable, Tx } from '@/server/db'
import { ApiError } from '@/server/http/errors'
import { CUSTOMER_CANCEL_WORDS } from '@/server/rules/customer/cancel-words'
import { PAYMENT_RETRY_HOLDS_LAPSE_MINUTES, RECENT_OPEN_RETRY_SQL } from '@/server/rules/memberships/retry-record'
import { staffIdOf, type ClaimActor, type SystemActor } from '@/server/rules/refunds/pipeline'
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
import { inC1, paymentOpenRefusal } from './money-in'
import { recordOrderPaymentStatus, withCashAndLine } from './money-left'
import { differsByMoreThanHalfAPenny } from '@/server/rules/orders/amounts'
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
  type LapseKept,
  type LapseRecord,
  type RefundOptions,
  type Started,
} from './refunds'

export type CancelKind = 'cancel' | 'cancel_credit'

const round2 = (n: number): number => Math.round(n * 100) / 100
const sum = (amounts: readonly number[]): number => round2(amounts.reduce((total, n) => total + n, 0))
/** Q18: half a penny either way passes. */
const confirmedAmount = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

export interface CancelOptions extends RefundOptions {
  /** Issue refunds: Cancel & return credit needs it when ticked paid add-ons are refunded (Cancel & Refund's route checks it). */
  canIssueRefunds: boolean
}

/** What R1 itself needs: who is cancelling (W33: a staff member, or the customer online; W43: the system) and Issue refunds. */
interface R1Options {
  actor: ClaimActor | SystemActor
  requestId: string
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
  /** W33: the customer is cancelling online (never with `club`): everything paid comes back, to store credit. */
  customer: boolean
  /** W43: the lapse sweep is cancelling (never with `club` or `customer`): `ruleApplies` is then "nothing comes back". */
  lapse: boolean
  ruleApplies: boolean
}

async function startCheckOf(db: Queryable, bookingId: string, club: boolean, customer = false): Promise<StartCheck> {
  const start = await sessionStartWallClock(db, bookingId)
  const inside = start !== null && startsWithinRealHours(start, 24)
  const started = start !== null && startsWithinRealHours(start, 0)
  return { inside, started, club, customer, lapse: false, ruleApplies: inside && !club }
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
 * W33 (Q44): so does the customer's own cancel online ("everything paid goes to store credit, including paid guests"):
 * `everythingBack` is the club's cancel or the customer's.
 */
const clubRefundsPaidGuests = (kind: CancelKind, booking: LoadedBooking, everythingBack: boolean): boolean => kind === 'cancel_credit' && everythingBack && paidGuestsOnACreditSeat(booking)

// --- W33: the customer channel's own checks

/**
 * W33 (Q44): which cancel a customer's online cancel is, from the booking alone. A credit, pass or payment-needed
 * booking is Cancel & return credit, unless it holds money of its own that isn't its paid guests' (then, as for staff,
 * that money is given back by Cancel & Refund). Anything else is Cancel & Refund.
 */
function customerKindOf(booking: LoadedBooking): CancelKind {
  const creditOrPaymentNeeded = CREDIT_SOURCES.has(booking.redemptionSource ?? '') || booking.status === 'payment_needed'
  if (!creditOrPaymentNeeded) return 'cancel'
  return booking.pricePaid > 0 && !paidGuestsOnACreditSeat(booking) ? 'cancel' : 'cancel_credit'
}

/** The statuses a customer can cancel online: a booking still to come (the 24-hour rule and the open-payment checks follow). */
const CUSTOMER_CANCELLABLE: ReadonlySet<string> = new Set(['confirmed', 'payment_needed'])

/** Someone else's booking is refused exactly as one that doesn't exist, so the answer never says it does. */
const notTheCustomers = (kind: CancelKind): ApiError => cancelRefusal(kind)('NOT_FOUND', 'booking_not_found', CUSTOMER_CANCEL_WORDS.bookingNotFound)

/**
 * W33: what the customer channel refuses before the staff checks run: a booking that isn't theirs, one already
 * cancelled, one still waiting for its first payment (`pending`: its price paid may not have been taken yet, so
 * nothing is given back on it online), one that is finished (completed, no-show), and one with card refund money
 * still owed on it (Q39: money a card refund should have given back is left for staff to settle, never turned into
 * store credit by the system, and Cancel & Refund would give it with the rest).
 * W33a (Wayne, 15 Nov): a private booking is no longer refused. W33a (review S2): a pass booking that customerKindOf
 * sends to Cancel & Refund is (money on it that isn't recognised as its paid guests': an older booking whose seats
 * have no price or pay-by). Cancel & Refund would give the money to store credit and lose the pass session, so the
 * customer is asked to get in touch. A membership credit booking in the same state is left: its credit comes back
 * by itself (it is counted from bookings that aren't cancelled).
 */
function customerCannotCancel(kind: CancelKind, booking: LoadedBooking, customerId: string): ApiError | null {
  const refuse = cancelRefusal(kind)
  if (booking.customerId !== customerId) return notTheCustomers(kind)
  if (booking.status === 'cancelled') return refuse('CONFLICT', 'already_cancelled', CUSTOMER_CANCEL_WORDS.alreadyCancelled)
  if (booking.status === 'pending') return refuse('CONFLICT', 'booking_pending', CUSTOMER_CANCEL_WORDS.paymentOpen)
  if (!CUSTOMER_CANCELLABLE.has(booking.status)) return refuse('CONFLICT', 'not_cancellable', CUSTOMER_CANCEL_WORDS.notCancellable)
  if (booking.refundOwed > 0) return refuse('CONFLICT', 'refund_owed', CUSTOMER_CANCEL_WORDS.refundOwed)
  if (booking.redemptionSource === 'session_pass_credit' && customerKindOf(booking) === 'cancel') return refuse('CONFLICT', 'pass_session_not_returned', CUSTOMER_CANCEL_WORDS.cannotCancelOnline)
  return null
}

/**
 * W33a (review S1; Q44: a customer gets money back only more than 24 hours before): the customer channel's own check
 * on the session's start, after the staff checks (which already refuse a confirmed booking inside 24 hours).
 * - Once the session has started, the customer is refused outright, a payment-needed booking included.
 * - A payment-needed booking is exempt from the 24-hour rule (its clock is the payment deadline) only when nothing
 *   comes back: inside 24 hours, one with money on it (its paid guests' price paid, or a paid add-on line) is refused.
 *   Without this, Cancel & return credit on the customer channel gave the paid guests' money to store credit at any
 *   time (W33's `everythingBack`).
 * Both with the 24-hour reason, so the customer is told the one thing: it is too late to cancel online.
 */
function customerTooLate(kind: CancelKind, booking: LoadedBooking, rows: readonly AddonRow[], at: StartCheck): ApiError | null {
  if (!at.customer) return null
  const moneyOnIt = booking.pricePaid > 0 || rows.some((row) => !isCreditLine(row) && lineAmount(row) > 0)
  if (at.started || (booking.status === 'payment_needed' && at.inside && moneyOnIt)) return cancelRefusal(kind)('CONFLICT', 'within_24_hours', WITHIN_24_HOURS_MESSAGE)
  return null
}

/** Every add-on line still on the booking, in line order: a customer's cancel takes them all. */
async function allAddonLineIds(db: Queryable, bookingId: string): Promise<string[]> {
  return (await db.query<{ id: string }>('SELECT id FROM addon_order_lines WHERE booking_id = $1::uuid AND removed_at IS NULL ORDER BY created_at, id', [bookingId])).map((row) => row.id)
}

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
  // W43: not at the booking's deadline either. The lapse sweep cancels it whatever is on it (Q48): the money goes to
  // store credit, or (inside 24 hours) is kept (lapsePlanOf).
  if (booking.pricePaid > 0 && !at.lapse) {
    if (!paidGuestsOnACreditSeat(booking)) return refuse('CONFLICT', 'money_paid', CANCEL_CREDIT_WORDS.moneyPaid)
    // W33 (Q44): nor when the customer cancels online: their paid guests' money goes to store credit with the cancel.
    if (!at.club && !at.customer) return refuse('CONFLICT', 'paid_guests_present', CANCEL_CREDIT_WORDS.paidGuestsPresent)
  }
  const tooLate = clubCancelTooLate('cancel_credit', at)
  if (tooLate) return tooLate
  // Payment-needed bookings are exempt: their clock is the payment deadline, not the session start.
  if (!paymentNeeded && at.ruleApplies) return refuse('CONFLICT', 'within_24_hours', WITHIN_24_HOURS_MESSAGE)
  return null
}

const refusalFor = (kind: CancelKind, db: Queryable, booking: LoadedBooking, at: StartCheck): Promise<ApiError | null> =>
  kind === 'cancel' ? cancelAndRefundRefusal(db, booking, at) : cancelCreditRefusal(db, booking, at)

// --- W43: the lapse sweep's own checks

/** W43: what the lapse sweep's cancel is, from the booking and where its session's start stands. */
export interface LapsePlan {
  kind: CancelKind
  /** Q48: what was paid comes back (to store credit). False: the booking is cancelled with nothing back. */
  back: boolean
  /** Why nothing comes back, when it doesn't. */
  kept: LapseKept | null
}

/**
 * W43 (Q48): 24 hours or more before the session, everything paid comes back as store credit, through the cancel the
 * customer's own would be (customerKindOf: Cancel & return credit, its paid guests refunded; Cancel & Refund when the
 * booking holds money that isn't its paid guests'). Inside 24 hours, or once the session has started, nothing comes
 * back: it is cancelled as Cancel & return credit with no money moved.
 * W43a (review S1): card refund money still owed on the booking (Q39) no longer decides the plan. Only the clock
 * does. What is owed is left out of what comes back (figuresFor) and stays owed on the cancelled booking.
 */
export function lapsePlanOf(booking: LoadedBooking, at: Pick<StartCheck, 'inside' | 'started'>): LapsePlan {
  const kept: LapseKept | null = at.started ? 'session_started' : at.inside ? 'inside_24_hours' : null
  if (kept) return { kind: 'cancel_credit', back: false, kept }
  return { kind: customerKindOf(booking), back: true, kept: null }
}

/** Under the booking's lock: it is still payment needed and its deadline has passed (the database sweep's own test). */
const LAPSE_DUE_SQL = "SELECT (status = 'payment_needed' AND payment_due_by <= now()) AS due FROM bookings WHERE id = $1::uuid"

/** The sweep's two refusals of its own. Nobody is shown them: they are the reason a booking was left, in the run's log. */
export const LAPSE_LEFT_WORDS = {
  notLapsed: 'The booking is no longer waiting for payment past its deadline.',
  // W47r-a (W47r review S2 b).
  paymentRetryHeld: "The membership's overdue payment was tried again from the desk in the last hour and hasn't been settled yet. The next run reads the booking again.",
  // Only a change to the cancel it would be, to whether money comes back, or to its add-on lines (W43a, review L1).
  bookingChanged: 'The booking changed while the sweep was reading it. The next run reads it again.',
} as const

/**
 * The cancel's one statement. The reason is the database sweep's own (`membership_lapsed`), so reports read the same.
 * W43a: a lapse has one statement only, and it never touches `refund_owed_amount` (what is owed stays owed).
 */
const CANCEL_BOOKING_SQL = {
  plain: "UPDATE bookings SET status = 'cancelled', cancelled_at = now(), updated_at = now() WHERE id = $1::uuid",
  owedCleared: "UPDATE bookings SET status = 'cancelled', cancelled_at = now(), refund_owed_amount = 0, updated_at = now() WHERE id = $1::uuid",
  lapsed: "UPDATE bookings SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'membership_lapsed', updated_at = now() WHERE id = $1::uuid",
} as const

/** W43: the lapse's own audit row, written with every lapse beside the cancel's (F-plan 4.11). */
export const BOOKING_LAPSED = 'booking.lapsed'

// --- The quote

/**
 * What cancelling gives back with these ticked lines: the figures both the quote and R1 work out. Inside 24 hours the
 * paid add-ons give nothing back (`ruleApplies`; never for the club's cancel, W23a).
 * W43a (review S1; Q39): `lapse`, the lapse sweep's cancel, gives the price paid less what is owed. Card refund money
 * owed is part of a live booking's price paid; the system never turns it into store credit, so it is left out here
 * and stays owed on the cancelled booking. Every other cancel gives the whole price paid, what is owed included.
 */
async function figuresFor(db: Queryable, kind: CancelKind, booking: LoadedBooking, rows: readonly AddonRow[], ruleApplies: boolean, paidRefunded: boolean, everythingBack: boolean, lapse = false) {
  // The booking's own money: Cancel & Refund's, and (W25) the paid guests' on the club's Cancel & return credit (W33: or the customer's).
  const seatMoney = kind === 'cancel' || clubRefundsPaidGuests(kind, booking, everythingBack)
  const refund = !seatMoney ? 0 : lapse ? Math.max(0, round2(booking.pricePaid - booking.refundOwed)) : round2(booking.pricePaid)
  const owed = seatMoney ? round2(booking.refundOwed) : 0
  const paidLines: AddonRefundLine[] =
    paidRefunded && !ruleApplies ? rows.filter((row) => !isCreditLine(row) && lineAmount(row) > 0).map((row) => ({ id: row.id, orderId: row.order_id, amount: lineAmount(row) })) : []
  return { refund, owed, paidLines, addonsRefund: sum(paidLines.map((line) => line.amount)) }
}

/**
 * W50 (brief item 12): `blocked` may be given as the read that finds it (the dialogs' quote), and `reads: 'together'`
 * then sends it with the quote's other two reads (where the card money can go, and the booking's paid line): none of
 * the three needs another's answer. Inside R1's transaction (one connection) they go one after another, as before.
 */
async function quoteFor(
  db: Queryable,
  kind: CancelKind,
  booking: LoadedBooking,
  rows: readonly AddonRow[],
  at: StartCheck,
  blockedOrItsRead: ApiError | null | (() => Promise<ApiError | null>),
  reads: 'in_turn' | 'together' = 'in_turn'
): Promise<CancelQuote> {
  const { refund, owed, paidLines, addonsRefund } = await figuresFor(db, kind, booking, rows, at.ruleApplies, true, at.club || at.customer)
  const readBlocked = async (): Promise<ApiError | null> => (typeof blockedOrItsRead === 'function' ? blockedOrItsRead() : blockedOrItsRead)
  const readPlan = () => planRefund(db, booking.id, refund, 'card', paidLines)
  const readFigures = () => withCashAndLine(db, booking.id, booking.figures)
  let blocked: ApiError | null
  let plan: Awaited<ReturnType<typeof planRefund>>
  let figures: Awaited<ReturnType<typeof withCashAndLine>>
  if (reads === 'together') {
    ;[blocked, plan, figures] = await Promise.all([readBlocked(), readPlan(), readFigures()])
  } else {
    blocked = await readBlocked()
    plan = await readPlan()
    figures = await readFigures()
  }
  const card = sum(plan.card.map((part) => part.amount))
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
/*
 * W50 (brief item 12; step D's close list: "the cancel-credit quote takes about 10 seconds"). The quote made its
 * reads one after another: 13 round trips to the database for a booking with a paid add-on. Which read depends on
 * which:
 *  - the booking (its row, its seats, its open flows, its money left), the ticked add-on lines and where the session
 *    start stands each need only the booking's id: sent together;
 *  - then what a press would be refused with, where the card money can go, and the paid line each need those answers
 *    but not each other's: sent together.
 * The same reads, the same statements and the same answer; only the waiting is shared. It is a read on the request's
 * own client (several connections), never inside a transaction. Both dialogs' quotes come through here (Cancel &
 * return credit, Cancel (payment needed) and Cancel & Refund). server/rules/bookings/cancel-quote-reads.test.ts
 * holds the count of reads, that they are the ones made before, and how many are waited for one after another.
 */
export async function quoteCancel(db: Db, kind: CancelKind, bookingId: string, addonLineIds: readonly string[] | undefined, clubCancelled = false): Promise<CancelQuote> {
  const [booking, rows, at] = await Promise.all([loadBooking(db, bookingId, 'together'), readAddonLines(db, bookingId, addonLineIds ?? [], false), startCheckOf(db, bookingId, clubCancelled)])
  if (!booking) throw cancelRefusal(kind)('NOT_FOUND', 'booking_not_found', kind === 'cancel' ? REFUND_WORDS.bookingNotFound : CANCEL_CREDIT_WORDS.bookingNotFound)
  return quoteFor(db, kind, booking, rows, at, () => refusalFor(kind, db, booking, at), 'together')
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
  /**
   * W33: the customer cancelling online (never with `clubCancelled`). Their own booking only, `kind` from
   * customerKindOf, `lineIds` every add-on line on the booking, `method` 'credit', and `total` what they confirmed
   * (the seat money and the add-ons' together: the website shows one figure).
   */
  customer?: { id: string; total: number }
  /**
   * W43: the lapse sweep cancelling (never with `clubCancelled` or `customer`). `kind` and `back` are lapsePlanOf's
   * from a read with no lock, `lineIds` every add-on line on the booking, `method` 'credit'. R1 checks all of it again
   * under the lock, and that the booking is still payment needed past its deadline.
   */
  lapse?: { back: boolean }
}

async function cancelR1(tx: Tx, input: R1Input, options: R1Options, livemode: boolean | null, result: R1Result): Promise<Started> {
  Object.assign(result, newResult())
  const { kind, bookingId, lineIds, method, customer, lapse } = input
  const refuse = cancelRefusal(kind)
  // The memberships the ticked credit add-ons go back to, read before the lock (a line's membership never changes), so
  // they are locked in LOCK_ORDER with the rest.
  const before = await readAddonLines(tx, bookingId, lineIds, false)
  const memberships = before.filter((row) => isCreditLine(row) && row.redeemed_membership_id).map((row) => row.redeemed_membership_id as string)
  const passId = kind === 'cancel_credit' ? ((await tx.query<{ id: string | null }>('SELECT redeemed_session_pass_id AS id FROM bookings WHERE id = $1::uuid', [bookingId]))[0]?.id ?? null) : null
  const loaded = await lockAndLoadBooking(tx, { bookingId, ownSession: true, membershipIds: memberships, sessionPassId: passId })
  if (!loaded) throw refuse('NOT_FOUND', 'booking_not_found', kind === 'cancel' ? REFUND_WORDS.bookingNotFound : CANCEL_CREDIT_WORDS.bookingNotFound)
  const { booking } = loaded
  if (customer) {
    // W33: the customer channel's own checks first (theirs, still to come, nothing owed), under the lock.
    const cannot = customerCannotCancel(kind, booking, customer.id)
    if (cannot) throw cannot
    // The kind and the add-on lines were read with no lock: a booking changed since (an add-on added, a guest paid
    // for) is refused whole, and the website asks for the quote again.
    const every = await allAddonLineIds(tx, bookingId)
    if (customerKindOf(booking) !== kind || every.length !== lineIds.length || every.some((id) => !lineIds.includes(id))) {
      throw refuse('CONFLICT', 'booking_changed', CUSTOMER_CANCEL_WORDS.bookingChanged)
    }
  }
  let at = await startCheckOf(tx, bookingId, input.clubCancelled, customer !== undefined)
  let lapsed: LapseRecord | null = null
  if (lapse) {
    // W43: under the lock, the booking is still the sweep's to cancel (Settle, a staff cancel or the database's own
    // sweep may have got there first), and it is still the cancel the sweep read it as.
    const due = (await tx.query<{ due: boolean | null }>(LAPSE_DUE_SQL, [bookingId]))[0]?.due === true
    if (!due) throw refuse('CONFLICT', 'not_lapsed', LAPSE_LEFT_WORDS.notLapsed)
    // W47r-a (W47r review S2 b): a credit booking whose membership's overdue payment was tried again from the desk
    // ("Try the payment again now") less than an hour ago, with that retry still open, is left: the payment may have
    // gone through with nothing recorded yet (its write failed, or its answer was lost), and marking the membership
    // paid gives back only bookings still waiting for payment, never one this sweep has cancelled. Asked under this
    // transaction's locks: a press writes its retry's first row under the customer's lock, which is held here. Only
    // for an hour (retry-record.ts): a retry that never ends must not keep unpaid bookings for ever.
    if (booking.redemptionSource === 'membership_credit' && booking.redeemedMembershipId) {
      const retried = await tx.query(RECENT_OPEN_RETRY_SQL, [booking.redeemedMembershipId, PAYMENT_RETRY_HOLDS_LAPSE_MINUTES])
      if (retried.length > 0) throw refuse('CONFLICT', 'payment_retry_held', LAPSE_LEFT_WORDS.paymentRetryHeld)
    }
    const plan = lapsePlanOf(booking, at)
    const every = await allAddonLineIds(tx, bookingId)
    if (plan.kind !== kind || plan.back !== lapse.back || every.length !== lineIds.length || every.some((id) => !lineIds.includes(id))) {
      throw refuse('CONFLICT', 'booking_changed', LAPSE_LEFT_WORDS.bookingChanged)
    }
    // Nothing comes back when the plan says so (inside 24 hours, or the session started).
    at = { ...at, lapse: true, ruleApplies: !plan.back }
    lapsed = { back: plan.back, kept: plan.kept, paymentDueBy: booking.paymentDueBy }
  }
  // Read again under the booking's lock: a second tab that waited for it finds them removed (and the booking cancelled).
  const rows = await readAddonLines(tx, bookingId, lineIds, true)
  const paidTicked = rows.some((row) => !isCreditLine(row))
  // W25: the club's cancel refunding paid guests moves money, and needs to know where it goes.
  // W43 (Q48): and the lapse sweep's, 24 hours or more before the session.
  const everythingBack = input.clubCancelled || customer !== undefined || lapse?.back === true
  const guestsRefunded = clubRefundsPaidGuests(kind, booking, everythingBack)
  // Inside 24 hours nothing comes back (only reachable on a payment-needed booking), unless the club is cancelling.
  const inside = at.ruleApplies
  const refused = (await refusalFor(kind, tx, booking, at)) ?? customerTooLate(kind, booking, rows, at)
  if (refused) throw refused
  // W58c (W58 review FL2): the two Issue refunds checks below come after the booking's own refusals (as W26a L1's
  // does), so a booking already cancelled in another tab says that, not "needs Issue refunds". Still before anything
  // is written or sent.
  // Cancel & return credit: refunding paid add-ons moves money, so Issue refunds first, as the old function checked it.
  if (kind === 'cancel_credit' && method && paidTicked && !options.canIssueRefunds) throw refuse('FORBIDDEN', 'no_refund_permission', ISSUE_REFUNDS_NEEDED_MESSAGE)
  // The club's cancel refunding paid guests (W25) moves money too.
  if (guestsRefunded && !options.canIssueRefunds) throw refuse('FORBIDDEN', 'no_refund_permission', ISSUE_REFUNDS_NEEDED_MESSAGE)
  // W26a (audit S6; Wayne, 14 Nov): inside 24 hours the club's cancel gives back what the rule would keep (the credit,
  // the pass session, the add-ons), and the flag comes from the screen, so it needs Issue refunds. Outside 24 hours
  // nothing changes, and a payment-needed booking (which the rule never covered) is as before. W58 (W26a review L1):
  // after the booking's own refusals, so a booking already cancelled in another tab says that, not "needs Issue
  // refunds". Still before anything is written or sent.
  if (input.clubCancelled && at.inside && booking.status !== 'payment_needed' && !options.canIssueRefunds) {
    throw refuse('FORBIDDEN', 'no_refund_permission', ISSUE_REFUNDS_NEEDED_MESSAGE)
  }
  if (guestsRefunded && method === null) throw refuse('CONFLICT', 'refund_method_required', PAID_GUESTS_REFUND_METHOD_MESSAGE)

  // Cancel & return credit leaves the paid lines alone without a method (the old includePaidLines).
  const claimed = rows.filter((row) => isCreditLine(row) || method !== null)
  const { refund, paidLines, addonsRefund } = await figuresFor(tx, kind, booking, claimed, inside, method !== null, everythingBack, lapse !== undefined)
  result.seatRefund = kind === 'cancel_credit' ? refund : 0
  // Q18: what staff confirmed, half a penny each way (missing counts as £0). W33: the customer confirms the one total.
  // W43: the sweep confirms no figure: it gives what the rule gives when it runs.
  const figuresChanged = lapse
    ? false
    : customer
    ? differsByMoreThanHalfAPenny(customer.total, round2(refund + addonsRefund))
    : differsByMoreThanHalfAPenny(input.confirmed.refund, refund) || differsByMoreThanHalfAPenny(input.confirmed.addonsRefund, addonsRefund)
  if (figuresChanged) {
    throw refuse('CONFLICT', 'refund_changed', REFUND_WORDS.figuresChanged, { cancelQuote: await quoteFor(tx, kind, booking, rows, at, null) })
  }
  if (claimed.length < lineIds.length && method !== null) result.notes.push(addonsAlreadyRemovedNote(lineIds.length - claimed.length))
  // With nothing left to give, only earlier refunds can make the lines refunded: read before any write.
  const allBackAlready = kind === 'cancel' && refund <= 0 ? await seatMoneyAllBack(tx, bookingId) : false

  // The cancel. Cancel & Refund gives what is owed too, so nothing stays owed; price_paid stays, as on every cancelled booking.
  // W25: so does the club's Cancel & return credit when it refunds paid guests (their money, what is owed included).
  // W43: a lapse also writes the database sweep's reason. W43a (review S1; Q39): and never clears what is owed. It
  // didn't give it (figuresFor), so it stays owed on the cancelled booking for staff.
  const owedCleared = !lapse && (kind === 'cancel' || guestsRefunded)
  await tx.query(lapse ? CANCEL_BOOKING_SQL.lapsed : owedCleared ? CANCEL_BOOKING_SQL.owedCleared : CANCEL_BOOKING_SQL.plain, [bookingId])
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
    // removed_by points at staff: null when the customer cancelled online (W33).
    await tx.query('UPDATE addon_order_lines SET removed_at = now(), removed_by = $1::uuid WHERE id = ANY($2::uuid[])', [staffIdOf(options.actor), claimed.map((row) => row.id)])
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
    ...(customer ? { channel: 'customer' as const } : {}),
    ...(lapsed ? { channel: 'system' as const, lapse: lapsed } : {}),
  }
  // W43: the lapse's own row, with what it gave. W43a (review S2): and what it kept or left. `addonsKept` is the paid
  // add-on lines removed with nothing back (price × quantity): that money is in no other figure here, since
  // `pricePaid` never holds add-on money. `refundOwed` is the card refund money left owed on the cancelled booking
  // (part of `pricePaid`), so the money a lapse kept is `pricePaid - refundOwed + addonsKept` when `back` is false.
  const addonsKept = sum(claimed.filter((row) => !isCreditLine(row) && !refunded.has(row.id)).map(lineAmount))
  const lapsedRow = (storeCreditRefunded: number): AuditEntry[] =>
    lapsed
      ? [
          {
            actorType: options.actor.type,
            actorId: options.actor.id,
            entityType: 'booking',
            entityId: bookingId,
            requestId: options.requestId,
            action: BOOKING_LAPSED,
            details: { ...lapsed, pricePaid: round2(booking.pricePaid), refundOwed: round2(booking.refundOwed), addonsKept, storeCreditRefunded, placesReleased },
          },
        ]
      : []
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
        actorType: options.actor.type,
        actorId: options.actor.id,
        entityType: 'booking',
        entityId: bookingId,
        requestId: options.requestId,
        ...cancelActionRow(kind, method, cancel, { cardRefunded: 0, storeCreditRefunded: 0, owed: 0 }),
      },
      ...lapsedRow(0),
    ])
    return { kind: 'done', output: { cardRefundedAmount: 0, storeCreditRefundedAmount: 0, ...(cancel.addons.length > 0 ? { addons: { cardRefundedAmount: 0, storeCreditRefundedAmount: 0 } } : {}) } }
  }

  const plan = await planRefund(tx, bookingId, refund, method, paidLines)
  // W33: nothing online ever goes back to a card. Thrown inside R1, so nothing of the cancel is kept.
  if (customer && plan.card.length > 0) throw new Error('A customer cancel planned a card refund.')
  // W43: nor does anything the lapse sweep gives.
  if (lapse && plan.card.length > 0) throw new Error('A lapse planned a card refund.')
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
      ...(customer ? { channel: 'customer' as const } : {}),
      ...(lapse ? { channel: 'system' as const } : {}),
    },
    options
  )
  result.sent = true
  if (plan.card.length > 0) return { kind: 'card', claim }
  const output = await finishClaimInTransaction(tx, claim, { went: [], owed: 0 }, by)
  if (!output) throw new Error(`Refund claim ${claim.id} was finished in its own transaction.`)
  await audit.recordAll(tx, lapsedRow(round2(output.storeCreditRefundedAmount + (output.addons?.storeCreditRefundedAmount ?? 0))))
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

// --- W33: the customer's own cancel online (Q44)

/** What the customer's cancel would give, as the staff quote has it, with which cancel it is. */
export interface CustomerCancelQuote {
  kind: CancelKind
  quote: CancelQuote
  /** The credit a credit or pass booking returns, when the cancel is Cancel & return credit on one. */
  returnsCredit: 'membership_credit' | 'session_pass_credit' | null
}

const creditReturnedBy = (kind: CancelKind, booking: LoadedBooking): CustomerCancelQuote['returnsCredit'] =>
  kind === 'cancel_credit' && (booking.redemptionSource === 'membership_credit' || booking.redemptionSource === 'session_pass_credit') ? booking.redemptionSource : null

/**
 * W33: the quote for the customer's own cancel. Reads only. Someone else's booking is not found; every other refusal
 * a press would meet now is in `quote.blocked` (the staff reason; the channel's words are cancels.ts's).
 */
export async function quoteCancelForCustomer(db: Db, bookingId: string, customerId: string): Promise<CustomerCancelQuote> {
  const booking = await loadBooking(db, bookingId)
  if (!booking || booking.customerId !== customerId) throw notTheCustomers('cancel')
  const kind = customerKindOf(booking)
  const rows = await readAddonLines(db, bookingId, await allAddonLineIds(db, bookingId), false)
  const at = await startCheckOf(db, bookingId, false, true)
  const blocked = customerCannotCancel(kind, booking, customerId) ?? (await refusalFor(kind, db, booking, at)) ?? customerTooLate(kind, booking, rows, at)
  return { kind, quote: await quoteFor(db, kind, booking, rows, at, blocked), returnsCredit: creditReturnedBy(kind, booking) }
}

/** What the customer's cancel did. */
export interface CustomerCancelled {
  kind: CancelKind
  /** Everything paid that went to store credit: the seats (paid guests among them) and the paid add-ons. */
  storeCreditRefunded: number
  storeCreditBalance?: number
  returnsCredit: CustomerCancelQuote['returnsCredit']
  /** The credit or pass session can be used again (its period, or the pass, still covers today). */
  creditUsableAgain: boolean
  /** Add-on credits given back to the membership. */
  addonCreditsReturned: number
}

/**
 * W33 (Q44): the customer cancels their own booking online, whole, with the total they confirmed. One transaction
 * (R1, which finishes its own claim): the method is store credit, so there is no card part, no Stripe client is made
 * and nothing can be held. Every refusal is an ApiError with the staff reason; cancels.ts gives it the customer's words.
 */
export async function cancelForCustomer(db: Db, bookingId: string, customer: { id: string; total: number }, requestId: string): Promise<CustomerCancelled> {
  // Whose it is, which cancel, and its add-on lines, from a read with no lock; R1 checks all three again under the lock.
  const booking = await loadBooking(db, bookingId)
  if (!booking || booking.customerId !== customer.id) throw notTheCustomers('cancel')
  const kind = customerKindOf(booking)
  const result = newResult()
  const input: R1Input = {
    kind,
    bookingId,
    lineIds: await allAddonLineIds(db, bookingId),
    method: 'credit',
    confirmed: { refund: 0, addonsRefund: 0 },
    clubCancelled: false,
    customer,
  }
  // No staff permission is involved: by rule the money can only go to the customer's own store credit.
  const options: R1Options = { actor: { type: 'customer', id: customer.id }, requestId, canIssueRefunds: true }
  const started = await inC1(db, (tx) => cancelR1(tx, input, options, null, result), notSavedFor(kind))
  if (started.kind !== 'done') throw new Error('A customer cancel was not finished in its own transaction.')
  const { output } = started
  const balances = [output.storeCreditBalance, output.addons?.storeCreditBalance].filter((balance): balance is number => balance !== undefined)
  return {
    kind,
    storeCreditRefunded: round2(output.storeCreditRefundedAmount + (output.addons?.storeCreditRefundedAmount ?? 0)),
    // The seat money and the add-ons' are two store credit rows, each answering the balance after it: both add to
    // it, so the balance after the cancel is the higher of the two.
    ...(balances.length > 0 ? { storeCreditBalance: Math.max(...balances) } : {}),
    returnsCredit: creditReturnedBy(kind, booking),
    creditUsableAgain: result.creditUsableAgain,
    addonCreditsReturned: result.addons.reduce((total, line) => total + line.creditsReturned, 0),
  }
}

// --- W43: the lapse sweep's cancel (Q48)

/** What the sweep did with one booking. */
export type LapseOutcome =
  | {
      outcome: 'lapsed'
      kind: CancelKind
      back: boolean
      kept: LapseKept | null
      /** Everything paid that went to store credit: the seats (paid guests among them) and the paid add-ons. */
      storeCreditRefunded: number
      addonCreditsReturned: number
    }
  /**
   * Not cancelled, with the refusal's reason: no longer due, a payment being taken, a refund being checked, or
   * (`booking_changed`) a different cancel, a different answer to "does money come back", or different add-on lines
   * than the read saw. The next run reads it again.
   */
  | { outcome: 'left'; reason: string }

/**
 * W43 (F-plan 4.8; Q48): the lapse sweep cancels one payment-needed booking past its deadline. One transaction (R1,
 * which finishes its own claim): the method is store credit, so there is no card part, no Stripe client is made and
 * nothing can be held. A refusal (an ApiError) is answered as `left`; anything else is thrown, with nothing kept.
 */
export async function lapseBooking(db: Db, bookingId: string, requestId: string): Promise<LapseOutcome> {
  // Which cancel it is, and its add-on lines, from a read with no lock; R1 checks both again under the lock.
  const booking = await loadBooking(db, bookingId)
  if (!booking || booking.status !== 'payment_needed') return { outcome: 'left', reason: 'not_lapsed' }
  const plan = lapsePlanOf(booking, await startCheckOf(db, bookingId, false))
  const result = newResult()
  const input: R1Input = {
    kind: plan.kind,
    bookingId,
    lineIds: await allAddonLineIds(db, bookingId),
    method: 'credit',
    confirmed: { refund: 0, addonsRefund: 0 },
    clubCancelled: false,
    lapse: { back: plan.back },
  }
  // No staff permission is involved: by rule the money can only go to the customer's own store credit.
  const options: R1Options = { actor: { type: 'system', id: null }, requestId, canIssueRefunds: true }
  let started: Started
  try {
    started = await inC1(db, (tx) => cancelR1(tx, input, options, null, result), notSavedFor(plan.kind))
  } catch (err) {
    const reason = err instanceof ApiError ? (err.details as { reason?: string } | undefined)?.reason : undefined
    // A database fault (`cancel_not_saved`) is not a reason to leave the booking quietly: the sweep logs it as failed.
    if (reason === undefined || reason === 'cancel_not_saved') throw err
    return { outcome: 'left', reason }
  }
  if (started.kind !== 'done') throw new Error('A lapse was not finished in its own transaction.')
  const { output } = started
  return {
    outcome: 'lapsed',
    kind: plan.kind,
    back: plan.back,
    kept: plan.kept,
    storeCreditRefunded: round2(output.storeCreditRefundedAmount + (output.addons?.storeCreditRefundedAmount ?? 0)),
    addonCreditsReturned: result.addons.reduce((total, line) => total + line.creditsReturned, 0),
  }
}
