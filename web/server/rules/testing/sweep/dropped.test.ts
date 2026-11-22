import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { staffAppDir } from '../staff-app-dir'
import { ID, seed } from '../replay/scenarios'
import { sweepDb } from './db-holder'
import { replay, startReplay, type ReplayEnvironment } from './run'
import { DROPPED } from './sweep'
import { workerSide } from './worker'

// W64 (H-plan 3.3 step 3): the decided behaviour of the step G scenarios dropped from the sweep because only the old
// code can run them (sweep.ts, DROPPED). The eighteen W05g / W05h money owed scenarios dropped beside them each name
// the rule test that holds their next step (W64a item 1), checked below.

vi.mock('@/server/db/connection', async () => {
  const { sweepDb: holder } = await import('./db-holder')
  return { openRequestDb: () => holder.db, closeRequestDb: () => {} }
})

const WORKER = path.resolve(__dirname, '../../../..')

/** The words sweep.ts gives a money owed scenario whose next step is the test named after it (its OWED_NEXT). */
const OWED_NEXT = 'bookings/money-owed-next-steps.test.ts, the test named after this scenario'

/**
 * Whether one line of `text` opens a test with `parts[0]` (`it('…` or `it("…`) and holds each later part after the one
 * before it, so a comment or a `describe` can't stand in for the test.
 */
function titleOnAnItLine(text: string, parts: readonly string[]): boolean {
  const [first, ...rest] = parts
  if (first === undefined) return false
  return text.split('\n').some((line) =>
    [`it('${first}`, `it("${first}`].some((opening) => {
      const start = line.indexOf(opening)
      if (start === -1) return false
      let at = start + opening.length
      for (const part of rest) {
        const found = line.indexOf(part, at)
        if (found === -1) return false
        at = found + part.length
      }
      return true
    })
  )
}

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
    // W64a item 6 (W64 review S5): its "who may" recording too, which only recorded the sweep's own words.
    expect(DROPPED['w48-generate-upcoming-sessions-who-may']).toMatch(/^GB24/)
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

  it('W64a item 1: each W05g / W05h money owed scenario names the rule test holding its next step, and that test is there', () => {
    const owed = Object.entries(DROPPED).filter(([, where]) => where.startsWith('W05g / W05h money owed'))
    expect(owed).toHaveLength(18)
    for (const [name, where] of owed) {
      const named = where.replace(/^W05g \/ W05h money owed \(set up on the old side\): /, '')
      const file = /^bookings\/[a-z-]+\.test\.ts/.exec(named)?.[0]
      expect(file, name).toBeDefined()
      const text = readFileSync(path.join(WORKER, 'server/rules', file as string), 'utf8')
      if (named === OWED_NEXT) {
        expect(text, name).toContain(`it('${name}: `)
        continue
      }
      // W64b (W64a check C2): any other entry quotes at least one title, and each is a test's own title: its first part
      // straight after `it('` or `it("`, then every later "…"-separated part, in order, on that same line.
      const titles = [...named.matchAll(/"([^"]+)"/g)].map(([, quoted]) => quoted ?? '')
      expect(titles, name).not.toHaveLength(0)
      for (const title of titles) {
        const parts = title.split('…').map((part) => part.trim()).filter((part) => part !== '')
        expect(parts[0]?.length ?? 0, `${name}: ${title}`).toBeGreaterThan(20)
        expect(titleOnAnItLine(text, parts), `${name}: ${title}`).toBe(true)
      }
    }
  })
})
