import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Db, Tx } from '@/server/db'
import { ApiError } from '@/server/http/errors'
import { LOCK_ORDER } from '@/server/rules/orders/locks'
import { lowerMoneyOwed, moneyOwedOnOrder, raiseMoneyOwed } from '@/server/rules/orders/money-owed'
import { fixtures, insert } from '@/server/rules/testing/database'
import { deferred, waitingOn } from '@/server/rules/testing/race'
import { startRealPostgres, type RealPostgres } from '@/server/rules/testing/real-postgres'
import { openClaimHoldingOrder, refuseWhileRefundOpen, writeEventBookingClaim, writeOrderClaim, type EventBookingClaimDetails, type OrderClaimDetails } from './claims'
import { lockForRefund, REFUND_LOCK_SQL, type RefundLockTargets } from './locks'
import { ORDER_CLAIMS, writeClaimRow } from './pipeline'

// Brief W27 items 2 and 8 on real Postgres 17.6, each Worker client on its own connection: the lock order of E-plan
// 4.2 (order, customer, session passes, memberships, product variants, event, event booking, gift cards), and two
// refunds racing on one order. Each test holds one side open until Postgres itself reports the other waiting on it,
// so none can pass by timing; each race has a control showing the unguarded version going wrong.
// W27a (W27 review S1): the claim writers take the order's lock themselves, so a caller that never ran lockForRefund
// still queues; the control is now the look and the write done by hand, past the writers.

let pg: RealPostgres
let first: Db
let second: Db
let third: Db

beforeAll(async () => {
  pg = await startRealPostgres()
  first = pg.connect()
  second = pg.connect()
  third = pg.connect()
})
afterAll(() => pg.stop())

let staffId: string
beforeAll(async () => {
  staffId = await insert(first, 'staff', { role: 'staff', first_name: 'Jo', last_name: 'Staff', email: 'w27-locks@example.com', can_issue_refunds: true })
})

const by = () => ({ actor: { type: 'staff' as const, id: staffId }, requestId: 'w27-race' })

async function blockedBy(holder: number): Promise<number> {
  const giveUpAt = Date.now() + 4_000
  while (Date.now() < giveUpAt) {
    const rows = await pg.admin.unsafe<{ pid: number }[]>('SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))', [holder])
    if (rows[0]) return rows[0].pid
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Nothing waited on the holder.')
}

/** `work` inside a transaction on `db`, held open after it until finished. */
async function holding<T>(db: Db, work: (tx: Tx) => Promise<T>) {
  const release = deferred()
  let announce: (value: { pid: number; result: T }) => void = () => {}
  const ready = new Promise<{ pid: number; result: T }>((resolve) => {
    announce = resolve
  })
  const done = db.transaction(async (tx) => {
    const result = await work(tx)
    const pid = (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]?.pid as number
    announce({ pid, result })
    await release.promise
    return result
  })
  const { pid, result } = await Promise.race([ready, done.then(() => Promise.reject(new Error('The holder ended early.')))])
  return {
    pid,
    result,
    async finish(): Promise<T> {
      release.resolve()
      return done
    },
  }
}

/** One of everything a step E refund can lock: an order with an event booking, and the rows its lines sold. */
async function everything() {
  const customerId = await fixtures.customer(first)
  const orderId = await insert(first, 'orders', { customer_id: customerId, order_total: '100.00', payment_status: 'paid', payment_method: 'card', order_source: 'staff_created' })
  const passType = await fixtures.passType(first)
  const passes = [await fixtures.pass(first, { customer_id: customerId, pass_type_id: passType }), await fixtures.pass(first, { customer_id: customerId, pass_type_id: passType })].sort()
  const plan = await fixtures.plan(first)
  const memberships = [await fixtures.membership(first, { customer_id: customerId, plan_id: plan }), await fixtures.membership(first, { customer_id: customerId, plan_id: plan })].sort()
  const product = await insert(first, 'products', { name: `Soap ${crypto.randomUUID().slice(0, 6)}`, base_price: '12.00', fulfillment_method: 'pickup' })
  const variants = [
    await insert(first, 'product_variants', { product_id: product, sku: `SKU-${crypto.randomUUID().slice(0, 8)}`, stock_quantity: 5 }),
    await insert(first, 'product_variants', { product_id: product, sku: `SKU-${crypto.randomUUID().slice(0, 8)}`, stock_quantity: 5 }),
  ].sort()
  const eventId = await fixtures.event(first)
  const eventBookingId = await insert(first, 'event_bookings', { event_id: eventId, customer_id: customerId, places: 2, status: 'confirmed', price_paid: '80.00' })
  const card = () =>
    insert(first, 'gift_cards', { code: `W27-${crypto.randomUUID().slice(0, 8)}`, type: 'monetary', original_value: '40.00', remaining_balance: '40.00', origin: 'customer_purchase', expiry_date: '2030-01-01' })
  const giftCards = [await card(), await card()].sort()
  const targets: RefundLockTargets = { orderId, sessionPassIds: passes, membershipIds: memberships, productVariantIds: variants, eventId, eventBookingId, giftCardIds: giftCards }
  return { customerId, orderId, passes, memberships, variants, eventId, eventBookingId, giftCards, targets }
}

/** The rows of `everything()` in the order LOCK_ORDER says they are locked, each with LOCK_ORDER's name for it. */
function chain(rows: Awaited<ReturnType<typeof everything>>): Array<{ name: (typeof LOCK_ORDER)[number]; table: string; id: string }> {
  return [
    { name: 'order', table: 'orders', id: rows.orderId },
    { name: 'customer', table: 'customers', id: rows.customerId },
    ...rows.passes.map((id) => ({ name: 'session_pass' as const, table: 'customer_session_passes', id })),
    ...rows.memberships.map((id) => ({ name: 'membership' as const, table: 'customer_memberships', id })),
    ...rows.variants.map((id) => ({ name: 'product_variants' as const, table: 'product_variants', id })),
    { name: 'event', table: 'events', id: rows.eventId },
    { name: 'event_booking', table: 'event_bookings', id: rows.eventBookingId },
    ...rows.giftCards.map((id) => ({ name: 'gift_card' as const, table: 'gift_cards', id })),
  ]
}

/** The lock an UPDATE of a row takes, for each table a step E refund can lock: fixed statements, the id as $1. */
const HOLD_SQL: Readonly<Record<string, string>> = {
  orders: 'SELECT id FROM orders WHERE id = $1 FOR NO KEY UPDATE',
  customers: 'SELECT id FROM customers WHERE id = $1 FOR NO KEY UPDATE',
  customer_session_passes: 'SELECT id FROM customer_session_passes WHERE id = $1 FOR NO KEY UPDATE',
  customer_memberships: 'SELECT id FROM customer_memberships WHERE id = $1 FOR NO KEY UPDATE',
  product_variants: 'SELECT id FROM product_variants WHERE id = $1 FOR NO KEY UPDATE',
  events: 'SELECT id FROM events WHERE id = $1 FOR NO KEY UPDATE',
  event_bookings: 'SELECT id FROM event_bookings WHERE id = $1 FOR NO KEY UPDATE',
  gift_cards: 'SELECT id FROM gift_cards WHERE id = $1 FOR NO KEY UPDATE',
}
const holdSql = (table: string): string => {
  const sql = HOLD_SQL[table]
  if (!sql) throw new Error(`No lock statement for ${table}.`)
  return sql
}

/**
 * Whether a row is locked by anyone right now: a NOWAIT lock on it, on the superuser's own connection, rolled back at
 * once. Postgres answers 55P03 (lock_not_available) when someone holds it. Asked there rather than through a Worker
 * client, which turns 55P03 into its own timeout error.
 */
async function isLocked(table: string, id: string): Promise<boolean> {
  const nowait = `${holdSql(table)} NOWAIT`
  await pg.admin.unsafe('BEGIN')
  try {
    await pg.admin.unsafe(nowait, [id])
    return false
  } catch (err) {
    if ((err as { code?: string }).code === '55P03') return true
    throw err
  } finally {
    await pg.admin.unsafe('ROLLBACK')
  }
}

describe('LOCK_ORDER for a step E refund (E-plan 4.2)', () => {
  it('LOCK_ORDER has the event booking straight after its event, and the rest as it was', () => {
    expect(LOCK_ORDER).toEqual(['order', 'booking', 'customer', 'promo_code', 'session', 'credit_period', 'session_pass', 'membership', 'product_variants', 'event', 'event_booking', 'gift_card'])
  })

  it('the statement itself: each lock waits for the one before it, because every lateral names the one before', () => {
    // Postgres runs a lateral only once what it refers to has run. That reference is the only thing that fixes the
    // order: without it the planner may take a later row first, and it usually doesn't, so no race test would notice
    // (a planted bug showed exactly that: W27 plants, N2). So the statement is read here as it is written.
    const first = /FROM \(SELECT id, customer_id FROM (\w+) WHERE id = \$1::uuid (FOR [A-Z ]+)\) (\w+)\n/.exec(REFUND_LOCK_SQL)
    expect(first?.slice(1)).toEqual(['orders', 'FOR UPDATE', 'o'])
    const laterals = [...REFUND_LOCK_SQL.matchAll(/JOIN LATERAL \(([\s\S]*?)\) (\w+) ON true/g)].map((match) => ({
      body: match[1] ?? '',
      alias: match[2] ?? '',
      table: /FROM (\w+) WHERE/.exec(match[1] ?? '')?.[1] ?? '',
      lock: /FOR (?:NO KEY )?UPDATE/.exec(match[1] ?? '')?.[0] ?? '',
    }))
    // In LOCK_ORDER's order, each locked FOR NO KEY UPDATE.
    expect(laterals.map(({ alias, table, lock }) => [alias, table, lock])).toEqual([
      ['c', 'customers', 'FOR NO KEY UPDATE'],
      ['sp', 'customer_session_passes', 'FOR NO KEY UPDATE'],
      ['m', 'customer_memberships', 'FOR NO KEY UPDATE'],
      ['v', 'product_variants', 'FOR NO KEY UPDATE'],
      ['e', 'events', 'FOR NO KEY UPDATE'],
      ['eb', 'event_bookings', 'FOR NO KEY UPDATE'],
      ['g', 'gift_cards', 'FOR NO KEY UPDATE'],
    ])
    // Each names the alias straight before it, inside its WHERE.
    const before = ['o', ...laterals.map((lateral) => lateral.alias)]
    for (const [index, lateral] of laterals.entries()) {
      const where = lateral.body.slice(lateral.body.indexOf('WHERE'))
      expect(new RegExp(`\\b${before[index]}\\.(id|ids|customer_id)\\b`).test(where), `${lateral.alias} must name ${before[index]}`).toBe(true)
    }
    // A set of rows is taken in id order: sorted inside the lateral, before it locks.
    for (const lateral of laterals.filter(({ alias }) => ['sp', 'm', 'v', 'g'].includes(alias))) expect(lateral.body, lateral.alias).toMatch(/ORDER BY id\s+FOR NO KEY UPDATE/)
  })

  it('locks everything it is given and answers what it holds; an order that is gone locks nothing', async () => {
    const rows = await everything()
    const held = await second.transaction((tx) => lockForRefund(tx, rows.targets))
    expect(held).toEqual({
      orderId: rows.orderId,
      customerId: rows.customerId,
      sessionPassIds: rows.passes,
      membershipIds: rows.memberships,
      variantIds: rows.variants,
      eventId: rows.eventId,
      eventBookingId: rows.eventBookingId,
      giftCardIds: rows.giftCards,
    })
    expect(await second.transaction((tx) => lockForRefund(tx, { ...rows.targets, orderId: crypto.randomUUID() }))).toBeNull()
    // Nothing else: an order with only plain lines locks the order and its customer.
    expect(await second.transaction((tx) => lockForRefund(tx, { orderId: rows.orderId }))).toEqual({
      orderId: rows.orderId,
      customerId: rows.customerId,
      sessionPassIds: [],
      membershipIds: [],
      variantIds: [],
      eventId: null,
      eventBookingId: null,
      giftCardIds: [],
    })
  })

  it('takes each row only once every row before it in LOCK_ORDER is held: with any one row held by someone else, it waits on that row, holding all before it and none after', async () => {
    const rows = await everything()
    const order = chain(rows)
    // The chain is in LOCK_ORDER's order.
    const places = order.map((row) => LOCK_ORDER.indexOf(row.name))
    expect(places).toEqual([...places].sort((a, b) => a - b))
    expect(order).toHaveLength(12)

    for (const [index, row] of order.entries()) {
      const holder = await holding(first, (tx) => tx.query(holdSql(row.table), [row.id]))
      const locking = second.transaction((tx) => lockForRefund(tx, rows.targets))
      const waiter = await blockedBy(holder.pid)
      expect(await waitingOn(pg, waiter), `waiting on ${row.table}`).toEqual([row.table])
      for (const [other, before] of order.entries()) {
        if (other === index) continue
        // Held already when it comes before the row waited on; still free when it comes after.
        expect(await isLocked(before.table, before.id), `${before.table} ${other < index ? 'before' : 'after'} ${row.table}`).toBe(other < index)
      }
      await holder.finish()
      expect((await locking)?.orderId).toBe(rows.orderId)
    }
  }, 60_000)

  it('rows named in any order are taken in id order: two refunds naming the same variants and gift cards the opposite ways round never deadlock (30 free-running rounds)', async () => {
    const one = await everything()
    const two = await everything()
    for (let round = 0; round < 30; round += 1) {
      const shared = { productVariantIds: [...one.variants, ...two.variants], giftCardIds: [...one.giftCards, ...two.giftCards], sessionPassIds: [...one.passes, ...two.passes], membershipIds: [...one.memberships, ...two.memberships] }
      const backwards = Object.fromEntries(Object.entries(shared).map(([key, ids]) => [key, [...ids].reverse()]))
      const refund = (db: Db, orderId: string, targets: Partial<RefundLockTargets>) =>
        db.transaction(async (tx) => {
          const held = await lockForRefund(tx, { orderId, ...targets })
          await tx.query('UPDATE product_variants SET updated_at = now() WHERE id = ANY($1::uuid[])', [held?.variantIds ?? []])
          return held?.variantIds
        })
      const [a, b] = await Promise.all([refund(second, one.orderId, shared), refund(third, two.orderId, backwards)])
      const sorted = [...one.variants, ...two.variants].sort()
      expect(a).toEqual(sorted)
      expect(b).toEqual(sorted)
    }
  }, 60_000)

  it('control: the same rows locked in the order each refund names them (not sorted) do deadlock', async () => {
    const rows = await everything()
    const [a, b] = rows.variants as [string, string]
    const bothHoldOne = { count: 0, all: deferred() }
    const unsorted = (db: Db, mine: string, theirs: string) =>
      db.transaction(async (tx) => {
        await tx.query('SELECT id FROM product_variants WHERE id = $1 FOR NO KEY UPDATE', [mine])
        bothHoldOne.count += 1
        if (bothHoldOne.count === 2) bothHoldOne.all.resolve()
        await bothHoldOne.all.promise
        await tx.query('SELECT id FROM product_variants WHERE id = $1 FOR NO KEY UPDATE', [theirs])
      })
    const outcomes = await Promise.allSettled([unsorted(second, a, b), unsorted(third, b, a)])
    const failed = outcomes.filter((outcome) => outcome.status === 'rejected')
    expect(failed).toHaveLength(1)
    expect(String((failed[0] as PromiseRejectedResult).reason)).toMatch(/deadlock|took too long to respond/i)
  })

  it("an order's refund and its event booking's cancel take the same order first, so they queue and never deadlock (20 free-running rounds)", async () => {
    for (let round = 0; round < 20; round += 1) {
      const rows = await everything()
      const orderRefund = second.transaction(async (tx) => {
        const held = await lockForRefund(tx, { orderId: rows.orderId, productVariantIds: rows.variants, giftCardIds: rows.giftCards })
        await tx.query('UPDATE orders SET updated_at = now() WHERE id = $1', [rows.orderId])
        return held?.orderId
      })
      const eventCancel = third.transaction(async (tx) => {
        const held = await lockForRefund(tx, { orderId: rows.orderId, eventId: rows.eventId, eventBookingId: rows.eventBookingId })
        await tx.query('UPDATE event_bookings SET updated_at = now() WHERE id = $1', [rows.eventBookingId])
        return held?.eventBookingId
      })
      expect(await Promise.all([orderRefund, eventCancel])).toEqual([rows.orderId, rows.eventBookingId])
    }
  }, 60_000)
})

const orderClaim = (orderId: string, storeCredit: number): OrderClaimDetails => ({
  kind: 'refund',
  amount: storeCredit,
  method: 'credit',
  reason: null,
  worker: true,
  plan: { card: [], storeCredit, cash: 0, ownOrderId: orderId },
  livemode: null,
})
const eventClaim = (orderId: string, storeCredit: number): EventBookingClaimDetails => ({ ...orderClaim(orderId, storeCredit), kind: 'cancel_places', orderId })

const outcome = async <T>(work: Promise<T>): Promise<T | ApiError> => work.catch((err: unknown) => (err instanceof ApiError ? err : Promise.reject(err)))
const openClaims = async (orderId: string) =>
  (await first.query<{ id: string }>("SELECT id FROM audit_log WHERE action LIKE '%.refund_claimed' AND (entity_id = $1 OR details->>'orderId' = $1)", [orderId])).length

describe('two refunds at once on one order: the second waits on the order, then is refused (`refund_open`)', () => {
  it('two refunds of the same order: one claim, the other refused with nothing written', async () => {
    const { orderId } = await everything()
    const r1 = (tx: Tx) => lockForRefund(tx, { orderId }).then(() => writeOrderClaim(tx, orderId, orderClaim(orderId, 10), by()))
    const holder = await holding(first, r1)
    const racing = outcome(second.transaction(r1))
    expect(await waitingOn(pg, await blockedBy(holder.pid))).toEqual(['orders'])
    await holder.finish()
    const second_ = await racing
    expect(second_).toBeInstanceOf(ApiError)
    expect(second_).toMatchObject({ code: 'CONFLICT', details: { reason: 'refund_open' } })
    expect(await openClaims(orderId)).toBe(1)
    expect(await openClaimHoldingOrder(first, orderId)).toBe(holder.result.id)
  })

  it("an order's refund racing its event booking's cancel: the same queue, one claim", async () => {
    const { orderId, eventId, eventBookingId } = await everything()
    const holder = await holding(first, (tx) => lockForRefund(tx, { orderId, eventId, eventBookingId }).then(() => writeEventBookingClaim(tx, eventBookingId, eventClaim(orderId, 40), by())))
    const racing = outcome(second.transaction((tx) => lockForRefund(tx, { orderId }).then(() => writeOrderClaim(tx, orderId, orderClaim(orderId, 10), by()))))
    expect(await waitingOn(pg, await blockedBy(holder.pid))).toEqual(['orders'])
    await holder.finish()
    expect(await racing).toMatchObject({ code: 'CONFLICT', details: { reason: 'refund_open' } })
    expect(await openClaims(orderId)).toBe(1)
  })

  it('the first rolled back (its R1 refused later on): the second goes through, and there is one claim', async () => {
    const { orderId } = await everything()
    const r1 = (tx: Tx) => lockForRefund(tx, { orderId }).then(() => writeOrderClaim(tx, orderId, orderClaim(orderId, 10), by()))
    const release = deferred()
    let holderPid = 0
    const announced = deferred()
    const failing = first
      .transaction(async (tx) => {
        await r1(tx)
        holderPid = (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]?.pid as number
        announced.resolve()
        await release.promise
        throw new Error('R1 refused after the claim')
      })
      .catch((err: unknown) => err)
    await announced.promise
    const racing = outcome(second.transaction(r1))
    expect(await waitingOn(pg, await blockedBy(holderPid))).toEqual(['orders'])
    release.resolve()
    expect(String(await failing)).toContain('R1 refused after the claim')
    expect(await racing).not.toBeInstanceOf(ApiError)
    expect(await openClaims(orderId)).toBe(1)
  })

  // W27a (W27 review S1). Before it, a caller that forgot lockForRefund wrote two claims (W27's control, which went
  // through refuseWhileRefundOpen and writeClaimRow by hand). The writers now take the order's lock themselves.
  it("a caller that forgot lockForRefund, two refunds of one order: the writer's own lock makes the second wait on the order, then it is refused; one claim", async () => {
    const { orderId } = await everything()
    const forgetful = (tx: Tx) => writeOrderClaim(tx, orderId, orderClaim(orderId, 10), by())
    const holder = await holding(first, forgetful)
    const racing = outcome(second.transaction(forgetful))
    expect(await waitingOn(pg, await blockedBy(holder.pid))).toEqual(['orders'])
    await holder.finish()
    expect(await racing).toMatchObject({ code: 'CONFLICT', details: { reason: 'refund_open' } })
    expect(await openClaims(orderId)).toBe(1)
    expect(await openClaimHoldingOrder(first, orderId)).toBe(holder.result.id)
  })

  it("a caller that forgot lockForRefund, an event booking's cancel and its order's refund: the event booking's writer locks the order that paid for it, either way round; one claim each time", async () => {
    const eventFirst = await everything()
    const eventHolder = await holding(first, (tx) => writeEventBookingClaim(tx, eventFirst.eventBookingId, eventClaim(eventFirst.orderId, 40), by()))
    const orderRacing = outcome(second.transaction((tx) => writeOrderClaim(tx, eventFirst.orderId, orderClaim(eventFirst.orderId, 10), by())))
    expect(await waitingOn(pg, await blockedBy(eventHolder.pid))).toEqual(['orders'])
    await eventHolder.finish()
    expect(await orderRacing).toMatchObject({ code: 'CONFLICT', details: { reason: 'refund_open' } })
    expect(await openClaims(eventFirst.orderId)).toBe(1)

    const orderFirst = await everything()
    const orderHolder = await holding(first, (tx) => writeOrderClaim(tx, orderFirst.orderId, orderClaim(orderFirst.orderId, 10), by()))
    const eventRacing = outcome(second.transaction((tx) => writeEventBookingClaim(tx, orderFirst.eventBookingId, eventClaim(orderFirst.orderId, 40), by())))
    expect(await waitingOn(pg, await blockedBy(orderHolder.pid))).toEqual(['orders'])
    await orderHolder.finish()
    expect(await eventRacing).toMatchObject({ code: 'CONFLICT', details: { reason: 'refund_open' } })
    expect(await openClaims(orderFirst.orderId)).toBe(1)
  })

  it("a caller that forgot lockForRefund, two cancels of one event booking's places: the second waits on the order, then is refused with the event booking's words; one claim", async () => {
    const { orderId, eventBookingId } = await everything()
    const forgetful = (tx: Tx) => writeEventBookingClaim(tx, eventBookingId, eventClaim(orderId, 40), by())
    const holder = await holding(first, forgetful)
    const racing = outcome(second.transaction(forgetful))
    expect(await waitingOn(pg, await blockedBy(holder.pid))).toEqual(['orders'])
    await holder.finish()
    const refused = await racing
    expect(refused).toMatchObject({ code: 'CONFLICT', details: { reason: 'refund_open' } })
    expect((refused as ApiError).message).toContain('event booking')
    expect(await openClaims(orderId)).toBe(1)
  })

  it("a caller that holds the order's lock already (lockForRefund) writes its claim as before: the writer's lock on a row it holds does nothing", async () => {
    const { orderId, eventId, eventBookingId } = await everything()
    const claim = await second.transaction(async (tx) => {
      await lockForRefund(tx, { orderId, eventId, eventBookingId })
      return writeEventBookingClaim(tx, eventBookingId, eventClaim(orderId, 40), by())
    })
    expect(await openClaimHoldingOrder(first, orderId)).toBe(claim.id)
    expect(await openClaims(orderId)).toBe(1)
  })

  it('control: the same look and write done by hand, past the writers and with no lock, lets both through (two open claims on one order)', async () => {
    const { orderId } = await everything()
    // Each looks, finds nothing, and writes. The look can't see the other's uncommitted row, so only the order's
    // lock makes it hold: this is what the writers would do without their own lock (W27a's plants P1 and P2).
    const bothLooked = { count: 0, all: deferred() }
    const unguarded = (db: Db) =>
      db.transaction(async (tx) => {
        await refuseWhileRefundOpen(tx, 'order', orderId)
        bothLooked.count += 1
        if (bothLooked.count === 2) bothLooked.all.resolve()
        await bothLooked.all.promise
        return writeClaimRow(tx, ORDER_CLAIMS, orderId, orderClaim(orderId, 10), by())
      })
    await Promise.all([unguarded(second), unguarded(third)])
    expect(await openClaims(orderId)).toBe(2)
  })
})

describe('money owed on an order under its lock (E-plan 4.5)', () => {
  it('two lowerings at once of all that is owed: the second waits on the order and lowers nothing', async () => {
    const { orderId } = await everything()
    await first.transaction((tx) => raiseMoneyOwed(tx, orderId, 25))
    const lower = (tx: Tx) => lockForRefund(tx, { orderId }).then(() => lowerMoneyOwed(tx, orderId, 25))
    const holder = await holding(first, lower)
    const racing = second.transaction(lower)
    expect(await waitingOn(pg, await blockedBy(holder.pid))).toEqual(['orders'])
    expect(await holder.finish()).toEqual({ ok: true, owed: 0 })
    expect(await racing).toEqual({ ok: false, reason: 'more_than_owed', owed: 0 })
    expect(await moneyOwedOnOrder(first, orderId)).toBe(0)
  })

  it('a raise and a lowering at once: both land, in turn', async () => {
    const { orderId } = await everything()
    await first.transaction((tx) => raiseMoneyOwed(tx, orderId, 10))
    const holder = await holding(first, (tx) => lockForRefund(tx, { orderId }).then(() => raiseMoneyOwed(tx, orderId, 5)))
    const racing = second.transaction((tx) => lockForRefund(tx, { orderId }).then(() => lowerMoneyOwed(tx, orderId, 15)))
    expect(await waitingOn(pg, await blockedBy(holder.pid))).toEqual(['orders'])
    expect(await holder.finish()).toBe(15)
    expect(await racing).toEqual({ ok: true, owed: 0 })
  })
})
