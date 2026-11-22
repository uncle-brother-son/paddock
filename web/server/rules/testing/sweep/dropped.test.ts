import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { staffAppDir } from '../staff-app-dir'
import { ID, seed } from '../replay/scenarios'
import { sweepDb } from './db-holder'
import { replay, startReplay, type ReplayEnvironment } from './run'
import { DROPPED } from './sweep'
import { workerSide } from './worker'

// W64 (H-plan 3.3 step 3): the decided behaviour of the two step G scenarios dropped from the sweep because only the old
// code can run them (sweep.ts, DROPPED). The eighteen W05g / W05h money owed scenarios dropped beside them are named in
// the W64 report with the rule tests that hold each step.

vi.mock('@/server/db/connection', async () => {
  const { sweepDb: holder } = await import('./db-holder')
  return { openRequestDb: () => holder.db, closeRequestDb: () => {} }
})

const WORKER = path.resolve(__dirname, '../../../..')

describe('the scenarios dropped from the sweep, held here (W64)', () => {
  let environment: ReplayEnvironment
  beforeAll(async () => {
    process.env.STAFF_API_KEY = 'test-staff-api-key'
    environment = await startReplay()
    sweepDb.db = environment.database.db
  })
  afterAll(() => environment.stop())

  it('GB24 (W51): generateUpcomingSessions is gone from the staff app and no route answers for it; the nightly job alone makes sessions', () => {
    expect(DROPPED['w48-gb24-generate-upcoming-sessions-is-dead-code-that-still-runs']).toMatch(/^GB24/)
    expect(existsSync(path.join(staffAppDir(), 'backend/paddock/generateUpcomingSessions.ts'))).toBe(false)
    expect(existsSync(path.join(WORKER, 'app/api/v1/staff/sessions/generate'))).toBe(false)
    const schema = readFileSync(path.join(WORKER, 'server/rules/testing/live-schema.sql'), 'utf8')
    expect(schema).toContain('FUNCTION public.generate_upcoming_sessions(horizon_days integer DEFAULT 98)')
  })

  it('GB15 (W61): no legacy /api/catalog route is left in the app, and the Worker refuses an inactive account the same change (every route checks the staff member first, GB14)', async () => {
    expect(DROPPED['w48-gb15-the-legacy-route-takes-the-shared-key-and-asks-no-staff-member']).toMatch(/^GB15/)
    expect(existsSync(path.join(WORKER, 'app/api/catalog'))).toBe(false)
    const answers: unknown[] = []
    await replay(
      environment,
      {
        name: 'gb15 on the Worker',
        async seed(db, stripe) {
          await seed(db, stripe)
          await db.query('UPDATE staff SET active = false WHERE id = $1', [ID.staff])
        },
        async run({ attempt, db }) {
          answers.push(await attempt('setProductActive', { productId: ID.product, active: false }))
          answers.push((await db.query<{ active: boolean }>('SELECT active FROM products WHERE id = $1', [ID.product]))[0]?.active)
        },
      },
      workerSide()
    )
    expect(answers[0]).toEqual({ thrown: expect.stringMatching(/inactive|not active/i) })
    // The product is still on sale: nothing was changed by the refused press.
    expect(answers[1]).toBe(true)
  })
})
