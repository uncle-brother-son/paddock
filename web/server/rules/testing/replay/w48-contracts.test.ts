import { writeFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ADMIN_CONTRACTS, type AdminFunctionName } from '@/contracts'
import { LEGACY_ADMIN_ACTIONS, oldSide, replay, startReplay, type ReplayEnvironment, type ReplaySide } from './harness'
import { w48Scenarios } from './w48-scenarios'

// Brief W48 item 1: contracts/admin.ts held to what the 82 old step G functions take and give. Every one of the 271
// step G scenarios is run once more through the frozen copy, and each call of a step G function is checked: its
// params against the function's input contract, its answer against the output contract, and every field of the
// answer against the fields the contract names, so a field a screen reads today can't be missing from a route built
// on it. Each difference is named below, with why.

vi.setConfig({ testTimeout: 120_000 })

interface Call {
  scenario: string
  action: string
  params: unknown
  /** The answer as the route would send it (JSON). Missing when the old function threw: only its params are checked then. */
  answer?: unknown
  threw: boolean
}

/**
 * Calls whose params a route built on the contract would answer with a validation error, where the old function
 * answered in its own words: the scenario sends the wrong kind of value on purpose (a word for a switch, a number for
 * a time, text for a list). Each slice decides whether its route keeps the old words for these (W48 report, "Noticed").
 */
const WRONG_KIND_SENT: ReadonlyArray<[scenario: string, action: string, field: string]> = [
  ['w48-plan-create-refusals', 'createMembershipPlan', 'isUnlimited'],
  ['w48-session-start-time-refusals', 'setSessionStartTime', 'startTime'],
  ['w48-event-check-in-many', 'setEventAttendeesCheckIn', 'attendeeIds'],
  ['w48-band-rules-refusals', 'setBandRules', 'rules'],
  ['w48-membership-settings-refusals', 'setMembershipSettings', 'addonCreditWaitMonths'],
]

/**
 * Fields an old answer carries that the contract leaves out, by function: columns the old read took with `SELECT *`
 * (or `RETURNING *`) and never named in its own type, so no screen's type has them (G-plan 4.2: named columns).
 */
const LEFT_OUT: Readonly<Record<string, readonly string[]>> = {
  // The function's own working columns, spread into its answer beside the two summaries it builds from them. No
  // screen's type has them.
  getOrderLineItems: ['[].addon_card_refunded', '[].addon_credits_returned', '[].addon_refunded', '[].addon_removed_count'],
}

const fieldsOf = (value: unknown, path = ''): string[] => {
  if (Array.isArray(value)) return [...new Set(value.flatMap((item) => fieldsOf(item, `${path}[]`)))]
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) return Object.entries(value).flatMap(([key, item]) => [`${path}.${key}`, ...fieldsOf(item, `${path}.${key}`)])
  return []
}

describe("contracts/admin.ts against the old step G functions' own calls (brief W48 item 1)", () => {
  let environment: ReplayEnvironment
  const calls: Call[] = []

  beforeAll(async () => {
    environment = await startReplay()
    for (const scenario of w48Scenarios()) {
      const recording = (db: Parameters<typeof oldSide>[0], stripe: Parameters<typeof oldSide>[1]): ReplaySide => {
        const old = oldSide(db, stripe)
        return {
          name: old.name,
          async call(action, params) {
            try {
              const answer = await old.call(action, params)
              // As the route would send it: JSON, so a moment is ISO text and an undefined field is gone.
              calls.push({ scenario: scenario.name, action, params, answer: JSON.parse(JSON.stringify(answer ?? null)) as unknown, threw: false })
              return answer
            } catch (err) {
              calls.push({ scenario: scenario.name, action, params, threw: true })
              throw err
            }
          },
        }
      }
      await replay(environment, scenario, recording)
    }
  })
  afterAll(() => environment.stop())

  const adminCalls = () => calls.filter((call) => LEGACY_ADMIN_ACTIONS.has(call.action))
  /** The calls that were answered (not thrown): the ones whose answer there is to check. */
  const answered = () => adminCalls().filter((call) => !call.threw)

  it('has a pair of contracts for each of the 82 functions, and the scenarios call every one of them', () => {
    expect(Object.keys(ADMIN_CONTRACTS).sort()).toEqual([...LEGACY_ADMIN_ACTIONS].sort())
    const called = new Set(adminCalls().map((call) => call.action))
    expect([...LEGACY_ADMIN_ACTIONS].filter((action) => !called.has(action))).toEqual([])
    // 774 calls of a step G function in all (the rest are set-up through the older copies' functions).
    expect(adminCalls()).toHaveLength(774)
  })

  it("every answer an old function gave fits its output contract", () => {
    const problems: string[] = []
    for (const call of answered()) {
      const parsed = ADMIN_CONTRACTS[call.action as AdminFunctionName].output.safeParse(call.answer)
      if (!parsed.success) problems.push(`${call.scenario} ${call.action}: ${parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`)
    }
    if (process.env.W48_CONTRACT_PROBLEMS_OUT) writeFileSync(process.env.W48_CONTRACT_PROBLEMS_OUT, `${[...new Set(problems.map((problem) => problem.replace(/^\S+ /, '').replace(/\d+\./g, 'N.')))].sort().join('\n')}\n`)
    expect(problems).toEqual([])
  })

  it('every field of an old answer is a field of the contract, but for the columns named as left out', () => {
    const extra = new Map<string, Set<string>>()
    for (const call of answered()) {
      const parsed = ADMIN_CONTRACTS[call.action as AdminFunctionName].output.safeParse(call.answer)
      if (!parsed.success) continue
      const kept = new Set(fieldsOf(parsed.data))
      for (const field of fieldsOf(call.answer)) {
        if (!kept.has(field)) extra.set(call.action, (extra.get(call.action) ?? new Set()).add(field))
      }
    }
    const found = Object.fromEntries([...extra].sort(([a], [b]) => a.localeCompare(b)).map(([action, fields]) => [action, [...fields].sort()]))
    if (process.env.W48_CONTRACT_LEFT_OUT) writeFileSync(process.env.W48_CONTRACT_LEFT_OUT, `${JSON.stringify(found, null, 2)}\n`)
    expect(found).toEqual(LEFT_OUT)
  })

  it("every call's params fit its input contract, but for the calls that send the wrong kind of value on purpose", () => {
    const refused: string[] = []
    for (const call of adminCalls()) {
      const parsed = ADMIN_CONTRACTS[call.action as AdminFunctionName].input.safeParse(JSON.parse(JSON.stringify(call.params ?? {})))
      if (!parsed.success) refused.push(...parsed.error.issues.map((issue) => `${call.scenario} ${call.action} ${String(issue.path[0])}`))
    }
    expect([...new Set(refused)].sort()).toEqual(WRONG_KIND_SENT.map(([scenario, action, field]) => `${scenario} ${action} ${field}`).sort())
  })
})
