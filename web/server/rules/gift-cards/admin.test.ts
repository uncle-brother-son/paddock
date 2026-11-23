import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { POST as extendRoute } from '@/app/api/v1/staff/gift-cards/[giftCardId]/extend/route'
import { POST as pickedUpRoute } from '@/app/api/v1/staff/gift-cards/[giftCardId]/picked-up/route'
import { GET as redemptionsRoute } from '@/app/api/v1/staff/gift-cards/[giftCardId]/redemptions/route'
import { POST as shippedRoute } from '@/app/api/v1/staff/gift-cards/[giftCardId]/shipped/route'
import { GET as listRoute } from '@/app/api/v1/staff/gift-cards/route'
import type { Db } from '@/server/db'
import { insert } from '@/server/rules/testing/database'
import { replay, REPLAY_USER, startReplay, type ReplayEnvironment, type ScenarioContext } from '@/server/rules/testing/sweep/run'
import { workerSide } from '@/server/rules/testing/sweep/worker'
import { refundOrderAsTheDialogPresses } from '@/server/rules/testing/sweep/order-refund-presses'
import { ID, paidSeat, seed, W36_ID, whileFailing } from '@/server/rules/testing/replay/scenarios'
import { extendGiftCard, GIFT_CARD_COLUMNS, listGiftCardRedemptions, listGiftCards, setGiftCardPickedUp } from './admin'
import { GIFT_CARD_EXTEND_MAX_MONTHS, GIFT_CARD_EXTEND_NEW_REASONS, GIFT_CARD_EXTEND_NEW_WORDS, GIFT_CARD_EXTEND_WORDS, GIFT_CARD_FLAG_WORDS } from './failure-messages'

vi.setConfig({ testTimeout: 60_000 })

// Brief W38 items 1 to 3 and 6: the five gift card routes on the replay's live schema. Every refusal with its words in
// the old order; a card voided by a refund (the Worker's own refund) and one moved to store credit (Q46); an expired
// card and one in date (Q47); a repeated press and an audit row that fails (FB15); picked up and back, shipped and
// back, by whom (FB24); the list, its search and the history, by named fields (FB16).

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))
vi.mock('@/server/stripe/client', async (importOriginal) => {
  const { stripeClientMock } = await import('@/server/rules/testing/replay/stripe-binding')
  return stripeClientMock(await importOriginal<typeof import('@/server/stripe/client')>())
})

const KEY = 'test-staff-api-key'
const NO_REFUNDS = 'front.desk@example.com'
const INACTIVE = 'gone@example.com'
const NOBODY = 'nobody@example.com'
const NO_STAFF_WORDS = `No staff record matches the logged-in user's email (${NOBODY}). Ask an admin to add you as staff before performing this action.`
const INACTIVE_WORDS = 'This staff account is inactive. Ask an admin to reactivate it.'

let environment: ReplayEnvironment
let db: Db
let frontDeskId = ''
beforeAll(async () => {
  process.env.STAFF_API_KEY = KEY
  environment = await startReplay()
  db = environment.database.db
  holder.db = db
})
afterAll(() => environment.stop())

/** The seed (one digital card, SEEDCARD: £40, in date to 1 January 2030), a pickup card, a shipping card, and two more staff. */
async function seeded(work: (context: ScenarioContext) => Promise<void>): Promise<void> {
  await replay(
    environment,
    {
      name: 'w38 gift cards',
      async seed(seedDb, stripe) {
        await seed(seedDb, stripe)
        const base = { type: 'monetary', original_value: '25.00', remaining_balance: '25.00', origin: 'customer_purchase', expiry_date: '2029-01-01', purchaser_id: ID.customer }
        await insert(seedDb, 'gift_cards', { ...base, id: W36_ID.pickupCard, code: 'PICKUP01', fulfillment_method: 'pickup', recipient_name: 'Ali Pickup', recipient_email: 'ali@example.com' })
        await insert(seedDb, 'gift_cards', { ...base, id: W36_ID.shippedCard, code: 'SHIPPED1', fulfillment_method: 'shipping', recipient_name: 'Bo Shipped' })
        frontDeskId = await insert(seedDb, 'staff', { first_name: 'Fran', last_name: 'Desk', email: NO_REFUNDS, role: 'staff', can_issue_refunds: false, can_manage_pricing: false, active: true })
        await insert(seedDb, 'staff', { first_name: 'Gone', last_name: 'Away', email: INACTIVE, role: 'staff', can_issue_refunds: true, can_manage_pricing: true, active: false })
      },
      run: work,
    },
    workerSide()
  )
}

type ErrorBody = { code: string; message: string; field?: string; details?: { reason?: string; message?: string; action?: string } }
type Answer = { status: number; replayed: boolean; body: { ok: boolean; data?: unknown; error?: ErrorBody } }
type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>
interface Who {
  email?: string
  key?: string | null
}

async function send(handler: Handler, method: 'GET' | 'POST', path: string, params: Record<string, string>, body: unknown, { email = REPLAY_USER.email, key = crypto.randomUUID() }: Who = {}): Promise<Answer> {
  // The replay holds the clock still (Postgres's too): moved on between presses, so rows read in time order keep theirs.
  vi.setSystemTime(Date.now() + 1000)
  const response = await handler(
    new Request(`https://worker.test/api/v1/staff/${path}`, {
      method,
      headers: { authorization: `Bearer ${KEY}`, 'x-staff-email': email, ...(method === 'POST' && key ? { 'idempotency-key': key } : {}), 'content-type': 'application/json' },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
    }),
    { params: Promise.resolve(params) }
  )
  return { status: response.status, replayed: response.headers.get('Idempotency-Replayed') === 'true', body: (await response.json()) as Answer['body'] }
}

const extend = (extendByMonths: unknown, who: Who & { card?: string } = {}) =>
  send(extendRoute as Handler, 'POST', `gift-cards/${who.card ?? ID.giftCard}/extend`, { giftCardId: who.card ?? ID.giftCard }, extendByMonths === undefined ? {} : { extendByMonths }, who)
const pickedUp = (card: string, value: unknown, who: Who = {}) => send(pickedUpRoute as Handler, 'POST', `gift-cards/${card}/picked-up`, { giftCardId: card }, { pickedUp: value }, who)
const shipped = (card: string, value: unknown, who: Who = {}) => send(shippedRoute as Handler, 'POST', `gift-cards/${card}/shipped`, { giftCardId: card }, { shipped: value }, who)
const list = (search?: string, who: Who = {}) => send(listRoute as Handler, 'GET', `gift-cards${search === undefined ? '' : `?search=${encodeURIComponent(search)}`}`, {}, undefined, who)
const redemptions = (card: string, who: Who = {}) => send(redemptionsRoute as Handler, 'GET', `gift-cards/${card}/redemptions`, { giftCardId: card }, undefined, who)

const refusal = (answer: Answer) => `${answer.status} ${answer.body.error?.code} ${answer.body.error?.details?.reason}: ${answer.body.error?.message}`

interface Card {
  expiry_date: string
  voided: boolean | null
  remaining_balance: string
  redeemed: boolean
  picked_up: boolean
  picked_up_by: string | null
  picked_up_set: boolean
  shipped_by: string | null
  shipped_set: boolean
}
async function cardNow(id: string = ID.giftCard): Promise<Card> {
  const [card] = await db.query<Card>(
    `SELECT expiry_date::text AS expiry_date, voided, remaining_balance::text AS remaining_balance, redeemed_at IS NOT NULL AS redeemed,
            picked_up, picked_up_by::text AS picked_up_by, picked_up_at IS NOT NULL AS picked_up_set, shipped_by::text AS shipped_by, shipped_at IS NOT NULL AS shipped_set
     FROM gift_cards WHERE id = $1`,
    [id]
  )
  if (!card) throw new Error(`No gift card ${id}`)
  return card
}
const audit = (action?: string) =>
  db.query<{ action: string; actor_type: string; actor_id: string; entity_type: string; entity_id: string; details: Record<string, unknown> }>(
    `SELECT action, actor_type, actor_id, entity_type, entity_id, details FROM audit_log WHERE action LIKE 'gift_card.%' AND ($1::text IS NULL OR action = $1) ORDER BY at, ctid`,
    [action ?? null]
  )
const setCard = (statement: string, id: string = ID.giftCard) => db.query(statement, [id])

const SEED: Card = { expiry_date: '2030-01-01', voided: false, remaining_balance: '40.00', redeemed: false, picked_up: false, picked_up_by: null, picked_up_set: false, shipped_by: null, shipped_set: false }

describe('extend: who may, and every refusal in the old order', () => {
  it('no staff record and an inactive account are refused before anything else; a press needs a key', async () => {
    await seeded(async () => {
      expect(refusal(await extend(6, { email: NOBODY }))).toBe(`401 UNAUTHORISED undefined: ${NO_STAFF_WORDS}`)
      expect(refusal(await extend(6, { email: INACTIVE }))).toBe(`403 FORBIDDEN undefined: ${INACTIVE_WORDS}`)
      expect((await extend(0, { email: INACTIVE, card: W36_ID.unknown })).status).toBe(403)
      expect((await extend(6, { key: null })).body.error).toMatchObject({ code: 'VALIDATION', field: 'Idempotency-Key' })
      expect(await cardNow()).toEqual(SEED)
      expect(await audit()).toEqual([])
    })
  })

  it('Issue refunds first (the old words), then the months, then the card: each refused with nothing changed', async () => {
    await seeded(async () => {
      // No Issue refunds is refused whatever else is wrong.
      for (const [months, card] of [
        [6, ID.giftCard],
        [0, ID.giftCard],
        [6, W36_ID.unknown],
      ] as const) {
        const denied = await extend(months, { email: NO_REFUNDS, card })
        expect(refusal(denied)).toBe(`403 FORBIDDEN permission_denied: ${GIFT_CARD_EXTEND_WORDS.permissionDenied}`)
        expect(denied.body.error?.details).toEqual({ reason: 'permission_denied', message: 'Needs the Issue refunds permission to extend or re-activate a gift card.', action: 'gift_card_extend' })
      }
      // The months: a whole number above 0, as a number.
      for (const months of [0, -1, 1.5, '6', '', null, undefined, true, [6], { months: 6 }, Number.NaN, Number.POSITIVE_INFINITY]) {
        for (const card of [ID.giftCard, W36_ID.unknown]) {
          const answer = await extend(months, { card })
          expect(refusal(answer), JSON.stringify(months)).toBe(`400 VALIDATION invalid_months: ${GIFT_CARD_EXTEND_WORDS.monthsInvalid}`)
          expect(answer.body.error?.field).toBe('extendByMonths')
          expect(answer.body.error?.details).toEqual({ reason: 'invalid_months', message: 'Enter a whole number of months from 1 to 120.', action: 'gift_card_extend' })
        }
      }
      // The card.
      const gone = await extend(6, { card: W36_ID.unknown })
      expect(refusal(gone)).toBe(`404 NOT_FOUND gift_card_not_found: ${GIFT_CARD_EXTEND_WORDS.failed}`)
      expect((await extend(6, { card: 'not-an-id' })).body.error).toMatchObject({ code: 'VALIDATION', field: 'giftCardId' })
      expect(await cardNow()).toEqual(SEED)
      expect(await audit()).toEqual([])
    })
  })
})

describe('extend: the months stop at 120 (W38a, review S2; Wayne, 16 Nov)', () => {
  const TOO_MANY = `400 VALIDATION invalid_months: Enter a whole number of months from 1 to 120.`

  it('1 and 120 are taken, each with its audit row', async () => {
    await seeded(async () => {
      expect(GIFT_CARD_EXTEND_MAX_MONTHS).toBe(120)
      expect((await extend(1, { card: W36_ID.pickupCard })).body.data).toEqual({ giftCard: { id: W36_ID.pickupCard, expiry_date: '2029-02-01', voided: false } })
      // 120 months is ten years on.
      expect((await extend(120)).body.data).toEqual({ giftCard: { id: ID.giftCard, expiry_date: '2040-01-01', voided: false } })
      expect((await audit('gift_card.extended')).map((row) => [row.entity_id, row.details['months'], row.details['expiryAfter']])).toEqual([
        [W36_ID.pickupCard, 1, '2029-02-01'],
        [ID.giftCard, 120, '2040-01-01'],
      ])
    })
  })

  it('121, and numbers the database could not take (2,147,483,648 and above), are refused as `invalid_months` with the range in words: the card unchanged, no audit row, on a real card and an unknown one', async () => {
    await seeded(async () => {
      for (const months of [121, 1_200, 2_147_483_647, 2_147_483_648, 70_000_000, Number.MAX_SAFE_INTEGER, 1e21]) {
        for (const card of [ID.giftCard, W36_ID.unknown]) {
          const answer = await extend(months, { card })
          expect(refusal(answer), String(months)).toBe(TOO_MANY)
          expect(answer.body.error?.field).toBe('extendByMonths')
          expect(answer.body.error?.details).toEqual({ reason: 'invalid_months', message: GIFT_CARD_EXTEND_WORDS.monthsInvalid, action: 'gift_card_extend' })
        }
      }
      expect(await cardNow()).toEqual(SEED)
      expect(await audit()).toEqual([])
    })
  })

  it('the press key of a number too large is answered as a refusal, the same again, never as a fault (which the staff app would read as "no answer"); the months put right under a new key go through', async () => {
    await seeded(async () => {
      for (const months of [121, 2_147_483_648]) {
        const key = crypto.randomUUID()
        const first = await extend(months, { key })
        const again = await extend(months, { key })
        for (const answer of [first, again]) {
          expect(refusal(answer), String(months)).toBe(TOO_MANY)
          expect(answer.body.error?.code).not.toBe('INTERNAL')
          expect(answer.body.error?.code).not.toBe('CONFLICT')
        }
      }
      expect(await cardNow()).toEqual(SEED)
      expect(await audit()).toEqual([])
      expect((await extend(120)).status).toBe(200)
    })
  })

  it('the ceiling is checked before the database is touched: no transaction is opened and no statement sent', async () => {
    const untouched = { query: vi.fn(), transaction: vi.fn() }
    const options = { actor: { type: 'staff' as const, id: ID.staff, canIssueRefunds: true }, requestId: 'w38a' }
    for (const months of [121, 2_147_483_648]) {
      await expect(extendGiftCard(untouched as unknown as Db, ID.giftCard, { extendByMonths: months }, options)).rejects.toThrow(GIFT_CARD_EXTEND_WORDS.monthsInvalid)
    }
    expect(untouched.transaction).not.toHaveBeenCalled()
    expect(untouched.query).not.toHaveBeenCalled()
    // The check has teeth: a number in range does reach the database.
    untouched.transaction.mockRejectedValue(new Error('reached the database'))
    await expect(extendGiftCard(untouched as unknown as Db, ID.giftCard, { extendByMonths: 120 }, options)).rejects.toThrow('reached the database')
  })
})

describe('extend: where the months are counted from (Q47)', () => {
  it('a card still in date has the months added to its expiry, as before; the audit row has who, the months and both dates; nothing else on the card moves', async () => {
    await seeded(async () => {
      const answer = await extend(6)
      expect(answer.status).toBe(200)
      expect(answer.body.data).toEqual({ giftCard: { id: ID.giftCard, expiry_date: '2030-07-01', voided: false } })
      expect(await cardNow()).toEqual({ ...SEED, expiry_date: '2030-07-01' })
      expect(await audit()).toEqual([
        { action: 'gift_card.extended', actor_type: 'staff', actor_id: ID.staff, entity_type: 'gift_card', entity_id: ID.giftCard, details: { months: 6, expiryBefore: '2030-01-01', expiryAfter: '2030-07-01', countedFrom: 'expiry', voidedBefore: false } },
      ])
      // A second extension counts from the new expiry, with its own row.
      expect((await extend(1)).body.data).toEqual({ giftCard: { id: ID.giftCard, expiry_date: '2030-08-01', voided: false } })
      expect((await audit()).map((row) => [row.details['expiryBefore'], row.details['expiryAfter']])).toEqual([
        ['2030-01-01', '2030-07-01'],
        ['2030-07-01', '2030-08-01'],
      ])
      // The other two cards are untouched.
      expect((await cardNow(W36_ID.pickupCard)).expiry_date).toBe('2029-01-01')
    })
  })

  it('a card on its last day is still in date: the months are added to its expiry', async () => {
    await seeded(async () => {
      // Today is 10 November 2026 (the replay's clock).
      await setCard("UPDATE gift_cards SET expiry_date = '2026-11-10' WHERE id = $1")
      expect((await extend(2)).body.data).toMatchObject({ giftCard: { expiry_date: '2027-01-10' } })
      expect((await audit())[0]?.details).toMatchObject({ countedFrom: 'expiry', expiryBefore: '2026-11-10' })
    })
  })

  it('a card that expired yesterday, and one that expired 14 months ago, each count the months from today', async () => {
    await seeded(async () => {
      await setCard("UPDATE gift_cards SET expiry_date = '2026-11-09' WHERE id = $1")
      expect((await extend(1)).body.data).toEqual({ giftCard: { id: ID.giftCard, expiry_date: '2026-12-10', voided: false } })
      await setCard("UPDATE gift_cards SET expiry_date = '2025-09-10' WHERE id = $1")
      expect((await extend(3)).body.data).toEqual({ giftCard: { id: ID.giftCard, expiry_date: '2027-02-10', voided: false } })
      expect((await audit()).map((row) => row.details)).toEqual([
        { months: 1, expiryBefore: '2026-11-09', expiryAfter: '2026-12-10', countedFrom: 'today', voidedBefore: false },
        { months: 3, expiryBefore: '2025-09-10', expiryAfter: '2027-02-10', countedFrom: 'today', voidedBefore: false },
      ])
      // The old function would have left it on 10 December 2025: still expired.
      expect((await cardNow()).expiry_date > '2026-11-10').toBe(true)
    })
  })

  it('"a month on" from the 31st is the month\'s last day, from an expiry and from today; and today is London\'s date, not UTC\'s', async () => {
    await seeded(async () => {
      await setCard("UPDATE gift_cards SET expiry_date = '2027-01-31' WHERE id = $1")
      expect((await extend(1)).body.data).toMatchObject({ giftCard: { expiry_date: '2027-02-28' } })
      // From today, on 31 January 2027, for a card that expired the day before.
      vi.setSystemTime(new Date('2027-01-31T12:00:00.000Z'))
      await setCard("UPDATE gift_cards SET expiry_date = '2027-01-30' WHERE id = $1", W36_ID.pickupCard)
      expect((await extend(1, { card: W36_ID.pickupCard })).body.data).toMatchObject({ giftCard: { expiry_date: '2027-02-28' } })
      // 23:30 UTC on 30 June is 00:30 on 1 July in London: a card good through 30 June has expired, and a month from
      // today is 1 August. (By UTC's date it would still be in date, and end on 30 July.)
      vi.setSystemTime(new Date('2027-06-30T23:30:00.000Z'))
      await setCard("UPDATE gift_cards SET expiry_date = '2027-06-30' WHERE id = $1", W36_ID.shippedCard)
      expect((await extend(1, { card: W36_ID.shippedCard })).body.data).toMatchObject({ giftCard: { expiry_date: '2027-08-01' } })
      expect((await audit()).map((row) => row.details['countedFrom'])).toEqual(['expiry', 'today', 'today'])
    })
  })
})

describe('extend: a voided card (Q46)', () => {
  /** Sam buys a £60 gift card with cash (the old createOrder), and the Worker refunds its line to store credit. */
  async function boughtAndRefunded({ call }: ScenarioContext): Promise<{ cardId: string; orderId: string; lineId: string }> {
    const placed = (await call('createOrder', { customerId: ID.customer, giftCard: { giftCardPresetId: ID.giftCardPreset, fulfillmentMethod: 'digital' }, payment: { method: 'cash', confirmedCashAmount: 60 } })) as { orderId: string; giftCardId: string }
    const [line] = await db.query<{ id: string }>("SELECT id FROM order_line_items WHERE order_id = $1::uuid AND item_type = 'gift_card'", [placed.orderId])
    if (!line) throw new Error('No gift card line')
    const refunded = (await refundOrderAsTheDialogPresses()(db, { orderId: placed.orderId, lineItemIds: [line.id], refundMethod: 'credit', restock: {} })) as { success?: boolean }
    expect(refunded).toMatchObject({ success: true })
    return { cardId: placed.giftCardId, orderId: placed.orderId, lineId: line.id }
  }

  it("a card voided because its order was refunded (by the Worker's own refund) can't be reactivated: refused with the reason why, the card left voided, no audit row; Issue refunds is still checked first", async () => {
    await seeded(async (context) => {
      const { cardId } = await boughtAndRefunded(context)
      const before = await cardNow(cardId)
      expect(before).toMatchObject({ voided: true, remaining_balance: '60.00' })
      const answer = await extend(1, { card: cardId })
      expect(refusal(answer)).toBe(`409 CONFLICT voided_by_refund: ${GIFT_CARD_EXTEND_NEW_WORDS.voidedByRefund}`)
      expect(answer.body.error?.details).toEqual({
        reason: 'voided_by_refund',
        message: "This gift card was voided because its order was refunded, so it can't be reactivated or extended. Its value was refunded with the order: check the order for where it went.",
        action: 'gift_card_extend',
      })
      expect(refusal(await extend(1, { card: cardId, email: NO_REFUNDS }))).toContain('permission_denied')
      expect(refusal(await extend(0, { card: cardId }))).toContain('invalid_months')
      // Expired as well: still refused, and not given a new date.
      await setCard("UPDATE gift_cards SET expiry_date = '2025-01-01' WHERE id = $1", cardId)
      expect(refusal(await extend(12, { card: cardId }))).toContain('voided_by_refund')
      expect(await cardNow(cardId)).toEqual({ ...before, expiry_date: '2025-01-01' })
      expect(await audit('gift_card.extended')).toEqual([])
      // Another card is not held back by this one's refund.
      expect((await extend(1)).status).toBe(200)
      expect(GIFT_CARD_EXTEND_NEW_REASONS).toEqual(['voided_by_refund', 'voided_to_store_credit'])
    })
  })

  it("a card voided because its balance was moved to store credit (migration 010's movement) can't be reactivated: refused with that reason", async () => {
    await seeded(async () => {
      // As migration 010 left such a card: emptied, voided, and a `migrated_from_gift_card` movement that names it.
      await db.query("SELECT public.store_credit_apply($1::uuid, 25::numeric, 'migrated_from_gift_card', NULL, NULL, NULL, 'Migrated from credit-style gift card', $2::uuid)", [ID.customer, W36_ID.pickupCard])
      await setCard('UPDATE gift_cards SET remaining_balance = 0, voided = true WHERE id = $1', W36_ID.pickupCard)
      const before = await cardNow(W36_ID.pickupCard)
      const answer = await extend(6, { card: W36_ID.pickupCard })
      expect(refusal(answer)).toBe(`409 CONFLICT voided_to_store_credit: ${GIFT_CARD_EXTEND_NEW_WORDS.voidedToStoreCredit}`)
      expect(answer.body.error?.message).toBe("This gift card was voided because its balance was moved to the customer's store credit, so it can't be reactivated or extended. Its balance was moved to their store credit.")
      expect(await cardNow(W36_ID.pickupCard)).toEqual(before)
      expect(await audit('gift_card.extended')).toEqual([])
      // A movement of another kind that names the card (none is written today) is not that reason.
      await db.query("SELECT public.store_credit_apply($1::uuid, 5::numeric, 'manual_adjustment', NULL, NULL, NULL, 'Goodwill', $2::uuid)", [ID.customer, W36_ID.shippedCard])
      await setCard('UPDATE gift_cards SET voided = true WHERE id = $1', W36_ID.shippedCard)
      expect((await extend(1, { card: W36_ID.shippedCard })).body.data).toMatchObject({ giftCard: { voided: false } })
    })
  })

  it('refunded and moved to store credit both: the refund is the reason given', async () => {
    await seeded(async (context) => {
      const { cardId } = await boughtAndRefunded(context)
      await db.query("SELECT public.store_credit_apply($1::uuid, 1::numeric, 'migrated_from_gift_card', NULL, NULL, NULL, 'Migrated', $2::uuid)", [ID.customer, cardId])
      expect(refusal(await extend(1, { card: cardId }))).toContain('409 CONFLICT voided_by_refund')
    })
  })

  it('a card voided for any other reason is un-voided and extended, as before, and the audit row says it was voided; one that is not voided is never refused for an old refund or movement', async () => {
    await seeded(async (context) => {
      await setCard('UPDATE gift_cards SET voided = true WHERE id = $1')
      expect((await extend(6)).body.data).toEqual({ giftCard: { id: ID.giftCard, expiry_date: '2030-07-01', voided: false } })
      expect((await audit('gift_card.extended'))[0]?.details).toEqual({ months: 6, expiryBefore: '2030-01-01', expiryAfter: '2030-07-01', countedFrom: 'expiry', voidedBefore: true })
      // A card that was sold on an order (its line not refunded) and voided for another reason comes back too.
      const sold = (await context.call('createOrder', { customerId: ID.customer, giftCard: { giftCardPresetId: ID.giftCardPreset, fulfillmentMethod: 'digital' }, payment: { method: 'cash', confirmedCashAmount: 60 } })) as { giftCardId: string }
      await setCard('UPDATE gift_cards SET voided = true WHERE id = $1', sold.giftCardId)
      expect((await extend(1, { card: sold.giftCardId })).body.data).toMatchObject({ giftCard: { voided: false } })
      // A null `voided` (the column allows it) is not voided: extended, and set to false as before.
      await setCard('UPDATE gift_cards SET voided = NULL WHERE id = $1', W36_ID.shippedCard)
      expect((await extend(1, { card: W36_ID.shippedCard })).body.data).toMatchObject({ giftCard: { expiry_date: '2029-02-01', voided: false } })
      // A refunded card that something un-voided since (not this route): it is not voided, so the months are added.
      const { cardId } = await boughtAndRefunded(context)
      await setCard('UPDATE gift_cards SET voided = false WHERE id = $1', cardId)
      expect((await extend(1, { card: cardId })).status).toBe(200)
    })
  })
})

describe('extend: the press key (FB15), and nothing half done', () => {
  it('the same press again under its key gets the first answer back and adds nothing: one month, one audit row; a new key adds another', async () => {
    await seeded(async () => {
      const key = crypto.randomUUID()
      const first = await extend(1, { key })
      const again = await extend(1, { key })
      expect(first.replayed).toBe(false)
      expect(again.replayed).toBe(true)
      expect(again.body.data).toEqual(first.body.data)
      expect((await cardNow()).expiry_date).toBe('2030-02-01')
      expect(await audit('gift_card.extended')).toHaveLength(1)
      // A different press under that key is not taken as a new one.
      expect((await extend(2, { key })).body.error?.code).toBe('IDEMPOTENCY_MISMATCH')
      expect((await cardNow()).expiry_date).toBe('2030-02-01')
      expect((await extend(1)).body.data).toMatchObject({ giftCard: { expiry_date: '2030-03-01' } })
      expect(await audit('gift_card.extended')).toHaveLength(2)
    })
  })

  it('when the audit row fails nothing is kept: the date has not moved; the same key again gets the same fault back; a new press then extends once', async () => {
    await seeded(async () => {
      const key = crypto.randomUUID()
      const failed = await whileFailing(db, { table: 'audit_log', event: 'INSERT', when: `NEW.action = 'gift_card.extended'` }, () => extend(1, { key }))
      expect(failed.status).toBe(500)
      expect(failed.body.error?.code).toBe('INTERNAL')
      expect(await cardNow()).toEqual(SEED)
      const again = await extend(1, { key })
      expect(again.status).toBe(500)
      expect(again.replayed).toBe(true)
      expect(await cardNow()).toEqual(SEED)
      expect((await extend(1)).body.data).toMatchObject({ giftCard: { expiry_date: '2030-02-01' } })
      expect(await audit('gift_card.extended')).toHaveLength(1)
    })
  })

  it('a refusal changes nothing however often it is pressed, and a refused press can be pressed again once put right', async () => {
    await seeded(async () => {
      await setCard('UPDATE gift_cards SET voided = true WHERE id = $1')
      await db.query("SELECT public.store_credit_apply($1::uuid, 40::numeric, 'migrated_from_gift_card', NULL, NULL, NULL, 'Migrated', $2::uuid)", [ID.customer, ID.giftCard])
      for (let i = 0; i < 3; i += 1) expect(refusal(await extend(1))).toContain('voided_to_store_credit')
      expect(await cardNow()).toEqual({ ...SEED, voided: true })
      expect(await audit()).toEqual([])
    })
  })
})

describe('picked up and shipped', () => {
  it('picked up and back: the flag, who and when, then cleared; an audit row each, with what was there before; the answer is the card by its named fields', async () => {
    await seeded(async () => {
      const set = await pickedUp(W36_ID.pickupCard, true)
      expect(set.status).toBe(200)
      const row = (set.body.data as { giftCard: Record<string, unknown> }).giftCard
      expect(Object.keys(row).sort()).toEqual([...GIFT_CARD_COLUMNS].sort())
      expect(row).toMatchObject({ id: W36_ID.pickupCard, code: 'PICKUP01', original_value: '25.00', remaining_balance: '25.00', expiry_date: '2029-01-01', picked_up: true, picked_up_by: ID.staff, shipped_at: null, shipped_by: null })
      expect(typeof row['picked_up_at']).toBe('string')
      expect(await cardNow(W36_ID.pickupCard)).toMatchObject({ picked_up: true, picked_up_by: ID.staff, picked_up_set: true })
      const cleared = await pickedUp(W36_ID.pickupCard, false)
      expect((cleared.body.data as { giftCard: Record<string, unknown> }).giftCard).toMatchObject({ picked_up: false, picked_up_at: null, picked_up_by: null })
      expect(await cardNow(W36_ID.pickupCard)).toMatchObject({ picked_up: false, picked_up_by: null, picked_up_set: false, expiry_date: '2029-01-01', remaining_balance: '25.00', voided: false })
      const rows = await audit('gift_card.picked_up')
      expect(rows.map((one) => [one.actor_id, one.entity_type, one.entity_id])).toEqual([
        [ID.staff, 'gift_card', W36_ID.pickupCard],
        [ID.staff, 'gift_card', W36_ID.pickupCard],
      ])
      expect(rows[0]?.details).toEqual({ pickedUp: true, before: { pickedUp: false, at: null, by: null } })
      expect(rows[1]?.details).toEqual({ pickedUp: false, before: { pickedUp: true, at: row['picked_up_at'], by: ID.staff } })
    })
  })

  it('shipped and back: when and who, then cleared; an audit row each', async () => {
    await seeded(async () => {
      const set = await shipped(W36_ID.shippedCard, true)
      const row = (set.body.data as { giftCard: Record<string, unknown> }).giftCard
      expect(Object.keys(row).sort()).toEqual([...GIFT_CARD_COLUMNS].sort())
      expect(row).toMatchObject({ id: W36_ID.shippedCard, shipped_by: ID.staff, picked_up: false })
      expect(typeof row['shipped_at']).toBe('string')
      expect(await cardNow(W36_ID.shippedCard)).toMatchObject({ shipped_by: ID.staff, shipped_set: true })
      const cleared = await shipped(W36_ID.shippedCard, false)
      expect((cleared.body.data as { giftCard: Record<string, unknown> }).giftCard).toMatchObject({ shipped_at: null, shipped_by: null })
      expect(await cardNow(W36_ID.shippedCard)).toMatchObject({ shipped_by: null, shipped_set: false })
      expect((await audit('gift_card.shipped')).map((one) => one.details)).toEqual([
        { shipped: true, before: { shipped: false, at: null, by: null } },
        { shipped: false, before: { shipped: true, at: row['shipped_at'], by: ID.staff } },
      ])
    })
  })

  it('any active staff member may, Issue refunds or not, and the flag records which one; W58 (W45 audit row 14): setting it again keeps the first who and when (the later press is still recorded)', async () => {
    await seeded(async () => {
      expect((await pickedUp(W36_ID.pickupCard, true, { email: NO_REFUNDS })).status).toBe(200)
      const first = await cardNow(W36_ID.pickupCard)
      expect(first).toMatchObject({ picked_up: true, picked_up_by: frontDeskId })
      expect((await pickedUp(W36_ID.pickupCard, true)).status).toBe(200)
      expect(await cardNow(W36_ID.pickupCard)).toEqual(first)
      const at = async () => (await db.query<{ at: string }>('SELECT picked_up_at::text AS at FROM gift_cards WHERE id = $1', [W36_ID.pickupCard]))[0]?.at
      const firstAt = await at()
      expect((await pickedUp(W36_ID.pickupCard, true)).status).toBe(200)
      expect(await at()).toBe(firstAt)
      expect((await shipped(W36_ID.shippedCard, true, { email: NO_REFUNDS })).status).toBe(200)
      expect(await cardNow(W36_ID.shippedCard)).toMatchObject({ shipped_by: frontDeskId })
      expect((await audit()).map((row) => [row.action, row.actor_id])).toEqual([
        ['gift_card.picked_up', frontDeskId],
        ['gift_card.picked_up', ID.staff],
        ['gift_card.picked_up', ID.staff],
        ['gift_card.shipped', frontDeskId],
      ])
    })
  })

  it("the old checks: a card that doesn't exist (`not_found`), and one with another delivery method, setting or clearing, with the screens' words", async () => {
    await seeded(async () => {
      for (const value of [true, false]) {
        expect(refusal(await pickedUp(W36_ID.unknown, value))).toBe(`404 NOT_FOUND not_found: ${GIFT_CARD_FLAG_WORDS.pickupFailed}`)
        expect(refusal(await pickedUp(ID.giftCard, value))).toBe(`409 CONFLICT not_pickup_fulfillment: ${GIFT_CARD_FLAG_WORDS.notPickup}`)
        expect(refusal(await pickedUp(W36_ID.shippedCard, value))).toBe('409 CONFLICT not_pickup_fulfillment: This gift card is not a pickup-fulfillment card')
        expect(refusal(await shipped(W36_ID.unknown, value))).toBe(`404 NOT_FOUND not_found: ${GIFT_CARD_FLAG_WORDS.shippingFailed}`)
        expect(refusal(await shipped(ID.giftCard, value))).toBe(`409 CONFLICT not_shipping_fulfillment: ${GIFT_CARD_FLAG_WORDS.notShipping}`)
        expect(refusal(await shipped(W36_ID.pickupCard, value))).toBe('409 CONFLICT not_shipping_fulfillment: This gift card is not a shipping-fulfillment card')
      }
      expect((await pickedUp(W36_ID.pickupCard, true)).body.error).toBeUndefined()
      expect((await pickedUp(W36_ID.unknown, true)).body.error?.details).toEqual({ reason: 'not_found', message: 'Failed to update pickup status', action: 'gift_card_picked_up' })
      expect((await shipped(ID.giftCard, true)).body.error?.details).toEqual({ reason: 'not_shipping_fulfillment', message: 'This gift card is not a shipping-fulfillment card', action: 'gift_card_shipped' })
      // The contract: the flag is true or false, the card an id, and a press has a key.
      for (const value of ['true', 1, null]) {
        expect((await pickedUp(W36_ID.pickupCard, value)).body.error).toMatchObject({ code: 'VALIDATION', field: 'pickedUp' })
        expect((await shipped(W36_ID.shippedCard, value)).body.error).toMatchObject({ code: 'VALIDATION', field: 'shipped' })
      }
      expect((await pickedUp('not-an-id', true)).body.error).toMatchObject({ code: 'VALIDATION', field: 'giftCardId' })
      expect((await shipped(W36_ID.shippedCard, true, { key: null })).body.error).toMatchObject({ code: 'VALIDATION', field: 'Idempotency-Key' })
      expect(await cardNow(ID.giftCard)).toEqual(SEED)
      expect(await cardNow(W36_ID.shippedCard)).toMatchObject({ shipped_set: false, picked_up: false })
    })
  })

  it('FB24: someone with no staff record, and an inactive account, are refused setting and clearing, and the flags stay as they were', async () => {
    await seeded(async () => {
      await pickedUp(W36_ID.pickupCard, true)
      await shipped(W36_ID.shippedCard, true)
      const before = [await cardNow(W36_ID.pickupCard), await cardNow(W36_ID.shippedCard)]
      const rows = (await audit()).length
      for (const value of [true, false]) {
        expect(refusal(await pickedUp(W36_ID.pickupCard, value, { email: NOBODY }))).toBe(`401 UNAUTHORISED undefined: ${NO_STAFF_WORDS}`)
        expect(refusal(await shipped(W36_ID.shippedCard, value, { email: NOBODY }))).toBe(`401 UNAUTHORISED undefined: ${NO_STAFF_WORDS}`)
        expect(refusal(await pickedUp(W36_ID.pickupCard, value, { email: INACTIVE }))).toBe(`403 FORBIDDEN undefined: ${INACTIVE_WORDS}`)
        expect(refusal(await shipped(W36_ID.shippedCard, value, { email: INACTIVE }))).toBe(`403 FORBIDDEN undefined: ${INACTIVE_WORDS}`)
      }
      expect([await cardNow(W36_ID.pickupCard), await cardNow(W36_ID.shippedCard)]).toEqual(before)
      expect(before[0]).toMatchObject({ picked_up: true, picked_up_by: ID.staff })
      expect(before[1]).toMatchObject({ shipped_set: true, shipped_by: ID.staff })
      expect((await audit()).length).toBe(rows)
    })
  })

  it('the same press under its key answers once; when the audit row fails the flag is not set', async () => {
    await seeded(async () => {
      const key = crypto.randomUUID()
      const first = await pickedUp(W36_ID.pickupCard, true, { key })
      const again = await pickedUp(W36_ID.pickupCard, true, { key })
      expect(again.replayed).toBe(true)
      expect(again.body.data).toEqual(first.body.data)
      expect(await audit('gift_card.picked_up')).toHaveLength(1)
      const failed = await whileFailing(db, { table: 'audit_log', event: 'INSERT', when: `NEW.action = 'gift_card.shipped'` }, () => shipped(W36_ID.shippedCard, true))
      expect(failed.status).toBe(500)
      expect(await cardNow(W36_ID.shippedCard)).toMatchObject({ shipped_set: false, shipped_by: null })
    })
  })
})

describe('the list and the history', () => {
  it("the named fields are every column of gift_cards in the saved schema, so a new column is a decision; the list adds the purchaser's three", async () => {
    await seeded(async () => {
      const columns = await db.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'gift_cards' ORDER BY ordinal_position")
      expect([...GIFT_CARD_COLUMNS]).toEqual(columns.map((row) => row.column_name))
      const rows = (await list()).body.data as Array<Record<string, unknown>>
      expect(Object.keys(rows[0] ?? {}).sort()).toEqual([...GIFT_CARD_COLUMNS, 'purchaser_first_name', 'purchaser_last_name', 'purchaser_email', 'reactivate_refused'].sort())
    })
  })

  it('a column added to gift_cards is not read: the list, the history and a flag\'s answer hold the named fields only (the routes\' own check of what they answer is off in production, so the rule must not read it)', async () => {
    await seeded(async () => {
      await db.query('RESET ROLE')
      await db.query("ALTER TABLE public.gift_cards ADD COLUMN w38_private_note text DEFAULT 'not for the screen'")
      await db.query("ALTER TABLE public.gift_card_redemptions ADD COLUMN w38_private_note text DEFAULT 'not for the screen'")
      await db.query('SET ROLE paddock_worker')
      try {
        await insert(db, 'gift_card_redemptions', { gift_card_id: ID.giftCard, amount_used: '2.50' })
        // The rules themselves, not the routes: nothing between the SQL and the answer.
        const listed = await listGiftCards(db, undefined)
        expect(listed).toHaveLength(3)
        for (const row of listed) expect(Object.keys(row).sort()).toEqual([...GIFT_CARD_COLUMNS, 'purchaser_first_name', 'purchaser_last_name', 'purchaser_email', 'reactivate_refused'].sort())
        const history = await listGiftCardRedemptions(db, ID.giftCard)
        expect(history.map((row) => Object.keys(row).sort())).toEqual([['amount_used', 'booking_id', 'event_booking_id', 'gift_card_id', 'id', 'order_id', 'redeemed_at']])
        const flagged = await setGiftCardPickedUp(db, W36_ID.pickupCard, true, { actor: { type: 'staff', id: ID.staff, canIssueRefunds: false }, requestId: 'w38-test' })
        expect(Object.keys(flagged.giftCard).sort()).toEqual([...GIFT_CARD_COLUMNS].sort())
        expect(JSON.stringify([listed, history, flagged])).not.toContain('not for the screen')
      } finally {
        await db.query('RESET ROLE')
        await db.query('ALTER TABLE public.gift_cards DROP COLUMN w38_private_note')
        await db.query('ALTER TABLE public.gift_card_redemptions DROP COLUMN w38_private_note')
        await db.query('SET ROLE paddock_worker')
      }
    })
  })

  it('W58 (W45 audit row 15): `%` and `_` in a search match themselves; a code with them is still found', async () => {
    await seeded(async () => {
      await insert(db, 'gift_cards', { type: 'monetary', code: 'HALF_50%', original_value: '10.00', remaining_balance: '10.00', origin: 'issued_as_credit', expiry_date: '2027-06-30', fulfillment_method: 'digital' })
      const codes = async (search: string) => ((await list(search)).body.data as Array<{ code: string }>).map((card) => card.code)
      // The old read took `%` for any text, so a search of "%" listed every card.
      expect(await codes('%')).toEqual(['HALF_50%'])
      expect(await codes('_5')).toEqual(['HALF_50%'])
      expect(await codes('F_5')).toEqual(['HALF_50%'])
      expect(await codes('F.5')).toEqual([])
    })
  })

  it('every card with its purchaser, newest first; money and dates as text', async () => {
    await seeded(async () => {
      // One made later comes first.
      vi.setSystemTime(Date.now() + 60_000)
      await insert(db, 'gift_cards', { type: 'monetary', code: 'NEWEST01', original_value: '10.00', remaining_balance: '7.50', origin: 'issued_as_credit', expiry_date: '2027-06-30', fulfillment_method: 'digital', purchaser_id: ID.member })
      const answer = await list()
      expect(answer.status).toBe(200)
      const rows = answer.body.data as Array<Record<string, unknown>>
      expect(rows.map((row) => row['code'])).toEqual(['NEWEST01', 'SEEDCARD', 'PICKUP01', 'SHIPPED1'])
      expect(rows[0]).toMatchObject({ original_value: '10.00', remaining_balance: '7.50', expiry_date: '2027-06-30', origin: 'issued_as_credit', purchaser_id: ID.member, purchaser_first_name: 'Mo', purchaser_last_name: 'Member', purchaser_email: 'mo@example.com', voided: false, picked_up: false, redeemed_at: null })
      expect(rows[1]).toMatchObject({ purchaser_id: null, purchaser_first_name: null, purchaser_last_name: null, purchaser_email: null, expiry_date: '2030-01-01' })
      expect(typeof rows[0]?.['created_at']).toBe('string')
      expect(Number.isNaN(Date.parse(String(rows[0]?.['created_at'])))).toBe(false)
    })
  })

  it('search matches the code, the recipient (name or email) or the purchaser (first name, last name or email), anywhere in the text and in any case; trimmed; nothing found is an empty list', async () => {
    await seeded(async () => {
      const codes = async (search: string) => ((await list(search)).body.data as Array<{ code: string }>).map((row) => row.code)
      expect(await codes('pickup01')).toEqual(['PICKUP01'])
      expect(await codes('SEEDC')).toEqual(['SEEDCARD'])
      expect(await codes('bo ship')).toEqual(['SHIPPED1'])
      expect(await codes('ali@')).toEqual(['PICKUP01'])
      expect(await codes('sam@example')).toEqual(['PICKUP01', 'SHIPPED1'])
      expect(await codes('SAM')).toEqual(['PICKUP01', 'SHIPPED1'])
      expect(await codes('Test')).toEqual(['PICKUP01', 'SHIPPED1'])
      expect(await codes('  pickup01  ')).toEqual(['PICKUP01'])
      // Anywhere in the text, not only its start.
      expect(await codes('ickup0')).toEqual(['PICKUP01'])
      expect(await codes('shipped')).toEqual(['SHIPPED1'])
      expect(await codes('example.com')).toEqual(['PICKUP01', 'SHIPPED1'])
      expect(await codes('est')).toEqual(['PICKUP01', 'SHIPPED1'])
      expect(await codes('nobody')).toEqual([])
      // Spaces alone are no search: every card.
      expect(await codes('   ')).toEqual(['SEEDCARD', 'PICKUP01', 'SHIPPED1'])
      expect(await codes('')).toEqual(['SEEDCARD', 'PICKUP01', 'SHIPPED1'])
    })
  })

  it("a card's history: its uses, newest first, by named fields; a card with none, and one that doesn't exist, have an empty list", async () => {
    await seeded(async (context) => {
      expect((await redemptions(ID.giftCard)).body.data).toEqual([])
      const placed = (await context.call('createOrder', { customerId: ID.customer, booking: paidSeat(), payment: { method: 'cash', confirmedCashAmount: 15, giftCard: { giftCardId: ID.giftCard, amount: 5 } } })) as { success?: boolean; orderId?: string }
      expect(placed).toMatchObject({ success: true })
      vi.setSystemTime(Date.now() + 60_000)
      await insert(db, 'gift_card_redemptions', { gift_card_id: ID.giftCard, amount_used: '2.50' })
      const answer = await redemptions(ID.giftCard)
      const rows = answer.body.data as Array<Record<string, unknown>>
      expect(rows.map((row) => row['amount_used'])).toEqual(['2.50', '5.00'])
      expect(Object.keys(rows[1] ?? {}).sort()).toEqual(['amount_used', 'booking_id', 'event_booking_id', 'gift_card_id', 'id', 'order_id', 'redeemed_at'])
      expect(rows[1]).toMatchObject({ gift_card_id: ID.giftCard, order_id: placed.orderId, booking_id: null, event_booking_id: null })
      expect(typeof rows[1]?.['redeemed_at']).toBe('string')
      expect((await redemptions(W36_ID.pickupCard)).body.data).toEqual([])
      expect((await redemptions(W36_ID.unknown)).body.data).toEqual([])
      expect((await redemptions('not-an-id')).body.error).toMatchObject({ code: 'VALIDATION', field: 'giftCardId' })
    })
  })

  it('FB16: both reads refuse someone with no staff record and an inactive account; staff without Issue refunds may read', async () => {
    await seeded(async () => {
      expect(refusal(await list(undefined, { email: NOBODY }))).toBe(`401 UNAUTHORISED undefined: ${NO_STAFF_WORDS}`)
      expect(refusal(await list('seed', { email: INACTIVE }))).toBe(`403 FORBIDDEN undefined: ${INACTIVE_WORDS}`)
      expect(refusal(await redemptions(ID.giftCard, { email: NOBODY }))).toBe(`401 UNAUTHORISED undefined: ${NO_STAFF_WORDS}`)
      expect(refusal(await redemptions(ID.giftCard, { email: INACTIVE }))).toBe(`403 FORBIDDEN undefined: ${INACTIVE_WORDS}`)
      expect((await list(undefined, { email: NO_REFUNDS })).status).toBe(200)
      expect((await redemptions(ID.giftCard, { email: NO_REFUNDS })).status).toBe(200)
    })
  })
})
