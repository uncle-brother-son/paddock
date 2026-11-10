import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Db } from '@/server/db'
import { compareRecordings, withCanonicalGoneNumbers, type Recording } from './compare'
import { FLOW_SCENARIOS, flowDifferences, newFlowSide, W12_FLOW_SCENARIOS } from './flow-side'
import { oldSide, readGolden, replay, startReplay, writeGolden, type ReplayEnvironment, type Scenario } from './harness'
import { scenarios } from './scenarios'

// W12 (brief item 2, "Parity and tests: Replay"): the reader flows' finalise and cancel (Move, Settle, Add
// Guest) through the new routes, against the old finaliseReaderPayment and cancelReaderPayment. Every
// recorded scenario that finishes or cancels a flow on the reader runs from the same seed; everything
// else in it (the order before, the flow's start, the refunds after) runs through the old functions on
// both sides, so what is compared is the finalise and cancel, and what the old functions after them make
// of the rows they leave. The golden files are the old functions' own recordings (W05 and before).
//
// The new routes take only a flow the Worker started (step D). Until then the old screens start every flow,
// so the new side writes onto the flow's record what step D's start will write (method, channel, request id,
// Stripe customer, the key's mode) as the old start returns: `asWorkerFlow`. That is the first named
// difference below.

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))
vi.mock('@/server/stripe/client', async (importOriginal) => {
  const { stripeClientMock } = await import('./stripe-binding')
  return stripeClientMock(await importOriginal<typeof import('@/server/stripe/client')>())
})

/**
 * A store credit note's `[ref <uuid>]` is random on both sides (shared/storeCreditRefund.ts; the flow's undo
 * writes one too), so its label is a `gone#N`, and the new side's audit and idempotency rows, which name
 * other ids first, shift N. Only that token loses its number: the note's words are still compared.
 */
function withRefsUnnumbered(recording: Recording): Recording {
  return JSON.parse(JSON.stringify(recording).replace(/\[ref gone#\d+\]/g, '[ref gone]')) as Recording
}

const byName = (name: string): Scenario => {
  const scenario = [...scenarios, ...W12_FLOW_SCENARIOS].find((s) => s.name === name)
  if (!scenario) throw new Error(`No scenario ${name}`)
  return scenario
}

describe('the reader flows (finalise and cancel) through the new routes, against the old functions', () => {
  let environment: ReplayEnvironment

  beforeAll(async () => {
    process.env.STAFF_API_KEY = 'test-staff-api-key'
    environment = await startReplay()
    holder.db = environment.database.db
  })
  afterAll(() => environment.stop())

  it('covers every golden file that writes a flow row, and only those', async () => {
    const { readdirSync, readFileSync } = await import('node:fs')
    const path = await import('node:path')
    const dir = path.join(__dirname, 'golden')
    const writing = readdirSync(dir)
      .filter((file) => file.endsWith('.json'))
      .filter((file) => {
        const recording = JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as Recording
        const table = recording.tables['pending_reader_payments'] as { added?: unknown[] } | undefined
        return (table?.added ?? []).length > 0
      })
      .map((file) => file.replace(/\.json$/, ''))
      .filter((name) => !name.startsWith('w12-'))
      .sort()
    expect(writing).toEqual([...FLOW_SCENARIOS].sort())
  })

  // W12's own scenarios: recorded from the old functions (UPDATE_GOLDEN=1), and the old functions still
  // match their recording, as replay.test.ts holds the shared scenarios to theirs.
  describe.each(W12_FLOW_SCENARIOS.map((scenario) => scenario.name))('%s (the old functions)', (name) => {
    it('the old functions match their recording', async () => {
      const recording = await replay(environment, byName(name), oldSide)
      if (process.env['UPDATE_GOLDEN']) writeGolden(recording)
      const golden = readGolden(name) as Recording
      expect(golden, `No golden file for ${name}`).not.toBeNull()
      expect(compareRecordings(golden, recording)).toEqual([])
    })
  })

  describe.each([...FLOW_SCENARIOS, ...W12_FLOW_SCENARIOS.map((scenario) => scenario.name)])('%s', (name) => {
    it('writes what the old functions wrote, in the same order, and answers the same', async () => {
      const golden = readGolden(name) as Recording
      expect(golden, `No golden file for ${name}`).not.toBeNull()
      const recording = await replay(environment, byName(name), newFlowSide())
      const compare = (r: Recording) => withRefsUnnumbered(withCanonicalGoneNumbers(r))
      expect(compareRecordings(compare(golden), compare(recording), flowDifferences())).toEqual([])
    })
  })
})
