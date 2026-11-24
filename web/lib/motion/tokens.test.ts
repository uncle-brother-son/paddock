import { describe, expect, it } from 'vitest'

import { parseStylesheet, readGlobalsCss, ruleNamed } from '@/lib/design/read-stylesheet'
import tokens from '@/lib/design/figma-tokens.json'

import { DURATION_LONG, DURATION_SHORT, EASE_SMOOTH, EASE_SMOOTH_CSS } from './tokens'

// Brief W71, item 5 (WQ20-WQ23): the curve and the two durations are written twice, as constants for Motion
// (tokens.ts, seconds) and as CSS variables (app/globals.css, milliseconds). This fails when the two differ.

/** The three motion values a stylesheet declares, in Motion's units: the curve's four numbers, and seconds. */
function motionIn(theme: Record<string, string>): { ease: number[]; short: number; long: number } {
  const curve = /^cubic-bezier\(([^)]+)\)$/.exec(theme['--ease-smooth'] ?? '')
  const seconds = (name: string): number => {
    const match = /^(\d*\.?\d+)ms$/.exec(theme[name] ?? '')
    if (!match) throw new Error(`${name} is not a millisecond value: ${theme[name]}`)
    return Number(match[1]) / 1000
  }
  if (!curve) throw new Error(`--ease-smooth is not a cubic-bezier: ${theme['--ease-smooth']}`)
  return { ease: curve[1]!.split(',').map((part) => Number(part.trim())), short: seconds('--duration-short'), long: seconds('--duration-long') }
}

const constants = { ease: [...EASE_SMOOTH], short: DURATION_SHORT, long: DURATION_LONG }

describe('motion tokens: Motion and the stylesheet hold the same curve and durations (W71)', () => {
  const theme = ruleNamed(readGlobalsCss(), '@theme static').declarations

  it('the stylesheet and tokens.ts agree', () => {
    expect(motionIn(theme)).toEqual(constants)
  })

  it('both are the values Wayne chose: cubic-bezier(0, 0, 0.2, 1), 320 ms and 640 ms', () => {
    expect(theme['--ease-smooth']).toBe(tokens.motion['ease-smooth'])
    expect(tokens.motion['duration-short'].startsWith(`${theme['--duration-short']} `)).toBe(true)
    expect(tokens.motion['duration-long'].startsWith(`${theme['--duration-long']} `)).toBe(true)
    expect(constants).toEqual({ ease: [0, 0, 0.2, 1], short: 0.32, long: 0.64 })
    expect(EASE_SMOOTH_CSS).toBe(theme['--ease-smooth'])
  })

  it('a CSS transition with no duration or curve of its own takes the short duration and the smooth curve', () => {
    expect(theme['--default-transition-duration']).toBe('var(--duration-short)')
    expect(theme['--default-transition-timing-function']).toBe('var(--ease-smooth)')
  })

  it('the check sees each value changed on one side only', () => {
    const changed = (declaration: string): Record<string, string> => ({
      ...theme,
      ...ruleNamed(parseStylesheet(`@theme static { ${declaration} }`), '@theme static').declarations,
    })
    expect(motionIn(changed('--duration-short: 300ms;'))).not.toEqual(constants)
    expect(motionIn(changed('--duration-long: 667ms;'))).not.toEqual(constants)
    expect(motionIn(changed('--ease-smooth: cubic-bezier(0.4, 0, 0.2, 1);'))).not.toEqual(constants)
    expect(() => motionIn(changed('--duration-short: 0.32s;'))).toThrow('not a millisecond value')
  })
})
