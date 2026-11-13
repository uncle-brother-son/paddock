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
// - A later part refused: it, and every part after it, go to store credit in R2 (today's rule), with the old warning.
// - No clear answer: the claim is held (Q35's refund words). No press ever sends it again: reconcile lists the refunds
//   on each planned PaymentIntent, matches `metadata.claim_id`, and runs R2 with what it found; a part Stripe never
//   received ends as money owed on the booking (Refund the rest), never resent (D-plan 4.10).
// - A later part the press had no time left to send (W21a, W21 review L6): it and the parts after it end as owed on the
//   booking (Refund the rest can still send them to the card), not store credit: Stripe never refused them.
// Refund the rest to the card first looks in Stripe for the old screens' card refunds with no clear answer (W21a, W21
// review L1 and L2): before R1, so R1 checks what was found under the booking's lock. Each one that went must be
// exactly one planned part, or nothing is sent (R1 refuses); a part it matched is stored in the claim (the old refund's
// id), so the press, reconcile and a close all count it as gone, never owed and never sent.
// One transaction per step replaces the old figure-built keys and their 24-hour look-up, refusal counts, put-backs and
// best-effort statements (bookingRefund.ts, bookingMoneyClaim.ts, cardRefundAttempts.ts, stripeRefundLookup.ts).
// W23 (brief W23 item 1): a claim plans ONE card part per order across its booking lines and its add-on lines (Cancel &
// Refund's seat and a ticked towel on the same order: one refund, one key), each order's card portion used once;
// R2 records the booking lines' share on them and stamps the add-on lines with theirs. Cancel & Refund and Cancel &
// return credit (cancel.ts) are claims of kind `cancel` and `cancel_credit`.
import 'server-only'
import Stripe from 'stripe'
import type { ApiErrorCode, OwedArrivedInput, PartRefundInput, RefundBookingOutput, RefundOwedInput } from '@/contracts'
import { audit, type AuditEntry } from '@/server/audit'
import { isDeadlock, type Db, type Queryable, type Tx } from '@/server/db'
import { ApiError } from '@/server/http/errors'
import { stripeIdempotencyKey } from '@/server/http/idempotency'
import type { StripeClient } from '@/server/stripe/client'
import { sendOptions, stripeTiming, type StripeTiming } from '@/server/stripe/deadline'
import { readStripeFailure } from '@/server/stripe/outcome'
import { pence } from '@/server/rules/orders/collect-saved-card'
import {
  cardRefundFailedMessage,
  CHANGE_REFUND_UNCONFIRMED_MESSAGE,
  laterCardRefundFailedMessage,
  laterCardRefundNotSentMessage,
  NO_CASH_LEFT_MESSAGE,
  oldRefundReachedCustomerMessage,
  onlyCardLeftMessage,
  onlyCashLeftMessage,
  onlyLeftMessage,
  owedChangedMessage,
  PART_REFUND_METHOD_WORDS,
  reasonRequiredMessage,
  reasonTooLongMessage,
  REFUND_CHECK_FAILED_MESSAGE,
  REFUND_METHOD_WORDS,
  REFUND_NOT_SAVED_MESSAGE,
  REFUND_NOT_SENT_DETAIL,
  REFUND_OPEN_MESSAGE,
  REFUND_REFUSED_NOT_PUT_BACK_MESSAGE,
  REFUND_WORDS,
  refundGoneNotRecordedMessage,
  refundRefusedDetail,
} from './failure-messages'
import { lockAndLoadBooking, paymentOpen, type LoadedBooking } from './load-booking'
import { lockForBooking } from './locks'
import { inC1, paymentOpenRefusal } from './money-in'
import { ADDONS_INSIDE_LINE, loadBookingLines, loadOrderCardPortion, recordOrderPaymentStatus, withCashAndLine, type RefundFigures } from './money-left'

export const REFUND_CLAIMED = 'booking.refund_claimed'
export const REFUND_FINISHED = 'booking.refund_finished'
/** The reason's limit, as the old function's. */
export const REFUND_REASON_MAX_LENGTH = 200

/**
 * W22: Remove Guest's and Remove add-on's claims go through the same pipeline (remove-guest.ts, remove-addon.ts). W23:
 * Cancel & Refund's (`cancel`, the old claim's kind) and Cancel & return credit's with paid add-ons (`cancel_credit`).
 */
export type RefundKind = 'part_refund' | 'refund_owed' | 'remove_guest' | 'remove_addon' | 'cancel' | 'cancel_credit'
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

/**
 * One line's share of a card part: a booking line's (order_line_items), or (W23, `addon: true`) a ticked add-on line's
 * (addon_order_lines) planned in the same part as the booking lines of its order. Remove add-on's parts (W22) hold
 * add-on lines with no mark: its claim says so by its kind.
 */
export interface CardPartLine {
  lineId: string
  amount: number
  addon?: true
}

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
  /** The seat money given back: Cancel & Refund's price paid (money owed included); £0 for Cancel & return credit. */
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
}

/** One refund to one order's card: the order's lines for this booking (newest first) add up to `amount`. */
export interface CardPart {
  orderId: string
  paymentIntentId: string
  amount: number
  lines: CardPartLine[]
}

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
  /**
   * W21a (W21 review L2): Refund the rest's planned parts that are an old card refund with no clear answer that went
   * (found before R1): each is gone already, so it is never sent, and reconcile and a close count it as gone.
   */
  matched?: MatchedPart[]
  /** W22: Remove Guest's claim. */
  guest?: GuestClaim
  /** W22: Remove add-on's claim. Its card parts' lines are add-on lines (addon_order_lines), not booking lines. */
  addon?: AddonClaim
  /** W23: Cancel & Refund's and Cancel & return credit's claim. */
  cancel?: CancelClaim
}

/** A planned card part that is an old refund already gone: the order it refunds and the old refund's id. */
export interface MatchedPart {
  orderId: string
  refundId: string
}

export interface Claim {
  id: string
  bookingId: string
  /** The staff member who made the claim: its store credit row and its audit rows name them. */
  staffId: string | null
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

/** Who finishes a claim: the press, reconcile, or a person closing it by hand (their reason). */
export interface FinishedBy {
  actor: { type: 'staff' | 'system'; id: string | null }
  requestId: string
  how: 'press' | 'reconcile' | 'close'
  why?: string
}

const round2 = (n: number): number => Math.round(n * 100) / 100
/** Rounded first, as the old cash rule: taking pounds from pounds leaves noise. Half a penny either way passes (Q18). */
const overHalfPenny = (amount: number, limit: number): boolean => Math.round((amount - limit) * 1e6) / 1e6 > 0.005
const explain = (err: unknown): string => (err instanceof Error ? `${err.name}: ${err.message}` : String(err))
const sum = (amounts: readonly number[]): number => round2(amounts.reduce((total, n) => total + n, 0))

/** The key of one card part: `<claimId>:refund:<orderId>` (the claim's record id, then the order it refunds). */
export const claimRefundKey = (claimId: string, orderId: string): string => `${stripeIdempotencyKey(claimId, 'refund')}:${orderId}`

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

/** A Worker claim with no finished row: `$1` the booking (as text). */
const OPEN_CLAIM_ON_BOOKING_SQL = `
SELECT c.id FROM audit_log c
WHERE c.action = '${REFUND_CLAIMED}' AND c.entity_type = 'booking' AND c.entity_id = $1::text AND c.details->>'worker' = 'true'
  AND NOT EXISTS (
    SELECT 1 FROM audit_log f
    WHERE f.action = '${REFUND_FINISHED}' AND f.entity_type = 'booking' AND f.entity_id = c.entity_id AND f.details->>'claimId' = c.id::text
  )
LIMIT 1`

/**
 * Every Worker claim with no finished row, older than `$1` minutes, oldest first: what reconcile settles (D-plan
 * 4.10). A claim and its finished row are written by different transactions only when card parts were sent.
 */
export const CLAIMS_DUE_SQL = `
SELECT c.id FROM audit_log c
WHERE c.action = '${REFUND_CLAIMED}' AND c.entity_type = 'booking' AND c.details->>'worker' = 'true'
  AND c.at < now() - make_interval(mins => $1::int)
  AND NOT EXISTS (
    SELECT 1 FROM audit_log f
    WHERE f.action = '${REFUND_FINISHED}' AND f.entity_type = 'booking' AND f.entity_id = c.entity_id AND f.details->>'claimId' = c.id::text
  )
ORDER BY c.at, c.id`

/** True when the booking has a Worker refund claim with no finished row: it holds the booking for every refund. */
export async function refundClaimOpen(db: Queryable, bookingId: string): Promise<boolean> {
  return (await openRefundClaimOn(db, bookingId)) !== null
}

/** The id of the booking's open Worker refund claim, if it has one. */
export async function openRefundClaimOn(db: Queryable, bookingId: string): Promise<string | null> {
  return (await db.query<{ id: string }>(OPEN_CLAIM_ON_BOOKING_SQL, [bookingId]))[0]?.id ?? null
}

/** The claim, or null when there is no Worker claim with that id. */
export async function readClaim(db: Queryable, claimId: string): Promise<Claim | null> {
  const row = (
    await db.query<{ id: string; entity_id: string; actor_id: string | null; at: unknown; details: ClaimDetails }>(
      `SELECT id, entity_id, actor_id, at, details FROM audit_log
       WHERE id = $1::uuid AND action = 'booking.refund_claimed' AND entity_type = 'booking' AND details->>'worker' = 'true'`,
      [claimId]
    )
  )[0]
  if (!row) return null
  return { id: row.id, bookingId: row.entity_id, staffId: row.actor_id, at: row.at instanceof Date ? row.at.toISOString() : String(row.at), details: row.details }
}

async function claimFinished(db: Queryable, claim: Pick<Claim, 'id' | 'bookingId'>): Promise<boolean> {
  const rows = await db.query(
    "SELECT 1 FROM audit_log WHERE action = 'booking.refund_finished' AND entity_type = 'booking' AND entity_id = $1::text AND details->>'claimId' = $2::text LIMIT 1",
    [claim.bookingId, claim.id]
  )
  return rows.length > 0
}

/** Writes the claim's row (`booking.refund_claimed`, lead call L3): the record every key and the finish come from. */
export async function writeClaim(tx: Tx, bookingId: string, details: ClaimDetails, options: Pick<RefundOptions, 'actor' | 'requestId'>): Promise<Claim> {
  const row = (
    await tx.query<{ id: string; at: unknown }>(
      `INSERT INTO audit_log (at, actor_type, actor_id, action, entity_type, entity_id, request_id, details)
       VALUES (clock_timestamp(), 'staff', $1::text, 'booking.refund_claimed', 'booking', $2::text, $3::text, $4::jsonb)
       RETURNING id, at`,
      [options.actor.id, bookingId, options.requestId, JSON.stringify(details)]
    )
  )[0]
  if (!row) throw new Error('The refund claim was not written.')
  return { id: row.id, bookingId, staffId: options.actor.id, at: row.at instanceof Date ? row.at.toISOString() : String(row.at), details }
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
 */
export async function planRefund(db: Queryable, bookingId: string, amount: number, method: RefundMethod, addonLines: readonly AddonRefundLine[] = []): Promise<RefundPlan> {
  const lines = await loadBookingLines(db, bookingId)
  const ownOrderId = lines.length > 0 ? (lines[lines.length - 1]?.orderId ?? null) : null
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
  // W23: the add-ons, booking lines first: each order's card money left after its seat money.
  let addonsLeft = 0
  for (const line of addonLines) {
    const portion = line.orderId ? await portionOf(line.orderId) : null
    const take = line.orderId && portion?.paymentIntentId ? round2(Math.min(line.amount, portion.left)) : 0
    if (take > 0 && line.orderId && portion?.paymentIntentId) {
      portion.left = round2(portion.left - take)
      addToPart(line.orderId, portion.paymentIntentId, { lineId: line.id, amount: take, addon: true })
    }
    addonsLeft = round2(addonsLeft + line.amount - take)
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

// --- R1

/** What R1 finished on its own, or the claim whose card parts the press now sends. */
export type Started = { kind: 'done'; output: RefundBookingOutput } | { kind: 'card'; claim: Claim }

/**
 * The checks every amount action starts with, under the booking's lock, in the old function's order (a payment still
 * being taken on the booking first, as refundBooking checked it before anything else).
 */
async function lockAndCheck(tx: Tx, bookingId: string, amount: unknown): Promise<{ booking: LoadedBooking; amount: number }> {
  const loaded = await lockAndLoadBooking(tx, { bookingId, ownSession: false })
  if (!loaded) throw refundRefusal('NOT_FOUND', 'booking_not_found', REFUND_WORDS.bookingNotFound)
  const { booking } = loaded
  if (paymentOpen(booking)) throw paymentOpenRefusal(booking, refundRefusal)
  // A held refund on the booking (no clear answer yet) holds every refund until reconcile settles it.
  if (await refundClaimOpen(tx, bookingId)) throw refundRefusal('CONFLICT', 'refund_open', REFUND_OPEN_MESSAGE)
  // price_paid stays on a cancelled booking after its refund, so it would pay out a second time.
  if (booking.status === 'cancelled') throw refundRefusal('CONFLICT', 'already_cancelled', REFUND_WORDS.alreadyCancelled)
  if (typeof amount !== 'number' || !Number.isFinite(amount) || !(round2(amount) > 0)) {
    throw refundRefusal('VALIDATION', 'amount_not_positive', REFUND_WORDS.amountNotPositive, { field: 'amount' })
  }
  return { booking, amount }
}

/** What Refund the rest and It already arrived both refuse: the amount must be what is owed, to half a penny. */
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
  const output = await finishClaimInTransaction(tx, claim, { went: [], extraToStoreCredit: 0, owed: 0 }, { actor: options.actor, requestId: options.requestId, how: 'press' })
  if (!output) throw new Error(`Refund claim ${claim.id} was finished in its own transaction.`)
  return { kind: 'done', output }
}

async function owedR1(
  tx: Tx,
  bookingId: string,
  input: RefundOwedInput,
  options: RefundOptions,
  livemode: boolean | null,
  looked: OldRefundsLooked | null
): Promise<Started> {
  const method = input.refundMethod
  if (method !== 'card' && method !== 'credit') throw refundRefusal('VALIDATION', 'refund_method_invalid', REFUND_METHOD_WORDS, { field: 'refundMethod' })
  const { booking, amount } = await lockAndCheck(tx, bookingId, input.amount)
  const figures = await withCashAndLine(tx, bookingId, booking.figures)
  const refused = owedRefusal(amount, figures)
  if (refused) throw refused
  // Exactly what is owed: staff confirmed it. Never a part refund: this money was never paid toward the booking.
  const owed = figures.refundOwed
  const plan = await planRefund(tx, bookingId, owed, method)
  const matched = looked ? await matchOldRefunds(tx, bookingId, plan, looked) : []
  await tx.query(
    'UPDATE bookings SET price_paid = price_paid - $1::numeric, refund_owed_amount = refund_owed_amount - $1::numeric, updated_at = now() WHERE id = $2::uuid',
    [owed, bookingId]
  )
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
      ...(matched.length > 0 ? { matched } : {}),
    },
    options
  )
  if (plan.card.length > 0) return { kind: 'card', claim }
  const output = await finishClaimInTransaction(tx, claim, { went: [], extraToStoreCredit: 0, owed: 0 }, { actor: options.actor, requestId: options.requestId, how: 'press' })
  if (!output) throw new Error(`Refund claim ${claim.id} was finished in its own transaction.`)
  return { kind: 'done', output }
}

// --- R2: what went is recorded, the rest to store credit (or owed), the claim finished

/** What a claim ended with. `owed`: card money Stripe never received (reconcile, a close), back on the booking as owed. */
export interface ClaimOutcome {
  went: CardPart[]
  /** Card parts after a later refusal (today's rule): to store credit, with the plan's own store credit. */
  extraToStoreCredit: number
  owed: number
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
        : 'Refund the rest of a failed booking refund'
  return `${base}${cardRefunded > 0 ? ' (the rest went back to the card).' : '.'} [ref ${crypto.randomUUID()}]`
}

/**
 * W22: the line that held a removed guest's seat, stamped refunded, as the old stampRemovedGuestLine (Remove Guest):
 * the newest booking line not yet stamped whose seat money is above £0 and no more than the seat's price, and which
 * isn't the booking's first line (unless nothing is left on the booking). Answers the stamped line's order, if any.
 * Fixed text: ADDONS_INSIDE_LINE is a constant; the booking and the price come in as $1 and $2.
 */
const STAMP_GUEST_LINE_SQL = `
WITH seat AS (
  SELECT oli.id
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
  ORDER BY oli.created_at DESC, oli.id DESC
  LIMIT 1
)
UPDATE order_line_items
SET refunded_at = now(), refund_method = CASE WHEN card_refunded_amount > 0 THEN 'card' ELSE 'credit' END
WHERE id IN (SELECT id FROM seat)
RETURNING order_id`

/** W22: stamps a removed guest's line (STAMP_GUEST_LINE_SQL) and works out its order's status again. */
export async function stampRemovedGuestLine(tx: Tx, bookingId: string, seatPrice: number): Promise<string | null> {
  const orderId = (await tx.query<{ order_id: string }>(STAMP_GUEST_LINE_SQL, [bookingId, seatPrice]))[0]?.order_id ?? null
  if (orderId) await recordOrderPaymentStatus(tx, orderId)
  return orderId
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

/** The action's own row, as each action writes it (W21: the old function's fields; W22: Remove Guest's and add-on's). */
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
  const club = cancel?.clubCancelled ? { clubCancelled: true } : {}
  if (kind === 'cancel') return { action: BOOKING_CANCELLED, details: { refundMethod: method, seatRefund: cancel?.seatAmount ?? 0, ...common, ...club } }
  return {
    action: BOOKING_CANCELLED_CREDIT,
    details: { addonRefund: cancel?.addonRefund ?? null, creditUsableAgain: cancel?.creditUsableAgain ?? false, passReturned: cancel?.passReturned ?? null, ...common, ...club },
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
 * credit and any later-refused parts given as one store credit refund; money Stripe never received put back on the
 * booking as owed (on a cancelled booking, which has no button left to give it, as store credit instead); the orders'
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
  // a cancel's add-on line's share of its order's part (`addon`).
  if (details.kind !== 'remove_addon') {
    for (const part of outcome.went) {
      for (const line of part.lines) {
        if (line.addon) continue
        await tx.query('UPDATE order_line_items SET card_refunded_amount = card_refunded_amount + $1::numeric WHERE id = $2::uuid', [line.amount, line.lineId])
      }
    }
  }
  const cardRefunded = sum(outcome.went.map((part) => part.amount))
  const status = (await tx.query<{ status: string }>('SELECT status FROM bookings WHERE id = $1::uuid', [claim.bookingId]))[0]?.status
  let owed = round2(outcome.owed)
  let storeCredit = round2(plan.storeCredit + outcome.extraToStoreCredit)
  // A cancelled booking has no Refund the rest, so money Stripe never received goes to store credit (W21). W23: not when
  // a person closes the claim by hand: reconcile left it because Stripe shows something it can't settle (several refunds,
  // a different amount, another mode), so the card money may have reached the customer, and store credit on top could
  // pay it twice. It stays owed on the booking, and the close's words say to check Stripe first.
  if (owed > 0 && status === 'cancelled' && by.how !== 'close') {
    storeCredit = round2(storeCredit + owed)
    owed = 0
  }
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
  let balance: number | undefined
  let addonsBalance: number | undefined
  if (seatStoreCredit > 0) {
    balance = await giveStoreCredit(seatStoreCredit, plan.ownOrderId, cancel ? cancelSeatNote(seatCard) : storeCreditNote(claim, cardRefunded))
  }
  // W23: the add-ons' store credit, one row per paying order, linked to it, after the seat's (as before).
  for (const group of shares?.creditByOrder ?? []) {
    addonsBalance = await giveStoreCredit(group.amount, group.orderId, `Add-on refund: ${group.described}. [ref ${crypto.randomUUID()}]`)
  }
  if (owed > 0) {
    // W23: a cancel never lowered price_paid (a cancelled booking keeps it, as before), so only what is owed rises.
    await tx.query(
      cancel
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
    for (const orderId of new Set([...outcome.went.map((part) => part.orderId), ...(plan.ownOrderId ? [plan.ownOrderId] : [])])) {
      await recordOrderPaymentStatus(tx, orderId)
    }
  }
  // W22: the removed guest's line, once all of their seat's money went back (the old function didn't stamp it while
  // some was still to refund).
  if (details.kind === 'remove_guest' && details.guest && owed <= 0) await stampRemovedGuestLine(tx, claim.bookingId, details.guest.seatPrice)

  const cash = plan.cash
  const actor = { actorType: 'staff' as const, actorId: claim.staffId, entityType: 'booking', entityId: claim.bookingId, requestId: by.requestId }
  const finishedBy = by.how === 'press' ? {} : { by: { how: by.how, type: by.actor.type, id: by.actor.id, ...(by.why ? { why: by.why } : {}) } }
  const entries: AuditEntry[] = [
    { ...actor, ...actionRow(details, { cardRefunded, storeCredit, owed, cash }) },
    {
      ...actor,
      action: REFUND_FINISHED,
      details: { claimId: claim.id, outcome: owed > 0 ? 'owed' : 'given', cardRefunded, storeCreditRefunded: storeCredit, owed, ...(cash > 0 ? { cash } : {}), ...finishedBy },
    },
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
 * The first card part was refused, so nothing went: R1 undone in one transaction, as the old put-backs did. A part
 * refund was never one (price_paid and part_refunded_amount back); Refund the rest's money is owed again. False when
 * the claim was finished already.
 */
async function undoClaim(db: Db, claim: Claim, by: FinishedBy): Promise<boolean> {
  return db.transaction(async (tx) => {
    // W22: a removed guest's place goes back to the booking's session, so it is locked too (LOCK_ORDER). W23: a cancel's
    // places too, with the memberships its add-on credits went back to and the pass it gave a session back to.
    const cancel = claim.details.cancel
    const locks = await lockForBooking(tx, {
      bookingId: claim.bookingId,
      ownSession: claim.details.kind === 'remove_guest' || cancel !== undefined,
      membershipIds: (cancel?.addons ?? []).filter((line) => line.creditsReturned > 0 && line.membershipId).map((line) => line.membershipId as string),
      sessionPassId: cancel?.passReturned ?? null,
    })
    if (!locks) throw new Error(`The booking of refund claim ${claim.id} no longer exists.`)
    if (await claimFinished(tx, claim)) return false
    const { amount, kind } = claim.details
    if (cancel) {
      await undoCancel(tx, claim.bookingId, cancel)
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
      if (guest.placeReleased) {
        await tx.query('UPDATE sessions SET total_booked = total_booked + 1, updated_at = now() WHERE id = $1::uuid', [locks.bookingSessionId])
      }
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
  await tx.query('UPDATE bookings SET status = $1::text, cancelled_at = $2::timestamptz, refund_owed_amount = $3::numeric, updated_at = now() WHERE id = $4::uuid', [
    cancel.status,
    cancel.cancelledAt,
    cancel.refundOwed,
    bookingId,
  ])
  if (cancel.placesReleased > 0) {
    await tx.query('UPDATE sessions SET total_booked = total_booked + $1::int, updated_at = now() WHERE id = $2::uuid', [cancel.placesReleased, cancel.sessionId])
  }
  if (cancel.passReturned) {
    await tx.query('UPDATE customer_session_passes SET sessions_remaining = sessions_remaining - 1, updated_at = now() WHERE id = $1::uuid', [cancel.passReturned])
  }
  for (const line of cancel.addons) {
    if (line.creditsReturned > 0 && line.membershipId) {
      await tx.query('UPDATE customer_memberships SET addon_credits_remaining = addon_credits_remaining - $1::int, updated_at = now() WHERE id = $2::uuid', [
        line.creditsReturned,
        line.membershipId,
      ])
    }
    await tx.query(
      'UPDATE addon_order_lines SET removed_at = NULL, removed_by = NULL, refunded_amount = $1::numeric, card_refunded_amount = $2::numeric, refund_method = $3::text WHERE id = $4::uuid',
      [line.was.refunded, line.was.card, line.was.method, line.id]
    )
  }
}

// --- The press: each card part once, then R2

type PartAnswer = { outcome: 'went'; refund: Stripe.Refund } | { outcome: 'refused'; detail: string } | { outcome: 'not_sent' } | { outcome: 'unclear'; detail: string }

const accessRefused = (err: unknown): boolean =>
  err instanceof Stripe.errors.StripeAuthenticationError || err instanceof Stripe.errors.StripePermissionError

/** One part's refund request, from the claim alone, so a resend under its key is the same request. */
export function cardPartRequest(claimId: string, part: CardPart): Stripe.RefundCreateParams {
  return { payment_intent: part.paymentIntentId, amount: pence(part.amount), metadata: { refund_key: claimRefundKey(claimId, part.orderId), claim_id: claimId } }
}

/**
 * Sends one card part, outside any transaction, under its key: Stripe's refund back (succeeded or pending) is a yes;
 * failed or cancelled, or a definite error, is a no; nothing sent (no time left before the first send) is not_sent
 * (W21a: not a refusal, Stripe never saw it); any other answer is sent once more with the same key and request, then is
 * unclear. Only the press calls this, once per part, straight after R1: reconcile never sends a refund.
 */
async function sendCardPart(stripe: StripeClient, claimId: string, part: CardPart, timing: StripeTiming): Promise<PartAnswer> {
  const request = cardPartRequest(claimId, part)
  const key = claimRefundKey(claimId, part.orderId)
  let last = ''
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let options: Stripe.RequestOptions
    try {
      options = sendOptions(timing, { idempotencyKey: key })
    } catch (err) {
      if (attempt === 1) return { outcome: 'not_sent' }
      return { outcome: 'unclear', detail: `${last} (not sent again: ${explain(err)})` }
    }
    try {
      const refund = await stripe.refunds.create(request, options)
      if (refund.status === 'failed' || refund.status === 'canceled') return { outcome: 'refused', detail: refundRefusedDetail(`the refund ${refund.status}`) }
      return { outcome: 'went', refund }
    } catch (err) {
      const failure = readStripeFailure(err)
      if (failure.outcome === 'definite' || (accessRefused(err) && attempt === 1)) return { outcome: 'refused', detail: refundRefusedDetail(failure.message) }
      last = failure.message
    }
  }
  return { outcome: 'unclear', detail: last }
}

// --- Refund the rest after an old card refund with no clear answer (the old 24-hour look-up's job, for old money)

/**
 * The old code's card refunds that got no clear answer (`booking.card_refund_unsure`: the key, PaymentIntent and
 * amount) since the booking's money owed was last dealt with (Refund the rest or It already arrived). Old Move, Remove
 * Guest and Cancel & Refund still write these until W22 to W24: the money is put on the booking as owed. The old
 * Refund the rest sent it again under the same key, so Stripe gave the first refund back (and after 24 hours looked
 * for it); a Worker refund has a key of its own, so it looks: `$1` the booking.
 */
const OLD_UNSURE_SQL = `
SELECT n.id::text AS id, n.details->>'key' AS key, n.details->>'paymentIntentId' AS payment_intent_id
FROM audit_log n
WHERE n.action = 'booking.card_refund_unsure' AND n.entity_type = 'booking' AND n.entity_id = $1::text
  AND n.at > COALESCE(
    (SELECT max(d.at) FROM audit_log d
     WHERE d.entity_type = 'booking' AND d.entity_id = $1::text AND d.action IN ('booking.refund_owed', 'booking.refund_owed_arrived')),
    '-infinity'::timestamptz)
ORDER BY n.at, n.id`

/** An old refund with no clear answer that went (succeeded or pending): its PaymentIntent, id and pence. */
interface OldRefundFound {
  paymentIntentId: string
  refundId: string
  amount: number
}

/** What Refund the rest's look-up saw: the notes it looked for (their ids) and the old refunds that went. */
export interface OldRefundsLooked {
  noteIds: string[]
  found: OldRefundFound[]
}

/**
 * Each old unsure refund found in Stripe (by its `refund_key`, which the legacy route put on every refund) that went
 * (succeeded or pending), each refund once (an old screen pressed again sent the same key); 'unclear' when Stripe
 * couldn't be asked, or a PaymentIntent has more refunds than reconcile pages through. Reads only, before R1.
 */
export async function oldUnsureRefundsThatWent(db: Queryable, stripe: StripeClient, bookingId: string, timing: StripeTiming): Promise<OldRefundsLooked | 'unclear'> {
  const notes = await db.query<{ id: string; key: string; payment_intent_id: string }>(OLD_UNSURE_SQL, [bookingId])
  const found = new Map<string, OldRefundFound>()
  const listed = new Map<string, Stripe.Refund[]>()
  for (const note of notes) {
    let refunds = listed.get(note.payment_intent_id)
    if (!refunds) {
      const answer = await listRefunds(stripe, note.payment_intent_id, timing)
      if (answer.kind === 'unclear') return 'unclear'
      refunds = answer.refunds
      listed.set(note.payment_intent_id, refunds)
    }
    const refund = refunds.find((one) => one.metadata?.['refund_key'] === note.key && one.status !== 'failed' && one.status !== 'canceled')
    if (refund) found.set(refund.id, { paymentIntentId: note.payment_intent_id, refundId: refund.id, amount: refund.amount })
  }
  return { noteIds: notes.map((note) => note.id), found: [...found.values()] }
}

/**
 * Under R1's lock: the notes are still the ones the look-up saw (or nothing is sent: try again), and each old refund
 * that went is exactly one planned part on its PaymentIntent (or nothing is sent: W21 review L1, where a £60 part on a
 * PaymentIntent that already gave back £40 and £20 would pay £60 over). Answers the parts matched, for the claim.
 */
export async function matchOldRefunds(tx: Tx, bookingId: string, plan: RefundPlan, looked: OldRefundsLooked): Promise<MatchedPart[]> {
  const notes = await tx.query<{ id: string }>(OLD_UNSURE_SQL, [bookingId])
  if (JSON.stringify(notes.map((note) => note.id)) !== JSON.stringify(looked.noteIds)) {
    throw refundRefusal('CONFLICT', 'refund_check_failed', REFUND_CHECK_FAILED_MESSAGE)
  }
  const free = [...plan.card]
  const matched: MatchedPart[] = []
  let allMatched = true
  for (const refund of looked.found) {
    const at = free.findIndex((part) => part.paymentIntentId === refund.paymentIntentId && pence(part.amount) === refund.amount)
    const part = at >= 0 ? free.splice(at, 1)[0] : undefined
    if (part) matched.push({ orderId: part.orderId, refundId: refund.refundId })
    else allMatched = false
  }
  if (!allMatched) {
    throw refundRefusal('CONFLICT', 'refund_check_failed', oldRefundReachedCustomerMessage(looked.found.map((refund) => refund.amount / 100)))
  }
  return matched
}

const held = (claim: Claim, reason: string, message: string, cardGone = 0): RefundBookingOutput => ({
  cardRefundedAmount: cardGone,
  storeCreditRefundedAmount: 0,
  held: { claimId: claim.id, reason, message },
})

/**
 * After R1 has committed a claim with card parts: each part once, in the plan's order (newest order first), then R2.
 * A part matched to an old refund that went (Refund the rest) is gone already: recorded, never sent. The first part
 * sent that is refused undoes R1 and is thrown with the old words; a later one sends it and the rest to store credit
 * (the old warning); a later one with no time left to send ends with the rest as owed (W21 review L6); no clear answer
 * holds the claim for reconcile (Q35), as does R2 failing after money went (W6-3's rule for refunds: what went is never
 * sent again, reconcile records it).
 */
async function sendAndFinish(db: Db, stripe: StripeClient, claim: Claim, options: RefundOptions, timing: StripeTiming, firstRefused: FirstRefused): Promise<RefundBookingOutput> {
  const by: FinishedBy = { actor: options.actor, requestId: options.requestId, how: 'press' }
  const matched = new Set((claim.details.matched ?? []).map((part) => part.orderId))
  const went: CardPart[] = claim.details.plan.card.filter((part) => matched.has(part.orderId))
  const toSend = claim.details.plan.card.filter((part) => !matched.has(part.orderId))
  let sentOne = false
  let extraToStoreCredit = 0
  let owed = 0
  let warning: string | undefined
  for (const [index, part] of toSend.entries()) {
    const answer = await sendCardPart(stripe, claim.id, part, timing)
    if (answer.outcome === 'went') {
      went.push(part)
      sentOne = true
      continue
    }
    if (answer.outcome === 'unclear') return held(claim, 'refund_unconfirmed', CHANGE_REFUND_UNCONFIRMED_MESSAGE)
    if (!sentOne) {
      try {
        await undoClaim(db, claim, by)
      } catch {
        return held(claim, 'refund_refused_not_put_back', REFUND_REFUSED_NOT_PUT_BACK_MESSAGE)
      }
      throw firstRefused(answer.outcome === 'not_sent' ? REFUND_NOT_SENT_DETAIL : answer.detail)
    }
    const rest = sum(toSend.slice(index).map((later) => later.amount))
    if (answer.outcome === 'not_sent') {
      // Never sent, so never refused: still owed, for Refund the rest to send to the card.
      owed = rest
      warning = laterCardRefundNotSentMessage(rest)
    } else {
      // Today's rule: a later refusal sends the rest to store credit, so money is never left half returned.
      extraToStoreCredit = rest
      warning = laterCardRefundFailedMessage(part.amount, answer.detail)
    }
    break
  }
  try {
    const output = await finishClaim(db, claim, { went, extraToStoreCredit, owed, ...(warning ? { warning } : {}) }, by)
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

/**
 * R1 in its transaction (with C1's once-only deadlock retry and plain words for a fault), then the card parts.
 * `prepare` runs first, outside any transaction, with the Stripe client of a card refund: Refund the rest's look-up.
 */
export async function run(
  db: Db,
  card: boolean,
  options: RefundOptions,
  prepare: (stripe: StripeClient | null, timing: StripeTiming) => Promise<R1>,
  firstRefused: FirstRefused = refundFirstRefused,
  notSavedAs: (logDetail: string) => ApiError = notSaved
): Promise<RefundBookingOutput> {
  // A card refund needs Stripe: the client is made before R1, so a missing key fails with nothing written.
  const stripe = card && options.stripe ? options.stripe() : null
  const timing = stripeTiming(options.startedAt ?? Date.now(), options.now ?? Date.now)
  const r1 = await prepare(stripe, timing)
  // A COMMIT with no answer (INTERNAL) may have saved a claim whose card parts were never sent: reconcile finds it,
  // finds nothing in Stripe, and the money ends as owed (Refund the rest).
  const started = await inC1(db, (tx) => r1(tx, stripe?.keyLivemode ?? null), notSavedAs)
  if (started.kind === 'done') return started.output
  if (!stripe) throw new Error('A card refund was planned with no Stripe client.')
  return sendAndFinish(db, stripe, started.claim, options, timing, firstRefused)
}

/** Part refund: gives `amount` of what is left, to the card (the rest to store credit), to store credit, or in cash. */
export function partRefund(db: Db, bookingId: string, input: PartRefundInput, options: RefundOptions): Promise<RefundBookingOutput> {
  return run(db, input.refundMethod === 'card', options, () => Promise.resolve((tx, livemode) => partR1(tx, bookingId, input, options, livemode)))
}

/**
 * Refund the rest: gives exactly what is owed; with the card, what the cards can't take goes to store credit. To the
 * card, the old screens' refunds with no clear answer are looked for first (money they put on the booking as owed may
 * have reached the customer): Stripe not answering sends nothing, and R1 checks what was found.
 */
export function refundOwed(db: Db, bookingId: string, input: RefundOwedInput, options: RefundOptions): Promise<RefundBookingOutput> {
  return run(db, input.refundMethod === 'card', options, async (stripe, timing) => {
    const looked = stripe ? await oldUnsureRefundsThatWent(db, stripe, bookingId, timing) : null
    if (looked === 'unclear') throw refundRefusal('CONFLICT', 'refund_check_failed', REFUND_CHECK_FAILED_MESSAGE)
    return (tx, livemode) => owedR1(tx, bookingId, input, options, livemode, looked)
  })
}

/**
 * It already arrived: what is owed reached the customer after all, so it comes off the booking with no money moving.
 * One transaction with its `booking.refund_owed_arrived` row (the old one statement's), as nothing else records it.
 */
export async function owedArrived(db: Db, bookingId: string, input: OwedArrivedInput, options: Pick<RefundOptions, 'actor' | 'requestId'>): Promise<RefundBookingOutput> {
  return inC1(
    db,
    async (tx) => {
      const { booking, amount } = await lockAndCheck(tx, bookingId, input.amount)
      const reason = requiredReason(input.reason, 'this')
      const figures = await withCashAndLine(tx, bookingId, booking.figures)
      const refused = owedRefusal(amount, figures)
      if (refused) throw refused
      const owed = figures.refundOwed
      await tx.query(
        'UPDATE bookings SET price_paid = price_paid - $1::numeric, refund_owed_amount = refund_owed_amount - $1::numeric, updated_at = now() WHERE id = $2::uuid',
        [owed, bookingId]
      )
      await audit.recordAll(tx, [
        {
          actorType: 'staff',
          actorId: options.actor.id,
          action: 'booking.refund_owed_arrived',
          entityType: 'booking',
          entityId: bookingId,
          requestId: options.requestId,
          details: { amount: owed, reason },
        },
      ])
      return { cardRefundedAmount: 0, storeCreditRefundedAmount: 0, pricePaid: round2(figures.pricePaid - owed) }
    },
    notSaved
  )
}

// --- Reconcile (D-plan 4.10) and the close by hand

/** A claim's card part as Stripe shows it: a refund naming the claim, none, or more than one (left for a person). */
type PartFound = { kind: 'went' } | { kind: 'none' } | { kind: 'several'; ids: string[] } | { kind: 'mismatch'; detail: string } | { kind: 'unclear'; detail: string }

const LIST_PAGE = 100
const LIST_MOST_PAGES = 10

/** Every refund on a PaymentIntent, every page (at most LIST_MOST_PAGES); 'unclear' when Stripe didn't answer. */
async function listRefunds(
  stripe: StripeClient,
  paymentIntentId: string,
  timing: StripeTiming | undefined
): Promise<{ kind: 'listed'; refunds: Stripe.Refund[] } | { kind: 'unclear'; detail: string }> {
  const refunds: Stripe.Refund[] = []
  let startingAfter: string | undefined
  try {
    for (let page = 0; ; page += 1) {
      if (page >= LIST_MOST_PAGES) return { kind: 'unclear', detail: `more than ${LIST_PAGE * LIST_MOST_PAGES} refunds to look through` }
      const listed = await stripe.refunds.list({ payment_intent: paymentIntentId, limit: LIST_PAGE, ...(startingAfter ? { starting_after: startingAfter } : {}) }, sendOptions(timing))
      refunds.push(...listed.data)
      const last = listed.data.at(-1)
      if (!listed.has_more || !last) break
      startingAfter = last.id
    }
  } catch (err) {
    return { kind: 'unclear', detail: readStripeFailure(err).message }
  }
  return { kind: 'listed', refunds }
}

/**
 * The refunds on the part's PaymentIntent that name this claim (`metadata.claim_id`), every page. Succeeded or pending
 * is money gone; failed or cancelled, or none, is money that never went. Never sends anything.
 */
export async function findCardPart(stripe: StripeClient, claimId: string, part: CardPart, timing: StripeTiming | undefined): Promise<PartFound> {
  const listed = await listRefunds(stripe, part.paymentIntentId, timing)
  if (listed.kind === 'unclear') return listed
  const matched = listed.refunds.filter((refund) => refund.metadata?.['claim_id'] === claimId)
  const live = matched.filter((refund) => refund.status !== 'failed' && refund.status !== 'canceled')
  if (live.length > 1) return { kind: 'several', ids: live.map((refund) => refund.id) }
  const refund = live[0]
  if (!refund) return { kind: 'none' }
  if (refund.amount !== pence(part.amount)) return { kind: 'mismatch', detail: `${refund.id} is ${refund.amount}p, the part ${pence(part.amount)}p` }
  return { kind: 'went' }
}
