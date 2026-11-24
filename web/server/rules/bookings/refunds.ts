// New in W21 (D-plan 1.6, 4.3, 4.7, 4.8, 4.10): the refund pipeline, and refundBooking's three amount actions on the
// Worker (Part refund, Refund the rest, It already arrived). Cancel & Refund stays on the old body until W23; Remove
// Guest, Remove add-on and a cheaper Move use this pipeline from W22 and W24.
//
// R1 is one transaction with no Stripe call: the booking locked (LOCK_ORDER: booking, then its customer), Issue
// refunds checked by the route, the figures (money-left.ts, the same ones the dialogs show), the confirmed amount (Q18,
// half a penny either way, with the old words and the new figures), the claim (price_paid lowered; a part refund also
// counted in part_refunded_amount, Q27/Q28; Refund the rest lowers what is owed), the plan (the card parts: the
// booking's orders newest first, each capped at its card portion and its booking line's net, as giveBookingMoneyBack
// did; the store credit; Q26's cash) and the claim's row (`booking.refund_claimed`, the plan in its details: the record
// every key comes from, lead call L3). With no card part, R1 also gives the store credit (or records the cash handed
// over) and finishes the claim: one transaction, nothing held.
//
// With card parts, R1 commits, then the press sends each part once, keyed `<claimId>:refund:<orderId>` with
// `metadata.claim_id`, then R2 (one transaction): each part recorded on its booking line, the rest to store credit, the
// orders' status worked out again, the claim finished (`booking.refund_finished`).
// - The first part refused (nothing went): R1 undone in one transaction, with the old words.
// - W26a (Wayne, 14 Nov): a card part Stripe refused is never given as store credit unseen, because the refusal may
//   mean the customer has the money already (refunded in Stripe's dashboard, or disputed). The refusal is marked on the
//   claim first (`booking.refund_refused`). A first refusal whose undo fails for any reason, and a later part refused
//   (it and every part after it), end as money owed on the booking, live or cancelled, with Stripe's reason in the
//   words: a person checks Stripe, then uses It already arrived or Refund the rest. Reconcile reads the mark, so a
//   claim the press couldn't finish ends the same way.
// - No clear answer: the claim is held (Q35's refund words). No press ever sends it again: reconcile lists the refunds
//   on each planned PaymentIntent, matches `metadata.claim_id`, and runs R2 with what it found; a part Stripe never
//   received ends as money owed on the booking (Refund the rest), never resent (D-plan 4.10). W26b (Wayne, 14 Nov):
//   on a cancelled booking too (it used to be given as store credit there), for Refund the rest (store credit only
//   there) or It already arrived.
// - A later part the press had no time left to send (W21a, W21 review L6): it and the parts after it end as owed on the
//   booking (Refund the rest can still send them to the card), not store credit: Stripe never refused them.
// W25: the look-up of the old screens' card refunds with no clear answer (`booking.card_refund_unsure`, W21a) is gone:
// nothing writes those notes any more (the last writer, the old Move, went at W24) and live has none.
// One transaction per step replaces the old figure-built keys and their 24-hour look-up, refusal counts, put-backs and
// best-effort statements (bookingRefund.ts, bookingMoneyClaim.ts, cardRefundAttempts.ts, stripeRefundLookup.ts).
// W23 (brief W23 item 1): a claim plans ONE card part per order across its booking lines and its add-on lines (Cancel &
// Refund's seat and a ticked towel on the same order: one refund, one key), each order's card portion used once;
// R2 records the booking lines' share on them and stamps the add-on lines with theirs. Cancel & Refund and Cancel &
// return credit (cancel.ts) are claims of kind `cancel` and `cancel_credit`.
// W27 (E-plan 4.1): the parts that don't care what is refunded (the claim's read and write, the due list, one card
// part's key, request and send, the refusal mark, the Stripe look-up, the held answer) are in
// server/rules/refunds/pipeline.ts, shared with step E's order and event claims. Everything about a booking stays
// here, under the same names, and every statement it runs is the one it ran before.
import 'server-only'
import type { ApiErrorCode, OwedArrivedInput, PartRefundInput, RefundBookingOutput, RefundOwedInput } from '@/contracts'
import { audit, type AuditEntry } from '@/server/audit'
import { isDeadlock, type Db, type Queryable, type Tx } from '@/server/db'
import { ApiError } from '@/server/http/errors'
import type { StripeClient } from '@/server/stripe/client'
import { stripeTiming, type StripeTiming } from '@/server/stripe/deadline'
import {
  BOOKING_CLAIMS,
  claimIsFinished,
  claimRefusal as claimRefusalOn,
  claimRowsActorOrSystem,
  claimsDueSql,
  heldAnswer,
  markRefused as markRefusedOn,
  openClaimOn,
  readClaimRow,
  sendCardPart,
  writeClaimRow,
  type CardPart,
  type CardPartLine,
  type ClaimActor,
  type SystemActor,
} from '@/server/rules/refunds/pipeline'
import {
  cardRefundFailedMessage,
  CHANGE_REFUND_UNCONFIRMED_MESSAGE,
  laterCardRefundNotSentMessage,
  laterCardRefundRefusedMessage,
  NO_CASH_LEFT_MESSAGE,
  OWED_ON_CANCELLED_STORE_CREDIT_ONLY_MESSAGE,
  onlyCardLeftMessage,
  onlyCashLeftMessage,
  onlyLeftMessage,
  owedChangedMessage,
  PART_REFUND_METHOD_WORDS,
  reasonRequiredMessage,
  reasonTooLongMessage,
  REFUND_METHOD_WORDS,
  REFUND_NOT_SAVED_MESSAGE,
  REFUND_NOT_SENT_DETAIL,
  REFUND_OPEN_MESSAGE,
  REFUND_WORDS,
  refundGoneNotRecordedMessage,
  putBackBlockedMessage,
  putBackBlockedNotRecordedMessage,
  putBackFailedMessage,
  putBackFailedNotRecordedMessage,
} from './failure-messages'
import { arrivedCardShortWords, arrivedRecordedOnWords } from '@/server/rules/refunds/failure-messages'
import { claimWatchEntries, refundSeen, refundsForRow, type RefundSeen } from '@/server/rules/refunds/refund-watch'
import { lockAndLoadBooking, paymentOpen, type LoadedBooking } from './load-booking'
import { lockForBooking } from './locks'
import { inC1, paymentOpenRefusal } from './money-in'
import { ADDONS_INSIDE_LINE, loadBookingLines, loadOrderCardPortion, OWED_ADDON_LINES_SQL, recordBookingOrdersPaymentStatus, recordOrderPaymentStatus, withCashAndLine, type RefundFigures } from './money-left'
import { overHalfPenny } from '@/server/rules/orders/amounts'

// W27: lifted to the shared core, and still exported from here under their old names.
export { cardPartRequest, claimRefundKey, findCardPart } from '@/server/rules/refunds/pipeline'
export type { CardPart, CardPartLine } from '@/server/rules/refunds/pipeline'

export const REFUND_CLAIMED = 'booking.refund_claimed'
export const REFUND_FINISHED = 'booking.refund_finished'
/** W26a: Stripe refused one of the claim's card parts (`claimId`, the part's `orderId` and `amount`, Stripe's `detail`). */
export const REFUND_REFUSED = 'booking.refund_refused'
/** The reason's limit, as the old function's. */
export const REFUND_REASON_MAX_LENGTH = 200

/**
 * W22: Remove Guest's and Remove add-on's claims go through the same pipeline (remove-guest.ts, remove-addon.ts). W23:
 * Cancel & Refund's (`cancel`, the old claim's kind) and Cancel & return credit's with paid add-ons (`cancel_credit`).
 */
export type RefundKind = 'part_refund' | 'refund_owed' | 'remove_guest' | 'remove_addon' | 'cancel' | 'cancel_credit' | 'move'
export type RefundMethod = 'card' | 'credit' | 'cash'

/**
 * W22: Remove Guest's claim. R1 deleted the guest (and released a public place); R2 stamps the line that held their
 * seat once all of it went back, as the old stampRemovedGuestLine did. With card parts the guest's row is kept, so an
 * undo after the first card refund is refused puts them back exactly as they were.
 */
export interface GuestClaim {
  id: string
  /** The store credit note names them, as the old function's did. */
  name: string
  /** The seat's price (its stored unit_price): the line R2 stamps held no more seat money than this. */
  seatPrice: number
  /** A public booking's place went back to the session in R1 (a private booking holds the whole session). */
  placeReleased: boolean
  /** With card parts only: the guest's row as it was (to_jsonb), for the undo. */
  restore?: Record<string, unknown>
  /**
   * W53 (W05h items 2 to 5): the order line the guest's own Add Guest wrote (guestLine), found in R1. R2 links the
   * refund's store credit to its order and stamps it, where the old rule guessed the line by its price. Null for a
   * guest with no line of their own (one of the party the booking was made with, whose seat is in the booking's first
   * line): then the old rule picks. Absent on a claim made before W53: R2 looks the line up itself.
   */
  line?: { id: string; orderId: string } | null
}

/** W22: Remove add-on's claim: the add-on line R1 marked removed, and what it paid (price × quantity). */
export interface AddonClaim {
  lines: Array<{ id: string; amount: number }>
  /** "1× Towel": the store credit note's words, as the old function wrote them. */
  described: string
  /** "Towel": the old refusal and warning words. */
  names: string
  /** The choice staff made ('card' or 'credit'; a removal with nothing back makes no claim). */
  refund: 'card' | 'credit'
}

// One line's share of a card part (`CardPartLine`, in the shared core): a booking line's (order_line_items), or (W23,
// `addon: true`) a ticked add-on line's (addon_order_lines) planned in the same part as the booking lines of its
// order. Remove add-on's parts (W22) hold add-on lines with no mark: its claim says so by its kind.

/** W23: a ticked paid add-on line a cancel gives back: the order that paid for it, and what it paid (price × quantity). */
export interface AddonRefundLine {
  id: string
  orderId: string | null
  amount: number
}

/** W23: one add-on line a cancel claimed (removed_at), for R2's stamp and store credit, and for the undo. */
export interface CancelAddonLine {
  id: string
  /** The order that paid for it: its card refund goes back there, and its store credit is linked to it (as before). */
  orderId: string | null
  /** A paid line refunded (with money), or a line given back with nothing (a credit line, or inside 24 hours). */
  paid: boolean
  /** Money back for a paid line refunded: price × quantity. 0 otherwise. */
  amount: number
  /** "1× Towel": the store credit note's words, as cancelBookingAddonLines wrote them. */
  described: string
  /** "Towel": the words of a refused card refund. */
  name: string
  /** A credit line's credits given back in R1, and to which membership (the undo takes them back). */
  creditsReturned: number
  membershipId: string | null
  /** The stamp R1 gave a line with no money back ('credit_returned' or 'none'); a refunded line is stamped in R2. */
  stamp: 'credit_returned' | 'none' | null
  /** The line's stamp before R1 claimed it, so the undo puts it back exactly. */
  was: { refunded: string; card: string; method: string | null }
}

/** W23: what a cancel's R1 changed (so the undo puts it back exactly) and what R2 still has to do. */
export interface CancelClaim {
  /** The booking as R1 found it. */
  status: string
  cancelledAt: string | null
  refundOwed: number
  /** The places R1 gave back to the booking's session (total_booked before, less after). */
  sessionId: string
  placesReleased: number
  /** Cancel & return credit: the session pass a credit went back to (sessions_remaining + 1). */
  passReturned: string | null
  /**
   * The seat money given back: Cancel & Refund's price paid (money owed included); £0 for Cancel & return credit,
   * except (W25) the club's cancel of a credit booking with paid guests, which gives their money back. W43a: on the
   * lapse sweep's cancel, the price paid less what is owed (what is owed stays owed on the cancelled booking).
   */
  seatAmount: number
  /** The booking lines are stamped refunded once seat money goes back, or when all of it had gone back already. */
  allBackAlready: boolean
  /** The add-on lines claimed, in line order. */
  addons: CancelAddonLine[]
  /** How the paid add-ons were refunded (Cancel & Refund: its method), or null when none were. */
  addonRefund: 'card' | 'credit' | null
  /** Cancel & return credit: the credit can be used again (its period, or the pass, still covers today). */
  creditUsableAgain?: boolean
  /** W23a (Wayne, 13 Nov): the club cancelled (Block Session, Block Day), so the 24-hour rule didn't apply. Only when true. */
  clubCancelled?: true
  /**
   * W33 (Q44): cancelled online by the customer: everything paid to store credit, every add-on line. W43 (Q48):
   * `system`, cancelled by the lapse sweep at its payment deadline. Absent on a staff cancel.
   */
  channel?: 'customer' | 'system'
  /**
   * W43: the lapse sweep's cancel. `back` says whether what was paid came back (to store credit), and `kept` why not
   * when it didn't. Only on a `system` cancel.
   */
  lapse?: LapseRecord
}

/**
 * W43 (Q48): why a lapsed booking's money wasn't given back: inside 24 hours of its session, or the session started.
 * (W43a: card refund money owed on it is no longer a reason. It stays owed, and the rest follows the clock.)
 */
export type LapseKept = 'inside_24_hours' | 'session_started'

/** W43: what the lapse sweep's cancel records of itself (the cancel's record, its own row, and `booking.lapsed`). */
export interface LapseRecord {
  back: boolean
  kept: LapseKept | null
  /** The deadline that passed (bookings.payment_due_by). */
  paymentDueBy: string | null
}

/**
 * W24: a cheaper Move's claim. R1 moved the booking (both sessions' places, the seats, a released credit or pass
 * session) and lowered price_paid by the refund; this is the booking as R1 found it and what R1 changed, so the undo
 * after a refused first card part puts the move back exactly.
 */
export interface MoveClaim {
  oldSessionId: string
  newSessionId: string
  /** As the database had them (text), so they go back exactly. */
  oldStartTime: string
  oldEndTime: string
  oldBandId: string | null
  oldCreditPeriodId: string | null
  oldRedemptionSource: string | null
  oldRedeemedMembershipId: string | null
  oldRedeemedSessionPassId: string | null
  /** Each seat as it was (unit_price as text, null for none). */
  seats: Array<{ id: string; unitPrice: string | null; payBy: string | null }>
  /** The places R1 took on the new session and gave back on the old one (total_booked after less before, and before less after). */
  placesClaimed: number
  placesReleased: number
  /** The session pass a released pass seat gave its session back to (sessions_remaining + 1), or null. */
  passReturned: string | null
  /** A membership or pass credit was released (its seat now paid), for the move's own row. */
  creditReleased: boolean
  /**
   * W58 (Wayne's Q54): the credit seat took a credit from the customer's current membership instead (its own had
   * ended): which one, for the move's own row. The undo puts the booking back on its old period (`oldCreditPeriodId`).
   */
  creditMovedTo?: CreditMovedTo
}

/** W58 (Q54): the membership and credit period a moved credit seat now draws on. */
export interface CreditMovedTo {
  membershipId: string
  creditPeriodId: string
}

/** W24: Move's own row (`booking.move`), whichever way it went: written by C1, or by R2 when money went back. */
export const BOOKING_MOVED = 'booking.move'

export interface MoveRow {
  oldSessionId: string
  newSessionId: string
  /** Signed: negative is a refund. */
  amountDue: number
  storeCredit: number
  giftCard: number
  /** The money-in method when something was collected ('card', 'reader', 'cash'), else null. */
  method: string | null
  toCollect: number
  /** A refund's method ('card' or 'credit') when money went back, else null. */
  refundMethod: string | null
  cardRefunded: number
  storeCreditRefunded: number
  owed: number
  pendingId: string | null
  creditReleased: boolean
  passReleased: string | null
  legacyPricing: boolean
  /** W58 (Q54): only when the credit seat moved to the current membership's credit. */
  creditMovedTo?: CreditMovedTo
}

export const moveRowDetails = (row: MoveRow): Record<string, unknown> => ({ ...row })

// One refund to one order's card (`CardPart`, in the shared core): the order's lines for this booking (newest first)
// add up to `amount`.

/** Where the claimed money goes: the card parts, then store credit for the rest, or (Q26) cash handed over. */
export interface RefundPlan {
  card: CardPart[]
  storeCredit: number
  cash: number
  /** The booking's own order (its oldest booking line's): the store credit's row is linked to it, as before. */
  ownOrderId: string | null
}

/** The claim's row details: the old fields (kind, amount, pricePaidBefore, method, reason), then the Worker's. */
export interface ClaimDetails {
  kind: RefundKind
  amount: number
  pricePaidBefore: number
  method: RefundMethod
  reason: string | null
  /** A claim the Worker made: reconcile and the stuck list look at these only. */
  worker: true
  plan: RefundPlan
  /** The Stripe key's mode the card parts are sent with (true live), for reconcile's "not found" (W11 review L1). */
  livemode: boolean | null
  /** Q26: who handed the cash over. */
  handedOverBy?: string
  /** W22: Remove Guest's claim. */
  guest?: GuestClaim
  /** W22: Remove add-on's claim. Its card parts' lines are add-on lines (addon_order_lines), not booking lines. */
  addon?: AddonClaim
  /** W23: Cancel & Refund's and Cancel & return credit's claim. */
  cancel?: CancelClaim
  /** W24: a cheaper Move's claim. */
  move?: MoveClaim
  /**
   * W33: the claim is the customer's own (the website's cancel): its rows name the customer. W43: `system`, the lapse
   * sweep's: its rows name nobody. Absent on a staff claim.
   */
  channel?: 'customer' | 'system'
}

export interface Claim {
  id: string
  bookingId: string
  /** The staff member who made the claim: its store credit row and its audit rows name them. */
  staffId: string | null
  /** W33: the customer who cancelled online, when the claim is theirs (then `staffId` is null). */
  customerId?: string | null
  /** W43: the system's own claim (the lapse sweep). Only when true. */
  system?: true
  at: string
  details: ClaimDetails
}

export interface RefundOptions {
  actor: { type: 'staff'; id: string }
  requestId: string
  /** The request's start: the press's Stripe calls end by a deadline from it. */
  startedAt?: number
  now?: () => number
  /** The Stripe client, made before R1 for a card refund, so a missing key fails with nothing written. */
  stripe?: () => StripeClient
}

/**
 * Who finishes a claim: the press, reconcile, or a person closing it by hand (their reason). W25a: `undo_blocked` is
 * the press whose first card part was refused and whose undo was blocked (`why`: Stripe's reason). W26a: `undo_failed`
 * is the same press when the undo failed for any other reason (a database fault).
 */
export interface FinishedBy {
  actor: { type: 'staff' | 'system' | 'customer'; id: string | null }
  requestId: string
  how: 'press' | 'reconcile' | 'close' | 'undo_blocked' | 'undo_failed'
  why?: string
}

const round2 = (n: number): number => Math.round(n * 100) / 100
/** Rounded first, as the old cash rule: taking pounds from pounds leaves noise. Half a penny either way passes (Q18). */
const sum = (amounts: readonly number[]): number => round2(amounts.reduce((total, n) => total + n, 0))

// --- Refusals

type RefundRefusalExtras = { figures?: RefundFigures; field?: string; logDetail?: string }

/** A refusal before anything moved: the old reason and words, and the new figures when the amount no longer fits. */
export function refundRefusal(code: ApiErrorCode, reason: string, message: string | undefined, extras: RefundRefusalExtras = {}): ApiError {
  const words = message ?? REFUND_WORDS.couldNotRefund
  return new ApiError(code, words, {
    ...(extras.field ? { field: extras.field } : {}),
    ...(extras.logDetail ? { logDetail: extras.logDetail } : {}),
    details: { reason, message: words, action: 'refund', ...(extras.figures ? { figures: extras.figures } : {}) },
  })
}

function requiredReason(value: unknown, what: string): string {
  const reason = typeof value === 'string' ? value.trim() : ''
  if (!reason) throw refundRefusal('VALIDATION', 'reason_required', reasonRequiredMessage(what), { field: 'reason' })
  if (reason.length > REFUND_REASON_MAX_LENGTH) throw refundRefusal('VALIDATION', 'reason_too_long', reasonTooLongMessage(REFUND_REASON_MAX_LENGTH), { field: 'reason' })
  return reason
}

// --- Claims on audit_log (lead call L3)

/**
 * Every Worker claim with no finished row, older than `$1` minutes, oldest first: what reconcile settles (D-plan
 * 4.10). A claim and its finished row are written by different transactions only when card parts were sent.
 */
export const CLAIMS_DUE_SQL = claimsDueSql(BOOKING_CLAIMS)

/** True when the booking has a Worker refund claim with no finished row: it holds the booking for every refund. */
export async function refundClaimOpen(db: Queryable, bookingId: string): Promise<boolean> {
  return (await openRefundClaimOn(db, bookingId)) !== null
}

/** The id of the booking's open Worker refund claim, if it has one. */
export async function openRefundClaimOn(db: Queryable, bookingId: string): Promise<string | null> {
  return openClaimOn(db, BOOKING_CLAIMS, bookingId)
}

/** The claim, or null when there is no Worker claim with that id. */
export async function readClaim(db: Queryable, claimId: string): Promise<Claim | null> {
  const row = await readClaimRow<ClaimDetails>(db, BOOKING_CLAIMS, claimId)
  if (!row) return null
  return { id: row.id, bookingId: row.subjectId, staffId: row.staffId, customerId: row.customerId, ...(row.system ? { system: true as const } : {}), at: row.at, details: row.details }
}

async function claimFinished(db: Queryable, claim: Pick<Claim, 'id' | 'bookingId'>): Promise<boolean> {
  return claimIsFinished(db, BOOKING_CLAIMS, { id: claim.id, subjectId: claim.bookingId })
}

/** Writes the claim's row (`booking.refund_claimed`, lead call L3): the record every key and the finish come from. */
export async function writeClaim(tx: Tx, bookingId: string, details: ClaimDetails, options: { actor: ClaimActor | SystemActor; requestId: string }): Promise<Claim> {
  const row = await writeClaimRow(tx, BOOKING_CLAIMS, bookingId, details, options)
  return { id: row.id, bookingId, staffId: row.staffId, customerId: row.customerId, ...(row.system ? { system: true as const } : {}), at: row.at, details }
}

// --- The plan

/**
 * Where `amount` goes, as giveBookingMoneyBack sent it: with the card, against the booking's lines newest first, each
 * order giving back at most what its card can still take (its card portion, each order's used once) and what that
 * line still holds in seat money; whatever the cards can't take, to store credit. A line whose order has no
 * PaymentIntent is passed over. Two lines of one order make one part (one refund, one key).
 *
 * W23 (brief W23 item 1): `addonLines`, a cancel's ticked paid add-ons, are planned after the booking lines in the same
 * parts: each against the order that paid for it, sharing that order's card portion (used once), each capped at its own
 * amount; what the cards can't take goes to store credit with the rest. So an order's seat and add-on money make ONE
 * part, under one key (order £45 on the card, seat £40 and towel £5: one £45 refund). With no add-on lines the plan is
 * exactly W21's.
 *
 * W53 (W47 review L1; Wayne's Q40): `addonsFirst` turns the two round: the add-on lines take their order's card money
 * before its booking lines do. For money owed (planOwedRefund), where an add-on line's share is the money that never
 * reached the card.
 *
 * W53a (W53 review S1; Wayne's Q40: each line's money goes back to the payment that took it): `firstOrderId`, when
 * given, is planned first: that order's booking lines take its card money before the other lines, which then follow
 * newest first as before. Remove Guest passes the order that paid for the guest's seat (the order of the line R2
 * stamps as theirs, or the booking's own order for one of the original party), so the seat's money goes back to that payment
 * and not to whichever card payment on the booking is newest. What that payment can't take still comes from the
 * others, then store credit. Null (every other caller): exactly the plan before W53a.
 */
export async function planRefund(
  db: Queryable,
  bookingId: string,
  amount: number,
  method: RefundMethod,
  addonLines: readonly AddonRefundLine[] = [],
  addonsFirst = false,
  firstOrderId: string | null = null
): Promise<RefundPlan> {
  const newestFirst = await loadBookingLines(db, bookingId)
  const ownOrderId = newestFirst.length > 0 ? (newestFirst[newestFirst.length - 1]?.orderId ?? null) : null
  // W53a: the given order's lines first, each group still newest first (filter keeps the order).
  const lines = firstOrderId
    ? [...newestFirst.filter((line) => line.orderId === firstOrderId), ...newestFirst.filter((line) => line.orderId !== firstOrderId)]
    : newestFirst
  const give = round2(amount)
  const addonTotal = sum(addonLines.map((line) => line.amount))
  if (method === 'cash') return { card: [], storeCredit: 0, cash: give, ownOrderId }
  if (method === 'credit') return { card: [], storeCredit: round2(give + addonTotal), cash: 0, ownOrderId }
  const portions = new Map<string, { paymentIntentId: string | null; left: number }>()
  const portionOf = async (orderId: string): Promise<{ paymentIntentId: string | null; left: number }> => {
    let portion = portions.get(orderId)
    if (!portion) {
      const loaded = await loadOrderCardPortion(db, orderId)
      portion = { paymentIntentId: loaded?.paymentIntentId ?? null, left: loaded?.paymentIntentId ? loaded.cardPortionRemaining : 0 }
      portions.set(orderId, portion)
    }
    return portion
  }
  const parts = new Map<string, CardPart>()
  const addToPart = (orderId: string, paymentIntentId: string, line: CardPartLine): void => {
    const part = parts.get(orderId) ?? { orderId, paymentIntentId, amount: 0, lines: [] }
    part.amount = round2(part.amount + line.amount)
    part.lines.push(line)
    parts.set(orderId, part)
  }
  let left = give
  const takeSeats = async (): Promise<void> => {
    for (const line of lines) {
      if (left <= 0.005) break
      const portion = await portionOf(line.orderId)
      if (!portion.paymentIntentId) continue
      const take = round2(Math.min(left, portion.left, line.netRemaining))
      if (take <= 0) continue
      portion.left = round2(portion.left - take)
      addToPart(line.orderId, portion.paymentIntentId, { lineId: line.id, amount: take })
      left = round2(left - take)
    }
  }
  let addonsLeft = 0
  const takeAddons = async (): Promise<void> => {
    for (const line of addonLines) {
      const portion = line.orderId ? await portionOf(line.orderId) : null
      const take = line.orderId && portion?.paymentIntentId ? round2(Math.min(line.amount, portion.left)) : 0
      if (take > 0 && line.orderId && portion?.paymentIntentId) {
        portion.left = round2(portion.left - take)
        addToPart(line.orderId, portion.paymentIntentId, { lineId: line.id, amount: take, addon: true })
      }
      addonsLeft = round2(addonsLeft + line.amount - take)
    }
  }
  // W23: the add-ons, booking lines first: each order's card money left after its seat money. W53: money owed the
  // other way round (`addonsFirst`).
  if (addonsFirst) {
    await takeAddons()
    await takeSeats()
  } else {
    await takeSeats()
    await takeAddons()
  }
  const seatToStoreCredit = left > 0.005 ? left : 0
  return { card: [...parts.values()], storeCredit: addonLines.length > 0 ? round2(seatToStoreCredit + addonsLeft) : seatToStoreCredit, cash: 0, ownOrderId }
}

/**
 * W22: where a removed add-on's money goes, as cancelBookingAddonLines sent it: with the card, against the order that
 * paid for the add-on (its own, or the guest's order an older add-on was paid inside), at most what that order's card
 * can still take back (its card portion less every card refund on its lines and add-on lines); the rest to store
 * credit, linked to that order. The card share runs line by line in order. A card part's lines are add-on lines.
 */
export async function planAddonRefund(db: Queryable, orderId: string | null, lines: AddonClaim['lines'], method: 'card' | 'credit'): Promise<RefundPlan> {
  const total = sum(lines.map((line) => line.amount))
  let card = 0
  let paymentIntentId: string | null = null
  if (method === 'card' && orderId && total > 0) {
    const portion = await loadOrderCardPortion(db, orderId)
    paymentIntentId = portion?.paymentIntentId ?? null
    if (paymentIntentId && portion) card = round2(Math.min(total, portion.cardPortionRemaining))
  }
  const parts: CardPart[] = []
  if (card > 0 && orderId && paymentIntentId) {
    let left = card
    const partLines: CardPartLine[] = []
    for (const line of lines) {
      const take = round2(Math.min(left, line.amount))
      if (take <= 0) continue
      partLines.push({ lineId: line.id, amount: take })
      left = round2(left - take)
    }
    parts.push({ orderId, paymentIntentId, amount: card, lines: partLines })
  }
  const storeCredit = round2(total - card)
  return { card: parts, storeCredit: storeCredit > 0.005 ? storeCredit : 0, cash: 0, ownOrderId: orderId }
}

/**
 * W53 (W47 review L1; Wayne's Q40: money goes back on the line its payment took): where money owed goes when Refund
 * the rest sends it to the card. First the booking's removed add-on lines whose card refund is part of what is owed
 * (OWED_ADDON_LINES_SQL), in a fixed order, each up to what it is short of and what its order's card can still take;
 * then the booking's lines as planRefund plans them; what the cards can't take, to store credit.
 *
 * Until W53 the whole of it was planned on the booking's lines. Example (the review's): a seat £20 and a towel £5 on
 * one £25 card payment; the towel is removed and its £5 refund refused, so £5 is owed. Refund the rest to the card
 * sent the £5 and recorded it on the SEAT's line, which then read £15 of seat money left; a later Cancel & Refund sent
 * £15 to the card and £5 to store credit, though the payment still had £20. Now the £5 is recorded on the towel's
 * line, and the cancel sends £20 to the card. To store credit, the plan is as before (nothing is recorded on a line).
 */
export async function planOwedRefund(db: Queryable, bookingId: string, owed: number, method: RefundMethod): Promise<RefundPlan> {
  if (method !== 'card') return planRefund(db, bookingId, owed, method)
  let left = round2(owed)
  const addonLines: AddonRefundLine[] = []
  for (const row of await db.query<{ id: string; order_id: string | null; amount: string; refunded_amount: string }>(OWED_ADDON_LINES_IN_ORDER_SQL, [bookingId])) {
    if (left <= 0.005) break
    const take = round2(Math.min(left, Number.parseFloat(row.amount) - Number.parseFloat(row.refunded_amount)))
    if (take <= 0) continue
    addonLines.push({ id: row.id, orderId: row.order_id, amount: take })
    left = round2(left - take)
  }
  return planRefund(db, bookingId, left, 'card', addonLines, true)
}

// --- R1

/** What R1 finished on its own, or the claim whose card parts the press now sends. */
export type Started = { kind: 'done'; output: RefundBookingOutput } | { kind: 'card'; claim: Claim }

/**
 * The checks every amount action starts with, under the booking's lock, in the old function's order (a payment still
 * being taken on the booking first, as refundBooking checked it before anything else).
 */
async function lockAndCheck(tx: Tx, bookingId: string, amount: unknown, owedOnly = false): Promise<{ booking: LoadedBooking; amount: number; cancelled: boolean }> {
  const loaded = await lockAndLoadBooking(tx, { bookingId, ownSession: false })
  if (!loaded) throw refundRefusal('NOT_FOUND', 'booking_not_found', REFUND_WORDS.bookingNotFound)
  const { booking } = loaded
  if (paymentOpen(booking)) throw paymentOpenRefusal(booking, refundRefusal)
  // A held refund on the booking (no clear answer yet) holds every refund until reconcile settles it.
  if (await refundClaimOpen(tx, bookingId)) throw refundRefusal('CONFLICT', 'refund_open', REFUND_OPEN_MESSAGE)
  // price_paid stays on a cancelled booking after its refund, so a part refund would pay out a second time. W25 (W23
  // review later 1): money still owed on a cancelled booking (a refund closed by hand) is not that: `owedOnly` (Refund
  // the rest, It already arrived) goes on, and gives or clears exactly what is owed, which lives in refund_owed_amount
  // alone on a cancelled booking.
  const cancelled = booking.status === 'cancelled'
  if (cancelled && !owedOnly) throw refundRefusal('CONFLICT', 'already_cancelled', REFUND_WORDS.alreadyCancelled)
  if (typeof amount !== 'number' || !Number.isFinite(amount) || !(round2(amount) > 0)) {
    throw refundRefusal('VALIDATION', 'amount_not_positive', REFUND_WORDS.amountNotPositive, { field: 'amount' })
  }
  return { booking, amount, cancelled }
}

/**
 * W25: what is owed comes off the booking (Refund the rest, It already arrived). A live booking's price_paid holds the
 * money owed, so both fall; a cancelled booking keeps its price_paid (as every cancelled booking does), and what is
 * owed on it is in refund_owed_amount alone (finishClaimInTransaction).
 */
const OWED_OFF_SQL = {
  live: 'UPDATE bookings SET price_paid = price_paid - $1::numeric, refund_owed_amount = refund_owed_amount - $1::numeric, updated_at = now() WHERE id = $2::uuid',
  cancelled: 'UPDATE bookings SET refund_owed_amount = refund_owed_amount - $1::numeric, updated_at = now() WHERE id = $2::uuid',
} as const

/** What Refund the rest refuses: the amount must be what is owed, to half a penny. (W28: It already arrived takes part of it too.) */
function owedRefusal(amount: number, figures: RefundFigures): ApiError | null {
  if (figures.refundOwed <= 0) return refundRefusal('CONFLICT', 'nothing_owed', REFUND_WORDS.nothingOwed, { figures })
  if (overHalfPenny(amount, figures.refundOwed) || overHalfPenny(figures.refundOwed, amount)) {
    return refundRefusal('CONFLICT', 'owed_changed', owedChangedMessage(figures.refundOwed), { figures })
  }
  return null
}

async function partR1(tx: Tx, bookingId: string, input: PartRefundInput, options: RefundOptions, livemode: boolean | null): Promise<Started> {
  const method = input.refundMethod
  if (method !== 'card' && method !== 'credit' && method !== 'cash') {
    throw refundRefusal('VALIDATION', 'refund_method_invalid', PART_REFUND_METHOD_WORDS, { field: 'refundMethod' })
  }
  const { booking, amount } = await lockAndCheck(tx, bookingId, input.amount)
  const reason = requiredReason(input.reason, 'a part refund')
  const figures = await withCashAndLine(tx, bookingId, booking.figures)
  if (figures.left <= 0) throw refundRefusal('CONFLICT', 'nothing_left', REFUND_WORDS.nothingLeft, { figures })
  if (overHalfPenny(amount, figures.left)) throw refundRefusal('CONFLICT', 'more_than_left', onlyLeftMessage(figures.left), { figures })
  const limit = method === 'card' ? figures.parts.card : method === 'cash' ? figures.cashLeft : figures.left
  if (overHalfPenny(amount, limit)) {
    if (method === 'card') throw refundRefusal('CONFLICT', 'more_than_card_left', limit > 0 ? onlyCardLeftMessage(limit) : REFUND_WORDS.noCardLeft, { figures })
    throw refundRefusal('CONFLICT', 'more_than_cash_left', limit > 0 ? onlyCashLeftMessage(limit) : NO_CASH_LEFT_MESSAGE, { figures })
  }
  const give = round2(Math.min(amount, limit))
  const plan = await planRefund(tx, bookingId, give, method)
  // part_refunded_amount is what Add Guest and Move read so a part refund stays with the customer (Q27, Q28), so it
  // takes the whole amount agreed: money that fails partway is still owed to them (Refund the rest never raises it).
  await tx.query(
    'UPDATE bookings SET price_paid = price_paid - $1::numeric, part_refunded_amount = part_refunded_amount + $1::numeric, updated_at = now() WHERE id = $2::uuid',
    [give, bookingId]
  )
  const claim = await writeClaim(
    tx,
    bookingId,
    {
      kind: 'part_refund',
      amount: give,
      pricePaidBefore: figures.pricePaid,
      method,
      reason,
      worker: true,
      plan,
      livemode: plan.card.length > 0 ? livemode : null,
      ...(method === 'cash' ? { handedOverBy: options.actor.id } : {}),
    },
    options
  )
  if (plan.card.length > 0) return { kind: 'card', claim }
  const output = await finishClaimInTransaction(tx, claim, { went: [], owed: 0 }, { actor: options.actor, requestId: options.requestId, how: 'press' })
  if (!output) throw new Error(`Refund claim ${claim.id} was finished in its own transaction.`)
  return { kind: 'done', output }
}

async function owedR1(tx: Tx, bookingId: string, input: RefundOwedInput, options: RefundOptions, livemode: boolean | null): Promise<Started> {
  const method = input.refundMethod
  if (method !== 'card' && method !== 'credit') throw refundRefusal('VALIDATION', 'refund_method_invalid', REFUND_METHOD_WORDS, { field: 'refundMethod' })
  const { booking, amount, cancelled } = await lockAndCheck(tx, bookingId, input.amount, true)
  const figures = await withCashAndLine(tx, bookingId, booking.figures)
  const refused = owedRefusal(amount, figures)
  if (refused) throw refused
  // W25: on a cancelled booking, store credit only. The money is owed there because a card refund couldn't be settled
  // (a refund closed by hand), so a second card refund could pay the same money twice.
  if (cancelled && method !== 'credit') throw refundRefusal('CONFLICT', 'cancelled_store_credit_only', OWED_ON_CANCELLED_STORE_CREDIT_ONLY_MESSAGE, { figures })
  // Exactly what is owed: staff confirmed it. Never a part refund: this money was never paid toward the booking.
  const owed = figures.refundOwed
  // W53 (W47 review L1): to the card, the owed add-on lines first, on a live booking as on a cancelled one.
  const plan = await planOwedRefund(tx, bookingId, owed, method)
  await tx.query(cancelled ? OWED_OFF_SQL.cancelled : OWED_OFF_SQL.live, [owed, bookingId])
  const claim = await writeClaim(
    tx,
    bookingId,
    {
      kind: 'refund_owed',
      amount: owed,
      pricePaidBefore: figures.pricePaid,
      method,
      reason: null,
      worker: true,
      plan,
      livemode: plan.card.length > 0 ? livemode : null,
    },
    options
  )
  if (plan.card.length > 0) return { kind: 'card', claim }
  const output = await finishClaimInTransaction(tx, claim, { went: [], owed: 0 }, { actor: options.actor, requestId: options.requestId, how: 'press' })
  if (!output) throw new Error(`Refund claim ${claim.id} was finished in its own transaction.`)
  return { kind: 'done', output }
}

// --- R2: what went is recorded, the rest to store credit (or owed), the claim finished

/** What a claim ended with. `owed`: card money that never went (the press, reconcile, a close), on the booking as owed, live or cancelled (W26b). */
export interface ClaimOutcome {
  went: CardPart[]
  /**
   * W32: the refund Stripe answered (the press) or lists (reconcile, a close) for each part that went: kept on the
   * finished row, and watched until it ends when it hadn't succeeded yet (refund-watch.ts).
   */
  refunds?: RefundSeen[]
  owed: number
  /**
   * W26a: Stripe refused a card part (its reason), kept on the finished row: the customer may have the money already,
   * so a person decides. (W26b: what is owed stays owed on a cancelled booking with or without it.)
   */
  refused?: string
  warning?: string
}

/** The notes the old function gave its store credit (shared/storeCreditRefund's `[ref …]` included, as it was written). */
function storeCreditNote(claim: Claim, cardRefunded: number): string {
  const { details } = claim
  // W22: Remove add-on's note was the add-ons alone (cancelBookingAddonLines), whatever went to the card.
  if (details.kind === 'remove_addon') return `Add-on refund: ${details.addon?.described ?? ''}. [ref ${crypto.randomUUID()}]`
  const base =
    details.kind === 'part_refund'
      ? `Booking partial refund: ${details.reason ?? ''}`
      : details.kind === 'remove_guest'
        ? `Refund for a guest removed from the booking (${details.guest?.name ?? ''})`
        : details.kind === 'move'
          ? // W24: the old Move's note (moveBooking.ts's giveBookingMoneyBack call).
            'Refund of the price difference after a booking move'
          : 'Refund the rest of a failed booking refund'
  return `${base}${cardRefunded > 0 ? ' (the rest went back to the card).' : '.'} [ref ${crypto.randomUUID()}]`
}

// --- W53: a removed guest's own line (W05h's step E items 2 to 5; the W35 audit's row 26)
//
// Nothing in the database links a guest to the order line that paid for their seat, so until W53 Remove Guest guessed
// the line by its price (W05f): the newest unstamped booking line holding no more than the seat. That guess went
// wrong four ways, none of which moved money (the stamp is a label, read only by the order's payment status):
//  - item 2: the refund's store credit was linked to the booking's OWN order, so that order read
//    `partially_refunded` while the guest's order read `refunded`;
//  - item 3: a guest whose seat had been moved to a cheaper session held more on their line than the seat's price,
//    so the line wasn't found, and their order stayed `partially_refunded` with all of its money back;
//  - item 4: a dearer Move's own charge line could be the newest small line, and was stamped in the guest's place;
//  - item 5: a guest who paid cash and was refunded from another order's card read `credit`, with no store credit given.
// Since W20 every Add Guest writes `booking.guest_add` with the guest's id and either the order it wrote (no card
// money) or the flow whose finished payment wrote the order (card, reader). That row is the link:
//  - the guest's line is the booking line of that order (guestLine); the price guess is kept only for a guest with no
//    such row (one of the party the booking was made with, or a guest added before W20), and then never picks a line
//    that is another guest's own, or a Move's or Settle's own charge line;
//  - the refund's store credit is linked to the guest's order when they have a line;
//  - the stamp says `card` when this removal sent card money back, whichever order's card it came from.

/**
 * The order line a guest's own Add Guest wrote: the booking line of the order `booking.guest_add` names, or of the
 * order its card or reader flow's finished payment wrote. `$1` the booking (text), `$2` the guest, `$3` the booking.
 */
const GUEST_LINE_SQL = `
WITH added AS (
  SELECT a.details->>'orderId' AS order_id, a.details->>'pendingId' AS pending_id
  FROM audit_log a
  WHERE a.action = 'booking.guest_add' AND a.entity_type = 'booking' AND a.entity_id = $1::text AND a.details->>'guestId' = $2::text
  ORDER BY a.at DESC, a.id DESC
  LIMIT 1
),
paid_on AS (
  SELECT o.id
  FROM added
  JOIN orders o ON o.id::text = added.order_id
  UNION ALL
  SELECT o.id
  FROM added
  JOIN pending_reader_payments p ON p.id::text = added.pending_id AND p.status = 'finalised' AND p.payment_intent_id IS NOT NULL
  JOIN orders o ON o.stripe_payment_intent_id = p.payment_intent_id
)
SELECT oli.id, oli.order_id
FROM paid_on
JOIN order_line_items oli ON oli.order_id = paid_on.id AND oli.booking_id = $3::uuid AND oli.item_type = 'booking'
ORDER BY oli.created_at, oli.id
LIMIT 1`

/** W53: the order line a guest's own Add Guest wrote (GUEST_LINE_SQL), or null when nothing names one. */
export async function guestLine(db: Queryable, bookingId: string, guestId: string): Promise<{ id: string; orderId: string } | null> {
  const row = (await db.query<{ id: string; order_id: string }>(GUEST_LINE_SQL, [bookingId, guestId, bookingId]))[0]
  return row ? { id: row.id, orderId: row.order_id } : null
}

/**
 * W53: true for a booking line `oli` (of order `o`) that is some guest's own (an Add Guest's order, or the order its
 * flow's payment wrote) or a Move's or Settle's own charge line (the order its flow's payment wrote). The price guess
 * below never picks one: it is used only for a guest with no line of their own.
 */
const LINE_IS_ANOTHER_PAYMENTS_SQL = `(EXISTS (
      SELECT 1 FROM audit_log a
      WHERE a.action = 'booking.guest_add' AND a.entity_type = 'booking' AND a.entity_id = oli.booking_id::text
        AND a.details->>'guestId' IS NOT NULL
        AND (a.details->>'orderId' = oli.order_id::text
             OR EXISTS (SELECT 1 FROM pending_reader_payments p
                        WHERE p.id::text = a.details->>'pendingId' AND p.payment_intent_id IS NOT NULL
                          AND p.payment_intent_id = o.stripe_payment_intent_id)))
    OR EXISTS (
      SELECT 1 FROM pending_reader_payments p
      WHERE p.record_id = oli.booking_id AND p.flow IN ('move', 'settle') AND p.payment_intent_id IS NOT NULL
        AND p.payment_intent_id = o.stripe_payment_intent_id))`

/**
 * W22's rule (the old stampRemovedGuestLine), for a guest with no line of their own: the newest booking line not yet
 * stamped whose seat money is above £0 and no more than the seat's price, and which isn't the booking's first line
 * (unless nothing is left on the booking). W53: and which isn't another guest's own line, or a Move's or Settle's
 * charge line. Fixed text: ADDONS_INSIDE_LINE is a constant; the booking and the price come in as $1 and $2.
 */
const GUESSED_GUEST_LINE_SQL = `
SELECT oli.id, oli.order_id
FROM order_line_items oli
${ADDONS_INSIDE_LINE}
WHERE oli.booking_id = $1::uuid AND oli.item_type = 'booking' AND oli.refunded_at IS NULL
  AND oli.line_total - COALESCE(oli.discount_amount, 0) - inside.addons > 0
  AND oli.line_total - COALESCE(oli.discount_amount, 0) - inside.addons <= $2::numeric
  AND (
    EXISTS (
      SELECT 1 FROM order_line_items earlier
      WHERE earlier.booking_id = oli.booking_id AND earlier.item_type = 'booking'
        AND (earlier.created_at, earlier.id) < (oli.created_at, oli.id)
    )
    OR (SELECT COALESCE(b.price_paid, 0) FROM bookings b WHERE b.id = oli.booking_id) <= 0
  )
  AND NOT ${LINE_IS_ANOTHER_PAYMENTS_SQL}
ORDER BY oli.created_at DESC, oli.id DESC
LIMIT 1`

/** The removed guest, as a claim holds them: enough to find their line. */
export type RemovedGuest = Pick<GuestClaim, 'id' | 'seatPrice' | 'line'>

/**
 * W53: the line a removed guest's seat was on. Their own (the claim's, or looked up for a claim made before W53);
 * else the price guess, for a guest who has none.
 */
export async function removedGuestLine(db: Queryable, bookingId: string, guest: RemovedGuest): Promise<{ id: string; orderId: string } | null> {
  const own = guest.line === undefined ? await guestLine(db, bookingId, guest.id) : guest.line
  if (own) return own
  const row = (await db.query<{ id: string; order_id: string }>(GUESSED_GUEST_LINE_SQL, [bookingId, guest.seatPrice]))[0]
  return row ? { id: row.id, orderId: row.order_id } : null
}

/**
 * A removed guest's line stamped refunded, once: `card` when card money is on the line or (`$2`, W53: W05h item 5)
 * the removal sent card money back from any of the booking's orders, else `credit`. Answers its order.
 */
const STAMP_GUEST_LINE_SQL = `
UPDATE order_line_items
SET refunded_at = now(), refund_method = CASE WHEN card_refunded_amount > 0 OR $2::boolean THEN 'card' ELSE 'credit' END
WHERE id = $1::uuid AND refunded_at IS NULL
RETURNING order_id`

/** Stamps one line as a removed guest's (STAMP_GUEST_LINE_SQL) and works out its order's status again. */
async function stampGuestLine(tx: Tx, lineId: string, byCard: boolean): Promise<string | null> {
  const orderId = (await tx.query<{ order_id: string }>(STAMP_GUEST_LINE_SQL, [lineId, byCard]))[0]?.order_id ?? null
  if (orderId) await recordOrderPaymentStatus(tx, orderId)
  return orderId
}

/**
 * W22: stamps a removed guest's line and works out its order's status again. W53: the guest's own line when they
 * have one (removedGuestLine); `byCard` when the removal sent card money back.
 */
export async function stampRemovedGuestLine(tx: Tx, bookingId: string, guest: RemovedGuest, byCard = false): Promise<string | null> {
  const line = await removedGuestLine(tx, bookingId, guest)
  return line ? stampGuestLine(tx, line.id, byCard) : null
}

/** W22: how a removed add-on line is stamped: what went back to it, how much of that to the card, and how. */
export interface AddonLineStamp {
  id: string
  refunded: number
  card: number
  method: 'card' | 'credit' | 'none' | 'credit_returned'
}

/** W22: the stamps on removed add-on lines (as cancelBookingAddonLines' step 5). */
export async function stampAddonLines(tx: Tx, stamps: readonly AddonLineStamp[]): Promise<void> {
  for (const stamp of stamps) {
    await tx.query('UPDATE addon_order_lines SET refunded_amount = $1::numeric, card_refunded_amount = $2::numeric, refund_method = $3::text WHERE id = $4::uuid', [
      stamp.refunded,
      stamp.card,
      stamp.method,
      stamp.id,
    ])
  }
}

/** W22: a removed add-on's lines, card first line by line, then store credit (as the old function split them). */
function addonStamps(lines: AddonClaim['lines'], card: number, credit: number): AddonLineStamp[] {
  let cardLeft = card
  let creditLeft = credit
  return lines.map((line) => {
    const cardPart = round2(Math.min(cardLeft, line.amount))
    cardLeft = round2(cardLeft - cardPart)
    const creditPart = round2(Math.min(creditLeft, line.amount - cardPart))
    creditLeft = round2(creditLeft - creditPart)
    return { id: line.id, refunded: round2(cardPart + creditPart), card: cardPart, method: cardPart > 0 ? 'card' : creditPart > 0 ? 'credit' : 'none' }
  })
}

/**
 * The action's own row, as each action writes it (W21: the old function's fields; W22: Remove Guest's and add-on's; W24:
 * a cheaper Move's `booking.move`).
 */
function actionRow(details: ClaimDetails, parts: { cardRefunded: number; storeCredit: number; owed: number; cash: number }): { action: string; details: Record<string, unknown> } {
  const { cardRefunded, storeCredit, owed, cash } = parts
  switch (details.kind) {
    case 'part_refund':
      return {
        action: 'booking.part_refund',
        details: { amount: details.amount, reason: details.reason, method: details.method, cardRefunded, storeCreditRefunded: storeCredit, owed, ...(cash > 0 ? { cashRefunded: cash, handedOverBy: details.handedOverBy ?? null } : {}) },
      }
    case 'refund_owed':
      return { action: 'booking.refund_owed', details: { amount: details.amount, method: details.method, cardRefunded, storeCreditRefunded: storeCredit, owed } }
    case 'remove_guest':
      return { action: GUEST_REMOVED, details: guestRemovedDetails(details.guest?.id ?? null, { refundAmount: details.amount, method: details.method, cardRefunded, storeCreditRefunded: storeCredit, owed }) }
    case 'remove_addon':
      return {
        action: ADDON_REMOVED,
        details: addonRemovedDetails((details.addon?.lines ?? []).map((line) => line.id), { refund: details.addon?.refund ?? null, amount: details.amount, cardRefunded, storeCreditRefunded: storeCredit, owed, creditsReturned: 0 }),
      }
    case 'cancel':
    case 'cancel_credit':
      return cancelActionRow(details.kind, details.method, details.cancel, { cardRefunded, storeCreditRefunded: storeCredit, owed })
    case 'move': {
      // W24: R2 writes a cheaper Move's own row once the money's fate is known (an undone move then leaves none).
      const move = details.move
      return {
        action: BOOKING_MOVED,
        details: moveRowDetails({
          oldSessionId: move?.oldSessionId ?? '',
          newSessionId: move?.newSessionId ?? '',
          amountDue: round2(-details.amount),
          storeCredit: 0,
          giftCard: 0,
          method: null,
          toCollect: 0,
          refundMethod: details.method,
          cardRefunded,
          storeCreditRefunded: storeCredit,
          owed,
          pendingId: null,
          creditReleased: move?.creditReleased ?? false,
          passReleased: move?.passReturned ?? null,
          legacyPricing: false,
          ...(move?.creditMovedTo ? { creditMovedTo: move.creditMovedTo } : {}),
        }),
      }
    }
  }
}

/** W23: Cancel & Refund's own row, and Cancel & return credit's (every cancel, with or without money back). */
export const BOOKING_CANCELLED = 'booking.cancel'
export const BOOKING_CANCELLED_CREDIT = 'booking.cancel_credit'

/** W23: a cancel's own row (R1 writes it when no money goes back, R2 when some does): what it gave back and released. */
export function cancelActionRow(
  kind: 'cancel' | 'cancel_credit',
  method: string | null,
  cancel: CancelClaim | undefined,
  money: { cardRefunded: number; storeCreditRefunded: number; owed: number }
): { action: string; details: Record<string, unknown> } {
  const addons = cancel?.addons ?? []
  const addonsRefund = sum(addons.filter((line) => line.paid && cancel?.addonRefund).map((line) => line.amount))
  const common = {
    addonLineIds: addons.map((line) => line.id),
    addonsRefund,
    cardRefunded: money.cardRefunded,
    storeCreditRefunded: money.storeCreditRefunded,
    owed: money.owed,
    creditsReturned: addons.reduce((total, line) => total + line.creditsReturned, 0),
    placesReleased: cancel?.placesReleased ?? 0,
  }
  // W23a: a club cancel says so (only then, so every other cancel's row is as W23 wrote it).
  // W33: so does a cancel the customer made online. W43: and the lapse sweep's, with what it recorded of itself.
  const club = {
    ...(cancel?.clubCancelled ? { clubCancelled: true } : {}),
    ...(cancel?.channel === 'customer' ? { channel: 'customer' } : {}),
    ...(cancel?.channel === 'system' ? { channel: 'system', lapse: cancel.lapse ?? null } : {}),
  }
  if (kind === 'cancel') return { action: BOOKING_CANCELLED, details: { refundMethod: method, seatRefund: cancel?.seatAmount ?? 0, ...common, ...club } }
  // W25: the club's Cancel & return credit that refunded paid guests says so (only then, so every other row is as W23's).
  const guests = (cancel?.seatAmount ?? 0) > 0 ? { refundMethod: method, seatRefund: cancel?.seatAmount ?? 0 } : {}
  return {
    action: BOOKING_CANCELLED_CREDIT,
    details: { addonRefund: cancel?.addonRefund ?? null, creditUsableAgain: cancel?.creditUsableAgain ?? false, passReturned: cancel?.passReturned ?? null, ...common, ...club, ...guests },
  }
}

/** W22: Remove Guest's own row (every removal, with or without money back). */
export const GUEST_REMOVED = 'booking.guest_remove'
/** W22: Remove add-on's own row (every removal, with or without money back). */
export const ADDON_REMOVED = 'booking.addon_remove'

export const guestRemovedDetails = (
  guestId: string | null,
  money: { refundAmount: number; method: RefundMethod | null; cardRefunded: number; storeCreditRefunded: number; owed: number }
): Record<string, unknown> => ({ guestId, ...money })

export const addonRemovedDetails = (
  lineIds: readonly string[],
  money: { refund: string | null; amount: number; cardRefunded: number; storeCreditRefunded: number; owed: number; creditsReturned: number }
): Record<string, unknown> => ({ lineIds, ...money })

/**
 * R2, inside a transaction the caller opened: the booking locked (and its customer), then, unless the claim is
 * finished already (null): each card part that went added to its booking lines' card_refunded_amount; the plan's store
 * credit given as one store credit refund; money Stripe never received, or refused (W26a), put back on the booking as
 * owed, live or cancelled (W26b: never as store credit instead); the orders'
 * status worked out again; the action's row (`booking.part_refund` / `booking.refund_owed`, as the old function wrote
 * them) and the claim's finished row. Throws on any failure, so the caller's transaction keeps nothing.
 */
export async function finishClaimInTransaction(tx: Tx, claim: Claim, outcome: ClaimOutcome, by: FinishedBy): Promise<RefundBookingOutput | null> {
  const locks = await lockForBooking(tx, { bookingId: claim.bookingId })
  if (!locks) throw new Error(`The booking of refund claim ${claim.id} no longer exists.`)
  if (await claimFinished(tx, claim)) return null
  const { details } = claim
  const { plan } = details

  // W22: a removed add-on's card refund is recorded on its add-on line (stamped below), not on a booking line. W23: so is
  // a cancel's add-on line's share of its order's part (`addon`). W53 (W47 review L1): and Refund the rest's share for
  // an add-on line whose card refund was part of what was owed (planOwedRefund), recorded on that line here, as It
  // already arrived "on the card" records it.
  if (details.kind !== 'remove_addon') {
    for (const part of outcome.went) {
      for (const line of part.lines) {
        if (line.addon) {
          if (details.kind === 'refund_owed') await tx.query(ARRIVED_ON_ADDON_LINE_SQL, [line.amount, line.lineId])
          continue
        }
        await tx.query('UPDATE order_line_items SET card_refunded_amount = card_refunded_amount + $1::numeric WHERE id = $2::uuid', [line.amount, line.lineId])
      }
    }
  }
  const cardRefunded = sum(outcome.went.map((part) => part.amount))
  const status = (await tx.query<{ status: string }>('SELECT status FROM bookings WHERE id = $1::uuid', [claim.bookingId]))[0]?.status
  // W26b (Wayne, 14 Nov): card money that never went is owed on the booking, live or cancelled, however the claim ends
  // (the press, reconcile's "not found", a refusal, a close by hand). It is never given as store credit here: "not
  // found" can also be a refusal whose mark couldn't be written, and the customer may have the money already. A person
  // checks Stripe, then uses It already arrived or Refund the rest on the booking (on a cancelled one, W25: store
  // credit only). Only the plan's own store credit (what the cards can't take) is given. W21 gave "not found" on a
  // cancelled booking as store credit; W23, W25a and W26a had already stopped that for a close and for every refusal.
  const owed = round2(outcome.owed)
  const storeCredit = round2(plan.storeCredit)
  const cancel = details.cancel ?? null
  // W23: a cancel's seat money and its add-ons' money, each as the old functions recorded it.
  const shares = cancel ? cancelShares(cancel, plan, outcome, owed > 0) : null
  const seatCard = shares ? round2(cardRefunded - shares.addons.card) : cardRefunded
  const seatStoreCredit = shares ? round2(storeCredit - shares.addons.storeCredit) : storeCredit

  let creditRows = 0
  const giveStoreCredit = async (amount: number, orderId: string | null, note: string): Promise<number | undefined> => {
    const applied = (
      await tx.query<{ result: { ok?: boolean; reason?: string; balance?: number | string; transaction_id?: string } | null }>(
        'SELECT public.store_credit_apply($1::uuid, $2::numeric, $3::text, $4::uuid, $5::uuid, $6::uuid, $7::text, NULL::uuid) AS result',
        [locks.customerId, amount, 'refund', orderId, claim.bookingId, claim.staffId, note]
      )
    )[0]?.result
    if (applied?.ok !== true) throw new Error(`The store credit refund was refused: ${applied?.reason ?? 'no answer'}.`)
    // W23: a cancel can give two rows in one transaction (the seat's, then an add-on's), whose now() is one instant: each
    // later row a millisecond on, so they read in the order given (as T1 spaces its rows).
    if (creditRows > 0 && typeof applied.transaction_id === 'string') {
      await tx.query("UPDATE store_credit_transactions SET created_at = created_at + make_interval(secs => $1::int / 1000.0) WHERE id = $2::uuid", [creditRows, applied.transaction_id])
    }
    creditRows += 1
    return applied.balance !== undefined && applied.balance !== null ? Number(applied.balance) : undefined
  }
  // W53 (W05h items 2 to 5): a removed guest's own line, found before anything is given, so their refund's store credit
  // is linked to the order that paid for their seat and that line is the one stamped below.
  const removedLine = details.kind === 'remove_guest' && details.guest ? await removedGuestLine(tx, claim.bookingId, details.guest) : null
  // W53 (W05h items 2 and 6): Refund the rest, as store credit, of money owed for ONE removed guest's seat (their
  // refund ended owed, and their line is still waiting for it) is linked to that guest's order too. With none, or more
  // than one, it is linked to the booking's own order, as before.
  const owedGuestOrder = details.kind === 'refund_owed' && status !== 'cancelled' && seatStoreCredit > 0 ? await orderOfTheOneGuestOwed(tx, claim.bookingId) : null
  let balance: number | undefined
  let addonsBalance: number | undefined
  if (seatStoreCredit > 0) {
    balance = await giveStoreCredit(seatStoreCredit, removedLine?.orderId ?? owedGuestOrder ?? plan.ownOrderId, cancel ? cancelSeatNote(seatCard) : storeCreditNote(claim, cardRefunded))
  }
  // W23: the add-ons' store credit, one row per paying order, linked to it, after the seat's (as before).
  for (const group of shares?.creditByOrder ?? []) {
    addonsBalance = await giveStoreCredit(group.amount, group.orderId, `Add-on refund: ${group.described}. [ref ${crypto.randomUUID()}]`)
  }
  if (owed > 0) {
    // W23: a cancel never lowered price_paid (a cancelled booking keeps it, as before), so only what is owed rises.
    // W25: the same for any claim closed by hand on a cancelled booking (an add-on removed from it): what is owed on a
    // cancelled booking is in refund_owed_amount alone, where Refund the rest and It already arrived take it from.
    await tx.query(
      cancel || status === 'cancelled'
        ? 'UPDATE bookings SET refund_owed_amount = refund_owed_amount + $1::numeric, updated_at = now() WHERE id = $2::uuid'
        : 'UPDATE bookings SET price_paid = price_paid + $1::numeric, refund_owed_amount = refund_owed_amount + $1::numeric, updated_at = now() WHERE id = $2::uuid',
      [owed, claim.bookingId]
    )
  }
  // W22: the removed add-on's line says what went back to it (money Stripe never received: nothing, and 'none', as the
  // old function stamped a refund with no clear answer); before the orders' status, which counts it.
  if (details.kind === 'remove_addon') await stampAddonLines(tx, addonStamps(details.addon?.lines ?? [], cardRefunded, storeCredit))
  if (cancel && shares) {
    // W23: the refunded add-on lines' stamps, then Cancel & Refund's booking lines (the old cancel's one statement),
    // then the orders' status, which counts both.
    await stampAddonLines(tx, shares.stamps)
    // Cancel & return credit gives no seat money: its lines are stamped only when all of it had gone back already,
    // after the add-ons (as cancelCreditBooking did), so the orders' status counts them too.
    const stamped = details.kind === 'cancel' ? [] : await stampLinesIfSeatMoneyAllBack(tx, claim.bookingId)
    if (details.kind === 'cancel') await stampCancelledBookingLines(tx, claim.bookingId, seatCard + seatStoreCredit > 0 || cancel.allBackAlready)
    for (const orderId of await cancelOrdersToRecount(tx, claim.bookingId, details.kind, cancel, plan, outcome, shares, stamped)) await recordOrderPaymentStatus(tx, orderId)
  } else if (cardRefunded + storeCredit > 0) {
    for (const orderId of new Set([...outcome.went.map((part) => part.orderId), ...(plan.ownOrderId ? [plan.ownOrderId] : []), ...(removedLine ? [removedLine.orderId] : [])])) {
      await recordOrderPaymentStatus(tx, orderId)
    }
  }
  // W22: the removed guest's line, once all of their seat's money went back (the old function didn't stamp it while
  // some was still to refund). W53: their own line (removedLine), stamped `card` when this removal sent card money back.
  if (details.kind === 'remove_guest' && details.guest && owed <= 0 && removedLine) await stampGuestLine(tx, removedLine.id, cardRefunded > 0)
  // W46 (W43a "Noticed" 3; W26 audit row 22): Refund the rest on a cancelled booking gave what was owed. Its lines
  // are stamped once all of their money is back, after the status above, and their orders' status worked out again.
  // W53: on a live booking too, for its owed add-on lines and its removed guests' lines (stampWhenOwedSettled).
  if (details.kind === 'refund_owed' && owed <= 0) {
    for (const orderId of await stampWhenOwedSettled(tx, claim.bookingId, cardRefunded > 0)) await recordOrderPaymentStatus(tx, orderId)
  }
  // W53 (brief item 4): what is owed on the booking has changed (it rose, or Refund the rest took it off), or cash was
  // handed back: every order of the booking is worked out again, the ones this refund never touched included. While
  // anything is owed none of them reads `refunded` (money-left.ts), and a cash part refund's order reads part refunded.
  if (owed > 0 || details.kind === 'refund_owed' || plan.cash > 0) await recordBookingOrdersPaymentStatus(tx, claim.bookingId)

  const cash = plan.cash
  // W33: a customer's own cancel is written as the customer's. W43: the lapse sweep's as the system's.
  const actor = { ...claimRowsActorOrSystem(claim), entityType: 'booking', entityId: claim.bookingId, requestId: by.requestId }
  const finishedBy = by.how === 'press' ? {} : { by: { how: by.how, type: by.actor.type, id: by.actor.id, ...(by.why ? { why: by.why } : {}) } }
  const entries: AuditEntry[] = [
    { ...actor, ...actionRow(details, { cardRefunded, storeCredit, owed, cash }) },
    {
      ...actor,
      action: REFUND_FINISHED,
      details: {
        claimId: claim.id,
        outcome: owed > 0 ? 'owed' : 'given',
        cardRefunded,
        storeCreditRefunded: storeCredit,
        owed,
        ...(cash > 0 ? { cash } : {}),
        ...(outcome.refused !== undefined ? { refused: outcome.refused } : {}),
        ...refundsForRow(outcome.went, outcome.refunds),
        ...finishedBy,
      },
    },
    // W32: a refund that hadn't succeeded yet is watched from the same transaction that records it as gone.
    ...claimWatchEntries({ id: claim.id, on: 'booking', subjectId: claim.bookingId, livemode: details.livemode }, outcome.went, outcome.refunds, { actor: by.actor, requestId: by.requestId }),
  ]
  await audit.recordAll(tx, entries)
  const pricePaid = (await tx.query<{ price_paid: string }>('SELECT price_paid::text AS price_paid FROM bookings WHERE id = $1::uuid', [claim.bookingId]))[0]?.price_paid
  if (shares) {
    // W23: a cancel answers its seat money and its add-ons' money apart, as the old function and the add-ons' did.
    return {
      cardRefundedAmount: seatCard,
      storeCreditRefundedAmount: seatStoreCredit,
      ...(balance !== undefined ? { storeCreditBalance: balance } : {}),
      ...(pricePaid !== undefined ? { pricePaid: Number.parseFloat(pricePaid) } : {}),
      ...(outcome.warning ? { warning: outcome.warning } : {}),
      addons: {
        cardRefundedAmount: shares.addons.card,
        storeCreditRefundedAmount: shares.addons.storeCredit,
        ...(addonsBalance !== undefined ? { storeCreditBalance: addonsBalance } : {}),
      },
    }
  }
  return {
    cardRefundedAmount: cardRefunded,
    storeCreditRefundedAmount: storeCredit,
    ...(cash > 0 ? { cashRefundedAmount: cash } : {}),
    ...(balance !== undefined ? { storeCreditBalance: balance } : {}),
    ...(pricePaid !== undefined ? { pricePaid: Number.parseFloat(pricePaid) } : {}),
    ...(outcome.warning ? { warning: outcome.warning } : {}),
  }
}

// --- W23: a cancel's R2 pieces (Cancel & Refund and Cancel & return credit; cancel.ts writes R1)

/** W23: each refunded add-on line's share, the add-ons' totals, and their store credit by paying order (in line order). */
export interface CancelShares {
  addons: { card: number; storeCredit: number }
  stamps: AddonLineStamp[]
  creditByOrder: Array<{ orderId: string | null; amount: number; described: string }>
}

/**
 * W23: where each refunded add-on line's money went. Its card share is its planned share of a part that went; the rest
 * of it (planned to store credit, or on a part that didn't go) went to store credit, unless the parts that didn't go
 * ended owed (`unsentOwed`: a claim closed by hand), when that share is owed and its line isn't stamped with it.
 */
export function cancelShares(cancel: CancelClaim, plan: RefundPlan, outcome: ClaimOutcome, unsentOwed: boolean): CancelShares {
  const went = new Set(outcome.went.map((part) => part.orderId))
  const planned = new Map<string, { card: number; went: number }>()
  for (const part of plan.card) {
    for (const line of part.lines) {
      if (!line.addon) continue
      const share = planned.get(line.lineId) ?? { card: 0, went: 0 }
      share.card = round2(share.card + line.amount)
      if (went.has(part.orderId)) share.went = round2(share.went + line.amount)
      planned.set(line.lineId, share)
    }
  }
  const stamps: AddonLineStamp[] = []
  const byOrder = new Map<string, { orderId: string | null; amount: number; described: string[] }>()
  let card = 0
  let storeCredit = 0
  for (const line of cancel.addons) {
    if (!line.paid || line.amount <= 0 || cancel.addonRefund === null) continue
    const share = planned.get(line.id) ?? { card: 0, went: 0 }
    const notSent = round2(share.card - share.went)
    const credit = round2(line.amount - share.card + (unsentOwed ? 0 : notSent))
    stamps.push({ id: line.id, refunded: round2(share.went + credit), card: share.went, method: share.went > 0 ? 'card' : credit > 0 ? 'credit' : 'none' })
    card = round2(card + share.went)
    storeCredit = round2(storeCredit + credit)
    if (credit > 0) {
      const key = line.orderId ?? ''
      const group = byOrder.get(key) ?? { orderId: line.orderId, amount: 0, described: [] }
      group.amount = round2(group.amount + credit)
      group.described.push(line.described)
      byOrder.set(key, group)
    }
  }
  return {
    addons: { card, storeCredit },
    stamps,
    creditByOrder: [...byOrder.values()].map((group) => ({ orderId: group.orderId, amount: group.amount, described: group.described.join(', ') })),
  }
}

/** W23: the old Cancel & Refund's store credit note for the booking's own money (shared/storeCreditRefund's `[ref …]` included). */
export const cancelSeatNote = (seatCard: number): string => `Booking refund${seatCard > 0 ? ' (the rest went back to the card).' : '.'} [ref ${crypto.randomUUID()}]`

/**
 * W23: the old Cancel & Refund's last statement for the booking's lines (shared/bookingRefund.ts), after the card
 * parts are on them: when money went back (or all of it had gone back already), every booking line that held seat money
 * is stamped refunded, by card when some of its money went back to the card, else store credit. A line with no seat
 * money keeps its stamp. Fixed text: ADDONS_INSIDE_LINE is a constant; the booking comes in as $1.
 */
const STAMP_CANCELLED_LINES_SQL = `
UPDATE order_line_items target
SET refunded_at = CASE WHEN $2::boolean AND seat.money THEN COALESCE(target.refunded_at, now()) ELSE target.refunded_at END,
    refund_method = CASE WHEN NOT $2::boolean OR NOT seat.money THEN target.refund_method
                         WHEN target.card_refunded_amount > 0 THEN 'card' ELSE 'credit' END
FROM (
  SELECT oli.id, oli.line_total - COALESCE(oli.discount_amount, 0) - inside.addons > 0 AS money
  FROM order_line_items oli
  ${ADDONS_INSIDE_LINE}
  WHERE oli.booking_id = $1::uuid AND oli.item_type = 'booking'
) seat
WHERE target.id = seat.id`

export async function stampCancelledBookingLines(tx: Tx, bookingId: string, refundedAny: boolean): Promise<void> {
  await tx.query(STAMP_CANCELLED_LINES_SQL, [bookingId, refundedAny])
}

/**
 * W23, ported from shared/bookingRefund.ts's seatMoneyAllBack: every penny of the booking's seat money has already gone
 * back (the card refunds on its booking lines and its store credit refunds, less the store credit that was for add-ons,
 * reach what its lines hold in seats). False when they held none, so a free booking never counts. Fixed text:
 * ADDONS_INSIDE_LINE is a constant; the booking comes in as $1.
 */
const SEAT_MONEY_ALL_BACK_SQL = `
WITH p AS (SELECT $1::uuid AS booking_id),
seats AS (
  SELECT COALESCE(SUM(GREATEST(oli.line_total - COALESCE(oli.discount_amount, 0) - inside.addons, 0)), 0) AS money,
         COALESCE(SUM(oli.card_refunded_amount), 0) AS card
  FROM p
  JOIN order_line_items oli ON oli.booking_id = p.booking_id AND oli.item_type = 'booking'
  ${ADDONS_INSIDE_LINE}
),
credit AS (
  SELECT COALESCE(SUM(sct.amount), 0) AS back
  FROM p JOIN store_credit_transactions sct ON sct.booking_id = p.booking_id AND sct.reason = 'refund'
),
addons AS (
  SELECT COALESCE(SUM(aol.refunded_amount - aol.card_refunded_amount), 0) AS credit
  FROM p JOIN addon_order_lines aol ON aol.booking_id = p.booking_id
)
SELECT seats.money > 0 AND seats.card + credit.back - addons.credit >= seats.money AS all_back
FROM seats, credit, addons`

export async function seatMoneyAllBack(db: Queryable, bookingId: string): Promise<boolean> {
  return (await db.query<{ all_back: boolean }>(SEAT_MONEY_ALL_BACK_SQL, [bookingId]))[0]?.all_back === true
}

/** W23, ported from stampLinesIfSeatMoneyAllBack: the lines that held seat money, stamped refunded when all of it is back. */
const STAMP_ALL_BACK_SQL = `
UPDATE order_line_items
SET refunded_at = COALESCE(refunded_at, now()),
    refund_method = COALESCE(refund_method, CASE WHEN card_refunded_amount > 0 THEN 'card' ELSE 'credit' END)
WHERE id IN (
  SELECT oli.id
  FROM order_line_items oli
  ${ADDONS_INSIDE_LINE}
  WHERE oli.booking_id = $1::uuid AND oli.item_type = 'booking'
    AND oli.line_total - COALESCE(oli.discount_amount, 0) - inside.addons > 0
)
RETURNING order_id`

/**
 * W23: after a cancel that gave no seat money itself (Cancel & return credit), the booking's lines are stamped when all
 * their seat money had gone back already (a paid guest refunded earlier). Answers the stamped lines' orders, whose
 * status the caller works out again.
 */
export async function stampLinesIfSeatMoneyAllBack(tx: Tx, bookingId: string): Promise<string[]> {
  if (!(await seatMoneyAllBack(tx, bookingId))) return []
  const stamped = await tx.query<{ order_id: string }>(STAMP_ALL_BACK_SQL, [bookingId])
  return [...new Set(stamped.map((row) => row.order_id))]
}

// --- W46: a cancelled booking's money owed, settled (W43a "Noticed" 3; the W26 audit's row 22)
//
// Money owed on a cancelled booking is card refund money that never reached the customer (Q39): the booking's lines
// stay unstamped while it is owed, because not all of their money is back. Before W46 nothing stamped them when staff
// later settled it (Refund the rest, It already arrived): the £20 guest whose lapse gave £15 with £5 owed kept
// `refunded_at` null for ever after the £5 was given, and its order never read as refunded. And an add-on line whose
// refund was part of the money owed went on reading "£0 back" after Refund the rest had given its share.
// Now, when either action leaves nothing owed on a cancelled booking:
// - Refund the rest: every removed add-on line whose refund a claim planned to send to a card, and which is not
//   stamped with all of its money, is stamped with it (store credit, or card when some of it had gone to the card).
//   Such a line is short of its money only because its card share never arrived (never sent, refused, not found, or
//   failed later and taken off the line by the refund watch, W32), so its share is in what was owed, and what is
//   owed is always given whole on a cancelled booking. A claim that was put back doesn't count: its line went back
//   on the booking, and if it was removed again later with nothing back, that money was kept;
// - both: the booking lines that held seat money are stamped refunded when all of that money is then back. "Back"
//   counts what the old test counted (card refunds on the lines, the booking's store credit refunds less the add-ons'
//   share), less any add-on share of the money owed that no stamp accounts for;
// - the orders of every line stamped have their status worked out again.
// W47 (the W35 audit's row 6; W46 "Noticed" 8, review L4; Wayne, 19 Nov): when staff say the money reached the card,
// It already arrived records it as card money on the lines (stampArrivedCard, below), so it is in the lines' own card
// figures. W46 counted the whole of every `booking.refund_owed_arrived` row instead (the `arrived` term of
// SEAT_MONEY_SETTLED_SQL): counted like that, card money on the lines would be counted twice, so that term is gone.
// What is counted from the rows now is only the part that is on no line (`elsewhere`: the row's amount less the card
// money it recorded): all of it when it arrived another way (or the row is from before W47), nothing when the cards
// could account for all of it. And It already arrived stamps the add-on lines when it settles what was owed, as
// Refund the rest does.
// A booking whose money was kept (a lapse inside 24 hours) is not stamped by settling what was owed on it: the test is
// all of the seat money, not what was owed. The stamps are written once: a line already stamped keeps its time.

// W70d: OWED_ADDON_LINES_SQL (W46: the booking's removed add-on lines whose card refund is part of what is, or was,
// owed) is in money-left.ts now, which counts what they are short of; it is read here as before.

/** W47: the same lines in a fixed order (by id), for It already arrived to record card money on (stampArrivedCard). */
const OWED_ADDON_LINES_IN_ORDER_SQL = `${OWED_ADDON_LINES_SQL}
ORDER BY aol.id`

/** W46: those lines stamped with all of their money: store credit, or card when some of it went to the card. */
const STAMP_OWED_ADDON_LINES_SQL = `
UPDATE addon_order_lines
SET refunded_amount = price_at_purchase * quantity,
    refund_method = CASE WHEN card_refunded_amount > 0 THEN 'card' ELSE 'credit' END
WHERE id IN (SELECT owed.id FROM (${OWED_ADDON_LINES_SQL}) owed)
RETURNING order_id`

/**
 * W46: SEAT_MONEY_ALL_BACK_SQL for a cancelled booking with nothing owed any more, less any add-on share of the money
 * owed that no add-on line's stamp accounts for. False while anything is owed, on a booking that isn't cancelled, and
 * when the lines held no seat money. Fixed text; the booking comes in as $1.
 * W47: money It already arrived took off is on the lines as card money (`seats.card`, and the add-on lines' own
 * card figures), so it is no longer added whole from the `booking.refund_owed_arrived` rows. Only what a row says is
 * on no line is (`elsewhere`: its amount less its `card`; a row from before W47 has no `card`): counted once.
 */
const SEAT_MONEY_SETTLED_SQL = `
WITH p AS (SELECT b.id AS booking_id FROM bookings b WHERE b.id = $1::uuid AND b.status = 'cancelled' AND b.refund_owed_amount <= 0),
seats AS (
  SELECT COALESCE(SUM(GREATEST(oli.line_total - COALESCE(oli.discount_amount, 0) - inside.addons, 0)), 0) AS money,
         COALESCE(SUM(oli.card_refunded_amount), 0) AS card
  FROM p
  JOIN order_line_items oli ON oli.booking_id = p.booking_id AND oli.item_type = 'booking'
  ${ADDONS_INSIDE_LINE}
),
credit AS (
  SELECT COALESCE(SUM(sct.amount), 0) AS back
  FROM p JOIN store_credit_transactions sct ON sct.booking_id = p.booking_id AND sct.reason = 'refund'
),
addons AS (
  SELECT COALESCE(SUM(aol.refunded_amount - aol.card_refunded_amount), 0) AS credit
  FROM p JOIN addon_order_lines aol ON aol.booking_id = p.booking_id
),
elsewhere AS (
  SELECT COALESCE(SUM((a.details->>'amount')::numeric - COALESCE((a.details->>'card')::numeric, 0)), 0) AS back
  FROM p JOIN audit_log a ON a.action = 'booking.refund_owed_arrived' AND a.entity_type = 'booking' AND a.entity_id = p.booking_id::text
),
owed_addons AS (
  SELECT COALESCE(SUM(owed.amount - owed.refunded_amount), 0) AS unstamped FROM (${OWED_ADDON_LINES_SQL}) owed
)
SELECT EXISTS (SELECT 1 FROM p) AND seats.money > 0
       AND seats.card + credit.back + elsewhere.back - addons.credit - owed_addons.unstamped >= seats.money AS all_back
FROM seats, credit, addons, elsewhere, owed_addons`

/**
 * W53 (W05h item 6): the guests of the booking (`$1`) whose removal's refund ended with money owed (a Remove Guest
 * claim whose finished row says `owed`): their lines were left unstamped then, because not all of the seat's money had
 * gone back. Oldest first. Only claims that name the guest's own line (W53 on) are answered.
 */
const GUESTS_REMOVED_OWED_SQL = `
SELECT c.details->'guest'->>'id' AS id, c.details->'guest'->'line'->>'id' AS line_id
FROM audit_log c
WHERE c.action = '${REFUND_CLAIMED}' AND c.entity_type = 'booking' AND c.entity_id = $1::text
  AND c.details->>'kind' = 'remove_guest' AND c.details->'guest'->'line'->>'id' IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM audit_log f
    WHERE f.action = '${REFUND_FINISHED}' AND f.entity_type = 'booking' AND f.entity_id = c.entity_id
      AND f.details->>'claimId' = c.id::text AND f.details->>'outcome' = 'owed'
  )
ORDER BY c.at, c.id`

/**
 * W53 (W05h items 2 and 6): the order of the one removed guest whose line is still waiting for money owed (their
 * refund ended owed and their line isn't stamped yet), or null when there is none, or more than one.
 */
const GUEST_LINES_WAITING_SQL = `SELECT oli.order_id FROM (${GUESTS_REMOVED_OWED_SQL}) g JOIN order_line_items oli ON oli.id::text = g.line_id WHERE oli.refunded_at IS NULL`
async function orderOfTheOneGuestOwed(tx: Tx, bookingId: string): Promise<string | null> {
  const waiting = await tx.query<{ order_id: string }>(GUEST_LINES_WAITING_SQL, [bookingId])
  return waiting.length === 1 ? (waiting[0]?.order_id ?? null) : null
}

/**
 * W46: after Refund the rest or It already arrived, under the booking's lock. Nothing is stamped while anything is
 * still owed. Answers the orders of the lines it stamped, whose status the caller works out again.
 * W47: It already arrived stamps the add-on lines too (it stamped only the booking lines).
 * W53: on a live booking too (until W53 only a cancelled one):
 *  - W47 review L1: its removed add-on lines whose refund was part of what was owed are stamped with their money, as
 *    on a cancelled booking (before, such a line read "£0 back" for ever on a live booking);
 *  - W05h item 6: the line of a guest whose removal's refund had ended owed is stamped now that the rest has been
 *    given or has arrived (`byCard`: it went to the card), so the guest's order can read `refunded`.
 * The booking lines themselves are stamped only on a cancelled booking, as before: a live one still holds its seats.
 */
export async function stampWhenOwedSettled(tx: Tx, bookingId: string, byCard = false): Promise<string[]> {
  const booking = (await tx.query<{ cancelled: boolean; settled: boolean }>("SELECT (status = 'cancelled') AS cancelled, (refund_owed_amount <= 0) AS settled FROM bookings WHERE id = $1::uuid", [bookingId]))[0]
  if (booking?.settled !== true) return []
  const orders = new Set<string>()
  // Everything owed has been given, or has arrived: the add-on lines whose refund was part of it now have their money.
  for (const row of await tx.query<{ order_id: string | null }>(STAMP_OWED_ADDON_LINES_SQL, [bookingId])) if (row.order_id) orders.add(row.order_id)
  // W47: and the ones It already arrived had already filled with card money.
  for (const row of await tx.query<{ order_id: string | null }>(STAMP_ARRIVED_ADDON_LINES_SQL, [bookingId])) if (row.order_id) orders.add(row.order_id)
  if (booking.cancelled === true) {
    if ((await tx.query<{ all_back: boolean }>(SEAT_MONEY_SETTLED_SQL, [bookingId]))[0]?.all_back === true) {
      for (const row of await tx.query<{ order_id: string }>(STAMP_ALL_BACK_SQL, [bookingId])) orders.add(row.order_id)
    }
    return [...orders]
  }
  // W53 (W05h item 6): a live booking's removed guests whose refund had ended owed.
  for (const guest of await tx.query<{ id: string; line_id: string }>(GUESTS_REMOVED_OWED_SQL, [bookingId])) {
    const orderId = await stampGuestLine(tx, guest.line_id, byCard)
    if (orderId) orders.add(orderId)
  }
  return [...orders]
}

/**
 * W23: the orders whose payment status a cancel works out again, as the old code did: Cancel & Refund, every order with
 * a booking line for the booking, each part's and its own order; Cancel & return credit, the orders R1 stamped; both,
 * each order an add-on's money went back to.
 */
async function cancelOrdersToRecount(
  tx: Tx,
  bookingId: string,
  kind: RefundKind,
  cancel: CancelClaim,
  plan: RefundPlan,
  outcome: ClaimOutcome,
  shares: CancelShares,
  stamped: readonly string[]
): Promise<string[]> {
  const orders: string[] = [...stamped]
  if (kind === 'cancel') {
    const rows = await tx.query<{ order_id: string }>("SELECT DISTINCT order_id FROM order_line_items WHERE booking_id = $1::uuid AND item_type = 'booking'", [bookingId])
    orders.push(...rows.map((row) => row.order_id), ...outcome.went.map((part) => part.orderId), ...(plan.ownOrderId ? [plan.ownOrderId] : []))
  } else if (cancel.seatAmount > 0) {
    // W25: the club's Cancel & return credit that refunded paid guests: the orders their money went back to.
    orders.push(...outcome.went.map((part) => part.orderId), ...(plan.ownOrderId ? [plan.ownOrderId] : []))
  }
  for (const stamp of shares.stamps) {
    const line = cancel.addons.find((one) => one.id === stamp.id)
    if (line?.orderId && stamp.refunded > 0) orders.push(line.orderId)
  }
  return [...new Set(orders)]
}

/** R2 in a transaction of its own, run once more after a deadlock (it is safe twice: the finished row is checked). */
export async function finishClaim(db: Db, claim: Claim, outcome: ClaimOutcome, by: FinishedBy): Promise<RefundBookingOutput | null> {
  try {
    return await db.transaction((tx) => finishClaimInTransaction(tx, claim, outcome, by))
  } catch (err) {
    if (!isDeadlock(err)) throw err
    return db.transaction((tx) => finishClaimInTransaction(tx, claim, outcome, by))
  }
}

/**
 * W25 (W22 review later 2, W23 review later 2, W24 review L1): the undo can't put the booking back because what R1
 * gave back has been taken since: the session's places (another booking), the pass session (spent), or (W37a) the
 * membership session credit (spent on another booking, or taken off the period by an adjustment); or (W51a, W51
 * review S1) because the session itself has been blocked, or its start time moved, since. Thrown inside
 * the undo's transaction, so nothing of the undo is kept: the change stands, and the press finishes the claim there and
 * then with every card part owed on the booking (W25a; `finishRefusedNotPutBack`).
 */
export class PutBackBlocked extends Error {
  constructor(what: string) {
    super(`The undo can't put the booking back: ${what}.`)
    this.name = 'PutBackBlocked'
  }
}

/** The session takes `places` back only while it has room for them (a private session: only while it is empty again). */
async function takePlacesBack(tx: Tx, sessionId: string, places: number): Promise<void> {
  if (places <= 0) return
  const taken = await tx.query(
    'UPDATE sessions SET total_booked = total_booked + $1::int, updated_at = now() WHERE id = $2::uuid AND (capacity - total_booked) >= $1::int RETURNING id',
    [places, sessionId]
  )
  if (taken.length !== 1) throw new PutBackBlocked(`session ${sessionId} no longer has ${places} free place${places === 1 ? '' : 's'}`)
}

/**
 * W51a (W51 review S1; GB5, GB6): a booking goes back onto a session only while that session is still open and
 * still at the time the booking has. Between R1 and this undo the booking wasn't on the session (a cheaper Move) or
 * was cancelled (a cancel), so a block or a start-time change saw no booking in the way and went ahead. Put back
 * regardless, the customer would hold a confirmed booking on a blocked session, or one whose times aren't the
 * session's. The caller holds the session's lock (lockForBooking), which a block and a start-time change take, so
 * what is read here is how the session stays until the undo commits. Otherwise PutBackBlocked: the change stands
 * and the refund ends as money still to refund (W25).
 */
const SESSION_TAKES_BOOKING_BACK_SQL = "SELECT id FROM sessions WHERE id = $1::uuid AND status = 'open' AND start_time = $2::timestamptz"
async function requireSessionAsItWas(tx: Tx, sessionId: string, startTime: string): Promise<void> {
  const asItWas = await tx.query(SESSION_TAKES_BOOKING_BACK_SQL, [sessionId, startTime])
  if (asItWas.length !== 1) throw new PutBackBlocked(`session ${sessionId} has been blocked or its start time changed since`)
}
/** A cancelled booking's own start time: a cancel doesn't change it, so it is the time its session had. */
const BOOKING_START_SQL = 'SELECT start_time FROM bookings WHERE id = $1::uuid'

/** The pass gives back the session it was handed only while it still has one: never below 0. */
async function takePassSessionBack(tx: Tx, passId: string): Promise<void> {
  const taken = await tx.query(
    'UPDATE customer_session_passes SET sessions_remaining = sessions_remaining - 1, updated_at = now() WHERE id = $1::uuid AND sessions_remaining >= 1 RETURNING id',
    [passId]
  )
  if (taken.length !== 1) throw new PutBackBlocked(`pass ${passId} has no session left to take back`)
}

/**
 * W37a (W37 review S1): the booking takes back the membership session credit a cheaper Move released only while its
 * period still has one free: unlimited, or fewer credit bookings than it allocates (New Order's own count,
 * write-booking.ts). The caller holds the period's lock (LOCK_ORDER) and hasn't put the booking back on it yet, so
 * the count is current and leaves this booking out. Never used above allocated.
 */
async function takeCreditBack(tx: Tx, periodId: string): Promise<void> {
  const free = await tx.query(
    `SELECT p.id FROM membership_credit_periods p
     WHERE p.id = $1::uuid
       AND (p.is_unlimited OR (
         SELECT count(*) FROM bookings b
         WHERE b.credit_period_id = p.id AND b.redemption_source = 'membership_credit' AND b.status <> 'cancelled'
       ) < p.credits_allocated)`,
    [periodId]
  )
  if (free.length !== 1) throw new PutBackBlocked(`credit period ${periodId} has no credit left to take back`)
}

/**
 * W58b (the W45 audit's row 8; W37 review S2): the membership takes back the add-on credits a cancel's R1 gave it
 * only while it still has them: never below zero. Spent meanwhile (or taken off by staff), the undo is blocked, as a
 * spent pass session is, and staff get the blocked words. Before this, migration 025's check refused the write and the
 * undo failed with the "couldn't be put back" words; the money ended owed on the booking either way.
 */
const TAKE_ADDON_CREDITS_BACK_SQL = `UPDATE customer_memberships SET addon_credits_remaining = addon_credits_remaining - $1::int, updated_at = now()
WHERE id = $2::uuid AND addon_credits_remaining >= $1::int RETURNING id`
async function takeAddonCreditsBack(tx: Tx, membershipId: string, credits: number): Promise<void> {
  const taken = await tx.query(TAKE_ADDON_CREDITS_BACK_SQL, [credits, membershipId])
  if (taken.length !== 1) throw new PutBackBlocked(`membership ${membershipId} has no ${credits === 1 ? 'add-on credit' : `${credits} add-on credits`} left to take back`)
}

/** The credit period a cheaper Move's R1 released the booking's membership credit from, or null when it released none. */
const creditPeriodReleased = (move: MoveClaim | undefined): string | null =>
  move?.creditReleased && move.oldRedemptionSource === 'membership_credit' ? move.oldCreditPeriodId : null

/**
 * The first card part was refused, so nothing went: R1 undone in one transaction, as the old put-backs did. A part
 * refund was never one (price_paid and part_refunded_amount back); Refund the rest's money is owed again. False when
 * the claim was finished already. W58 (W35 audit row 44, W26a review L2): run once more after a deadlock, as W29a's
 * order undo is. Postgres rolled the whole of the first try back, and the undo checks the claim is still open, so the
 * second try can't undo anything twice.
 */
async function undoClaim(db: Db, claim: Claim, by: FinishedBy): Promise<boolean> {
  try {
    return await undoClaimOnce(db, claim, by)
  } catch (err) {
    if (!isDeadlock(err)) throw err
    return undoClaimOnce(db, claim, by)
  }
}

async function undoClaimOnce(db: Db, claim: Claim, by: FinishedBy): Promise<boolean> {
  return db.transaction(async (tx) => {
    // W22: a removed guest's place goes back to the booking's session, so it is locked too (LOCK_ORDER). W23: a cancel's
    // places too, with the memberships its add-on credits went back to and the pass it gave a session back to.
    const cancel = claim.details.cancel
    // W24: a Move's two sessions (in id order) and the pass its released seat gave a session back to. W37a: and the
    // credit period its released membership credit goes back to (after the sessions, before the pass).
    const move = claim.details.move
    const creditPeriod = creditPeriodReleased(move)
    const locks = await lockForBooking(tx, {
      bookingId: claim.bookingId,
      ownSession: claim.details.kind === 'remove_guest' || cancel !== undefined,
      sessionIds: move ? [move.oldSessionId, move.newSessionId] : [],
      creditPeriodIds: creditPeriod ? [creditPeriod] : [],
      membershipIds: (cancel?.addons ?? []).filter((line) => line.creditsReturned > 0 && line.membershipId).map((line) => line.membershipId as string),
      sessionPassId: cancel?.passReturned ?? move?.passReturned ?? null,
    })
    if (!locks) throw new Error(`The booking of refund claim ${claim.id} no longer exists.`)
    if (await claimFinished(tx, claim)) return false
    const { amount, kind } = claim.details
    if (cancel) {
      await undoCancel(tx, claim.bookingId, cancel)
    } else if (move) {
      await undoMoveClaim(tx, claim.bookingId, amount, move)
    } else if (kind === 'part_refund') {
      await tx.query(
        'UPDATE bookings SET price_paid = price_paid + $1::numeric, part_refunded_amount = GREATEST(part_refunded_amount - $1::numeric, 0), updated_at = now() WHERE id = $2::uuid',
        [amount, claim.bookingId]
      )
    } else if (kind === 'remove_guest') {
      // W22: the guest comes back exactly as they were (their row as R1 found it), with their place and their money.
      const guest = claim.details.guest
      if (!guest?.restore) throw new Error(`Refund claim ${claim.id} has no guest to put back.`)
      await tx.query('INSERT INTO booking_guests SELECT * FROM jsonb_populate_record(NULL::booking_guests, $1::jsonb)', [JSON.stringify(guest.restore)])
      await tx.query('UPDATE bookings SET price_paid = price_paid + $1::numeric, party_size = party_size + 1, updated_at = now() WHERE id = $2::uuid', [amount, claim.bookingId])
      if (guest.placeReleased) await takePlacesBack(tx, locks.bookingSessionId, 1)
    } else if (kind === 'remove_addon') {
      // W22: the add-on goes back on the booking (cancelBookingAddonLines' unclaim): nothing went back for it.
      await tx.query('UPDATE addon_order_lines SET removed_at = NULL, removed_by = NULL WHERE id = ANY($1::uuid[])', [(claim.details.addon?.lines ?? []).map((line) => line.id)])
    } else {
      await tx.query(
        'UPDATE bookings SET price_paid = price_paid + $1::numeric, refund_owed_amount = refund_owed_amount + $1::numeric, updated_at = now() WHERE id = $2::uuid',
        [amount, claim.bookingId]
      )
    }
    await audit.recordAll(tx, [
      {
        actorType: 'staff',
        actorId: claim.staffId,
        action: REFUND_FINISHED,
        entityType: 'booking',
        entityId: claim.bookingId,
        requestId: by.requestId,
        details: { claimId: claim.id, outcome: kind === 'refund_owed' ? 'owed' : 'put_back', cardRefunded: 0, storeCreditRefunded: 0, owed: kind === 'refund_owed' ? amount : 0 },
      },
    ])
    return true
  })
}

/**
 * W23: a cancel's R1 put back exactly (the first card part refused, so nothing went): the booking's status, cancelled
 * time and money owed as they were; its places back on the session; the pass session taken back; the add-on credits
 * taken back from their membership; the add-on lines back on the booking with their stamps as they were.
 */
async function undoCancel(tx: Tx, bookingId: string, cancel: CancelClaim): Promise<void> {
  // W51a (S1): only onto a session still open and still at the booking's time (PutBackBlocked otherwise).
  const start = (await tx.query<{ start_time: Date | string }>(BOOKING_START_SQL, [bookingId]))[0]?.start_time
  if (start === undefined) throw new Error(`Booking ${bookingId} no longer exists.`)
  await requireSessionAsItWas(tx, cancel.sessionId, start instanceof Date ? start.toISOString() : start)
  await tx.query('UPDATE bookings SET status = $1::text, cancelled_at = $2::timestamptz, refund_owed_amount = $3::numeric, updated_at = now() WHERE id = $4::uuid', [
    cancel.status,
    cancel.cancelledAt,
    cancel.refundOwed,
    bookingId,
  ])
  // W25: only while the session still has the places and the pass still has the session (PutBackBlocked otherwise).
  await takePlacesBack(tx, cancel.sessionId, cancel.placesReleased)
  if (cancel.passReturned) await takePassSessionBack(tx, cancel.passReturned)
  for (const line of cancel.addons) {
    if (line.creditsReturned > 0 && line.membershipId) await takeAddonCreditsBack(tx, line.membershipId, line.creditsReturned)
    await tx.query(
      'UPDATE addon_order_lines SET removed_at = NULL, removed_by = NULL, refunded_amount = $1::numeric, card_refunded_amount = $2::numeric, refund_method = $3::text WHERE id = $4::uuid',
      [line.was.refunded, line.was.card, line.was.method, line.id]
    )
  }
}

/**
 * W24: a cheaper Move's R1 put back exactly (the first card part refused, so nothing went): the booking on its old
 * session with its old times, band and credit, price_paid back up by the refund; each seat's price and cover as they
 * were; the new session's places given back and the old session's taken again (by what R1 changed); the pass session
 * a released pass seat gave back taken back. W37a: a released membership credit goes back only while its period
 * still has one free, checked before the booking is put back on it (PutBackBlocked otherwise).
 */
async function undoMoveClaim(tx: Tx, bookingId: string, amount: number, move: MoveClaim): Promise<void> {
  const creditPeriod = creditPeriodReleased(move)
  if (creditPeriod) await takeCreditBack(tx, creditPeriod)
  // W51a (S1): only onto an old session still open and still at the booking's old start time (PutBackBlocked otherwise).
  await requireSessionAsItWas(tx, move.oldSessionId, move.oldStartTime)
  await tx.query(
    `UPDATE bookings
     SET session_id = $1::uuid, start_time = $2::timestamptz, end_time = $3::timestamptz, price_paid = price_paid + $4::numeric,
         band_id = $5::uuid, credit_period_id = $6::uuid, redemption_source = $7::text, redeemed_membership_id = $8::uuid,
         redeemed_session_pass_id = $9::uuid, updated_at = now()
     WHERE id = $10::uuid`,
    [
      move.oldSessionId,
      move.oldStartTime,
      move.oldEndTime,
      amount,
      move.oldBandId,
      move.oldCreditPeriodId,
      move.oldRedemptionSource,
      move.oldRedeemedMembershipId,
      move.oldRedeemedSessionPassId,
      bookingId,
    ]
  )
  for (const seat of move.seats) {
    await tx.query('UPDATE booking_guests SET unit_price = $1::numeric, pay_by = $2::text WHERE id = $3::uuid', [seat.unitPrice, seat.payBy, seat.id])
  }
  if (move.placesClaimed !== 0) {
    await tx.query('UPDATE sessions SET total_booked = total_booked - $1::int, updated_at = now() WHERE id = $2::uuid', [move.placesClaimed, move.newSessionId])
  }
  // W25: the old session's places only while it still has them, and the pass session only while the pass still has it
  // (PutBackBlocked otherwise: the move stands and the refund ends as money still to refund). W37a: the membership
  // credit the same way, above.
  await takePlacesBack(tx, move.oldSessionId, move.placesReleased)
  if (move.passReturned) await takePassSessionBack(tx, move.passReturned)
}

// --- The press: each card part once, then R2

// W27: one part's request and its send (`sendCardPart`: once, under its key, sent once more only on an unclear answer)
// are the shared core's.

const held = (claim: Claim, reason: string, message: string, cardGone = 0): RefundBookingOutput => heldAnswer(claim.id, reason, message, cardGone)

/**
 * W26a: the mark that Stripe refused one of the claim's card parts, written before anything else is tried (the undo,
 * R2), in a transaction of its own, twice at most. Reconcile reads it (`claimRefusal`): a claim the press couldn't
 * finish then ends as money owed, never as store credit on a cancelled booking. A mark that can't be written is passed
 * over: the press carries on, and its own finish records the refusal.
 */
async function markRefused(db: Db, claim: Claim, part: CardPart, detail: string, requestId: string): Promise<void> {
  return markRefusedOn(db, BOOKING_CLAIMS, { id: claim.id, subjectId: claim.bookingId, staffId: claim.staffId }, part, detail, requestId)
}

/** W26a: Stripe's reason when it refused one of the claim's card parts (the first mark), or null when it never did. */
export async function claimRefusal(db: Queryable, claim: Pick<Claim, 'id' | 'bookingId'>): Promise<string | null> {
  return claimRefusalOn(db, BOOKING_CLAIMS, { id: claim.id, subjectId: claim.bookingId })
}

/**
 * The first card part was refused and the undo didn't put the booking back, so the change stands. W25a (W25 review
 * S1): when the undo was blocked (`PutBackBlocked`); W26a (audit S2; Wayne, 14 Nov): when it failed for any other
 * reason too. The claim is finished now as a close by hand finishes it: nothing gone, every card part owed on the
 * booking (kept owed on a cancelled booking too, never store credit: Stripe's refusal may mean the customer has the
 * money already), the plan's own store credit given. Reconcile never sees the claim. The answer is still `held` (the
 * screens show its words), with Stripe's reason and the two buttons. If the finish fails as well, the claim stays open
 * with the refusal's mark, and reconcile finishes it the same way (owed, never store credit). Null when the claim was
 * finished already: the undo's COMMIT went through and only its answer was lost (nothing else can finish a claim
 * within a press), so the booking is back as it was and the press answers as for any refused first part.
 */
async function finishRefusedNotPutBack(db: Db, claim: Claim, options: RefundOptions, detail: string, blocked: boolean): Promise<RefundBookingOutput | null> {
  const owed = sum(claim.details.plan.card.map((part) => part.amount))
  const cancelled = claim.details.cancel !== undefined
  try {
    // W58 (W26a review L4): a first part Stripe refused carries `refused` on the finished row, as a later refusal's and
    // reconcile's do, so a report counting refusals by `details.refused` finds it (a part never sent was refused by nobody).
    const refusal = detail !== REFUND_NOT_SENT_DETAIL ? { refused: detail } : {}
    const output = await finishClaim(db, claim, { went: [], owed, ...refusal }, { actor: options.actor, requestId: options.requestId, how: blocked ? 'undo_blocked' : 'undo_failed', why: detail })
    if (!output) return null
    // W31: the words name the store credit the finish gave (the plan's own), so nobody gives it again by hand.
    // W32 (W31 review S2): the add-ons' store credit with the seat's (a cancel answers the two apart).
    const storeCredit = round2((output.storeCreditRefundedAmount ?? 0) + (output.addons?.storeCreditRefundedAmount ?? 0))
    const words = blocked ? putBackBlockedMessage(detail, owed, cancelled, storeCredit) : putBackFailedMessage(detail, owed, cancelled, storeCredit)
    return { ...output, held: { claimId: claim.id, reason: 'refund_refused_not_put_back', message: words } }
  } catch {
    return held(claim, 'refund_refused_not_put_back', blocked ? putBackBlockedNotRecordedMessage(detail) : putBackFailedNotRecordedMessage(detail))
  }
}

/**
 * After R1 has committed a claim with card parts: each part once, in the plan's order (newest order first), then R2.
 * A refusal is marked on the claim first (W26a, `markRefused`). The first part sent that is refused undoes R1 and is
 * thrown with the old words; an undo that doesn't put the booking back (blocked, or failed for any reason) finishes
 * the claim as money owed (`finishRefusedNotPutBack`). A later part refused ends with it and every part after it owed
 * on the booking, with Stripe's reason (W26a: no longer store credit); a later one with no time left to send ends with
 * the rest as owed too (W21 review L6: Stripe never got it). No clear answer holds the claim for reconcile (Q35), as
 * does R2 failing after money went (W6-3's rule for refunds: what went is never sent again, reconcile records it).
 */
export async function sendAndFinish(db: Db, stripe: StripeClient, claim: Claim, options: RefundOptions, timing: StripeTiming, firstRefused: FirstRefused): Promise<RefundBookingOutput> {
  const by: FinishedBy = { actor: options.actor, requestId: options.requestId, how: 'press' }
  const went: CardPart[] = []
  /** W32: each part's refund as Stripe answered it. */
  const refunds: RefundSeen[] = []
  const toSend = claim.details.plan.card
  let sentOne = false
  let owed = 0
  let refused: string | undefined
  let warning: string | undefined
  for (const [index, part] of toSend.entries()) {
    const answer = await sendCardPart(stripe, claim.id, part, timing)
    if (answer.outcome === 'went') {
      went.push(part)
      refunds.push(refundSeen(part, answer.refund))
      sentOne = true
      continue
    }
    if (answer.outcome === 'unclear') return held(claim, 'refund_unconfirmed', CHANGE_REFUND_UNCONFIRMED_MESSAGE)
    // W26a: Stripe's refusal is on the claim before the undo or R2 is tried, so reconcile never reads it as "not found".
    if (answer.outcome === 'refused') await markRefused(db, claim, part, answer.detail, options.requestId)
    if (!sentOne) {
      const detail = answer.outcome === 'not_sent' ? REFUND_NOT_SENT_DETAIL : answer.detail
      try {
        await undoClaim(db, claim, by)
      } catch (err) {
        // W25: the places or the pass session have been taken since. W26a: or the undo failed for any other reason.
        // Either way the change stands, and the money is owed on the booking for a person to decide.
        const ended = await finishRefusedNotPutBack(db, claim, options, detail, err instanceof PutBackBlocked)
        if (ended) return ended
      }
      throw firstRefused(detail)
    }
    // Never sent (no time left) or refused: this part and every part after it are still owed on the booking.
    owed = sum(toSend.slice(index).map((later) => later.amount))
    if (answer.outcome === 'not_sent') {
      // Never sent, so never refused: Refund the rest can send it to the card.
      warning = laterCardRefundNotSentMessage(owed, claim.details.cancel !== undefined)
    } else {
      // W26a (Wayne, 14 Nov): refused, so a person decides (It already arrived, or Refund the rest), with the reason.
      refused = answer.detail
      warning = laterCardRefundRefusedMessage(part.amount, answer.detail, owed, claim.details.cancel !== undefined)
    }
    break
  }
  try {
    const output = await finishClaim(db, claim, { went, refunds, owed, ...(refused !== undefined ? { refused } : {}), ...(warning ? { warning } : {}) }, by)
    // Finished by someone else (a close): what went is theirs to report.
    return output ?? held(claim, 'refund_finished_elsewhere', refundGoneNotRecordedMessage(sum(went.map((part) => part.amount))), sum(went.map((part) => part.amount)))
  } catch {
    const gone = sum(went.map((part) => part.amount))
    return held(claim, 'refund_not_recorded', refundGoneNotRecordedMessage(gone), gone)
  }
}

// --- The three actions

const notSaved = (logDetail: string): ApiError => refundRefusal('INTERNAL', 'refund_not_saved', REFUND_NOT_SAVED_MESSAGE, { logDetail })

export type R1 = (tx: Tx, livemode: boolean | null) => Promise<Started>

/**
 * W22: what the press throws when the first card part is refused (nothing went, R1 undone): the action's own reason
 * and words, from the refusal's detail ("Failed to refund payment: …").
 */
export type FirstRefused = (detail: string) => ApiError

/** W21's words for Part refund and Refund the rest (shared/bookingRefund.ts's). */
const refundFirstRefused: FirstRefused = (detail) => refundRefusal('PAYMENT_FAILED', 'refund_failed', cardRefundFailedMessage(detail))

/** R1 in its transaction (with C1's once-only deadlock retry and plain words for a fault), then the card parts. */
export async function run(
  db: Db,
  card: boolean,
  options: RefundOptions,
  r1: R1,
  firstRefused: FirstRefused = refundFirstRefused,
  notSavedAs: (logDetail: string) => ApiError = notSaved
): Promise<RefundBookingOutput> {
  // A card refund needs Stripe: the client is made before R1, so a missing key fails with nothing written.
  const stripe = card && options.stripe ? options.stripe() : null
  const timing = stripeTiming(options.startedAt ?? Date.now(), options.now ?? Date.now)
  // A COMMIT with no answer (INTERNAL) may have saved a claim whose card parts were never sent: reconcile finds it,
  // finds nothing in Stripe, and the money ends as owed (Refund the rest).
  const started = await inC1(db, (tx) => r1(tx, stripe?.keyLivemode ?? null), notSavedAs)
  if (started.kind === 'done') return started.output
  if (!stripe) throw new Error('A card refund was planned with no Stripe client.')
  return sendAndFinish(db, stripe, started.claim, options, timing, firstRefused)
}

/** Part refund: gives `amount` of what is left, to the card (the rest to store credit), to store credit, or in cash. */
export function partRefund(db: Db, bookingId: string, input: PartRefundInput, options: RefundOptions): Promise<RefundBookingOutput> {
  return run(db, input.refundMethod === 'card', options, (tx, livemode) => partR1(tx, bookingId, input, options, livemode))
}

/** Refund the rest: gives exactly what is owed; with the card, what the cards can't take goes to store credit. */
export function refundOwed(db: Db, bookingId: string, input: RefundOwedInput, options: RefundOptions): Promise<RefundBookingOutput> {
  return run(db, input.refundMethod === 'card', options, (tx, livemode) => owedR1(tx, bookingId, input, options, livemode))
}

/** One line It already arrived recorded card money on: a booking line, or (`addon`) a removed add-on's line. */
export interface ArrivedLine {
  lineId: string
  orderId: string
  amount: number
  addon?: true
}

/**
 * W47 (the W35 audit's row 6; W28 review L4; W46 "Noticed" 8): It already arrived says card refund money that was
 * owed did reach the customer. Until W47 it took the money off what was owed and recorded nothing on the lines, so the
 * card money left on the booking's orders read too high by it (a later Card refund asked Stripe for money the payment
 * no longer had; Stripe refused, so nothing went twice). Now, when staff say it reached the card (`arrivedOn: 'card'`),
 * what arrived is recorded as card money, where Refund the rest to the card would record it, with no money moving and
 * nothing sent to Stripe:
 * - on a cancelled booking, first on the removed add-on lines whose card refund is part of what is owed
 *   (OWED_ADDON_LINES_SQL), in a fixed order, each up to what it is short of and what its order's card can still take:
 *   its card figure and its refunded figure both rise (it is stamped when nothing is owed any more);
 * - then on the booking's lines, as planRefund plans a card refund: newest first, each order giving at most what its
 *   card can still take and what the line still holds in seat money.
 * What the cards can't account for is on no line (`card` on the row is then less than the amount): it reached the
 * customer some other way, and SEAT_MONEY_SETTLED_SQL counts that part from the row (`elsewhere`).
 *
 * W53 (W47 review L1; Wayne's Q40): the add-on lines go first on a LIVE booking too. Until W53 a live booking's
 * arrived money all went on its booking lines, so the towel's £5 (the review's example: a seat £20 and a towel £5 on
 * one £25 card payment, the towel removed and its refund refused) was recorded on the seat's line; a later Cancel &
 * Refund then sent £15 to the card and £5 to store credit, though the payment still had £20. Now it is on the towel's
 * line and the cancel sends £20 to the card.
 */
/**
 * W47: card money that arrived, on a removed add-on's line (`$1` pounds, `$2` the line): its card figure and its
 * refunded figure. Its stamp stays as it is (`none`) until nothing is owed on the booking any more, as Refund the
 * rest leaves it: an order's status counts a removed add-on's line as refunded by its stamp, and must not read
 * "refunded" while the seat's money on the same order is still owed.
 */
const ARRIVED_ON_ADDON_LINE_SQL = `
UPDATE addon_order_lines
SET card_refunded_amount = card_refunded_amount + $1::numeric,
    refunded_amount = refunded_amount + $1::numeric
WHERE id = $2::uuid`

/**
 * W47: once nothing is owed, the booking's (`$1`) removed add-on lines that It already arrived filled with card money
 * are stamped `card`. Only stampArrivedCard leaves a line reading all of its money back with card money on it and
 * no stamp.
 */
const STAMP_ARRIVED_ADDON_LINES_SQL = `
UPDATE addon_order_lines
SET refund_method = 'card'
WHERE booking_id = $1::uuid AND removed_at IS NOT NULL AND refund_method = 'none'
  AND card_refunded_amount > 0 AND refunded_amount >= price_at_purchase * quantity
RETURNING order_id`

async function stampArrivedCard(tx: Tx, bookingId: string, arrived: number): Promise<{ card: number; lines: ArrivedLine[] }> {
  const lines: ArrivedLine[] = []
  let left = round2(arrived)
  // W53 (W47 review L1): the owed add-on lines first on a live booking too (until W53: `if (cancelled)`).
  const owedAddons = await tx.query<{ id: string; order_id: string | null; amount: string; refunded_amount: string }>(OWED_ADDON_LINES_IN_ORDER_SQL, [bookingId])
  for (const row of owedAddons) {
    if (left <= 0.005 || !row.order_id) continue
    // Read for each line: the line before it may have used the same order's card money.
    const portion = await loadOrderCardPortion(tx, row.order_id)
    const cardLeft = portion?.paymentIntentId ? portion.cardPortionRemaining : 0
    const take = round2(Math.min(left, Number.parseFloat(row.amount) - Number.parseFloat(row.refunded_amount), cardLeft))
    if (take <= 0) continue
    await tx.query(ARRIVED_ON_ADDON_LINE_SQL, [take, row.id])
    lines.push({ lineId: row.id, orderId: row.order_id, amount: take, addon: true })
    left = round2(left - take)
  }
  if (left > 0.005) {
    const plan = await planRefund(tx, bookingId, left, 'card')
    for (const part of plan.card) {
      for (const line of part.lines) {
        await tx.query('UPDATE order_line_items SET card_refunded_amount = card_refunded_amount + $1::numeric WHERE id = $2::uuid', [line.amount, line.lineId])
        lines.push({ lineId: line.lineId, orderId: part.orderId, amount: line.amount })
      }
    }
  }
  return { card: sum(lines.map((line) => line.amount)), lines }
}

/**
 * W53 (W47 review L3; the builder's call: name the choice made): the booking's card payments and what the arrived
 * money was recorded against each, in words, when the booking has more than one card payment to choose between
 * (orders with a card payment that hold one of its booking lines or add-on lines). Null with one card payment or
 * none: there was no choice. The rule's own order decided (the owed add-on lines first, then the booking's lines
 * newest first), so on a partial arrival the money may be recorded against a different payment than the one it came
 * back to. Nothing can go twice: Stripe refuses a whole refund that asks a payment for more than it has left (it
 * doesn't cap it; W53a, W53 review L2), and the refused card part is then money still to refund. W53a (W53 review L1):
 * each payment is named by what it took on the card (loadOrderCardPortion's `cardPortion`), not the order's total.
 */
const BOOKING_CARD_ORDERS_SQL = `
SELECT o.id, o.created_at
FROM orders o
WHERE o.stripe_payment_intent_id IS NOT NULL
  AND (EXISTS (SELECT 1 FROM order_line_items x WHERE x.order_id = o.id AND x.booking_id = $1::uuid AND x.item_type = 'booking')
       OR EXISTS (SELECT 1 FROM addon_order_lines a WHERE a.order_id = o.id AND a.booking_id = $2::uuid))
ORDER BY o.created_at, o.id`

async function arrivedRecordedOn(tx: Tx, bookingId: string, lines: readonly ArrivedLine[]): Promise<string | null> {
  const orders = await tx.query<{ id: string; created_at: Date | string }>(BOOKING_CARD_ORDERS_SQL, [bookingId, bookingId])
  if (orders.length < 2) return null
  const parts: Array<{ amount: number; cardPayment: number; orderedAt: string }> = []
  for (const order of orders) {
    const amount = sum(lines.filter((line) => line.orderId === order.id).map((line) => line.amount))
    if (amount <= 0) continue
    const cardPayment = (await loadOrderCardPortion(tx, order.id))?.cardPortion ?? 0
    parts.push({ amount, cardPayment, orderedAt: order.created_at instanceof Date ? order.created_at.toISOString() : String(order.created_at) })
  }
  return parts.length > 0 ? arrivedRecordedOnWords(parts, orders.length) : null
}

/**
 * It already arrived: what is owed reached the customer after all, so it comes off the booking with no money moving.
 * One transaction with its `booking.refund_owed_arrived` row (the old one statement's), as nothing else records it.
 * W28: all of what is owed, or part of it (the rest stays owed).
 */
export async function owedArrived(db: Db, bookingId: string, input: OwedArrivedInput, options: Pick<RefundOptions, 'actor' | 'requestId'>): Promise<RefundBookingOutput> {
  return inC1(
    db,
    async (tx) => {
      const { booking, amount, cancelled } = await lockAndCheck(tx, bookingId, input.amount, true)
      const reason = requiredReason(input.reason, 'this')
      const figures = await withCashAndLine(tx, bookingId, booking.figures)
      // W28 (the W26 audit's row 31; W25 review L4): any amount up to what is owed, so a part found in Stripe with a
      // different amount can be settled exactly. More than is owed is still refused, with the figure (as before).
      if (figures.refundOwed <= 0) throw refundRefusal('CONFLICT', 'nothing_owed', REFUND_WORDS.nothingOwed, { figures })
      if (overHalfPenny(amount, figures.refundOwed)) throw refundRefusal('CONFLICT', 'owed_changed', owedChangedMessage(figures.refundOwed), { figures })
      // Within half a penny of all that is owed clears it exactly.
      const arrived = round2(Math.min(amount, figures.refundOwed))
      // W47 (Wayne, 19 Nov): staff say where they saw the money. On the card (`arrivedOn: 'card'`): it goes on the
      // lines as card money, before the money owed comes off. Another way (store credit on their balance, cash), or no
      // choice sent (a staff app from before W47): nothing on the lines and the row as it was before W47. Money found
      // on their balance is already in the store credit rows: recorded as card money too it would be counted twice.
      const onCard = input.arrivedOn === 'card'
      const stamped = onCard ? await stampArrivedCard(tx, bookingId, arrived) : { card: 0, lines: [] as ArrivedLine[] }
      await tx.query(cancelled ? OWED_OFF_SQL.cancelled : OWED_OFF_SQL.live, [arrived, bookingId])
      await audit.recordAll(tx, [
        {
          actorType: 'staff',
          actorId: options.actor.id,
          action: 'booking.refund_owed_arrived',
          entityType: 'booking',
          entityId: bookingId,
          requestId: options.requestId,
          details: { amount: arrived, reason, ...(onCard ? { arrivedOn: 'card', card: stamped.card, lines: stamped.lines } : {}) },
        },
      ])
      // W46: on a cancelled booking, once nothing is owed any more, its lines are stamped if all of their seat money is
      // then back, and their orders' status worked out again. W47: so is the status of every order whose lines the
      // arrived money was just recorded on, as R2 does for a card part that went.
      // W53: on a live booking too (its owed add-on lines, and a removed guest's line whose refund had ended owed:
      // stampWhenOwedSettled), and then every order of the booking, because what is owed on it has changed.
      const orders = new Set(stamped.lines.map((line) => line.orderId))
      for (const orderId of await stampWhenOwedSettled(tx, bookingId, onCard && stamped.card > 0)) orders.add(orderId)
      for (const orderId of orders) await recordOrderPaymentStatus(tx, orderId)
      await recordBookingOrdersPaymentStatus(tx, bookingId)
      // W53 (W47 review L3): where the booking has more than one card payment, the answer names the ones the money
      // was recorded against (the choice the rule made), so staff can see it.
      const recordedOn = onCard && stamped.card > 0 ? await arrivedRecordedOn(tx, bookingId, stamped.lines) : null
      // W47a (W47 review L2): less than what arrived could be recorded as card money (the booking's lines had less
      // card money left). The cap stands; the answer now says so, with both figures.
      const other = round2(arrived - stamped.card)
      const short: { arrivedOnCard?: { recorded: number; other: number }; warning?: string } =
        onCard && other > 0.005 ? { arrivedOnCard: { recorded: round2(stamped.card), other }, warning: arrivedCardShortWords('booking', round2(stamped.card), other) } : {}
      // The screens show an answer's `warning` under the result, so the named choice is said there too (after the
      // short-of-card words, when both apply).
      const notes = [short.warning, recordedOn].filter((note): note is string => typeof note === 'string' && note !== '')
      return {
        cardRefundedAmount: 0,
        storeCreditRefundedAmount: 0,
        pricePaid: cancelled ? figures.pricePaid : round2(figures.pricePaid - arrived),
        ...short,
        ...(recordedOn ? { arrivedRecordedOn: recordedOn } : {}),
        ...(notes.length > 0 ? { warning: notes.join(' ') } : {}),
      }
    },
    notSaved
  )
}

// --- Reconcile (D-plan 4.10) and the close by hand
//
// W27: the look-up they use (`findCardPart`: the refunds on a part's PaymentIntent that name the claim, never a send)
// is the shared core's, exported from here as before.
