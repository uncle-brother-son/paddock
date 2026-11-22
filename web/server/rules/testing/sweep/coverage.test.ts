import { readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { NAMED_BREACHES } from './named-breaches'
import { AS_THE_DIALOG_SENDS, ATTEMPTED, NEW_SIDE_CONFIRMS, REFUSED_PRESSES_AS_ANSWERS, REFUSED_READS_AS_ANSWERS, REPEATED_PRESS_SCENARIOS, TOLD_AGAIN } from './press-forms'
import { WORKER_EXCEPTIONS } from '../replay/invariants'
import { DROPPED, exceptionsListedFor, SWEEP_FILES, SWEEP_SCENARIOS } from './sweep'

// W64 (H-plan 3.3 step 3): the sweep's own bookkeeping. Every scenario runs in exactly one sweep file, or is dropped
// with a reason; every recording kept is a scenario's; every name the press forms and the named breaches give is a
// scenario's (a name that no longer is would hide nothing and say nothing).

const names = SWEEP_SCENARIOS.map((scenario) => scenario.name)
const recordings = readdirSync(path.join(__dirname, '..', 'recordings')).map((file) => file.replace(/\.json$/, ''))

describe('the sweep covers every scenario once (W64)', () => {
  it('no two scenarios share a name', () => {
    expect(new Set(names).size).toBe(names.length)
  })

  it('every scenario is in exactly one sweep file, or dropped with a reason; every file has a test file of its own', () => {
    for (const name of names) {
      const files = Object.entries(SWEEP_FILES).filter(([, holds]) => holds(name)).map(([file]) => file)
      expect(files, name).toHaveLength(1)
    }
    for (const name of Object.keys(DROPPED)) expect(names, name).toContain(name)
    const testFiles = readdirSync(__dirname).filter((file) => /^sweep-.*\.test\.ts$/.test(file)).map((file) => file.replace(/^sweep-|\.test\.ts$/g, ''))
    expect(testFiles.sort()).toEqual(Object.keys(SWEEP_FILES).sort())
  })

  it('a recording is kept for every scenario swept, and for nothing else', () => {
    expect(recordings.sort()).toEqual(names.filter((name) => !(name in DROPPED)).sort())
  })

  it('every name in the press forms and the named breaches is a scenario of the sweep', () => {
    const named = [
      ...Object.keys(NEW_SIDE_CONFIRMS),
      ...REPEATED_PRESS_SCENARIOS,
      ...REFUSED_READS_AS_ANSWERS,
      ...REFUSED_PRESSES_AS_ANSWERS,
      ...Object.keys(TOLD_AGAIN),
      ...Object.keys(AS_THE_DIALOG_SENDS),
      ...ATTEMPTED,
      ...Object.keys(NAMED_BREACHES),
    ]
    for (const name of named) expect(names, name).toContain(name)
  })

  it("W64a item 4: every W05 exception the Worker's lists give is a swept scenario's, so its sweep file's exact check sees it", () => {
    const swept = names.filter((name) => !(name in DROPPED))
    const listed = [WORKER_EXCEPTIONS.stripeRefundsNotOnRows, WORKER_EXCEPTIONS.cancelledWithoutAllTheMoney, WORKER_EXCEPTIONS.chargesNotOnOneOrder].flatMap((list) => Object.keys(list))
    expect(listed).toHaveLength(4 + 4 + 16)
    for (const name of listed) expect(swept, name).toContain(name)
    expect(exceptionsListedFor(swept)).toHaveLength(24)
  })
})
