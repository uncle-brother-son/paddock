import { describe, expect, it } from 'vitest'

import { parseStylesheet, readGlobalsCss, ruleNamed } from '@/lib/design/read-stylesheet'
import tokens from '@/lib/design/figma-tokens.json'

import { EASE_SMOOTH_POINTS, EASE_SMOOTH_SPRING } from './ease-smooth'
import { DURATION_LONG, DURATION_SHORT, EASE_SMOOTH, EASE_SMOOTH_CSS, INTRO_PAUSE, linearEasingPoints } from './tokens'

// Brief W71, item 5 (WQ20-WQ23), and W74c (WQ53, WQ55): the curve, the two durations and the intro's pause are
// written twice, as constants for Motion (tokens.ts, seconds) and as CSS variables (app/globals.css, milliseconds).
// This fails when the two differ. scripts/build-ease.test.ts holds the curve to the spring it is made from.

/** The motion values a stylesheet declares, in Motion's units: the curve's points, and seconds. */
function motionIn(theme: Record<string, string>): { ease: [number, number][]; short: number; long: number; pause: number } {
  const ease = linearEasingPoints(theme['--ease-smooth'] ?? '')
  const seconds = (name: string): number => {
    const match = /^(\d*\.?\d+)ms$/.exec(theme[name] ?? '')
    if (!match) throw new Error(`${name} is not a millisecond value: ${theme[name]}`)
    return Number(match[1]) / 1000
  }
  if (ease.length === 0) throw new Error(`--ease-smooth is not a linear() curve: ${theme['--ease-smooth']}`)
  return { ease, short: seconds('--duration-short'), long: seconds('--duration-long'), pause: seconds('--intro-pause') }
}

const constants = { ease: EASE_SMOOTH_POINTS.map(([progress, value]): [number, number] => [progress, value]), short: DURATION_SHORT, long: DURATION_LONG, pause: INTRO_PAUSE }

describe('motion tokens: Motion and the stylesheet hold the same curve and durations (W71, W74c)', () => {
  const theme = ruleNamed(readGlobalsCss(), '@theme static').declarations

  it('the stylesheet and tokens.ts agree', () => {
    expect(motionIn(theme)).toEqual(constants)
    expect(theme['--ease-smooth']).toBe(EASE_SMOOTH_CSS)
  })

  it("both are the values Wayne chose: Figma's Slow spring (WQ55), 320 ms and 640 ms, and the intro's 480 ms pause (WQ53)", () => {
    expect(tokens.motion['ease-smooth-spring']).toEqual({ preset: 'SLOW', mass: EASE_SMOOTH_SPRING.mass, stiffness: EASE_SMOOTH_SPRING.stiffness, damping: EASE_SMOOTH_SPRING.damping })
    expect(tokens.motion['duration-short'].startsWith(`${theme['--duration-short']} `)).toBe(true)
    expect(tokens.motion['duration-long'].startsWith(`${theme['--duration-long']} `)).toBe(true)
    expect(tokens.motion['intro-pause'].startsWith(`${theme['--intro-pause']} `)).toBe(true)
    expect({ short: constants.short, long: constants.long, pause: constants.pause }).toEqual({ short: 0.32, long: 0.64, pause: 0.48 })
  })

  it('Motion is given the curve through the same points as CSS draws', () => {
    for (const [progress, value] of EASE_SMOOTH_POINTS) expect(EASE_SMOOTH(progress)).toBeCloseTo(value, 10)
    // Half way between two points it is half way between their values: straight pieces, as `linear(...)` draws them.
    const [first, second] = [EASE_SMOOTH_POINTS[5]!, EASE_SMOOTH_POINTS[6]!]
    expect(EASE_SMOOTH((first[0] + second[0]) / 2)).toBeCloseTo((first[1] + second[1]) / 2, 10)
  })

  it('a CSS transition with no duration or curve of its own takes the short duration and the smooth curve', () => {
    expect(theme['--default-transition-duration']).toBe('var(--duration-short)')
    expect(theme['--default-transition-timing-function']).toBe('var(--ease-smooth)')
  })

  it('a curve is read the same as the tokens write it and as a browser reports it', () => {
    expect(linearEasingPoints('linear(0, 0.25 10%, 0.9 55.5%, 1)')).toEqual([[0, 0], [0.1, 0.25], [0.555, 0.9], [1, 1]])
    expect(linearEasingPoints('linear(0 0%, 0.25 10%, 0.9 55.5%, 1 100%)')).toEqual([[0, 0], [0.1, 0.25], [0.555, 0.9], [1, 1]])
    expect(linearEasingPoints('ease')).toEqual([])
  })

  it('the check sees each value changed on one side only', () => {
    const changed = (declaration: string): Record<string, string> => ({
      ...theme,
      ...ruleNamed(parseStylesheet(`@theme static { ${declaration} }`), '@theme static').declarations,
    })
    expect(motionIn(changed('--duration-short: 300ms;'))).not.toEqual(constants)
    expect(motionIn(changed('--duration-long: 667ms;'))).not.toEqual(constants)
    expect(motionIn(changed('--intro-pause: 400ms;'))).not.toEqual(constants)
    expect(motionIn(changed(`--ease-smooth: ${EASE_SMOOTH_CSS.replace(/, 1\)$/, ', 0.9999 99%, 1)')};`))).not.toEqual(constants)
    expect(() => motionIn(changed('--ease-smooth: ease-out;'))).toThrow('not a linear() curve')
    expect(() => motionIn(changed('--duration-short: 0.32s;'))).toThrow('not a millisecond value')
  })
})
