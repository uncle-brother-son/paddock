import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Db, Tx } from '@/server/db'
import { ApiError } from '@/server/http/errors'
import { fixtures, insert } from '@/server/rules/testing/database'
import { deferred, waitingOn } from '@/server/rules/testing/race'
import { startRealPostgres, type RealPostgres } from '@/server/rules/testing/real-postgres'
import { extendGiftCard, setGiftCardPickedUp } from './admin'

// Brief W38 item 6 on real Postgres 17.6, each client on its own connection: an extension racing the refund that
// voids the card (Q46), both ways round; two extensions at once; a flag pressed twice at once. Each race holds one
// side's transaction open, after its writes, until Postgres reports the other as waiting on the card's row, so none
// can pass by timing. The control runs the old function's own statement the same way, and un-voids the refunded card.

let pg: RealPostgres
let first: Db
let second: Db
let third: Db
let staffId: string
let customer: string
let n = 0

beforeAll(async () => {
  pg = await startRealPostgres()
  first = pg.connect()
  second = pg.connect()
  third = pg.connect()
  staffId = await insert(first, 'staff', { role: 'staff', first_name: 'Jo', last_name: 'Staff', email: 'w38-race@example.com', can_issue_refunds: true })
  customer = await fixtures.customer(first)
})
afterAll(() => pg.stop())

const by = () => ({ actor: { type: 'staff' as const, id: staffId, canIssueRefunds: true }, requestId: crypto.randomUUID() })

/** A £50 card good to 1 January 2030, sold on a paid order's gift card line. */
async function soldCard(row: Record<string, unknown> = {}): Promise<{ card: string; line: string }> {
  n += 1
  const card = await insert(first, 'gift_cards', { code: `W38RACE${n}`, type: 'monetary', original_value: '50.00', remaining_balance: '50.00', origin: 'customer_purchase', expiry_date: '2030-01-01', purchaser_id: customer, fulfillment_method: 'pickup', ...row })
  const order = await insert(first, 'orders', { customer_id: customer, order_total: '50.00', payment_status: 'paid', payment_method: 'cash', order_source: 'staff_created' })
  const line = await insert(first, 'order_line_items', { order_id: order, gift_card_id: card, item_type: 'gift_card', quantity: 1, unit_price: '50.00', line_total: '50.00' })
  return { card, line }
}

/** What the Worker's order refund does to a gift card line (refund-lines.ts): the card locked and voided, the line stamped, in one transaction. */
async function refundVoids(tx: Tx, card: string, line: string): Promise<void> {
  await tx.query('SELECT id FROM gift_cards WHERE id = $1::uuid FOR NO KEY UPDATE', [card])
  await tx.query('UPDATE gift_cards SET voided = true, updated_at = now() WHERE id = $1::uuid', [card])
  await tx.query("UPDATE order_line_items SET refunded_at = now(), refund_method = 'credit' WHERE id = $1::uuid", [line])
}

/** The old extendGiftCardExpiry's one statement. */
const oldExtend = (db: Db, card: string, months: number) =>
  db.query<{ voided: boolean }>("UPDATE gift_cards SET expiry_date = (expiry_date + ($1 || ' months')::interval)::date, voided = false, updated_at = now() WHERE id = $2 RETURNING voided", [String(months), card])

type Outcome<T> = { answered: T } | { refused: string }
async function outcome<T>(work: Promise<T>): Promise<Outcome<T>> {
  try {
    return { answered: await work }
  } catch (err) {
    if (err instanceof ApiError) return { refused: String((err.details as { reason?: unknown } | undefined)?.reason ?? err.code) }
    throw err
  }
}

/** `db`, with its first transaction held open after its work is done (every write made, nothing committed) until `finish`. */
function heldOpen(db: Db): { db: Db; pid: Promise<number>; finish(): void } {
  const release = deferred()
  let announce: (pid: number) => void = () => {}
  const pid = new Promise<number>((resolve) => {
    announce = resolve
  })
  let count = 0
  const held = new Proxy(db, {
    get(target, property, receiver) {
      if (property !== 'transaction') return Reflect.get(target, property, receiver) as unknown
      return async <T>(work: (tx: Tx) => Promise<T>): Promise<T> => {
        count += 1
        if (count > 1) return target.transaction(work)
        return target.transaction(async (tx) => {
          const result = await work(tx)
          announce(Number((await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]?.pid))
          await release.promise
          return result
        })
      }
    },
  })
  return { db: held, pid, finish: () => release.resolve() }
}

/** Waits until Postgres itself reports a session blocked by `holder`, and answers that session. */
async function blockedBy(holder: number): Promise<number> {
  const giveUpAt = Date.now() + 4_000
  while (Date.now() < giveUpAt) {
    const rows = await pg.admin.unsafe<{ pid: number }[]>('SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))', [holder])
    if (rows[0]) return rows[0].pid
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Nothing waited on the holder.')
}

/** Runs `held` and keeps it open, starts `waiter`, checks Postgres reports it waiting on the card's row, then lets both finish. */
async function race<A, B>(held: (db: Db) => Promise<A>, waiter: (db: Db) => Promise<B>): Promise<{ held: Outcome<A>; waiter: Outcome<B> }> {
  const holding = heldOpen(first)
  const heldWork = outcome(held(holding.db))
  const holder = await Promise.race([holding.pid, heldWork.then(() => Promise.reject(new Error('The first ended before it could be held.')))])
  let settled = false
  const waiting = outcome(waiter(second)).finally(() => {
    settled = true
  })
  const blocked = await blockedBy(holder)
  expect(settled).toBe(false)
  expect(await waitingOn(pg, blocked)).toEqual(['gift_cards'])
  holding.finish()
  return { held: await heldWork, waiter: await waiting }
}

const cardNow = async (card: string) =>
  (await third.query<{ expiry_date: string; voided: boolean | null; picked_up: boolean }>('SELECT expiry_date::text AS expiry_date, voided, picked_up FROM gift_cards WHERE id = $1', [card]))[0]
const auditOf = async (card: string, action: string) => (await third.query<{ details: Record<string, unknown> }>('SELECT details FROM audit_log WHERE entity_id = $1 AND action = $2 ORDER BY at, ctid', [card, action])).map((row) => row.details)

describe('an extension against the refund that voids the card (Q46, FB13)', () => {
  it('the refund first: the extension waits on the card, then sees the refunded line and is refused (voided_by_refund); the card stays voided, its date unmoved, no audit row', async () => {
    const { card, line } = await soldCard()
    const result = await race(
      (db) => db.transaction((tx) => refundVoids(tx, card, line)),
      (db) => extendGiftCard(db, card, { extendByMonths: 6 }, by())
    )
    expect(result.held).toEqual({ answered: undefined })
    expect(result.waiter).toEqual({ refused: 'voided_by_refund' })
    expect(await cardNow(card)).toEqual({ expiry_date: '2030-01-01', voided: true, picked_up: false })
    expect(await auditOf(card, 'gift_card.extended')).toEqual([])
  })

  it("the control: the old function's one statement, the same way round, waits and then un-voids the refunded card (bug FB13)", async () => {
    const { card, line } = await soldCard()
    const result = await race(
      (db) => db.transaction((tx) => refundVoids(tx, card, line)),
      (db) => oldExtend(db, card, 6)
    )
    expect(result.waiter).toEqual({ answered: [{ voided: false }] })
    expect(await cardNow(card)).toEqual({ expiry_date: '2030-07-01', voided: false, picked_up: false })
  })

  it('the extension first: the refund waits on the card, then voids it; the card ends voided, with the date the extension gave it and the extension on record', async () => {
    const { card, line } = await soldCard()
    const result = await race(
      (db) => extendGiftCard(db, card, { extendByMonths: 6 }, by()),
      (db) => db.transaction((tx) => refundVoids(tx, card, line))
    )
    expect(result.held).toEqual({ answered: { giftCard: { id: card, expiry_date: '2030-07-01', voided: false } } })
    expect(await cardNow(card)).toEqual({ expiry_date: '2030-07-01', voided: true, picked_up: false })
    expect(await auditOf(card, 'gift_card.extended')).toHaveLength(1)
    // And it can't be brought back afterwards.
    expect(await outcome(extendGiftCard(third, card, { extendByMonths: 1 }, by()))).toEqual({ refused: 'voided_by_refund' })
  })
})

describe('two presses at once on one card', () => {
  it('two extensions of a month each: the second waits on the card, then counts from the date the first left: two months on, two audit rows that follow on', async () => {
    const { card } = await soldCard()
    const result = await race(
      (db) => extendGiftCard(db, card, { extendByMonths: 1 }, by()),
      (db) => extendGiftCard(db, card, { extendByMonths: 1 }, by())
    )
    expect(result.held).toMatchObject({ answered: { giftCard: { expiry_date: '2030-02-01' } } })
    expect(result.waiter).toMatchObject({ answered: { giftCard: { expiry_date: '2030-03-01' } } })
    expect((await auditOf(card, 'gift_card.extended')).map((row) => [row['expiryBefore'], row['expiryAfter']])).toEqual([
      ['2030-01-01', '2030-02-01'],
      ['2030-02-01', '2030-03-01'],
    ])
  })

  it('an expired card extended twice at once: the first counts from today, the second from the new date (it is in date by then)', async () => {
    const { card } = await soldCard({ expiry_date: '2020-01-01' })
    const result = await race(
      (db) => extendGiftCard(db, card, { extendByMonths: 1 }, by()),
      (db) => extendGiftCard(db, card, { extendByMonths: 1 }, by())
    )
    const [today] = await third.query<{ one: string; two: string }>(
      "SELECT ((now() AT TIME ZONE 'Europe/London')::date + interval '1 month')::date::text AS one, (((now() AT TIME ZONE 'Europe/London')::date + interval '1 month')::date + interval '1 month')::date::text AS two"
    )
    expect(result.held).toMatchObject({ answered: { giftCard: { expiry_date: today?.one } } })
    expect(result.waiter).toMatchObject({ answered: { giftCard: { expiry_date: today?.two } } })
    expect((await auditOf(card, 'gift_card.extended')).map((row) => row['countedFrom'])).toEqual(['today', 'expiry'])
  })

  it('collected pressed twice at once: the second waits on the card; both are recorded, the second as already collected', async () => {
    const { card } = await soldCard()
    const result = await race(
      (db) => setGiftCardPickedUp(db, card, true, by()),
      (db) => setGiftCardPickedUp(db, card, true, by())
    )
    expect(result.held).toMatchObject({ answered: { giftCard: { picked_up: true } } })
    expect(result.waiter).toMatchObject({ answered: { giftCard: { picked_up: true } } })
    expect((await auditOf(card, 'gift_card.picked_up')).map((row) => (row['before'] as { pickedUp: boolean }).pickedUp)).toEqual([false, true])
    expect((await cardNow(card))?.picked_up).toBe(true)
  })
})
