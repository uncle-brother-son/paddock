// Ported in W38 from the staff app's extendGiftCardExpiry.ts, setGiftCardPickedUp.ts, setGiftCardShipped.ts,
// getGiftCards.ts and getGiftCardRedemptions.ts (F-plan 1.6, 4.6; brief W38; bugs FB13 to FB16 and FB24; Wayne's Q46
// and Q47, 15 Nov; lead call L2). None touches Stripe, so each write is one transaction with nothing to hold: the
// card locked, the old checks, the change and its audit row together. A refusal is a throw, so nothing of it is kept.
import 'server-only'
import type { ExtendGiftCardInput, ExtendGiftCardOutput, GiftCardFlagOutput, GiftCardListRow, GiftCardRedemptionRow, GiftCardRow } from '@/contracts'
import { audit } from '@/server/audit'
import type { Db, Queryable, Tx } from '@/server/db'
import { accountRefusal, type AccountOptions } from '@/server/rules/account/refusal'
import { likeContaining } from '@/server/rules/admin/like'
import { GIFT_CARD_EXTEND_MAX_MONTHS, GIFT_CARD_EXTEND_NEW_WORDS, GIFT_CARD_EXTEND_WORDS, GIFT_CARD_FLAG_WORDS } from './failure-messages'

/**
 * Every column of gift_cards, by name (F-plan 4.6: named fields, where the old functions read `*`). Money and dates
 * as the database's own text, as the old functions gave them. admin.test.ts holds the list to the saved schema, so a
 * new column is a decision, not a leak.
 */
export const GIFT_CARD_COLUMNS = [
  'id',
  'code',
  'type',
  'original_value',
  'remaining_balance',
  'purchaser_id',
  'recipient_name',
  'recipient_email',
  'gift_message',
  'origin',
  'issue_date',
  'expiry_date',
  'redeemed_at',
  'created_at',
  'updated_at',
  'fulfillment_method',
  'picked_up',
  'picked_up_at',
  'picked_up_by',
  'voided',
  'shipped_at',
  'shipped_by',
] as const

const AS_TEXT: ReadonlySet<string> = new Set(['original_value', 'remaining_balance', 'issue_date', 'expiry_date'])
const cardColumns = (alias: string): string => GIFT_CARD_COLUMNS.map((column) => (AS_TEXT.has(column) ? `${alias}.${column}::text AS ${column}` : `${alias}.${column}`)).join(', ')

const TIMES = ['redeemed_at', 'created_at', 'updated_at', 'picked_up_at', 'shipped_at'] as const
const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value))

/** A row as the contract gives it: each moment as ISO text (null stays null). */
function withTimes<T extends Record<string, unknown>>(row: T, times: readonly string[]): T {
  const out: Record<string, unknown> = { ...row }
  for (const name of times) if (out[name] !== null && out[name] !== undefined) out[name] = iso(out[name])
  return out as T
}

/** Today in London, as every gift card rule reads it (money-in.ts: a card is good through its expiry date). */
const LONDON_TODAY = "(now() AT TIME ZONE 'Europe/London')::date"

/**
 * What an extension needs to know about the card, read after its lock: whether it has expired (its expiry before
 * today's London date), and the two marks Q46 looks for.
 */
const EXTEND_FACTS_SQL = `
SELECT gc.expiry_date::text AS expiry_date, gc.voided,
       gc.expiry_date < ${LONDON_TODAY} AS expired,
       EXISTS (SELECT 1 FROM order_line_items oli WHERE oli.gift_card_id = gc.id AND oli.item_type = 'gift_card' AND oli.refunded_at IS NOT NULL) AS refunded,
       EXISTS (SELECT 1 FROM store_credit_transactions sct WHERE sct.gift_card_id = gc.id AND sct.reason = 'migrated_from_gift_card') AS moved_to_store_credit
FROM gift_cards gc WHERE gc.id = $1::uuid`

/** Q47: the months go on the later of the card's expiry and today (London), by Postgres's own date sum. Un-voids, as before. */
const EXTEND_SQL = `
UPDATE gift_cards
SET expiry_date = (GREATEST(expiry_date, ${LONDON_TODAY}) + make_interval(months => $1::int))::date,
    voided = false,
    updated_at = now()
WHERE id = $2::uuid
RETURNING id, expiry_date::text AS expiry_date, voided`

interface ExtendFacts {
  expiry_date: string
  voided: boolean | null
  expired: boolean
  /** Its order line has been refunded (the refund voids the card and stamps the line in one transaction). */
  refunded: boolean
  /** Its balance was moved to the purchaser's store credit (migration 010's `migrated_from_gift_card` movement). */
  moved_to_store_credit: boolean
}

/**
 * extendGiftCardExpiry. Issue refunds (the old words), then a whole number of months from 1 to 120 (W38a, review S2;
 * Wayne, 16 Nov: refused before the database is touched, so a huge number is a refusal and never a fault), then one transaction
 * under the card's lock (the lock an order paying with the card, and a refund voiding it, both take):
 *  - Q46 (FB13): a voided card whose order line was refunded, or whose balance was moved to store credit, is refused
 *    with the reason why. The old function un-voided any card, so a refunded £50 card could be spent again;
 *  - Q47 (FB14): a card that has already expired counts the months from today (London); one still in date has them
 *    added to its expiry, as before. Postgres's own date sum, so "a month on" from the 31st is the month's last day;
 *  - a card voided for any other reason is un-voided, as before;
 *  - a `gift_card.extended` audit row: who, the months, the old and new date, and whether it was voided (FB15).
 * The route's press key stops a repeated press adding the months twice (FB15).
 */
export async function extendGiftCard(db: Db, giftCardId: string, input: ExtendGiftCardInput, options: AccountOptions): Promise<ExtendGiftCardOutput> {
  if (!options.actor.canIssueRefunds) throw accountRefusal('FORBIDDEN', 'gift_card_extend', 'permission_denied', GIFT_CARD_EXTEND_WORDS.permissionDenied)
  const months = input.extendByMonths
  if (typeof months !== 'number' || !Number.isInteger(months) || months <= 0 || months > GIFT_CARD_EXTEND_MAX_MONTHS) {
    throw accountRefusal('VALIDATION', 'gift_card_extend', 'invalid_months', GIFT_CARD_EXTEND_WORDS.monthsInvalid, { field: 'extendByMonths' })
  }

  return db.transaction(async (tx) => {
    const [locked] = await tx.query<{ id: string }>('SELECT id FROM gift_cards WHERE id = $1::uuid FOR NO KEY UPDATE', [giftCardId])
    if (!locked) throw accountRefusal('NOT_FOUND', 'gift_card_extend', 'gift_card_not_found', GIFT_CARD_EXTEND_WORDS.failed)
    // Read in its own statement, after the lock: a refund that was voiding the card has finished by now, and its
    // line's stamp shows (server/rules/README.md, "Locks before reads").
    const [facts] = await tx.query<ExtendFacts>(EXTEND_FACTS_SQL, [giftCardId])
    if (!facts) throw new Error(`Gift card ${giftCardId} was locked but could not be read.`)
    if (facts.voided === true && facts.refunded) throw accountRefusal('CONFLICT', 'gift_card_extend', 'voided_by_refund', GIFT_CARD_EXTEND_NEW_WORDS.voidedByRefund)
    if (facts.voided === true && facts.moved_to_store_credit) {
      throw accountRefusal('CONFLICT', 'gift_card_extend', 'voided_to_store_credit', GIFT_CARD_EXTEND_NEW_WORDS.voidedToStoreCredit)
    }

    const [card] = await tx.query<ExtendGiftCardOutput['giftCard']>(EXTEND_SQL, [months, giftCardId])
    if (!card) throw new Error(`Gift card ${giftCardId} was locked but not updated.`)
    await audit.record(tx, {
      actorType: options.actor.type,
      actorId: options.actor.id,
      action: 'gift_card.extended',
      entityType: 'gift_card',
      entityId: giftCardId,
      requestId: options.requestId,
      details: {
        months,
        expiryBefore: facts.expiry_date,
        expiryAfter: card.expiry_date,
        countedFrom: facts.expired ? 'today' : 'expiry',
        voidedBefore: facts.voided === true,
      },
    })
    return { giftCard: card }
  })
}

type Flag = 'picked_up' | 'shipped'

const FLAGS = {
  picked_up: {
    action: 'gift_card_picked_up',
    method: 'pickup',
    wrongMethod: 'not_pickup_fulfillment',
    wrongMethodWords: GIFT_CARD_FLAG_WORDS.notPickup,
    failedWords: GIFT_CARD_FLAG_WORDS.pickupFailed,
    audit: 'gift_card.picked_up',
    key: 'pickedUp',
    // W58 (W45 audit row 14): a flag already set keeps its first who and when; pressing it again changes nothing there.
    on: 'UPDATE gift_cards SET picked_up = true, picked_up_at = CASE WHEN picked_up IS TRUE THEN picked_up_at ELSE now() END, picked_up_by = CASE WHEN picked_up IS TRUE THEN picked_up_by ELSE $1::uuid END, updated_at = now() WHERE id = $2::uuid RETURNING id',
    off: 'UPDATE gift_cards SET picked_up = false, picked_up_at = NULL, picked_up_by = NULL, updated_at = now() WHERE id = $1::uuid RETURNING id',
  },
  shipped: {
    action: 'gift_card_shipped',
    method: 'shipping',
    wrongMethod: 'not_shipping_fulfillment',
    wrongMethodWords: GIFT_CARD_FLAG_WORDS.notShipping,
    failedWords: GIFT_CARD_FLAG_WORDS.shippingFailed,
    audit: 'gift_card.shipped',
    key: 'shipped',
    on: 'UPDATE gift_cards SET shipped_at = COALESCE(shipped_at, now()), shipped_by = CASE WHEN shipped_at IS NULL THEN $1::uuid ELSE shipped_by END, updated_at = now() WHERE id = $2::uuid RETURNING id',
    off: 'UPDATE gift_cards SET shipped_at = NULL, shipped_by = NULL, updated_at = now() WHERE id = $1::uuid RETURNING id',
  },
} as const

const READ_CARD_SQL = `SELECT ${cardColumns('gc')} FROM gift_cards gc WHERE gc.id = $1::uuid`

async function readCard(tx: Tx, giftCardId: string): Promise<GiftCardRow | null> {
  const [row] = await tx.query<GiftCardRow>(READ_CARD_SQL, [giftCardId])
  return row ? withTimes(row, TIMES) : null
}

/**
 * setGiftCardPickedUp and setGiftCardShipped. The old checks: the card exists, and is one to pick up (or to ship).
 * Then, under the card's lock, the flag set with who and when, or cleared, and a `gift_card.picked_up` /
 * `gift_card.shipped` audit row (the flag as pressed, and who and when it was set before). Any active staff member:
 * the route has already refused anyone else, setting or clearing (FB24: the old functions let someone with no staff
 * record clear a flag).
 */
async function setFlag(db: Db, flag: Flag, giftCardId: string, value: boolean, options: AccountOptions): Promise<GiftCardFlagOutput> {
  const spec = FLAGS[flag]
  return db.transaction(async (tx) => {
    const [locked] = await tx.query<{ fulfillment_method: string }>('SELECT fulfillment_method FROM gift_cards WHERE id = $1::uuid FOR NO KEY UPDATE', [giftCardId])
    if (!locked) throw accountRefusal('NOT_FOUND', spec.action, 'not_found', spec.failedWords)
    if (locked.fulfillment_method !== spec.method) throw accountRefusal('CONFLICT', spec.action, spec.wrongMethod, spec.wrongMethodWords)
    const before = await readCard(tx, giftCardId)
    const written = value ? await tx.query<{ id: string }>(spec.on, [options.actor.id, giftCardId]) : await tx.query<{ id: string }>(spec.off, [giftCardId])
    const giftCard = await readCard(tx, giftCardId)
    if (written.length !== 1 || !before || !giftCard) throw new Error(GIFT_CARD_FLAG_WORDS.notReadBack)
    await audit.record(tx, {
      actorType: options.actor.type,
      actorId: options.actor.id,
      action: spec.audit,
      entityType: 'gift_card',
      entityId: giftCardId,
      requestId: options.requestId,
      details: {
        [spec.key]: value,
        before: flag === 'picked_up' ? { pickedUp: before.picked_up, at: before.picked_up_at, by: before.picked_up_by } : { shipped: before.shipped_at !== null, at: before.shipped_at, by: before.shipped_by },
      },
    })
    return { giftCard }
  })
}

export const setGiftCardPickedUp = (db: Db, giftCardId: string, pickedUp: boolean, options: AccountOptions): Promise<GiftCardFlagOutput> => setFlag(db, 'picked_up', giftCardId, pickedUp, options)
export const setGiftCardShipped = (db: Db, giftCardId: string, shipped: boolean, options: AccountOptions): Promise<GiftCardFlagOutput> => setFlag(db, 'shipped', giftCardId, shipped, options)

/**
 * W58 (W45 audit row 12): why Reactivate (an extension of a voided card) would be refused, as extendGiftCard refuses it
 * (Q46's two marks), so the list greys the button with the reason before the press. Null when nothing refuses.
 */
const LIST_SELECT = `
SELECT ${cardColumns('gc')}, p.first_name AS purchaser_first_name, p.last_name AS purchaser_last_name, p.email AS purchaser_email,
       gc.voided IS TRUE AND EXISTS (SELECT 1 FROM order_line_items oli WHERE oli.gift_card_id = gc.id AND oli.item_type = 'gift_card' AND oli.refunded_at IS NOT NULL) AS voided_by_refund,
       gc.voided IS TRUE AND EXISTS (SELECT 1 FROM store_credit_transactions sct WHERE sct.gift_card_id = gc.id AND sct.reason = 'migrated_from_gift_card') AS voided_to_store_credit
FROM gift_cards gc
LEFT JOIN customers p ON p.id = gc.purchaser_id`
/** W58 (W45 audit row 15): the list is capped, newest first; the screen says "showing the newest N" when it is full. */
export const GIFT_CARD_LIST_LIMIT = 500
const LIST_ORDER = `ORDER BY gc.created_at DESC, gc.id LIMIT ${GIFT_CARD_LIST_LIMIT}`
const LIST_ALL_SQL = `${LIST_SELECT}
${LIST_ORDER}`
const LIST_SEARCH_SQL = `${LIST_SELECT}
WHERE gc.code ILIKE $1 ESCAPE '\\' OR gc.recipient_name ILIKE $1 ESCAPE '\\' OR gc.recipient_email ILIKE $1 ESCAPE '\\'
   OR p.first_name ILIKE $1 ESCAPE '\\' OR p.last_name ILIKE $1 ESCAPE '\\' OR p.email ILIKE $1 ESCAPE '\\'
${LIST_ORDER}`

/**
 * getGiftCards: the cards with their purchaser, newest first. `search` (trimmed) matches the code, the recipient's
 * name or email, or the purchaser's first name, last name or email, anywhere in the text and in any case. Cards made
 * in the same moment come in id order, so the list doesn't shuffle between reads. W58: at most GIFT_CARD_LIST_LIMIT
 * (the old read had no limit); `%` and `_` are plain characters; each row says why Reactivate would be refused.
 */
export async function listGiftCards(db: Queryable, search: string | undefined): Promise<GiftCardListRow[]> {
  const wanted = search?.trim()
  type Read = GiftCardListRow & { voided_by_refund?: boolean; voided_to_store_credit?: boolean }
  const rows = wanted ? await db.query<Read>(LIST_SEARCH_SQL, [likeContaining(wanted)]) : await db.query<Read>(LIST_ALL_SQL)
  return rows.map(({ voided_by_refund: byRefund, voided_to_store_credit: toStoreCredit, ...row }) => ({
    ...withTimes(row as GiftCardListRow, TIMES),
    reactivate_refused: byRefund ? GIFT_CARD_EXTEND_NEW_WORDS.voidedByRefund : toStoreCredit ? GIFT_CARD_EXTEND_NEW_WORDS.voidedToStoreCredit : null,
  }))
}

/** getGiftCardRedemptions: one card's uses, newest first. A card that doesn't exist has none, as before. */
export async function listGiftCardRedemptions(db: Queryable, giftCardId: string): Promise<GiftCardRedemptionRow[]> {
  const rows = await db.query<GiftCardRedemptionRow>(
    `SELECT id, gift_card_id, order_id, booking_id, event_booking_id, amount_used::text AS amount_used, redeemed_at
     FROM gift_card_redemptions
     WHERE gift_card_id = $1::uuid
     ORDER BY redeemed_at DESC, id`,
    [giftCardId]
  )
  return rows.map((row) => withTimes(row, ['redeemed_at']))
}
