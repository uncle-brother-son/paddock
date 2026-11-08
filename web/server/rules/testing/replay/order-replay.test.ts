import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Db } from '@/server/db'
import { staffSees } from '@/server/rules/orders/failure-messages'
import { compareRecordings, type Recording } from './compare'
import { readGolden, replay, startReplay, type ReplayEnvironment, type Scenario } from './harness'
import { NOT_BUILT_SCENARIOS, orderDifferences, W06_SCENARIOS } from './order-differences'
import { newOrderSide, type OrderAnswer } from './order-side'
import { scenarios } from './scenarios'

// W06's parity proof (W03-plan 3.1 layer 1): each scenario in W06's scope runs from the same seed
// through the new order route, and its rows (in the order the app reads them), its answer and its
// money must match what the old createOrder wrote, saved in the golden file, except the differences
// named in order-differences.ts. A golden file is the old function's own recording, so this still
// holds the route to it after the old code goes.

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))

const byName = (name: string): Scenario => {
  const scenario = scenarios.find((s) => s.name === name)
  if (!scenario) throw new Error(`No scenario ${name}`)
  return scenario
}

describe('the order route against the old createOrder', () => {
  let environment: ReplayEnvironment

  beforeAll(async () => {
    process.env.STAFF_API_KEY = 'test-staff-api-key'
    environment = await startReplay()
    holder.db = environment.database.db
  })
  afterAll(() => environment.stop())

  async function runNew(name: string): Promise<{ recording: Recording; answers: OrderAnswer[] }> {
    const answers: OrderAnswer[] = []
    const recording = await replay(environment, byName(name), newOrderSide(answers))
    return { recording, answers }
  }

  describe.each(W06_SCENARIOS)('%s', (name) => {
    it('writes what the old function wrote, in the same order, and answers the same', async () => {
      const golden = readGolden(name) as Recording
      expect(golden, `No golden file for ${name}`).not.toBeNull()
      const { recording } = await runNew(name)
      const placed = (golden.results[0] as { success?: boolean }).success === true
      expect(compareRecordings(golden, recording, orderDifferences(placed))).toEqual([])
    })

    it('tells staff what the screen told them', async () => {
      const golden = readGolden(name) as Recording
      const old = golden.results[0] as { success: boolean; reason?: string; message?: string; amountDueTotal?: number }
      const { answers } = await runNew(name)
      const body = answers[0]?.body
      if (old.success) {
        expect(body?.ok).toBe(true)
        return
      }
      expect(body?.ok).toBe(false)
      if (body && !body.ok) expect(body.error.message).toBe(staffSees({ reason: old.reason as string, message: old.message, amountDueTotal: old.amountDueTotal }))
    })
  })

  describe('row order', () => {
    it('the seats keep their order, though now() does not move inside the transaction', async () => {
      const { recording } = await runNew('w06-a-full-public-party')
      expect(recording.tables['booking_guests']?.tied).toBe(0)
      expect(recording.tables['booking_guests']?.added.map((seat) => seat['guest_type'])).toEqual([
        'account_holder',
        'additional_guest',
        'additional_guest',
        'additional_guest',
        'additional_guest',
        'additional_guest',
      ])
    })

    it('the order lines and the booking add-ons keep theirs', async () => {
      const lines = (await runNew('w06-booking-and-a-standalone-addon-in-cash')).recording.tables['order_line_items']
      expect(lines?.tied).toBe(0)
      expect(lines?.added.map((line) => line['item_type'])).toEqual(['booking', 'addon'])
      const addons = (await runNew('w06-two-addon-credits-on-one-membership')).recording.tables['addon_order_lines']
      expect(addons?.tied).toBe(0)
      expect(addons?.added.map((line) => line['sku_at_purchase'])).toEqual(['TOWEL', 'ROBE'])
    })

    it('the two audit rows are in order: created, then paid', async () => {
      const audit = (await runNew('cash-booking-two-guests-addon')).recording.tables['audit_log']
      expect(audit?.tied).toBe(0)
      expect(audit?.added.map((row) => row['action'])).toEqual(['order.create', 'order.paid'])
    })
  })

  describe.each(Object.entries(NOT_BUILT_SCENARIOS))('%s is not built yet', (name, parts) => {
    it('answers NOT_BUILT, naming what, before anything is written', async () => {
      const { recording, answers } = await runNew(name)
      expect(answers[0]?.status).toBe(501)
      expect(answers[0]?.body).toMatchObject({ ok: false, error: { code: 'NOT_BUILT', details: { notBuilt: parts } } })
      expect(Object.keys(recording.tables)).toEqual(['api_idempotency'])
    })
  })
})
