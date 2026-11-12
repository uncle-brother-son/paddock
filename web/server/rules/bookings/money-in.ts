// New in W20 (brief W20: "build on W19's pieces; don't make second copies"): the money-in parts Settle (W19) and Add
// Guest (W20) share, moved out of settle.ts unchanged: a payment part's amount, the held-payment refusal, the store
// credit and gift card claims (New Order's words and guarded UPDATE, which stamps redeemed_at when a card is used up:
// W09 review O1), and C1's transaction with its once-only deadlock retry (W17 review S2). Each takes the action's own
// refusal builder, so each action keeps its own reason words and details.
import 'server-only'
import type { ApiErrorCode } from '@/contracts'
import { DbCommitUnknownError, DbError, inOpenTransaction, isDeadlock, postgresRefusal, type Db, type Tx } from '@/server/db'
import { ApiError } from '@/server/http/errors'
import { FAILURE_MESSAGES as ORDER_WORDS } from '@/server/rules/orders/failure-messages'
import { CARD_PAYMENT_OPEN_MESSAGE, READER_PAYMENT_OPEN_MESSAGE } from './failure-messages'
import type { LoadedBooking } from './load-booking'

/** How an action builds its refusal: the old reason, the old function's words (if any), and what goes in details. */
export type MoneyInRefusal<Extras> = (code: ApiErrorCode, reason: string, message: string | undefined, extras?: Extras) => ApiError

const round2 = (n: number): number => Math.round(n * 100) / 100
const wholePennies = (n: number): boolean => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6
const explain = (err: unknown): string => (err instanceof Error ? `${err.name}: ${err.message}` : String(err))

/**
 * A part's amount: missing or £0 is no part (as the old functions); anything else must be whole pennies above £0,
 * refused with New Order's words otherwise.
 */
export function partAmount<E>(
  sent: number | undefined,
  reason: 'gift_card_amount_invalid' | 'store_credit_amount_invalid',
  refuse: MoneyInRefusal<E>,
  extras?: E
): number {
  if (sent === undefined || sent === 0) return 0
  if (!Number.isFinite(sent) || sent < 0 || !wholePennies(sent)) throw refuse('VALIDATION', reason, ORDER_WORDS[reason], extras)
  return sent
}

/** The held-payment refusal, with the card words when every open flow on the booking is a saved-card one (W18a). */
export function paymentOpenRefusal<E>(booking: Pick<LoadedBooking, 'openFlows'>, refuse: MoneyInRefusal<E>): ApiError {
  const cardOnly = booking.openFlows.length > 0 && booking.openFlows.every((flow) => flow.method === 'card')
  return cardOnly ? refuse('CONFLICT', 'card_payment_open', CARD_PAYMENT_OPEN_MESSAGE) : refuse('CONFLICT', 'reader_payment_open', READER_PAYMENT_OPEN_MESSAGE)
}

export interface StoreCreditClaim {
  customerId: string
  /** The amount taken, as a positive number of pounds. */
  amount: number
  bookingId: string
  staffId: string
  note: string
}

/**
 * The store credit taken (store_credit_apply, reason `redemption`, the booking and the staff member), refused with the
 * old reasons. Answers the ledger row's id.
 */
export async function claimStoreCredit<E>(tx: Tx, claim: StoreCreditClaim, refuse: MoneyInRefusal<E>, extras?: E): Promise<string | null> {
  const applied = (
    await tx.query<{ result: { ok?: boolean; reason?: string; transaction_id?: string } | null }>(
      'SELECT public.store_credit_apply($1::uuid, $2::numeric, $3::text, NULL::uuid, $4::uuid, $5::uuid, $6::text, NULL::uuid) AS result',
      [claim.customerId, -claim.amount, 'redemption', claim.bookingId, claim.staffId, claim.note]
    )
  )[0]?.result
  if (applied?.ok !== true) {
    throw refuse('CONFLICT', applied?.reason === 'insufficient_store_credit' ? 'store_credit_insufficient_or_invalid' : 'store_credit_failed', undefined, extras)
  }
  return typeof applied.transaction_id === 'string' ? applied.transaction_id : null
}

/**
 * The gift card's checks with New Order's words (D-plan 2.2), under its lock, then the claim. The old reason for all
 * four, so the screens' handling is unchanged; New Order's words say which. Answers whether this stamped redeemed_at.
 */
export async function claimGiftCard<E>(tx: Tx, giftCardId: string, amount: number, refuse: MoneyInRefusal<E>, extras?: E): Promise<boolean> {
  const card = (
    await tx.query<{ remaining_balance: string; voided: boolean | null; expired: boolean; redeemed: boolean }>(
      `SELECT remaining_balance::text AS remaining_balance, voided,
              expiry_date < (now() AT TIME ZONE 'Europe/London')::date AS expired, redeemed_at IS NOT NULL AS redeemed
       FROM gift_cards WHERE id = $1::uuid`,
      [giftCardId]
    )
  )[0]
  const refused = (words: string | undefined) => refuse('CONFLICT', 'gift_card_insufficient_or_invalid', words, extras)
  if (!card) throw refused(ORDER_WORDS['gift_card_not_found'])
  if (card.voided === true) throw refused(ORDER_WORDS['gift_card_voided'])
  if (card.expired) throw refused(ORDER_WORDS['gift_card_expired'])
  const balance = Number.parseFloat(card.remaining_balance)
  if (balance <= 0 || round2(balance - amount) < 0) throw refused(ORDER_WORDS['gift_card_insufficient_or_invalid'])
  const claimed = (
    await tx.query<{ redeemed: boolean }>(
      `UPDATE gift_cards
       SET remaining_balance = remaining_balance - $1::numeric,
           redeemed_at = CASE WHEN redeemed_at IS NULL AND round(remaining_balance - $1::numeric, 2) <= 0 THEN now() ELSE redeemed_at END,
           updated_at = now()
       WHERE id = $2::uuid AND remaining_balance >= $1::numeric AND voided IS NOT TRUE
         AND expiry_date >= (now() AT TIME ZONE 'Europe/London')::date
       RETURNING redeemed_at IS NOT NULL AS redeemed`,
      [amount, giftCardId]
    )
  )[0]
  if (!claimed) throw refused(ORDER_WORDS['gift_card_insufficient_or_invalid'])
  return !card.redeemed && claimed.redeemed
}

/**
 * C1 in a transaction of its own, run once more after a deadlock (W17 review S2, as T1 does: it calls nothing outside
 * the database). A database fault rolled all of it back, so it is a definite answer with the action's plain words
 * (`notSaved`); only a COMMIT with no answer may have saved it, and stays INTERNAL.
 */
export async function inC1<T>(db: Db, work: (tx: Tx) => Promise<T>, notSaved: (logDetail: string) => ApiError): Promise<T> {
  const opensItsOwn = !inOpenTransaction(db)
  try {
    try {
      return await db.transaction(work)
    } catch (err) {
      if (!opensItsOwn || !isDeadlock(err)) throw err
      return await db.transaction(work)
    }
  } catch (err) {
    if (!opensItsOwn || err instanceof ApiError || err instanceof DbCommitUnknownError) throw err
    if (!(err instanceof DbError) && !postgresRefusal(err)) throw err
    throw notSaved(`C1 rolled back: ${explain(err)}`)
  }
}
