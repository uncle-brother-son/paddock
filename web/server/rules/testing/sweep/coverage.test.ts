import { readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { NAMED_BREACHES } from './named-breaches'
import { AS_THE_DIALOG_SENDS, ATTEMPTED, NEW_SIDE_CONFIRMS, REFUSED_PRESSES_AS_ANSWERS, REFUSED_READS_AS_ANSWERS, REPEATED_PRESS_SCENARIOS } from './press-forms'
import { WORKER_EXCEPTIONS, type InvariantException } from '../replay/invariants'
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
    // W65: the dropped scenarios went with the old side; DROPPED keeps only their names (dropped.test.ts).
    for (const name of Object.keys(DROPPED)) expect(names, name).not.toContain(name)
    expect(Object.keys(DROPPED)).toHaveLength(21)
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
    // W70a (L5): by what breaks the check, so a scenario with two payments on no order is two.
    expect(exceptionsListedFor(swept)).toHaveLength(25)
  })

  it('W70a (the W70 audit\'s L5): every exception names exactly what it lets through, the PaymentIntent with it, and why', () => {
    const of = (list: Readonly<Record<string, InvariantException>>) => Object.entries(list).flatMap(([name, one]) => one.breaches.map((breach) => [name, breach] as const))
    for (const [name, breach] of of(WORKER_EXCEPTIONS.chargesNotOnOneOrder)) expect(breach, name).toMatch(/^pi_fake_\d{4} is on 0 orders$/)
    for (const [name, breach] of of(WORKER_EXCEPTIONS.stripeRefundsNotOnRows)) expect(breach, name).toMatch(/^Stripe refunded £\d+\.\d{2} of pi_fake_\d{4}( and £\d+\.\d{2} of pi_fake_\d{4})*, the rows say £0$/)
    for (const [name, breach] of of(WORKER_EXCEPTIONS.cancelledWithoutAllTheMoney)) expect(breach, name).toMatch(/^cancelled with £\d+\.\d{2} back on £\d+\.\d{2} paid$/)
    for (const list of Object.values(WORKER_EXCEPTIONS)) {
      for (const [name, one] of Object.entries(list as Record<string, InvariantException>)) {
        expect(one.breaches.length, name).toBeGreaterThan(0)
        expect(one.why.length, name).toBeGreaterThan(20)
      }
    }
  })
})
