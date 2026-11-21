import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { GET as redemptionsRoute } from '@/app/api/v1/staff/promo-codes/[promoCodeId]/redemptions/route'
import { POST as updateRoute } from '@/app/api/v1/staff/promo-codes/[promoCodeId]/route'
import { GET as listRoute, POST as createRoute } from '@/app/api/v1/staff/promo-codes/route'
import type { Db, SqlParam, Tx } from '@/server/db'
import { ADMIN_TEST_KEY, auditRowsOf, pressRoute, type AdminAnswer } from '@/server/rules/testing/admin-routes'
import { fixtures, insert, startTestDatabase, type TestDatabase } from '@/server/rules/testing/database'
import { STAFF_ADMIN_WORDS } from '@/server/rules/staff/failure-messages'
import { createPromoCode, updatePromoCode } from './admin'
import { PROMO_ADMIN_WORDS } from './admin-failure-messages'

vi.setConfig({ testTimeout: 60_000 })

// Brief W54 items 4 and 6 (G-plan 5, W54's tests): the four promo code routes on the live schema. Every refusal in
// the old order and words; the locked code text; a duplicate in another letter case, on create and on edit; the two
// reads' named fields and their staff check (GB14); the audit rows with the code before and after (GB18). The edit
// against an order using the code, with two connections, is in admin-postgres.test.ts.

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))

const JO = 'jo@example.com'
const TIA = 'tia@example.com'
const WORDS = PROMO_ADMIN_WORDS
const NO_PRICING = STAFF_ADMIN_WORDS.pricingStaff.youDoNotHavePermissionManage
const INACTIVE = STAFF_ADMIN_WORDS.staffAccess.staffAccountInactiveAskAdminReactivate
const UNKNOWN_ID = '10000000-0000-4000-8000-000000000f4f'
const EVERY_KIND = ['booking', 'addon', 'product', 'session_pass', 'membership', 'event']

let database: TestDatabase
let db: Db
let jo = ''
let sam = ''
let mo = ''
let allTen = ''
let fiver = ''

beforeAll(async () => {
  process.env.STAFF_API_KEY = ADMIN_TEST_KEY
  database = await startTestDatabase({ schema: 'live' })
  db = database.db
  holder.db = db
})
afterAll(() => database.stop())

/** Jo with Manage pricing and Tia without; Sam and Mo; ALLTEN (10% off everything) and FIVER (£5 off, for Mo only). */
beforeEach(async () => {
  await database.pg.exec('RESET ROLE; TRUNCATE audit_log, api_idempotency, promo_code_redemptions, promo_codes, orders, customers, staff CASCADE; SET ROLE paddock_worker;')
  jo = await insert(db, 'staff', { role: 'admin', first_name: 'Jo', last_name: 'Staff', email: JO, can_issue_refunds: true, can_manage_pricing: true })
  await insert(db, 'staff', { role: 'staff', first_name: 'Tia', last_name: 'Team', email: TIA })
  sam = await fixtures.customer(db, { first_name: 'Sam', last_name: 'Test', email: 'sam@example.com' })
  mo = await fixtures.customer(db, { first_name: 'Mo', last_name: 'Member', email: 'mo@example.com' })
  allTen = await insert(db, 'promo_codes', { code: 'ALLTEN', discount_type: 'percentage', discount_value: '10', applies_to: EVERY_KIND, created_at: '2026-10-01 09:00:00+00' })
  fiver = await insert(db, 'promo_codes', { code: 'FIVER', description: 'For Mo only', discount_type: 'fixed', discount_value: '5', applies_to: EVERY_KIND, restricted_customer_id: mo, created_by: JO, created_at: '2026-10-02 09:00:00+00' })
})

/** Sam's order used ALLTEN: one redemption of £2. */
async function samUsesAllTen(): Promise<string> {
  const order = await insert(db, 'orders', { customer_id: sam, order_total: '18.00', payment_status: 'paid', payment_method: 'cash', order_source: 'staff_created' })
  return insert(db, 'promo_code_redemptions', { promo_code_id: allTen, order_id: order, customer_id: sam, discount_amount: '2' })
}

type PromoRow = Record<string, unknown>
const promoRow = async (id: string) => (await db.query<PromoRow>('SELECT code, description, discount_type, discount_value::text AS discount_value, applies_to, active, restricted_customer_id, created_by FROM promo_codes WHERE id = $1', [id]))[0]
const codes = async () => (await db.query<{ code: string }>('SELECT code FROM promo_codes ORDER BY code')).map((row) => row.code)
const refusedWith = (answer: AdminAnswer) => ({ status: answer.status, reason: answer.reason, words: answer.error?.message })

const newCode = { code: ' winter25 ', description: '  Winter offer  ', discountType: 'percentage', discountValue: 25, appliesTo: ['booking', 'addon'], appliesOnMemberPrices: false, expiresOn: null, maxTotalUses: null, oneUsePerCustomer: false, minSpend: null, restrictedCustomerId: null }
const asItIs = { code: 'ALLTEN', discountType: 'percentage', discountValue: 10, appliesTo: EVERY_KIND, appliesOnMemberPrices: false, expiresOn: null, maxTotalUses: null, oneUsePerCustomer: false, minSpend: null, restrictedCustomerId: null, active: true }

const by = () => ({ actor: { type: 'staff' as const, id: jo, role: 'admin' as const, canManagePricing: true, canIssueRefunds: true }, requestId: crypto.randomUUID(), pressKey: crypto.randomUUID() })
/** The statements one call of a rule sends, in order. */
async function statementsOf(work: (watched: Db) => Promise<unknown>): Promise<string[]> {
  const seen: string[] = []
  const watching = <T extends { query: Db['query'] }>(target: T): T =>
    new Proxy(target, {
      get(inner, property, receiver) {
        if (property === 'query') {
          return (sql: string, params?: readonly SqlParam[]) => {
            seen.push(sql.trim().replace(/\s+/g, ' '))
            return inner.query(sql, params)
          }
        }
        if (property === 'transaction') return <R>(fn: (tx: Tx) => Promise<R>) => (inner as unknown as Db).transaction((tx) => fn(watching(tx)))
        return Reflect.get(inner, property, receiver) as unknown
      },
    })
  await work(watching(db))
  return seen
}

const list = (email = JO) => pressRoute<PromoRow[]>(listRoute, 'GET', { email })
const uses = (promoCodeId: string, email = JO) => pressRoute<PromoRow[]>(redemptionsRoute, 'GET', { email, params: { promoCodeId } })
const create = (body: unknown, email = JO, key?: string) => pressRoute<PromoRow>(createRoute, 'POST', { email, body, ...(key !== undefined ? { key } : {}) })
/** W54a: a code's stamp as the page gets it: from the list, read by Jo. Undefined for a code that isn't there. */
const stampOf = async (promoCodeId: string): Promise<string | undefined> => (await list()).data?.find((row) => row['id'] === promoCodeId)?.['stamp'] as string | undefined
type Updated = { updated: true; promo: PromoRow; stamp: string }
/** The edit exactly as sent: no stamp unless the body has one. */
const updateAsSent = (promoCodeId: string, body: unknown, email = JO, key?: string) => pressRoute<Updated>(updateRoute, 'POST', { email, params: { promoCodeId }, body, ...(key !== undefined ? { key } : {}) })
/** The edit as the page presses it (W54a): with the code's stamp from a list read just before, unless the body brings its own. */
const update = async (promoCodeId: string, body: object, email = JO, key?: string) => updateAsSent(promoCodeId, 'stamp' in body ? body : { ...body, stamp: await stampOf(promoCodeId) }, email, key)

describe('GET promo-codes and GET promo-codes/:promoCodeId/redemptions (the reads; GB14)', () => {
  it('lists every code, newest first, with how often it was used and who a restricted one is for, by named fields', async () => {
    await samUsesAllTen()
    const answer = await list(TIA)
    expect(answer.status).toBe(200)
    expect(answer.data?.map((row) => [row['code'], row['used_count'], row['restricted_customer_name']])).toEqual([['FIVER', '0', 'Mo Member'], ['ALLTEN', '1', null]])
    expect(Object.keys(answer.data?.[0] ?? {}).sort()).toEqual([
      'active', 'applies_on_member_prices', 'applies_to', 'code', 'created_at', 'created_by', 'description', 'discount_type', 'discount_value', 'expires_on', 'id',
      'max_total_uses', 'min_spend', 'one_use_per_customer', 'restricted_customer_id', 'restricted_customer_name', 'stamp', 'updated_at', 'used_count',
    ])
    expect(answer.data?.[0]).toMatchObject({ discount_type: 'fixed', discount_value: '5', description: 'For Mo only', created_by: JO, applies_to: EVERY_KIND })
    expect(String(answer.data?.[0]?.['created_at'])).toBe('2026-10-02T09:00:00.000Z')
  })

  it("lists one code's uses: the order, when, the customer and the discount; none for a code that is not there", async () => {
    const redemption = await samUsesAllTen()
    const answer = await uses(allTen, TIA)
    expect(answer.data).toHaveLength(1)
    // W53 (migration 033, carried by the saved schema): discount_amount is numeric(10,2), so its text is to the penny.
    expect(answer.data?.[0]).toMatchObject({ id: redemption, customer_id: sam, customer_first_name: 'Sam', customer_last_name: 'Test', discount_amount: '2.00' })
    expect(Object.keys(answer.data?.[0] ?? {}).sort()).toEqual(['created_at', 'customer_first_name', 'customer_id', 'customer_last_name', 'discount_amount', 'id', 'order_created_at', 'order_id'])
    expect((await uses(fiver)).data).toEqual([])
    expect((await uses(UNKNOWN_ID)).data).toEqual([])
    expect((await uses('not-an-id')).data).toEqual([])
  })

  it('refuses an inactive account and a sign-in with no staff row, which the old reads answered', async () => {
    await db.query('UPDATE staff SET active = false WHERE id = $1', [jo])
    for (const refused of [await list(), await uses(allTen)]) expect([refused.status, refused.error?.message]).toEqual([403, INACTIVE])
    const words = STAFF_ADMIN_WORDS.staffAccess.noStaffRecordMatchesLoggedIn('nobody@example.com')
    for (const refused of [await list('nobody@example.com'), await uses(allTen, 'nobody@example.com')]) expect([refused.status, refused.error?.message]).toEqual([401, words])
  })
})

describe('POST promo-codes (createPromoCode)', () => {
  it('makes the code: text trimmed and upper-cased, the description trimmed, active, made by the staff member; and a promo.created audit row', async () => {
    const key = crypto.randomUUID()
    const answer = await create(newCode, JO, key)
    expect(answer.status).toBe(200)
    expect(answer.data).toMatchObject({ code: 'WINTER25', description: 'Winter offer', discount_type: 'percentage', discount_value: '25', applies_to: ['booking', 'addon'], applies_on_member_prices: false, expires_on: null, max_total_uses: null, one_use_per_customer: false, min_spend: null, restricted_customer_id: null, active: true, created_by: JO })
    const second = await create({ code: 'MO-FIVER', discountType: 'fixed', discountValue: 5, appliesTo: EVERY_KIND, appliesOnMemberPrices: true, expiresOn: '2026-12-31', maxTotalUses: 3, oneUsePerCustomer: true, minSpend: 20, restrictedCustomerId: mo })
    // W53 (migration 033): min_spend is numeric(10,2) (`20.00`); discount_value is left plain numeric (`5`).
    expect(second.data).toMatchObject({ code: 'MO-FIVER', description: null, discount_value: '5', expires_on: '2026-12-31', max_total_uses: 3, one_use_per_customer: true, min_spend: '20.00', restricted_customer_id: mo })
    const rows = await auditRowsOf(db)
    expect(rows.map((row) => [row.action, row.actor_id, row.entity_type, row.entity_id])).toEqual([['promo.created', jo, 'promo_code', answer.data?.['id']], ['promo.created', jo, 'promo_code', second.data?.['id']]])
    expect(rows[0]?.details.before).toBeNull()
    expect(rows[0]?.details.after).toEqual(answer.data)
    expect(rows[0]?.details.key).toBe(key)
  })

  it('refuses each bad field in the old order and words, and writes nothing', async () => {
    const tries: Array<[unknown, string]> = [
      [{ ...newCode, code: 'ab' }, WORDS.promoCodes.codeMust420CharactersUsing],
      [{ ...newCode, code: 'TEN OFF' }, WORDS.promoCodes.codeMust420CharactersUsing],
      [{ ...newCode, code: 'A-VERY-LONG-PROMO-CODE-INDEED' }, WORDS.promoCodes.codeMust420CharactersUsing],
      [{ ...newCode, code: undefined }, WORDS.promoCodes.codeMust420CharactersUsing],
      [{ ...newCode, discountType: 'bogof' }, WORDS.promoCodes.discountTypeMustPercentageOrFixed],
      [{ ...newCode, discountValue: 0 }, WORDS.promoCodes.discountValueMustGreaterThan0],
      [{ ...newCode, discountValue: null }, WORDS.promoCodes.discountValueMustGreaterThan0],
      [{ ...newCode, discountValue: 101 }, WORDS.promoCodes.percentageDiscountCannotExceed100],
      [{ ...newCode, appliesTo: [] }, WORDS.promoCodes.chooseAtLeastOneValidBasket],
      [{ ...newCode, appliesTo: ['booking', 'gift_card'] }, WORDS.promoCodes.chooseAtLeastOneValidBasket],
      [{ ...newCode, appliesTo: 'booking' }, WORDS.promoCodes.chooseAtLeastOneValidBasket],
      [{ ...newCode, expiresOn: '01/12/2026' }, WORDS.promoCodes.expiryMustDateYyyyMmDd],
      // A date the calendar doesn't have: the old check asked only for the shape, and the database refused it in its own words.
      [{ ...newCode, expiresOn: '2026-02-30' }, WORDS.promoCodes.expiryMustDateYyyyMmDd],
      [{ ...newCode, maxTotalUses: 0 }, WORDS.promoCodes.maximumTotalUsesMustWholeNumber],
      [{ ...newCode, maxTotalUses: 2.5 }, WORDS.promoCodes.maximumTotalUsesMustWholeNumber],
      [{ ...newCode, minSpend: -1 }, WORDS.promoCodes.minimumSpendMustNonNegativeAmount],
      [{ ...newCode, restrictedCustomerId: UNKNOWN_ID }, WORDS.createPromoCode.restrictedCustomerDoesNotExist],
      [{ ...newCode, restrictedCustomerId: 'not-an-id' }, WORDS.createPromoCode.restrictedCustomerDoesNotExist],
      // The code's text is checked before the fields, and the fields before the customer.
      [{ ...newCode, code: 'ab', discountValue: 0, restrictedCustomerId: UNKNOWN_ID }, WORDS.promoCodes.codeMust420CharactersUsing],
      [{ ...newCode, discountValue: 0, restrictedCustomerId: UNKNOWN_ID }, WORDS.promoCodes.discountValueMustGreaterThan0],
    ]
    for (const [body, sentence] of tries) expect((await create(body)).error?.message, JSON.stringify(body)).toBe(sentence)
    expect(await codes()).toEqual(['ALLTEN', 'FIVER'])
    expect(await auditRowsOf(db)).toEqual([])
  })

  it('refuses a code already there in another letter case, in the old words (GB18)', async () => {
    const words = WORDS.createPromoCode.promoCodeAlreadyExistsCodesAre('ALLTEN')
    expect(refusedWith(await create({ ...newCode, code: 'allten' }))).toEqual({ status: 409, reason: 'duplicate_code', words })
    expect(refusedWith(await create({ ...newCode, code: ' AllTen ' }))).toEqual({ status: 409, reason: 'duplicate_code', words })
    // A code stored in lower case by another writer is the same code too.
    await insert(db, 'promo_codes', { code: 'spring', discount_type: 'fixed', discount_value: '3', applies_to: EVERY_KIND })
    expect((await create({ ...newCode, code: 'SPRING' })).reason).toBe('duplicate_code')
    expect(await codes()).toEqual(['ALLTEN', 'FIVER', 'spring'])
    expect(await auditRowsOf(db)).toEqual([])
  })

  it('needs Manage pricing, refused before any field is looked at; the same press again is answered from the first', async () => {
    expect(refusedWith(await create({ ...newCode, code: 'ab' }, TIA))).toEqual({ status: 403, reason: 'no_pricing_permission', words: NO_PRICING })
    const key = crypto.randomUUID()
    const first = await create(newCode, JO, key)
    const again = await create(newCode, JO, key)
    expect(again.replayed).toBe(true)
    expect(again.data).toEqual(first.data)
    expect(await codes()).toEqual(['ALLTEN', 'FIVER', 'WINTER25'])
    expect(await auditRowsOf(db)).toHaveLength(1)
    expect((await create({ ...newCode, discountValue: 30 }, JO, key)).error?.code).toBe('IDEMPOTENCY_MISMATCH')
  })
})

describe('POST promo-codes/:promoCodeId (updatePromoCode)', () => {
  it('changes every field in one press, then is switched off by the page\'s switch; each edit is recorded with the code before and after', async () => {
    const edited = await update(allTen, { ...asItIs, code: 'all-fifteen', description: ' Now 15% ', discountValue: 15, appliesTo: ['booking'], appliesOnMemberPrices: true, expiresOn: '2027-01-31', maxTotalUses: 100, oneUsePerCustomer: true, minSpend: 10, restrictedCustomerId: sam })
    expect(edited.data?.updated).toBe(true)
    expect(edited.data?.promo).toMatchObject({ id: allTen, code: 'ALL-FIFTEEN', description: 'Now 15%', discount_value: '15', applies_to: ['booking'], applies_on_member_prices: true, expires_on: '2027-01-31', max_total_uses: 100, one_use_per_customer: true, min_spend: '10.00', restricted_customer_id: sam, active: true })
    expect(Object.keys(edited.data?.promo ?? {}).sort()).toEqual([
      'active', 'applies_on_member_prices', 'applies_to', 'code', 'created_at', 'created_by', 'description', 'discount_type', 'discount_value', 'expires_on', 'id',
      'max_total_uses', 'min_spend', 'one_use_per_customer', 'restricted_customer_id', 'updated_at',
    ])
    const off = await update(allTen, { ...asItIs, code: 'ALL-FIFTEEN', discountValue: 15, active: false })
    expect(off.data?.promo).toMatchObject({ code: 'ALL-FIFTEEN', active: false, description: null, applies_to: EVERY_KIND })

    const rows = await auditRowsOf(db)
    expect(rows.map((row) => [row.action, row.actor_id, row.entity_type, row.entity_id])).toEqual([['promo.updated', jo, 'promo_code', allTen], ['promo.updated', jo, 'promo_code', allTen]])
    expect(rows[0]?.details.before).toMatchObject({ code: 'ALLTEN', discount_value: '10', active: true })
    expect(rows[0]?.details.after).toMatchObject({ code: 'ALL-FIFTEEN', discount_value: '15', active: true })
    expect(rows[1]?.details.before).toEqual(rows[0]?.details.after)
    expect(rows[1]?.details.after).toMatchObject({ code: 'ALL-FIFTEEN', active: false })
  })

  it('once used, the code\'s text is locked; everything else can still change', async () => {
    await samUsesAllTen()
    expect(refusedWith(await update(allTen, { ...asItIs, code: 'ALLTWENTY', discountValue: 20 }))).toEqual({ status: 409, reason: 'code_locked', words: WORDS.updatePromoCode.codeHasBeenRedeemedAtLeast })
    expect(await promoRow(allTen)).toMatchObject({ code: 'ALLTEN', discount_value: '10' })
    // The same text typed in another case is the same text.
    const kept = await update(allTen, { ...asItIs, code: ' allten ', discountValue: 20, description: 'Was 10%' })
    expect(kept.data?.promo).toMatchObject({ code: 'ALLTEN', discount_value: '20', description: 'Was 10%' })
    // An unused code's text can change.
    expect((await update(fiver, { ...asItIs, code: 'SIXER', discountType: 'fixed', discountValue: 6 })).data?.promo).toMatchObject({ code: 'SIXER', discount_value: '6' })
    expect((await auditRowsOf(db)).map((row) => row.entity_id)).toEqual([allTen, fiver])
  })

  it('refuses in the old order and words: not there, the text, the lock, the fields, the customer, a duplicate', async () => {
    expect(refusedWith(await update(UNKNOWN_ID, asItIs))).toEqual({ status: 404, reason: 'not_found', words: WORDS.updatePromoCode.thatPromoCodeNoLongerExists })
    expect(refusedWith(await update('not-an-id', asItIs))).toEqual({ status: 404, reason: 'not_found', words: WORDS.updatePromoCode.thatPromoCodeNoLongerExists })
    // A code that is not there comes before a bad text.
    expect((await update(UNKNOWN_ID, { ...asItIs, code: 'no' })).reason).toBe('not_found')
    expect((await update(allTen, { ...asItIs, code: 'no' })).error?.message).toBe(WORDS.promoCodes.codeMust420CharactersUsing)
    expect((await update(allTen, { ...asItIs, discountValue: 150 })).error?.message).toBe(WORDS.promoCodes.percentageDiscountCannotExceed100)
    expect((await update(allTen, { ...asItIs, appliesTo: ['seat'] })).error?.message).toBe(WORDS.promoCodes.chooseAtLeastOneValidBasket)
    expect((await update(allTen, { ...asItIs, restrictedCustomerId: UNKNOWN_ID })).error?.message).toBe(WORDS.updatePromoCode.restrictedCustomerDoesNotExist)
    expect(refusedWith(await update(allTen, { ...asItIs, code: 'fiver' }))).toEqual({ status: 409, reason: 'duplicate_code', words: WORDS.updatePromoCode.promoCodeAlreadyExistsCodesAre('FIVER') })
    // The lock comes before the fields: a used code with a changed text and a bad discount is told about the lock.
    await samUsesAllTen()
    expect((await update(allTen, { ...asItIs, code: 'ALLTWENTY', discountValue: 150 })).reason).toBe('code_locked')
    expect(await promoRow(allTen)).toMatchObject({ code: 'ALLTEN', discount_value: '10' })
    expect(await auditRowsOf(db)).toEqual([])
  })

  it('needs Manage pricing; an edit made twice under one key is answered from the first', async () => {
    expect(refusedWith(await update(allTen, { ...asItIs, discountValue: 15 }, TIA))).toEqual({ status: 403, reason: 'no_pricing_permission', words: NO_PRICING })
    const key = crypto.randomUUID()
    // The same press again is the same body: the stamp the page held when it pressed, not a new one.
    const stamp = await stampOf(allTen)
    await update(allTen, { ...asItIs, discountValue: 15, stamp }, JO, key)
    await update(allTen, { ...asItIs, discountValue: 30 })
    expect((await update(allTen, { ...asItIs, discountValue: 15, stamp }, JO, key)).replayed).toBe(true)
    expect(await promoRow(allTen)).toMatchObject({ discount_value: '30' })
    expect(await auditRowsOf(db)).toHaveLength(2)
  })

  it("takes the code's own row lock before it reads the code or counts its uses (GB18)", async () => {
    const stamp = await stampOf(allTen)
    const seen = await statementsOf((watched) => updatePromoCode(watched, { promoCodeId: allTen, ...asItIs, code: 'ALLTWENTY', stamp }, by()))
    expect(seen[0]).toBe('SELECT id FROM promo_codes WHERE id = ANY($1::uuid[]) ORDER BY id FOR NO KEY UPDATE')
    const counted = seen.findIndex((sql) => sql.includes('FROM promo_code_redemptions WHERE promo_code_id'))
    const written = seen.findIndex((sql) => sql.startsWith('UPDATE promo_codes'))
    expect(counted).toBeGreaterThan(0)
    expect(written).toBeGreaterThan(counted)
    // W54a: the code's stamp is read under that lock, before the uses are counted and before the write.
    const stamped = seen.findIndex((sql) => sql.includes('AS stamp FROM promo_codes pc WHERE pc.id = $1::uuid'))
    expect(stamped).toBeGreaterThan(0)
    expect(stamped).toBeLessThan(counted)
  })
})

// W54a (W49 + W54 review S1; the lead's call: one step G rule). The switch and the dialog both send every field as
// the page loaded it, so a page loaded before someone else's change would put the old values back. The press sends
// the row's stamp as the list read it, and a code that has changed since is refused under the code's lock.
describe('POST promo-codes/:promoCodeId: an edit from a page loaded before someone else\'s change is refused (W54a)', () => {
  const CHANGED_SINCE = { status: 409, reason: 'changed_since', words: 'This was changed by someone else since the page loaded. The page has been reloaded: check it and save again.' }
  type ListRow = PromoRow & { id: string; code: string; description: string | null; discount_type: string; discount_value: string; applies_to: string[]; applies_on_member_prices: boolean; expires_on: string | null; max_total_uses: number | null; one_use_per_customer: boolean; min_spend: string | null; restricted_customer_id: string | null; active: boolean; stamp: string }
  /** The page's list as one manager loaded it. */
  const pageOf = async () => ((await list()).data ?? []) as ListRow[]
  /** The page's switch (PromoCodesPage, handleToggleActive): every field of the row as the page holds it, `active` changed, and the row's stamp. */
  const switched = (row: ListRow, active: boolean) => ({
    code: row.code,
    description: row.description ?? undefined,
    discountType: row.discount_type,
    discountValue: Number.parseFloat(row.discount_value),
    appliesTo: row.applies_to,
    appliesOnMemberPrices: row.applies_on_member_prices,
    expiresOn: row.expires_on,
    maxTotalUses: row.max_total_uses,
    oneUsePerCustomer: row.one_use_per_customer,
    minSpend: row.min_spend != null ? Number.parseFloat(row.min_spend) : null,
    restrictedCustomerId: row.restricted_customer_id,
    active,
    stamp: row.stamp,
  })
  const pressSwitch = (row: ListRow, active: boolean) => updateAsSent(row.id, switched(row, active))
  let welcome = ''
  /** WELCOME, set to 100% by mistake, last changed a month ago (so no press in a test can land on the same moment). */
  beforeEach(async () => {
    welcome = await insert(db, 'promo_codes', { code: 'WELCOME', discount_type: 'percentage', discount_value: '100', applies_to: EVERY_KIND, expires_on: '2027-06-30', max_total_uses: 50, restricted_customer_id: mo, created_at: '2026-10-03 09:00:00+00', updated_at: '2026-10-03 09:00:00+00' })
  })
  const rowOn = (page: ListRow[], id = welcome) => page.find((row) => row.id === id) as ListRow

  it("the reviewer's example: WELCOME at 100%, corrected to 10% by B; A's switch from the older page is refused, and WELCOME stays 10%", async () => {
    const pageA = await pageOf()
    const pageB = await pageOf()
    expect(rowOn(pageA)).toMatchObject({ code: 'WELCOME', discount_value: '100', active: true })
    // B corrects the discount in the dialog.
    const corrected = await updateAsSent(welcome, { ...switched(rowOn(pageB), true), discountValue: 10 })
    expect(corrected.data?.promo).toMatchObject({ discount_value: '10' })
    const afterB = await promoRow(welcome)
    const auditAfterB = await auditRowsOf(db)
    expect(auditAfterB).toHaveLength(1)

    // A, whose page still shows 100%, switches WELCOME off, then on again.
    expect(refusedWith(await pressSwitch(rowOn(pageA), false))).toEqual(CHANGED_SINCE)
    expect(refusedWith(await pressSwitch(rowOn(pageA), true))).toEqual(CHANGED_SINCE)
    // Nothing written: the code is as B left it, still on, and neither refused press left an audit row.
    expect(await promoRow(welcome)).toEqual(afterB)
    expect(await promoRow(welcome)).toMatchObject({ discount_value: '10', active: true })
    expect(await auditRowsOf(db)).toEqual(auditAfterB)

    // A's page reloads (the screen does, on the refusal): it shows 10%, and the switch now goes through at 10%.
    const reloaded = await pageOf()
    expect(rowOn(reloaded)).toMatchObject({ discount_value: '10' })
    const off = await pressSwitch(rowOn(reloaded), false)
    expect(off.data?.promo).toMatchObject({ discount_value: '10', active: false })
    expect((await auditRowsOf(db)).map((row) => row.details.after)).toMatchObject([{ discount_value: '10', active: true }, { discount_value: '10', active: false }])
  })

  it("the dialog's save from an older page is refused too, whichever field the other change was to", async () => {
    const changes: Array<[string, Record<string, unknown>]> = [
      ['the expiry', { expiresOn: '2026-12-31' }],
      ['the limit', { maxTotalUses: 5 }],
      ['who it is for', { restrictedCustomerId: sam }],
      ['the switch', { active: false }],
      ['the description', { description: 'Corrected' }],
    ]
    for (const [what, change] of changes) {
      const pageA = await pageOf()
      const pageB = await pageOf()
      expect((await updateAsSent(welcome, { ...switched(rowOn(pageB), true), ...change })).status, what).toBe(200)
      const afterB = await promoRow(welcome)
      const audit = (await auditRowsOf(db)).length
      // A's dialog, opened from the older page, changes only the minimum spend.
      expect(refusedWith(await updateAsSent(welcome, { ...switched(rowOn(pageA), true), minSpend: 30 })), what).toEqual(CHANGED_SINCE)
      expect(await promoRow(welcome), what).toEqual(afterB)
      expect((await auditRowsOf(db)).length, what).toBe(audit)
    }
  })

  it('a press from a page that is up to date is saved, and its answer carries the new stamp: the next press with it is saved without another read, and the stamp before it is refused', async () => {
    const page = await pageOf()
    const first = await pressSwitch(rowOn(page), false)
    expect(first.status).toBe(200)
    expect(typeof first.data?.stamp).toBe('string')
    expect(first.data?.stamp).not.toBe(rowOn(page).stamp)
    // The answer's stamp is the list's stamp for the row as it now is.
    expect(first.data?.stamp).toBe(await stampOf(welcome))
    const second = await updateAsSent(welcome, { ...switched(rowOn(page), true), stamp: first.data?.stamp })
    expect(second.data?.promo).toMatchObject({ active: true })
    // The page's first stamp, and the first answer's, are both out of date now.
    expect(refusedWith(await pressSwitch(rowOn(page), false))).toEqual(CHANGED_SINCE)
    expect(refusedWith(await updateAsSent(welcome, { ...switched(rowOn(page), false), stamp: first.data?.stamp }))).toEqual(CHANGED_SINCE)
    expect(await promoRow(welcome)).toMatchObject({ active: true })
    expect(await auditRowsOf(db)).toHaveLength(2)
  })

  it('a press with no stamp (an older staff app), or one that is not the text the list gave, is refused the same way, and nothing is written', async () => {
    const page = await pageOf()
    const { stamp, ...withoutStamp } = switched(rowOn(page), false)
    const before = await promoRow(welcome)
    for (const sent of [withoutStamp, { ...withoutStamp, stamp: null }, { ...withoutStamp, stamp: '' }, { ...withoutStamp, stamp: 0 }, { ...withoutStamp, stamp: [stamp] }, { ...withoutStamp, stamp: `${stamp} ` }, { ...withoutStamp, stamp: 'none' }]) {
      expect(refusedWith(await updateAsSent(welcome, sent)), JSON.stringify(sent)).toEqual(CHANGED_SINCE)
    }
    expect(await promoRow(welcome)).toEqual(before)
    expect(await auditRowsOf(db)).toEqual([])
  })

  it('a change that leaves updated_at alone (a correction made by hand in SQL), and one made in the same instant, still change the stamp', async () => {
    const page = await pageOf()
    await database.pg.exec(`RESET ROLE; UPDATE promo_codes SET discount_value = 10 WHERE code = 'WELCOME'; SET ROLE paddock_worker;`)
    expect(await stampOf(welcome)).not.toBe(rowOn(page).stamp)
    expect(refusedWith(await pressSwitch(rowOn(page), false))).toEqual(CHANGED_SINCE)
    // The same moment on the row as the page read, another discount: still another stamp.
    const again = await pageOf()
    await database.pg.exec(`RESET ROLE; UPDATE promo_codes SET discount_value = 15 WHERE code = 'WELCOME'; SET ROLE paddock_worker;`)
    expect(refusedWith(await pressSwitch(rowOn(again), false))).toEqual(CHANGED_SINCE)
    expect(await promoRow(welcome)).toMatchObject({ discount_value: '15', active: true })
    // Put back to exactly what the page read, the row is what the page shows, and the page's press is saved.
    await database.pg.exec(`RESET ROLE; UPDATE promo_codes SET discount_value = 10 WHERE code = 'WELCOME'; SET ROLE paddock_worker;`)
    expect(await stampOf(welcome)).toBe(rowOn(again).stamp)
    expect((await pressSwitch(rowOn(again), false)).status).toBe(200)
  })

  it("the order of the refusals: a code that is not there first, then a code changed since, then the old checks; and only the pressed code's stamp counts", async () => {
    const page = await pageOf()
    expect((await updateAsSent(UNKNOWN_ID, switched(rowOn(page), false))).reason).toBe('not_found')
    // Another code's change doesn't make this one's page stale.
    expect((await update(allTen, { ...asItIs, discountValue: 12 })).status).toBe(200)
    expect((await pressSwitch(rowOn(page), false)).status).toBe(200)
    // Stale and wrong at once (a text too short, a discount over 100%): told it has changed, not what is wrong with it.
    expect(refusedWith(await updateAsSent(welcome, { ...switched(rowOn(page), true), code: 'no', discountValue: 150 }))).toEqual(CHANGED_SINCE)
    // Without Manage pricing the refusal is the permission's, before any stamp is read.
    expect(refusedWith(await updateAsSent(welcome, switched(rowOn(page), true), TIA))).toEqual({ status: 403, reason: 'no_pricing_permission', words: NO_PRICING })
  })

  it('a refused press is stored against its key like any other answer: the same press again gets the same refusal and writes nothing', async () => {
    const pageA = await pageOf()
    expect((await update(welcome, { ...switched(rowOn(pageA), true), discountValue: 10 })).status).toBe(200)
    const key = crypto.randomUUID()
    const first = await updateAsSent(welcome, switched(rowOn(pageA), false), JO, key)
    const again = await updateAsSent(welcome, switched(rowOn(pageA), false), JO, key)
    expect(refusedWith(first)).toEqual(CHANGED_SINCE)
    expect(again.replayed).toBe(true)
    expect(refusedWith(again)).toEqual(CHANGED_SINCE)
    expect(await promoRow(welcome)).toMatchObject({ discount_value: '10', active: true })
    expect(await auditRowsOf(db)).toHaveLength(1)
  })
})

// The planted bugs showed these two were not held: with the rule's own check taken out, the table's index refused
// the write and the same words came back, so every other test still passed. The rule's check is the first guard and
// the index the second (promo/admin-postgres.test.ts holds the index's answer, for two creates at once).
describe('a duplicate code in another letter case is refused before anything is written', () => {
  it('create: the refusal comes from the rule, and no insert is sent', async () => {
    const seen = await statementsOf((watched) => createPromoCode(watched, { ...newCode, code: 'allten' }, { ...by(), createdBy: JO }).catch((err: unknown) => err))
    expect(seen.some((sql) => sql.includes('FROM promo_codes WHERE upper(code) = $1'))).toBe(true)
    expect(seen.filter((sql) => sql.startsWith('INSERT INTO'))).toEqual([])
    // A code another writer stored in lower case is found the same way.
    await insert(db, 'promo_codes', { code: 'spring', discount_type: 'fixed', discount_value: '3', applies_to: EVERY_KIND })
    const second = await statementsOf((watched) => createPromoCode(watched, { ...newCode, code: 'SPRING' }, { ...by(), createdBy: JO }).catch((err: unknown) => err))
    expect(second.filter((sql) => sql.startsWith('INSERT INTO'))).toEqual([])
  })

  it('edit: the refusal comes from the rule, and no update is sent', async () => {
    let refused: unknown
    const stamp = await stampOf(allTen)
    const seen = await statementsOf((watched) =>
      updatePromoCode(watched, { promoCodeId: allTen, ...asItIs, code: 'fiver', stamp }, by()).catch((err: unknown) => {
        refused = err
      })
    )
    expect((refused as { details?: { reason?: string } }).details?.reason).toBe('duplicate_code')
    expect(seen.filter((sql) => sql.startsWith('UPDATE promo_codes'))).toEqual([])
    expect(await codes()).toEqual(['ALLTEN', 'FIVER'])
  })
})
