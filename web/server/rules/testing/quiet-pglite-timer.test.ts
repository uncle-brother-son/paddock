import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { isPgliteTimerWarning, quietPgliteTimer } from './quiet-pglite-timer'

// W59 (W45 audit row 56): only PGlite's own timer warning is kept out of the logs; everything else still prints.
const warning = (name: string, stack: string): Error => Object.assign(new Error('41130010000 does not fit into a 32-bit signed integer.'), { name, stack })
const PGLITE_STACK = 'TimeoutOverflowWarning: …\n    at setTimeout (node:timers:135:19)\n    at __setitimer_js (file:///x/node_modules/@electric-sql/pglite/dist/chunk-O74Z5DUS.js:3:3510)'

describe("the test set-up's warning filter", () => {
  it("PGlite's timer warning is the one recognised", () => {
    expect(isPgliteTimerWarning(warning('TimeoutOverflowWarning', PGLITE_STACK))).toBe(true)
    expect(isPgliteTimerWarning(warning('TimeoutOverflowWarning', 'at setTimeout (node:timers)\n    at ours (server/db/client.ts:91:13)'))).toBe(false)
    expect(isPgliteTimerWarning(warning('DeprecationWarning', PGLITE_STACK))).toBe(false)
  })

  it('the printers still get every other warning, and not that one', () => {
    const target = new EventEmitter() as unknown as NodeJS.Process
    const printed: string[] = []
    target.on('warning', (seen: Error) => printed.push(seen.name))
    quietPgliteTimer(target)
    target.emit('warning', warning('TimeoutOverflowWarning', PGLITE_STACK))
    target.emit('warning', warning('TimeoutOverflowWarning', 'at setTimeout\n    at somewhere/else.ts'))
    target.emit('warning', warning('DeprecationWarning', 'at somewhere'))
    expect(printed).toEqual(['TimeoutOverflowWarning', 'DeprecationWarning'])
  })
})
