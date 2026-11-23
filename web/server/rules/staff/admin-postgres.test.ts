import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '@/server/db'
import { holdingAfter, outcomeOf, pressBy, sessionBlockedBy } from '@/server/rules/testing/admin-race'
import { insert } from '@/server/rules/testing/database'
import { deferred, waitingOn } from '@/server/rules/testing/race'
import { startRealPostgres, type RealPostgres } from '@/server/rules/testing/real-postgres'
import { setStaffPermission, setStaffRole } from './admin'

// Brief W49 item 2 (GB16; "Parity and tests"): the two "keep one" rules as races, on real Postgres 17.6, each press
// on its own connection (PGlite is one session and can't show one press waiting for another). The first press is the
// rule itself, held open after its write until Postgres reports the second as blocked by it; each race has a control
// showing what the old read-then-write did.

let pg: RealPostgres
let first: Db
let second: Db
let jo = ''
let ada = ''

beforeAll(async () => {
  pg = await startRealPostgres()
  first = pg.connect()
  second = pg.connect()
})
afterAll(() => pg.stop())

/** Jo and Ada: the only two admins, and the only two with Manage pricing. Tia has neither. */
beforeEach(async () => {
  await first.query('DELETE FROM audit_log')
  await first.query('DELETE FROM staff')
  jo = await insert(first, 'staff', { role: 'admin', first_name: 'Jo', last_name: 'Staff', email: 'jo@example.com', can_issue_refunds: true, can_manage_pricing: true })
  ada = await insert(first, 'staff', { role: 'admin', first_name: 'Ada', last_name: 'Admin', email: 'ada@example.com', can_issue_refunds: true, can_manage_pricing: true })
  await insert(first, 'staff', { role: 'staff', first_name: 'Tia', last_name: 'Team', email: 'tia@example.com' })
})

const activeHolders = async () => (await first.query<{ id: string }>('SELECT id FROM staff WHERE can_manage_pricing = true AND active = true ORDER BY id')).map((row) => row.id)
const activeAdmins = async () => (await first.query<{ id: string }>("SELECT id FROM staff WHERE role = 'admin' AND active = true ORDER BY id")).map((row) => row.id)
const audited = async () => (await first.query<{ action: string; entity_id: string }>('SELECT action, entity_id FROM audit_log ORDER BY at')).map((row) => [row.action, row.entity_id])
const afterItsWrite = (sql: string) => sql.startsWith('UPDATE staff')

/** Two presses at once: the first held open after its write until the second is blocked by it. Answers both outcomes and what the second waited on. */
async function atOnce<A, B>(one: (db: Db) => Promise<A>, two: (db: Db) => Promise<B>) {
  const held = holdingAfter(first, afterItsWrite)
  const firstPress = outcomeOf(one(held.db))
  const holder = await held.holding
  const secondPress = outcomeOf(two(second))
  const waiter = await sessionBlockedBy(pg, holder)
  const waitedOn = await waitingOn(pg, waiter)
  held.release()
  return { first: await firstPress, second: await secondPress, waitedOn }
}

describe('two admins removing the last two Manage pricing holders at once (GB16)', () => {
  it("each takes the other's: the second waits for the first on the staff guard, then is refused, and one of them keeps it", async () => {
    const outcome = await atOnce(
      (db) => setStaffPermission(db, ada, 'can_manage_pricing', false, pressBy(jo)),
      (db) => setStaffPermission(db, jo, 'can_manage_pricing', false, pressBy(ada))
    )
    expect(outcome.waitedOn).toEqual(['staff'])
    expect(outcome.first).toEqual({ answered: { id: ada, can_manage_pricing: false } })
    expect(outcome.second).toEqual({ refused: 'last_pricing_holder' })
    expect(await activeHolders()).toEqual([jo])
    // One change, one record.
    expect(await audited()).toEqual([['staff.permission_set', ada]])
  })

  it('one takes the other\'s Manage pricing while the other is being switched off: still one active holder', async () => {
    const outcome = await atOnce(
      (db) => setStaffPermission(db, ada, 'can_manage_pricing', false, pressBy(jo)),
      (db) => setStaffPermission(db, jo, 'active', false, pressBy(ada))
    )
    expect(outcome.waitedOn).toEqual(['staff'])
    expect(outcome.first).toEqual({ answered: { id: ada, can_manage_pricing: false } })
    // Ada is still an active admin, so that rule lets Jo be switched off; the pricing rule does not.
    expect(outcome.second).toEqual({ refused: 'last_pricing_holder' })
    expect(await activeHolders()).toEqual([jo])
  })

  it('when the first press fails and is rolled back, the second goes through: it decides from what was really left', async () => {
    const gate = deferred()
    let announce: (pid: number) => void = () => {}
    const holding = new Promise<number>((resolve) => {
      announce = resolve
    })
    // The first press as far as its write, under the guard, and then a failure: nothing of it is kept.
    const firstPress = first
      .transaction(async (tx) => {
        await tx.query('SELECT id FROM staff ORDER BY id FOR NO KEY UPDATE')
        await tx.query('UPDATE staff SET can_manage_pricing = false WHERE id = $1', [ada])
        announce((await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]?.pid as number)
        await gate.promise
        throw new Error('the press failed after its write')
      })
      .catch(() => 'rolled back')
    const holder = await holding
    const secondPress = outcomeOf(setStaffPermission(second, jo, 'can_manage_pricing', false, pressBy(ada)))
    expect(await waitingOn(pg, await sessionBlockedBy(pg, holder))).toEqual(['staff'])
    gate.resolve()
    expect(await firstPress).toBe('rolled back')
    // Ada still holds it, so Jo's can go.
    expect(await secondPress).toEqual({ answered: { id: jo, can_manage_pricing: false } })
    expect(await activeHolders()).toEqual([ada])
  })

  it('control: the old read-then-write, with no guard, lets both through and leaves nobody able to change a price', async () => {
    // The old setStaffCanManagePricing's own three statements (as it was at W48), on two connections.
    const others = (db: Db, id: string) => db.query<{ count: number }>('SELECT count(*)::int AS count FROM staff WHERE can_manage_pricing = true AND active = true AND id <> $1', [id])
    const take = (db: Db, id: string) => db.query('UPDATE staff SET can_manage_pricing = $1, updated_at = now() WHERE id = $2 RETURNING id, can_manage_pricing', [false, id])
    // Both read before either writes: each sees the other still holding it.
    expect((await others(first, ada))[0]?.count).toBe(1)
    expect((await others(second, jo))[0]?.count).toBe(1)
    await take(first, ada)
    await take(second, jo)
    expect(await activeHolders()).toEqual([])
  })
})

describe('two admins removing the last two active admins at once', () => {
  it('each demotes the other: the second waits on the staff guard, then is refused, and one admin is left', async () => {
    const outcome = await atOnce(
      (db) => setStaffRole(db, ada, 'manager', pressBy(jo)),
      (db) => setStaffRole(db, jo, 'staff', pressBy(ada))
    )
    expect(outcome.waitedOn).toEqual(['staff'])
    expect(outcome.first).toEqual({ answered: { id: ada, role: 'manager' } })
    expect(outcome.second).toEqual({ refused: 'last_active_admin' })
    expect(await activeAdmins()).toEqual([jo])
    expect(await audited()).toEqual([['staff.role_set', ada]])
  })

  it('one demotes the other while being switched off by them: the two rules share the one guard, and one active admin is left', async () => {
    const outcome = await atOnce(
      (db) => setStaffRole(db, ada, 'manager', pressBy(jo)),
      (db) => setStaffPermission(db, jo, 'active', false, pressBy(ada))
    )
    expect(outcome.waitedOn).toEqual(['staff'])
    expect(outcome.first).toEqual({ answered: { id: ada, role: 'manager' } })
    expect(outcome.second).toEqual({ refused: 'last_active_admin' })
    expect(await activeAdmins()).toEqual([jo])
  })

  it('each switches the other off: the second is refused, and one active admin is left', async () => {
    const outcome = await atOnce(
      (db) => setStaffPermission(db, ada, 'active', false, pressBy(jo)),
      (db) => setStaffPermission(db, jo, 'active', false, pressBy(ada))
    )
    expect(outcome.waitedOn).toEqual(['staff'])
    expect(outcome.first).toEqual({ answered: { id: ada, active: false } })
    expect(outcome.second).toEqual({ refused: 'last_active_admin' })
    expect(await activeAdmins()).toEqual([jo])
  })
})
