import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { GET as meRoute } from '@/app/api/v1/staff/staff/me/route'
import { GET as listRoute, POST as createRoute } from '@/app/api/v1/staff/staff/route'
import { POST as permissionsRoute } from '@/app/api/v1/staff/staff/[staffId]/permissions/route'
import { POST as roleRoute } from '@/app/api/v1/staff/staff/[staffId]/role/route'
import { GET as whoamiRoute } from '@/app/api/v1/staff/whoami/route'
import type { Db, SqlParam, Tx } from '@/server/db'
import { auditRowsOf, pressRoute, type AdminAnswer, ADMIN_TEST_KEY } from '@/server/rules/testing/admin-routes'
import { insert, startTestDatabase, type TestDatabase } from '@/server/rules/testing/database'
import { setStaffPermission, setStaffRole } from './admin'
import { STAFF_ADMIN_WORDS } from './failure-messages'

vi.setConfig({ testTimeout: 60_000 })

// Brief W49 items 1 and 2 (G-plan 5, W49's tests): the five staff routes on the live schema. Every refusal in the
// old words; the last active admin and the last active Manage pricing holder; a sign-in with capitals; an inactive
// member's own row and nothing else; the audit rows; a press made twice. The two "last one" rules as races, with two
// connections, are in admin-postgres.test.ts.

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))

const JO = 'jo@example.com'
const MAX = 'max@example.com'
const TIA = 'tia@example.com'
const NOBODY = 'nobody@example.com'
const WORDS = STAFF_ADMIN_WORDS
const ADMINS_ONLY = WORDS.staffAccess.adminsOnlyActionRequiresAdminRole
const INACTIVE = WORDS.staffAccess.staffAccountInactiveAskAdminReactivate
const LAST_ADMIN = WORDS.staffAccess.thereMustAlwaysAtLeastOne
const LAST_PRICING = WORDS.setStaffCanManagePricing.cannotRemovePricingPermissionLastStaff
const NOT_FOUND = WORDS.setStaffCanManagePricing.staffMemberNotFound
const UNKNOWN_ID = '10000000-0000-4000-8000-000000000f4f'

let database: TestDatabase
let db: Db
let jo = ''
let max = ''
let tia = ''

beforeAll(async () => {
  process.env.STAFF_API_KEY = ADMIN_TEST_KEY
  database = await startTestDatabase({ schema: 'live' })
  db = database.db
  holder.db = db
})
afterAll(() => database.stop())

/** Jo, an admin with both switches; Max, a manager with Manage pricing; Tia, a team member with nothing. */
beforeEach(async () => {
  await database.pg.exec('RESET ROLE; TRUNCATE audit_log, api_idempotency, staff CASCADE; SET ROLE paddock_worker;')
  jo = await insert(db, 'staff', { role: 'admin', first_name: 'Jo', last_name: 'Staff', email: JO, can_issue_refunds: true, can_manage_pricing: true })
  max = await insert(db, 'staff', { role: 'manager', first_name: 'Max', last_name: 'Manager', email: MAX, can_issue_refunds: true, can_manage_pricing: true })
  tia = await insert(db, 'staff', { role: 'staff', first_name: 'Tia', last_name: 'Team', email: TIA })
})

interface StaffRow {
  id: string
  email: string
  role: string
  can_issue_refunds: boolean | null
  can_manage_pricing: boolean | null
  active: boolean | null
}
const staffRow = async (id: string) => (await db.query<StaffRow>('SELECT id, email, role, can_issue_refunds, can_manage_pricing, active FROM staff WHERE id = $1', [id]))[0]
/** One change to a staff row, as another writer makes it. Test data only: each `set` is a literal in this file. */
// eslint-disable-next-line no-restricted-syntax -- test data only: every `set` is a literal written in this file; the id goes in as a parameter
const staffIs = (id: string, set: string) => db.query(`UPDATE staff SET ${set} WHERE id = $1`, [id])
const newPerson = { firstName: ' Nia ', lastName: ' New ', email: ' Nia.New@Example.COM ', role: 'staff' }

const me = (email: string | null, bearer?: string) => pressRoute<StaffRow | null>(meRoute, 'GET', { email, ...(bearer !== undefined ? { bearer } : {}) })
const list = (email = JO) => pressRoute<Array<StaffRow & { first_name: string }>>(listRoute, 'GET', { email })
const create = (body: unknown, email = JO, key?: string) => pressRoute<StaffRow & { first_name: string; last_name: string; created_at: string }>(createRoute, 'POST', { email, body, ...(key !== undefined ? { key } : {}) })
const role = (staffId: string, to: unknown, email = JO, key?: string) => pressRoute<{ id: string; role: string }>(roleRoute, 'POST', { email, params: { staffId }, body: { role: to }, ...(key !== undefined ? { key } : {}) })
const permission = (staffId: string, field: unknown, value: unknown, email = JO) => pressRoute<Record<string, unknown>>(permissionsRoute, 'POST', { email, params: { staffId }, body: { field, value } })
const refusedWith = (answer: AdminAnswer) => ({ status: answer.status, reason: answer.reason, words: answer.error?.message })

describe('GET staff/me (lead call L10)', () => {
  it("answers the signed-in staff member's own row, and null for a sign-in with no staff row", async () => {
    expect((await me(JO)).data).toEqual({ id: jo, email: JO, role: 'admin', can_issue_refunds: true, can_manage_pricing: true, active: true })
    expect((await me(TIA)).data).toEqual({ id: tia, email: TIA, role: 'staff', can_issue_refunds: false, can_manage_pricing: false, active: true })
    const nobody = await me(NOBODY)
    expect(nobody.status).toBe(200)
    expect(nobody.data).toBeNull()
  })

  it("answers an inactive member's own row, so the screen can say so; every other staff route refuses them", async () => {
    await staffIs(jo, 'active = false')
    expect((await me(JO)).data).toEqual({ id: jo, email: JO, role: 'admin', can_issue_refunds: true, can_manage_pricing: true, active: false })

    const refusals = [await list(), await create(newPerson), await role(tia, 'manager'), await permission(tia, 'can_issue_refunds', true), await pressRoute(whoamiRoute, 'GET', { email: JO })]
    for (const refused of refusals) expect({ status: refused.status, code: refused.error?.code, words: refused.error?.message }).toEqual({ status: 403, code: 'FORBIDDEN', words: INACTIVE })
    // Nothing was written by any of them.
    expect(await auditRowsOf(db)).toEqual([])
    expect((await staffRow(tia))?.role).toBe('staff')
    expect((await db.query('SELECT 1 FROM staff')).length).toBe(3)
  })

  it('is still behind the shared key and the signed-in email: neither missing nor wrong gets a row', async () => {
    for (const refused of [await me(JO, 'wrong-key'), await me(null)]) {
      expect(refused.status).toBe(401)
      expect(refused.data).toBeUndefined()
    }
  })

  it('a sign-in with no staff row gets null from it and is refused by every other route, in the staff check\'s words', async () => {
    const words = WORDS.staffAccess.noStaffRecordMatchesLoggedIn(NOBODY)
    for (const refused of [await list(NOBODY), await create(newPerson, NOBODY), await role(tia, 'manager', NOBODY), await permission(tia, 'active', false, NOBODY)]) {
      expect({ status: refused.status, words: refused.error?.message }).toEqual({ status: 401, words })
    }
  })
})

describe('a sign-in finds its staff row in lower case (GB16), in the staff check and in staff/me alike', () => {
  it('a sign-in spelt with capitals is the staff member stored in lower case', async () => {
    const signIn = 'Jo@Example.COM'
    expect((await me(signIn)).data).toMatchObject({ id: jo, email: JO, active: true })
    expect((await list(signIn)).data?.map((row) => row.email)).toEqual([JO, MAX, TIA])
    const who = await pressRoute<{ id: string; email: string }>(whoamiRoute, 'GET', { email: signIn })
    expect(who.data).toMatchObject({ id: jo, email: JO })
    // A write under that sign-in is recorded against the staff member, not the spelling.
    expect((await role(tia, 'manager', signIn)).data).toEqual({ id: tia, role: 'manager' })
    expect((await auditRowsOf(db)).map((row) => row.actor_id)).toEqual([jo])
  })

  it('a staff row stored with capitals is found by a sign-in without them', async () => {
    await staffIs(jo, "email = 'Jo@Example.com'")
    expect((await me(JO)).data).toMatchObject({ id: jo, email: 'Jo@Example.com' })
    expect((await list(JO)).status).toBe(200)
  })

  it('two rows that differ only in case: the one spelt as the sign-in is, every time', async () => {
    const capital = await insert(db, 'staff', { role: 'staff', first_name: 'Other', last_name: 'Jo', email: 'JO@example.com' })
    expect((await me('JO@example.com')).data).toMatchObject({ id: capital })
    expect((await me(JO)).data).toMatchObject({ id: jo })
    expect((await pressRoute<{ id: string }>(whoamiRoute, 'GET', { email: 'JO@example.com' })).data).toMatchObject({ id: capital })
    expect((await pressRoute<{ id: string }>(whoamiRoute, 'GET', { email: JO })).data).toMatchObject({ id: jo })
  })
})

describe('GET staff', () => {
  it('lists every staff member for an admin, by role then name, each moment as ISO text', async () => {
    const answer = await list()
    expect(answer.status).toBe(200)
    expect(answer.data?.map((row) => [row.first_name, row.role, row.email])).toEqual([['Jo', 'admin', JO], ['Max', 'manager', MAX], ['Tia', 'staff', TIA]])
    const first = answer.data?.[0] as unknown as Record<string, unknown>
    expect(Object.keys(first).sort()).toEqual(['active', 'can_issue_refunds', 'can_manage_pricing', 'created_at', 'email', 'first_name', 'id', 'last_name', 'role', 'updated_at'])
    expect(String(first['created_at'])).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it('refuses anyone who is not an admin, in the old words', async () => {
    expect(refusedWith(await list(MAX))).toEqual({ status: 403, reason: 'admins_only', words: ADMINS_ONLY })
    expect(refusedWith(await list(TIA))).toEqual({ status: 403, reason: 'admins_only', words: ADMINS_ONLY })
  })
})

describe('POST staff (createStaff)', () => {
  it('adds the member: names trimmed, the email lower-cased, active, no Manage pricing, and a staff.created audit row', async () => {
    const key = crypto.randomUUID()
    const answer = await create(newPerson, JO, key)
    expect(answer.status).toBe(200)
    expect(answer.data).toMatchObject({ first_name: 'Nia', last_name: 'New', email: 'nia.new@example.com', role: 'staff', can_issue_refunds: false, can_manage_pricing: false, active: true })
    const id = answer.data?.id as string
    expect(await staffRow(id)).toMatchObject({ email: 'nia.new@example.com', role: 'staff', active: true })
    const rows = await auditRowsOf(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ action: 'staff.created', actor_type: 'staff', actor_id: jo, entity_type: 'staff', entity_id: id })
    expect(rows[0]?.details).toEqual({ before: null, after: { role: 'staff', can_issue_refunds: false, can_manage_pricing: false, active: true }, key })

    const refunds = await create({ firstName: 'Rae', lastName: 'Refunds', email: 'rae@example.com', role: 'manager', canIssueRefunds: true })
    expect(refunds.data).toMatchObject({ role: 'manager', can_issue_refunds: true, can_manage_pricing: false })
  })

  it('refuses each bad field in the old order and words, and writes nothing', async () => {
    const tries: Array<[unknown, string, string]> = [
      [{ ...newPerson, firstName: '  ' }, 'first_name_required', WORDS.createStaff.firstNameRequired],
      [{ ...newPerson, firstName: undefined }, 'first_name_required', WORDS.createStaff.firstNameRequired],
      [{ ...newPerson, lastName: '' }, 'last_name_required', WORDS.createStaff.lastNameRequired],
      [{ ...newPerson, email: 'not-an-email' }, 'email_invalid', WORDS.createStaff.validEmailAddressRequired],
      [{ ...newPerson, email: '' }, 'email_invalid', WORDS.createStaff.validEmailAddressRequired],
      [{ ...newPerson, role: 'owner' }, 'invalid_role', 'Invalid role: owner'],
      [{ firstName: 'Nia', lastName: 'New', email: 'nia@example.com' }, 'invalid_role', 'Invalid role: undefined'],
      // Both names missing: the first name's refusal comes first, as before.
      [{ email: 'nia@example.com', role: 'staff' }, 'first_name_required', WORDS.createStaff.firstNameRequired],
    ]
    for (const [body, reason, words] of tries) expect(refusedWith(await create(body)), reason).toEqual({ status: 400, reason, words })
    expect((await db.query('SELECT 1 FROM staff')).length).toBe(3)
    expect(await auditRowsOf(db)).toEqual([])
  })

  it('refuses an email already on file in any case, whichever way round the capitals are (GB16)', async () => {
    const DUPLICATE = WORDS.createStaff.staffMemberWithEmailAddressAlready
    expect(refusedWith(await create({ ...newPerson, email: 'MAX@example.com' }))).toEqual({ status: 409, reason: 'duplicate_email', words: DUPLICATE })
    // A row stored with capitals (written before emails were lower-cased): the old function added it again in lower case.
    await staffIs(tia, "email = 'Tia@Example.com'")
    expect(refusedWith(await create({ ...newPerson, email: 'tia@example.com' }))).toEqual({ status: 409, reason: 'duplicate_email', words: DUPLICATE })
    expect((await db.query('SELECT 1 FROM staff')).length).toBe(3)
    expect(await auditRowsOf(db)).toEqual([])
  })

  it('refuses anyone who is not an admin before any field is looked at', async () => {
    expect(refusedWith(await create({ ...newPerson, firstName: '' }, MAX))).toEqual({ status: 403, reason: 'admins_only', words: ADMINS_ONLY })
  })

  it('the same press again is answered from the first: one member, one audit row; a changed press under that key is refused', async () => {
    const key = crypto.randomUUID()
    const first = await create(newPerson, JO, key)
    const again = await create(newPerson, JO, key)
    expect(again.replayed).toBe(true)
    expect(again.data).toEqual(first.data)
    expect((await db.query('SELECT 1 FROM staff')).length).toBe(4)
    expect(await auditRowsOf(db)).toHaveLength(1)
    const changed = await create({ ...newPerson, lastName: 'Other' }, JO, key)
    expect(changed.status).toBe(422)
    expect(changed.error?.code).toBe('IDEMPOTENCY_MISMATCH')
    // No key at all: an idempotent route refuses before anything is read.
    expect((await pressRoute(createRoute, 'POST', { email: JO, body: newPerson, key: null })).status).toBe(400)
  })
})

describe('POST staff/:staffId/role (setStaffRole)', () => {
  it('sets the role and records who, with the staff member before and after', async () => {
    expect((await role(tia, 'manager')).data).toEqual({ id: tia, role: 'manager' })
    expect((await role(tia, 'admin')).data).toEqual({ id: tia, role: 'admin' })
    // Two active admins now, so either may step down.
    expect((await role(jo, 'staff')).data).toEqual({ id: jo, role: 'staff' })
    const rows = await auditRowsOf(db)
    expect(rows.map((row) => [row.action, row.actor_id, row.entity_id])).toEqual([['staff.role_set', jo, tia], ['staff.role_set', jo, tia], ['staff.role_set', jo, jo]])
    expect(rows.map((row) => [(row.details.before as StaffRow).role, (row.details.after as StaffRow).role])).toEqual([['staff', 'manager'], ['manager', 'admin'], ['admin', 'staff']])
    expect(rows[0]?.details.before).toEqual({ role: 'staff', can_issue_refunds: false, can_manage_pricing: false, active: true })
  })

  it('refuses a role that is not one, a staff member who is not there, and anyone who is not an admin', async () => {
    expect(refusedWith(await role(tia, 'owner'))).toEqual({ status: 400, reason: 'invalid_role', words: 'Invalid role: owner' })
    expect(refusedWith(await role(UNKNOWN_ID, 'manager'))).toEqual({ status: 404, reason: 'staff_not_found', words: NOT_FOUND })
    expect(refusedWith(await role(UNKNOWN_ID, 'admin'))).toEqual({ status: 404, reason: 'staff_not_found', words: NOT_FOUND })
    // An id that is not an id names nobody: the same refusal, never a database error.
    expect(refusedWith(await role('not-an-id', 'manager'))).toEqual({ status: 404, reason: 'staff_not_found', words: NOT_FOUND })
    expect(refusedWith(await role(tia, 'manager', MAX))).toEqual({ status: 403, reason: 'admins_only', words: ADMINS_ONLY })
    expect((await staffRow(tia))?.role).toBe('staff')
    expect(await auditRowsOf(db)).toEqual([])
  })

  it('the last active admin keeps the role: an inactive admin does not count as one', async () => {
    expect(refusedWith(await role(jo, 'manager'))).toEqual({ status: 409, reason: 'last_active_admin', words: LAST_ADMIN })
    const ada = await insert(db, 'staff', { role: 'admin', first_name: 'Ada', last_name: 'Admin', email: 'ada@example.com', active: false })
    expect(refusedWith(await role(jo, 'staff'))).toEqual({ status: 409, reason: 'last_active_admin', words: LAST_ADMIN })
    expect((await staffRow(jo))?.role).toBe('admin')
    // An inactive admin may be demoted whoever else there is: they were not one of the active admins.
    expect((await role(ada, 'staff')).data).toEqual({ id: ada, role: 'staff' })
    await staffIs(ada, "role = 'admin', active = true")
    expect((await role(jo, 'manager')).data).toEqual({ id: jo, role: 'manager' })
  })

  it('making the last active admin an admin again changes nothing and is allowed', async () => {
    expect((await role(jo, 'admin')).data).toEqual({ id: jo, role: 'admin' })
  })
})

describe('POST staff/:staffId/permissions (setStaffPermission, setStaffCanManagePricing)', () => {
  it('sets each switch on and off, answers it under its column, and records which switch', async () => {
    expect((await permission(tia, 'can_issue_refunds', true)).data).toEqual({ id: tia, can_issue_refunds: true })
    expect((await permission(tia, 'can_issue_refunds', false)).data).toEqual({ id: tia, can_issue_refunds: false })
    expect((await permission(tia, 'can_manage_pricing', true)).data).toEqual({ id: tia, can_manage_pricing: true })
    expect((await permission(tia, 'can_manage_pricing', false)).data).toEqual({ id: tia, can_manage_pricing: false })
    // Taking it from someone who never had it is allowed and changes nothing.
    expect((await permission(tia, 'can_manage_pricing', false)).data).toEqual({ id: tia, can_manage_pricing: false })
    expect((await permission(tia, 'active', false)).data).toEqual({ id: tia, active: false })
    expect((await permission(tia, 'active', true)).data).toEqual({ id: tia, active: true })
    const rows = await auditRowsOf(db)
    expect(rows.map((row) => [row.action, row.details['field']])).toEqual([
      ['staff.permission_set', 'can_issue_refunds'],
      ['staff.permission_set', 'can_issue_refunds'],
      ['staff.permission_set', 'can_manage_pricing'],
      ['staff.permission_set', 'can_manage_pricing'],
      ['staff.permission_set', 'can_manage_pricing'],
      ['staff.permission_set', 'active'],
      ['staff.permission_set', 'active'],
    ])
    expect(rows[5]?.details.before).toEqual({ role: 'staff', can_issue_refunds: false, can_manage_pricing: false, active: true })
    expect(rows[5]?.details.after).toEqual({ role: 'staff', can_issue_refunds: false, can_manage_pricing: false, active: false })
  })

  it('refuses a switch that is not one, a value that is not on or off, a staff member who is not there, and anyone who is not an admin', async () => {
    expect(refusedWith(await permission(tia, 'role', true))).toEqual({ status: 400, reason: 'invalid_field', words: 'Invalid field: role' })
    const notASwitch = await permission(tia, 'active', 'yes')
    expect([notASwitch.status, notASwitch.error?.code]).toEqual([400, 'VALIDATION'])
    for (const field of ['can_issue_refunds', 'can_manage_pricing', 'active']) {
      expect(refusedWith(await permission(UNKNOWN_ID, field, true)), field).toEqual({ status: 404, reason: 'staff_not_found', words: NOT_FOUND })
      expect(refusedWith(await permission(UNKNOWN_ID, field, false)), field).toEqual({ status: 404, reason: 'staff_not_found', words: NOT_FOUND })
    }
    expect(refusedWith(await permission(tia, 'can_issue_refunds', true, MAX))).toEqual({ status: 403, reason: 'admins_only', words: ADMINS_ONLY })
    expect(await staffRow(tia)).toMatchObject({ can_issue_refunds: false, active: true })
    expect(await auditRowsOf(db)).toEqual([])
  })

  it('the last active admin stays active', async () => {
    expect(refusedWith(await permission(jo, 'active', false))).toEqual({ status: 409, reason: 'last_active_admin', words: LAST_ADMIN })
    expect((await staffRow(jo))?.active).toBe(true)
    await staffIs(max, "role = 'admin'")
    expect((await permission(jo, 'active', false)).data).toEqual({ id: jo, active: false })
  })

  it('the last active Manage pricing holder keeps it: only active holders count', async () => {
    // Max is inactive, so Jo is the last one.
    await staffIs(max, 'active = false')
    expect(refusedWith(await permission(jo, 'can_manage_pricing', false))).toEqual({ status: 409, reason: 'last_pricing_holder', words: LAST_PRICING })
    expect((await staffRow(jo))?.can_manage_pricing).toBe(true)
    await staffIs(max, 'active = true')
    expect((await permission(jo, 'can_manage_pricing', false)).data).toEqual({ id: jo, can_manage_pricing: false })
    // Max is now the last: taking his is refused too.
    expect(refusedWith(await permission(max, 'can_manage_pricing', false))).toEqual({ status: 409, reason: 'last_pricing_holder', words: LAST_PRICING })
  })

  it('the last active Manage pricing holder stays active, so someone can always change a price', async () => {
    await staffIs(jo, 'can_manage_pricing = false')
    // Max (a manager) is the only one with Manage pricing. Switching him off would leave nobody.
    expect(refusedWith(await permission(max, 'active', false))).toEqual({ status: 409, reason: 'last_pricing_holder', words: LAST_PRICING })
    expect((await staffRow(max))?.active).toBe(true)
    // With another active holder he may be switched off; and someone without it may be switched off whoever holds it.
    await staffIs(jo, 'can_manage_pricing = true')
    expect((await permission(max, 'active', false)).data).toEqual({ id: max, active: false })
    expect((await permission(tia, 'active', false)).data).toEqual({ id: tia, active: false })
  })

  it('switching on, and switching off someone already off, needs no guard', async () => {
    await staffIs(jo, 'active = false')
    await staffIs(max, "role = 'admin'")
    // Jo is already inactive: "off" again is not the last active admin going.
    expect((await permission(jo, 'active', false, MAX)).data).toEqual({ id: jo, active: false })
    expect((await permission(jo, 'active', true, MAX)).data).toEqual({ id: jo, active: true })
  })
})

describe('every staff change holds the staff guard before it reads (GB16)', () => {
  const by = (id: string) => ({ actor: { type: 'staff' as const, id, role: 'admin' as const, canManagePricing: true, canIssueRefunds: true }, requestId: crypto.randomUUID(), pressKey: crypto.randomUUID() })
  /** The statements one press runs, in order. */
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
  const GUARD = 'SELECT id FROM staff ORDER BY id FOR NO KEY UPDATE'

  it('the role and each switch: the guard first, then the row, then the count, then the write', async () => {
    const demote = await statementsOf((watched) => setStaffRole(watched, max, 'staff', by(jo)))
    expect(demote[0]).toBe(GUARD)
    expect(demote.findIndex((sql) => sql.startsWith('UPDATE staff'))).toBeGreaterThan(1)

    await staffIs(max, "role = 'admin'")
    const off = await statementsOf((watched) => setStaffPermission(watched, max, 'active', false, by(jo)))
    expect(off[0]).toBe(GUARD)
    const count = off.findIndex((sql) => sql.includes("count(*)::int AS n FROM staff WHERE role = 'admin'"))
    expect(count).toBeGreaterThan(0)
    expect(off.findIndex((sql) => sql.startsWith('UPDATE staff'))).toBeGreaterThan(count)

    const pricing = await statementsOf((watched) => setStaffPermission(watched, jo, 'can_manage_pricing', true, by(jo)))
    expect(pricing[0]).toBe(GUARD)
  })
})
