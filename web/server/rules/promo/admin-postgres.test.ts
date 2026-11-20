import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Db, Queryable, Tx } from '@/server/db'
import { lockForOrder } from '@/server/rules/orders/locks'
import { holdingAfter, outcomeOf, pressBy, sessionBlockedBy } from '@/server/rules/testing/admin-race'
import { fixtures, insert } from '@/server/rules/testing/database'
import { deferred, waitingOn } from '@/server/rules/testing/race'
import { startRealPostgres, type RealPostgres } from '@/server/rules/testing/real-postgres'
import { createPromoCode, listPromoCodes, updatePromoCode } from './admin'

// Brief W54 item 6 (GB18; "Parity and tests"): a promo edit against an order using the code, on real Postgres 17.6,
// each on its own connection. The order's side is the order's own lock (lockForOrder, which every order placed with a
// code takes before it writes its redemption) and its redemption row. Each race is held until Postgres reports the
// second as blocked by the first; a control shows what the old count-then-write did.

let pg: RealPostgres
let first: Db
let second: Db
let jo = ''
let sam = ''
let allTen = ''

const EVERY_KIND = ['booking', 'addon', 'product', 'session_pass', 'membership', 'event']
const asItIs = { code: 'ALLTEN', discountType: 'percentage', discountValue: 10, appliesTo: EVERY_KIND, appliesOnMemberPrices: false, expiresOn: null, maxTotalUses: null, oneUsePerCustomer: false, minSpend: null, restrictedCustomerId: null, active: true }

beforeAll(async () => {
  pg = await startRealPostgres()
  first = pg.connect()
  second = pg.connect()
  jo = await insert(first, 'staff', { role: 'admin', first_name: 'Jo', last_name: 'Staff', email: 'w54-promo-race@example.com', can_issue_refunds: true, can_manage_pricing: true })
  sam = await fixtures.customer(first)
})
afterAll(() => pg.stop())

beforeEach(async () => {
  await first.query('DELETE FROM audit_log')
  await first.query('DELETE FROM promo_code_redemptions')
  await first.query('DELETE FROM orders')
  await first.query('DELETE FROM promo_codes')
  allTen = await insert(first, 'promo_codes', { code: 'ALLTEN', discount_type: 'percentage', discount_value: '10', applies_to: EVERY_KIND })
})

const noOtherLocks = { sessionId: null, creditMembershipId: null, sessionPassId: null, addonMembershipIds: [], productVariantIds: [], eventId: null, giftCardId: null }
/** An order using a code, as far as the code goes: the order's own lock (the customer, then the code), then its order and redemption rows. */
async function orderUsing(tx: Tx, code: string): Promise<string | null> {
  const held = await lockForOrder(tx, { customerId: sam, promoCode: code, ...noOtherLocks })
  if (!held?.promoCodeId) return null
  const [order] = await tx.query<{ id: string }>("INSERT INTO orders (customer_id, order_total, payment_status, payment_method, order_source) VALUES ($1, '18.00', 'paid', 'cash', 'staff_created') RETURNING id", [sam])
  await tx.query("INSERT INTO promo_code_redemptions (promo_code_id, order_id, customer_id, discount_amount) VALUES ($1, $2, $3, '2')", [held.promoCodeId, order?.id ?? null, sam])
  return held.promoCodeId
}
const codeNow = async () => (await first.query<{ code: string; discount_value: string }>('SELECT code, discount_value::text AS discount_value FROM promo_codes WHERE id = $1', [allTen]))[0]
/** W54a: a code's stamp as the Promo Codes page holds it after a load: from the list read, on the given connection. */
const stampOf = async (db: Queryable, id = allTen) => (await listPromoCodes(db, pressBy(jo).actor)).find((row) => row.id === id)?.stamp
const uses = async () => (await first.query('SELECT 1 FROM promo_code_redemptions WHERE promo_code_id = $1', [allTen])).length
const backendPid = async (tx: Tx) => (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]?.pid as number

describe("a promo edit against an order using the code (GB18)", () => {
  it("the edit of the code's text waits for the order on the code's row, then finds the code used and is refused: the text and the discount stay", async () => {
    const gate = deferred()
    let announce: (pid: number) => void = () => {}
    const holding = new Promise<number>((resolve) => {
      announce = resolve
    })
    const order = first.transaction(async (tx) => {
      const used = await orderUsing(tx, 'allten')
      announce(await backendPid(tx))
      await gate.promise
      return used
    })
    const holder = await holding
    const edit = outcomeOf(updatePromoCode(second, { promoCodeId: allTen, ...asItIs, code: 'ALLTWENTY', discountValue: 20, stamp: await stampOf(second) }, pressBy(jo)))
    expect(await waitingOn(pg, await sessionBlockedBy(pg, holder))).toEqual(['promo_codes'])
    gate.resolve()
    expect(await order).toBe(allTen)
    // W54a: an order using the code doesn't change the code's row, so the page is not out of date: the lock is what refuses.
    expect(await edit).toEqual({ refused: 'code_locked' })
    expect(await codeNow()).toEqual({ code: 'ALLTEN', discount_value: '10' })
    expect(await uses()).toBe(1)
    expect(await first.query('SELECT 1 FROM audit_log')).toEqual([])
  })

  it('the same edit, when the order is rolled back, goes through: the code was never used', async () => {
    const gate = deferred()
    let announce: (pid: number) => void = () => {}
    const holding = new Promise<number>((resolve) => {
      announce = resolve
    })
    const order = first
      .transaction(async (tx) => {
        await orderUsing(tx, 'ALLTEN')
        announce(await backendPid(tx))
        await gate.promise
        throw new Error('the order failed')
      })
      .catch(() => 'rolled back')
    const holder = await holding
    const edit = outcomeOf(updatePromoCode(second, { promoCodeId: allTen, ...asItIs, code: 'ALLTWENTY', discountValue: 20, stamp: await stampOf(second) }, pressBy(jo)))
    await sessionBlockedBy(pg, holder)
    gate.resolve()
    expect(await order).toBe('rolled back')
    expect(await edit).toMatchObject({ answered: { updated: true, promo: { code: 'ALLTWENTY', discount_value: '20' } } })
    expect(await uses()).toBe(0)
  })

  it("an order that meets an edit in progress waits for it on the code's row, then finds no code of that name: no redemption is written against a renamed code", async () => {
    const held = holdingAfter(first, (sql) => sql.startsWith('UPDATE promo_codes'))
    const edit = outcomeOf(updatePromoCode(held.db, { promoCodeId: allTen, ...asItIs, code: 'ALLTWENTY', discountValue: 20, stamp: await stampOf(second) }, pressBy(jo)))
    const holder = await held.holding
    const order = second.transaction((tx) => orderUsing(tx, 'ALLTEN'))
    expect(await waitingOn(pg, await sessionBlockedBy(pg, holder))).toEqual(['promo_codes'])
    held.release()
    expect(await edit).toMatchObject({ answered: { updated: true, promo: { code: 'ALLTWENTY' } } })
    // The order's lock found nothing called ALLTEN once the edit was in (place-order then refuses the code as not found).
    expect(await order).toBeNull()
    expect(await uses()).toBe(0)
  })

  it("control: the old count-then-write lets the text change under the order's redemption", async () => {
    // The old updatePromoCode's own statements (testing/legacy-admin): count the uses, then write.
    const [counted] = await second.query<{ uses: string }>('SELECT COUNT(*) AS uses FROM promo_code_redemptions WHERE promo_code_id = $1', [allTen])
    expect(counted?.uses).toBe('0')
    // An order uses the code between the two.
    await first.transaction((tx) => orderUsing(tx, 'ALLTEN'))
    await second.query("UPDATE promo_codes SET code = 'ALLTWENTY', discount_value = 20, updated_at = now() WHERE id = $1", [allTen])
    expect(await codeNow()).toEqual({ code: 'ALLTWENTY', discount_value: '20' })
    expect(await uses()).toBe(1)
  })
})

// W54a (W49 + W54 review S1): the reviewer's example as a true race. Both pages were loaded while WELCOME was 100%.
describe('two edits of one code at once, from pages loaded before either (W54a)', () => {
  let welcome = ''
  const welcomeAt100 = { code: 'WELCOME', discountType: 'percentage', discountValue: 100, appliesTo: EVERY_KIND, appliesOnMemberPrices: false, expiresOn: null, maxTotalUses: null, oneUsePerCustomer: false, minSpend: null, restrictedCustomerId: null, active: true }
  const welcomeNow = async () => (await first.query<{ discount_value: string; active: boolean }>('SELECT discount_value::text AS discount_value, active FROM promo_codes WHERE id = $1', [welcome]))[0]
  beforeEach(async () => {
    welcome = await insert(first, 'promo_codes', { code: 'WELCOME', discount_type: 'percentage', discount_value: '100', applies_to: EVERY_KIND })
  })

  it("B's correction to 10% is under way when A's switch is pressed: the switch waits on the code's row, then is refused, and WELCOME stays 10% and on", async () => {
    const loaded = await stampOf(second, welcome)
    const held = holdingAfter(first, (sql) => sql.startsWith('UPDATE promo_codes'))
    const correction = outcomeOf(updatePromoCode(held.db, { promoCodeId: welcome, ...welcomeAt100, discountValue: 10, stamp: loaded }, pressBy(jo)))
    const holder = await held.holding
    // B's 10% is written but not committed: a read still gives the stamp both pages hold, so a comparison made before
    // the lock would let A's switch through with its 100%.
    expect(await stampOf(second, welcome)).toBe(loaded)
    const switchOff = outcomeOf(updatePromoCode(second, { promoCodeId: welcome, ...welcomeAt100, active: false, stamp: loaded }, pressBy(jo)))
    expect(await waitingOn(pg, await sessionBlockedBy(pg, holder))).toEqual(['promo_codes'])
    held.release()
    expect(await correction).toMatchObject({ answered: { updated: true, promo: { discount_value: '10' } } })
    expect(await switchOff).toEqual({ refused: 'changed_since' })
    expect(await welcomeNow()).toEqual({ discount_value: '10', active: true })
    expect((await first.query("SELECT 1 FROM audit_log WHERE action = 'promo.updated'")).length).toBe(1)

    // A's page reloads: 10% on screen, and the switch goes through at 10%.
    const reloaded = await stampOf(second, welcome)
    expect(reloaded).toBe((await correction as { answered: { stamp: string } }).answered.stamp)
    expect(await outcomeOf(updatePromoCode(second, { promoCodeId: welcome, ...welcomeAt100, discountValue: 10, active: false, stamp: reloaded }, pressBy(jo)))).toMatchObject({ answered: { promo: { discount_value: '10', active: false } } })
  })

  it("control: with the stamp compared before the lock (read, then lock, then write), A's switch goes through and WELCOME is 100% again", async () => {
    const loaded = await stampOf(second, welcome)
    const held = holdingAfter(first, (sql) => sql.startsWith('UPDATE promo_codes'))
    const correction = outcomeOf(updatePromoCode(held.db, { promoCodeId: welcome, ...welcomeAt100, discountValue: 10, stamp: loaded }, pressBy(jo)))
    const holder = await held.holding
    // A's switch as it would be with the comparison in the wrong place: the list's stamp read first, then the lock and the write.
    const switchOff = second.transaction(async (tx) => {
      if ((await stampOf(tx, welcome)) !== loaded) return 'refused'
      await tx.query('SELECT id FROM promo_codes WHERE id = $1::uuid FOR NO KEY UPDATE', [welcome])
      await tx.query('UPDATE promo_codes SET discount_value = 100, active = false, updated_at = now() WHERE id = $1::uuid', [welcome])
      return 'saved'
    })
    expect(await waitingOn(pg, await sessionBlockedBy(pg, holder))).toEqual(['promo_codes'])
    held.release()
    expect(await correction).toMatchObject({ answered: { updated: true } })
    expect(await switchOff).toBe('saved')
    // B's correction is gone: the next £25 session booked with WELCOME, once switched on again, is free.
    expect(await welcomeNow()).toEqual({ discount_value: '100', active: false })
  })
})

describe('two creates of one code at once, in two letter cases', () => {
  it("one is made and the other is refused as a duplicate, in the old words: the table's index on the upper-cased code decides", async () => {
    const fields = { discountType: 'fixed', discountValue: 5, appliesTo: EVERY_KIND, appliesOnMemberPrices: false, expiresOn: null, maxTotalUses: null, oneUsePerCustomer: false, minSpend: null, restrictedCustomerId: null, description: undefined }
    const by = () => ({ ...pressBy(jo), createdBy: 'w54-promo-race@example.com' })
    const held = holdingAfter(first, (sql) => sql.startsWith('INSERT INTO promo_codes'))
    const one = outcomeOf(createPromoCode(held.db, { code: 'spring', ...fields }, by()))
    const holder = await held.holding
    const two = outcomeOf(createPromoCode(second, { code: 'SPRING', ...fields }, by()))
    // The second's insert waits on the first's uncommitted entry in the index.
    await sessionBlockedBy(pg, holder)
    held.release()
    expect(await one).toMatchObject({ answered: { code: 'SPRING' } })
    expect(await two).toEqual({ refused: 'duplicate_code' })
    expect((await first.query("SELECT 1 FROM promo_codes WHERE upper(code) = 'SPRING'")).length).toBe(1)
    expect((await first.query("SELECT 1 FROM audit_log WHERE action = 'promo.created'")).length).toBe(1)
  })
})
