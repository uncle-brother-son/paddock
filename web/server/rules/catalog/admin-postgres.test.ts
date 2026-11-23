import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { BasketQuoteInput } from '@/contracts'
import type { Db, Tx } from '@/server/db'
import { loadBasketFacts } from '@/server/rules/orders/load-basket'
import { lockForOrder } from '@/server/rules/orders/locks'
import { holdingAfter, outcomeOf, pressBy, sessionBlockedBy } from '@/server/rules/testing/admin-race'
import { fixtures, insert } from '@/server/rules/testing/database'
import { deferred, waitingOn } from '@/server/rules/testing/race'
import { startRealPostgres, type RealPostgres } from '@/server/rules/testing/real-postgres'
import { listServiceTypes, setTierGroupRange } from './service-types'
import { adjustStock } from './stock'

// Briefs W55 + W56 ("Parity and tests": races on real Postgres 17.6, each press on its own connection). Each race is
// held until Postgres itself reports the second press as blocked by the first, so none can pass by timing:
//  - GB13: two stock presses on one variant take turns on the variant's lock, and both count;
//  - GB13: a stock adjustment against an order taking that stock: the adjustment reads the stock the order left;
//  - GB21: a size group's range change against a private quote: a quote reads the group's old ranges in every band
//    until the change commits, and the new ones in every band after, never one band moved and the other not.
let pg: RealPostgres
let first: Db
let second: Db
let jo = ''
let sam = ''
let product = ''
let variant = ''

beforeAll(async () => {
  pg = await startRealPostgres()
  first = pg.connect()
  second = pg.connect()
  jo = await insert(first, 'staff', { role: 'admin', first_name: 'Jo', last_name: 'Staff', email: 'w55-catalog-race@example.com', can_issue_refunds: true, can_manage_pricing: true })
  sam = await fixtures.customer(first)
})
afterAll(() => pg.stop())

beforeEach(async () => {
  await first.query('DELETE FROM audit_log')
  await first.query('DELETE FROM stock_adjustments')
  await first.query('DELETE FROM product_variants')
  await first.query('DELETE FROM products')
  product = await insert(first, 'products', { name: 'T-shirt', base_price: '20.00' })
  variant = await insert(first, 'product_variants', { product_id: product, size: 'M', sku: `TEE-${crypto.randomUUID().slice(0, 8)}`, stock_quantity: 5 })
})

const stockNow = async () => Number((await first.query<{ stock_quantity: number }>('SELECT stock_quantity FROM product_variants WHERE id = $1', [variant]))[0]?.stock_quantity)
const ledger = async () => (await first.query<{ change_amount: number }>('SELECT change_amount FROM stock_adjustments WHERE variant_id = $1 ORDER BY change_amount', [variant])).map((row) => row.change_amount)
const backendPid = async (tx: Tx) => (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]?.pid as number

describe('GB13: a stock adjustment on real Postgres', () => {
  it('two presses on one variant: the second waits on the variant\'s row, then counts from what the first left; both ledger rows, both audit rows', async () => {
    const held = holdingAfter(first, (sql) => sql.startsWith('INSERT INTO stock_adjustments'))
    const one = adjustStock(held.db, { variantId: variant, changeAmount: 3, reasonCategory: 'delivery' }, pressBy(jo))
    const holder = await held.holding
    const two = adjustStock(second, { variantId: variant, changeAmount: 4, reasonCategory: 'delivery' }, pressBy(jo))
    expect(await waitingOn(pg, await sessionBlockedBy(pg, holder))).toEqual(['product_variants'])
    held.release()
    expect((await one).stock_quantity).toBe(8)
    expect((await two).stock_quantity).toBe(12)
    expect(await stockNow()).toBe(12)
    expect(await ledger()).toEqual([3, 4])
    const rows = await first.query<{ details: { before: { stock_quantity: number }; after: { stock_quantity: number } } }>("SELECT details FROM audit_log WHERE action = 'stock.adjusted' ORDER BY at, ctid")
    expect(rows.map((row) => [row.details.before.stock_quantity, row.details.after.stock_quantity])).toEqual([
      [5, 8],
      [8, 12],
    ])
  })

  it('against an order taking the stock: the adjustment waits on the order\'s lock, reads the stock the order left, and is refused below zero with those figures', async () => {
    const gate = deferred()
    let announce: (pid: number) => void = () => {}
    const holding = new Promise<number>((resolve) => {
      announce = resolve
    })
    // An order taking 2 of the 5, as the order path does: the variant's lock (lockForOrder), then the stock.
    const order = first.transaction(async (tx) => {
      await lockForOrder(tx, { customerId: sam, promoCode: null, sessionId: null, creditMembershipId: null, sessionPassId: null, addonMembershipIds: [], productVariantIds: [variant], eventId: null, giftCardId: null })
      await tx.query('UPDATE product_variants SET stock_quantity = stock_quantity - 2 WHERE id = $1', [variant])
      announce(await backendPid(tx))
      await gate.promise
    })
    const holder = await holding
    // Damage of 4: fine against the 5 on the shelf before the order, not against the 3 after it.
    const adjust = outcomeOf(adjustStock(second, { variantId: variant, changeAmount: -4, reasonCategory: 'damage' }, pressBy(jo)))
    expect(await waitingOn(pg, await sessionBlockedBy(pg, holder))).toEqual(['product_variants'])
    gate.resolve()
    await order
    expect(await adjust).toEqual({ refused: 'stock_below_zero' })
    expect(await stockNow()).toBe(3)
    expect(await ledger()).toEqual([])
  })

  it('control: an adjustment that read the stock outside the lock (the old check-then-write) would have passed its check against 5', async () => {
    const seen = await stockNow()
    await first.query('UPDATE product_variants SET stock_quantity = stock_quantity - 2 WHERE id = $1', [variant])
    expect(seen + -4 >= 0).toBe(true)
    expect((await stockNow()) + -4 >= 0).toBe(false)
  })
})

describe('GB21: a size group\'s range against a private quote, on real Postgres', () => {
  let privateType = ''
  let core = ''
  let peak = ''
  let coreSession = ''
  let peakSession = ''
  let coreTier = ''

  beforeEach(async () => {
    await first.query('DELETE FROM service_type_price_tiers')
    privateType = await fixtures.serviceType(first, { booking_type: 'private', duration: 120, capacity: 12 })
    core = await fixtures.band(first, { name: 'Core' })
    peak = await fixtures.band(first, { name: 'Peak' })
    coreTier = await insert(first, 'service_type_price_tiers', { service_type_id: privateType, band_id: core, min_people: 1, max_people: 4, price: '100.00' })
    await insert(first, 'service_type_price_tiers', { service_type_id: privateType, band_id: peak, min_people: 1, max_people: 4, price: '140.00' })
    const day = 10 + Math.floor(Math.random() * 18)
    coreSession = await fixtures.session(first, { service_type_id: privateType, type: 'private', capacity: 12, band_id: core, start_time: `2031-03-${day} 10:00:00+00`, end_time: `2031-03-${day} 12:00:00+00` })
    peakSession = await fixtures.session(first, { service_type_id: privateType, type: 'private', capacity: 12, band_id: peak, start_time: `2031-03-${day} 18:00:00+00`, end_time: `2031-03-${day} 20:00:00+00` })
  })

  /** A party of four's tier price in each band, as an order's basket reads it (load-basket.ts). */
  const quoteFour = async (db: Db): Promise<Array<string | null>> => {
    const guests = [1, 2, 3, 4].map((n) => ({ name: `Guest ${n}`, email: `g${n}@example.com`, dateOfBirth: '1990-01-01' }))
    const facts = async (sessionId: string) => (await loadBasketFacts(db, { customerId: sam, booking: { sessionId, guests } } as unknown as BasketQuoteInput)) as unknown as { session: { private_tier: { price: string | null } | null } | null }
    return [(await facts(coreSession)).session?.private_tier?.price ?? null, (await facts(peakSession)).session?.private_tier?.price ?? null]
  }

  it('while the change to 1 to 3 is written but not committed, a quote reads 1 to 4 in BOTH bands; after it, neither band prices four', async () => {
    const stamp = (await listServiceTypes(first, pressBy(jo).actor)).flatMap((type) => type['price_tiers'] as Array<{ id: string; range_stamp: string }>).find((tier) => tier.id === coreTier)?.range_stamp
    const held = holdingAfter(first, (sql) => sql.startsWith('UPDATE service_type_price_tiers SET min_people'))
    const change = setTierGroupRange(held.db, { tierId: coreTier, minPeople: 1, maxPeople: 3, stamp }, pressBy(jo))
    await held.holding
    expect(await quoteFour(second)).toEqual(['100.00', '140.00'])
    held.release()
    await change
    expect(await quoteFour(second)).toEqual([null, null])
  })

  it('two range changes of one group at once take turns on the service type: the second, from the same page, is refused changed_since', async () => {
    const stamp = (await listServiceTypes(first, pressBy(jo).actor)).flatMap((type) => type['price_tiers'] as Array<{ id: string; range_stamp: string }>).find((tier) => tier.id === coreTier)?.range_stamp
    const held = holdingAfter(first, (sql) => sql.startsWith('UPDATE service_type_price_tiers SET min_people'))
    const one = setTierGroupRange(held.db, { tierId: coreTier, minPeople: 1, maxPeople: 3, stamp }, pressBy(jo))
    const holder = await held.holding
    const two = outcomeOf(setTierGroupRange(second, { tierId: coreTier, minPeople: 1, maxPeople: 2, stamp }, pressBy(jo)))
    expect(await waitingOn(pg, await sessionBlockedBy(pg, holder))).toEqual(['service_types'])
    held.release()
    expect((await one).max_people).toBe(3)
    expect(await two).toEqual({ refused: 'changed_since' })
    expect((await first.query('SELECT id FROM service_type_price_tiers WHERE max_people = 3')).length).toBe(2)
  })
})
