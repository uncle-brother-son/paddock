import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BasketQuoteInput } from '@/contracts'
import type { Db } from '@/server/db'
import { pruneClientSecrets } from '@/server/http/idempotency'
import { oldSide, replay, startReplay, type ReplayEnvironment } from '@/server/rules/testing/replay/harness'
import { orderInput, postOrder } from '@/server/rules/testing/replay/order-side'
import { ID, paidSeat, seed } from '@/server/rules/testing/replay/scenarios'
import { finaliseOrder } from './finalise-order'
import type { MadeSubscription } from './membership'
import { priceBasket, SUB_PENNY_GIFT_CARD_MESSAGE, SUB_PENNY_PAYMENT_MESSAGE } from './price-basket'

// Brief W14a, the Worker items: W7-6 (free postage in pennies), W9-3 and W7-7 (sub-penny amounts refused
// at entry), W11-9 (stored client secrets pruned after the window) and W13d's defence (T2 writes no left
// row for a paid order whose record holds this very subscription, and says whether it wrote one).

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))

let environment: ReplayEnvironment
let db: Db

beforeAll(async () => {
  process.env.STAFF_API_KEY = 'test-staff-api-key'
  environment = await startReplay()
  db = environment.database.db
  holder.db = db
})
afterAll(() => environment.stop())
beforeEach(async () => {
  await replay(environment, { name: 'seed only', seed, run: async () => {} }, oldSide)
})

const quote = (input: Record<string, unknown>) => priceBasket(db, { customerId: ID.customer, ...input } as BasketQuoteInput)
const shipped = { shippingAddress: { name: 'Sam Test', line1: '1 Mill Lane', city: 'Hebden Bridge', postcode: 'HX7 1AA' }, postageMethod: 'standard' }

describe('W7-6: free postage is judged in pennies', () => {
  it('three candles at £16.65 reach a £49.95 threshold (16.65 × 3 is 49.949999… as a float)', async () => {
    await db.query(`UPDATE products SET base_price = '16.65' WHERE id = $1`, [ID.candle])
    await db.query(`UPDATE postage_settings SET free_shipping_threshold = '49.95'`)
    const answer = await quote({ products: [{ productVariantId: ID.candleVariant, quantity: 3 }], ...shipped })
    expect(answer.postage).toEqual({ method: 'standard', amount: 0, shippedValue: 49.95 })
  })

  it('a penny under still pays', async () => {
    await db.query(`UPDATE products SET base_price = '16.64' WHERE id = $1`, [ID.candle])
    await db.query(`UPDATE postage_settings SET free_shipping_threshold = '49.92'`)
    const answer = await quote({ products: [{ productVariantId: ID.candleVariant, quantity: 3 }], ...shipped })
    expect(answer.postage).toMatchObject({ amount: 0 })
    await db.query(`UPDATE postage_settings SET free_shipping_threshold = '49.93'`)
    expect((await quote({ products: [{ productVariantId: ID.candleVariant, quantity: 3 }], ...shipped })).postage).toMatchObject({ amount: 4.95 })
  })
})

describe('W9-3 and W7-7: an amount with a fraction of a penny is refused, never rounded', () => {
  it('a custom gift card of £25.555', async () => {
    const answer = await quote({ giftCard: { giftCardTypeId: ID.giftCardType, amount: 25.555, fulfillmentMethod: 'digital' } })
    expect(answer.problems[0]).toEqual({ stage: 'validation', reason: 'invalid_gift_card_amount', message: SUB_PENNY_GIFT_CARD_MESSAGE })
    // £25.56 is fine.
    expect((await quote({ giftCard: { giftCardTypeId: ID.giftCardType, amount: 25.56, fulfillmentMethod: 'digital' } })).problems).toEqual([])
  })

  it('£19.995 of store credit or of a gift card to pay with', async () => {
    const credit = await quote({ booking: paidSeat(), payment: { storeCredit: { amount: 19.995 } } })
    expect(credit.problems[0]).toMatchObject({ reason: 'store_credit_amount_invalid', message: SUB_PENNY_PAYMENT_MESSAGE })
    const card = await quote({ booking: paidSeat(), payment: { giftCard: { giftCardId: ID.giftCard, amount: 19.995 } } })
    expect(card.problems[0]).toMatchObject({ reason: 'gift_card_amount_invalid', message: SUB_PENNY_PAYMENT_MESSAGE })
  })

  it('the order refuses it too, keeping nothing (the golden w09-half-penny-store-credit-covers-it is the old code\'s)', async () => {
    const answer = await postOrder(orderInput({ customerId: ID.customer, booking: paidSeat(), payment: { storeCredit: { amount: 19.995 } } }))
    expect(answer.body).toMatchObject({ ok: false, error: { code: 'VALIDATION', message: SUB_PENNY_PAYMENT_MESSAGE, details: { reason: 'store_credit_amount_invalid' } } })
    expect((await db.query('SELECT 1 FROM orders')).length).toBe(0)
  })
})

describe('W11-9: a stored client secret is taken out after the pending window', () => {
  const insertAnswer = (endpoint: string, response: unknown, minutesAgo: number) =>
    db.query(
      `INSERT INTO api_idempotency (key, actor_type, actor_id, endpoint, request_hash, status, response, http_status, created_at)
       VALUES ($1, 'staff', $2, $3, 'h', 'done', $4, 200, now() - make_interval(mins => $5))`,
      [crypto.randomUUID(), ID.staff, endpoint, response as { [key: string]: unknown }, minutesAgo]
    )
  const reader = { ok: true, data: { orderId: 'o1', status: 'pending_reader', pendingReaderPayment: { orderId: 'o1', paymentIntentId: 'pi_1', clientSecret: 'pi_1_secret_x', amount: 20 } } }
  const setup = { ok: true, data: { clientSecret: 'seti_1_secret_x', setupIntentId: 'seti_1', stripeCustomerId: 'cus_1' } }

  it('older than 15 minutes: the secret goes, the rest stays; younger: kept, so a lost answer gets it back', async () => {
    await db.query('DELETE FROM api_idempotency')
    await insertAnswer('POST /api/v1/staff/orders', reader, 16)
    await insertAnswer('POST /api/v1/staff/terminal/setup-intents', setup, 20)
    await insertAnswer('POST /api/v1/staff/orders', reader, 5)
    expect(await pruneClientSecrets(db)).toBe(2)
    const rows = await db.query<{ response: { data: Record<string, unknown> }; old: boolean }>(
      `SELECT response, created_at < now() - interval '15 minutes' AS old FROM api_idempotency ORDER BY created_at`
    )
    const [setupRow, oldReader, youngReader] = rows
    expect(setupRow?.response.data).toEqual({ setupIntentId: 'seti_1', stripeCustomerId: 'cus_1' })
    expect(oldReader?.response.data['pendingReaderPayment']).toEqual({ orderId: 'o1', paymentIntentId: 'pi_1', amount: 20 })
    expect(youngReader?.response.data['pendingReaderPayment']).toMatchObject({ clientSecret: 'pi_1_secret_x' })
    // Nothing left to take: a second run changes nothing.
    expect(await pruneClientSecrets(db)).toBe(0)
  })
  // W19a (W19 review later 2): Settle on the reader stores its intent's secret under the booking's own path, which
  // pruneClientSecrets matches by pattern. settle.test.ts also runs this through the real route.
  it('a reader Settle older than 15 minutes: its secret goes, the rest stays; a younger one keeps it', async () => {
    await db.query('DELETE FROM api_idempotency')
    const settleAt = (bookingId: string) => `POST /api/v1/staff/bookings/${bookingId}/settle`
    const pending = { flow: 'settle', recordId: 'b1', pendingId: 'p1', paymentIntentId: 'pi_2', clientSecret: 'pi_2_secret_x', amount: 15 }
    const settle = { ok: true, data: { settled: false, pendingReaderPayment: pending } }
    await insertAnswer(settleAt(crypto.randomUUID()), settle, 16)
    await insertAnswer(settleAt(crypto.randomUUID()), settle, 5)
    // Another booking route keeps whatever it stored: the pattern names Settle only.
    await insertAnswer(`POST /api/v1/staff/bookings/${crypto.randomUUID()}/status`, settle, 20)
    expect(await pruneClientSecrets(db)).toBe(1)
    const rows = await db.query<{ endpoint: string; response: { data: Record<string, unknown> } }>(
      `SELECT endpoint, response FROM api_idempotency ORDER BY created_at, endpoint`
    )
    const kept = Object.fromEntries(Object.entries(pending).filter(([field]) => field !== 'clientSecret'))
    expect(rows.map((row) => [row.endpoint.replace(/[0-9a-f-]{36}/, ':id'), row.response.data['pendingReaderPayment']])).toEqual([
      ['POST /api/v1/staff/bookings/:id/status', pending],
      ['POST /api/v1/staff/bookings/:id/settle', kept],
      ['POST /api/v1/staff/bookings/:id/settle', pending],
    ])
    expect(await pruneClientSecrets(db)).toBe(0)
  })
})

describe("W13d's defence: T2 and a paid order that holds this press's subscription", () => {
  const subscription = (id: string): MadeSubscription => ({
    id,
    status: 'active',
    customer: 'cus_1',
    priceId: 'price_1',
    orderId: null,
    periodStart: null,
    periodEnd: null,
    invoicePaymentIntentId: null,
    amountPaid: 4000,
    invoiceTotal: 4000,
    invoiceId: null,
  })
  const leftRows = async () => (await db.query(`SELECT 1 FROM audit_log WHERE action = 'order.subscription_left'`)).length

  async function paidOrderHolding(subscriptionId: string): Promise<string> {
    const placed = await postOrder(orderInput({ customerId: ID.customer, booking: paidSeat(), payment: { method: 'cash', confirmedCashAmount: 20 } }))
    if (!placed.body.ok) throw new Error('The order was refused.')
    const orderId = placed.body.data.orderId
    await db.query(`UPDATE orders SET stripe_payment_intent_id = 'pi_other', reader_payment = $1 WHERE id = $2`, [
      { method: 'card', membership: { subscription_id: subscriptionId } } as { [key: string]: unknown },
      orderId,
    ])
    return orderId
  }

  it('the record names this subscription: no row, nothing said left, so nothing is put back', async () => {
    const orderId = await paidOrderHolding('sub_this')
    const outcome = await finaliseOrder(db, orderId, null, { actor: { type: 'staff', id: ID.staff }, requestId: 'r1', subscription: subscription('sub_this'), subscriptionMadeHere: true })
    expect(outcome).toEqual({ finalised: false, reason: 'paid_by_another_payment' })
    expect(await leftRows()).toBe(0)
  })

  it('the record names another subscription: the row is written, and T2 says so', async () => {
    const orderId = await paidOrderHolding('sub_other')
    const outcome = await finaliseOrder(db, orderId, null, { actor: { type: 'staff', id: ID.staff }, requestId: 'r1', subscription: subscription('sub_this'), subscriptionMadeHere: true })
    expect(outcome).toEqual({ finalised: false, reason: 'paid_by_another_payment', subscriptionLeft: true })
    expect(await leftRows()).toBe(1)
  })

  it('not made here: no row, nothing said left', async () => {
    const orderId = await paidOrderHolding('sub_other')
    const outcome = await finaliseOrder(db, orderId, null, { actor: { type: 'staff', id: ID.staff }, requestId: 'r1', subscription: subscription('sub_this') })
    expect(outcome).toEqual({ finalised: false, reason: 'paid_by_another_payment' })
    expect(await leftRows()).toBe(0)
  })
})
