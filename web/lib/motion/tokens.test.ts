import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { parseStylesheet, readGlobalsCss, ruleNamed } from '@/lib/design/read-stylesheet'
import tokens from '@/lib/design/figma-tokens.json'

import { DURATION_LONG, DURATION_SHORT, EASE_SMOOTH, EASE_SMOOTH_BEZIER, EASE_SMOOTH_CSS, INTRO_PAUSE } from './tokens'

// Brief W71, item 5 (WQ20-WQ23), W74c (WQ53) and WQ88 (Wayne, 27 Nov): the curve, the two durations and the intro's
// pause are written twice, as constants for Motion (tokens.ts, seconds) and as CSS variables (app/globals.css,
// milliseconds). This fails when the two differ.

const WEB = path.resolve(__dirname, '../..')

/** The four numbers of a `cubic-bezier(...)` value, as the stylesheet writes it and as a browser reports it. */
function bezierOf(easing: string): number[] {
  const inside = /^cubic-bezier\(([^)]*)\)$/.exec(easing.trim())?.[1]
  if (inside === undefined) throw new Error(`--ease-smooth is not a cubic-bezier curve: ${easing}`)
  return inside.split(',').map((number) => Number(number.trim()))
}

/** The motion values a stylesheet declares, in Motion's units: the curve's four numbers, and seconds. */
function motionIn(theme: Record<string, string>): { ease: number[]; short: number; long: number; pause: number } {
  const seconds = (name: string): number => {
    const match = /^(\d*\.?\d+)ms$/.exec(theme[name] ?? '')
    if (!match) throw new Error(`${name} is not a millisecond value: ${theme[name]}`)
    return Number(match[1]) / 1000
  }
  return { ease: bezierOf(theme['--ease-smooth'] ?? ''), short: seconds('--duration-short'), long: seconds('--duration-long'), pause: seconds('--intro-pause') }
}

const constants = { ease: [...EASE_SMOOTH_BEZIER], short: DURATION_SHORT, long: DURATION_LONG, pause: INTRO_PAUSE }

describe('motion tokens: Motion and the stylesheet hold the same curve and durations (W71, W74c, WQ88)', () => {
  const theme = ruleNamed(readGlobalsCss(), '@theme static').declarations

  it('the stylesheet and tokens.ts agree', () => {
    expect(motionIn(theme)).toEqual(constants)
    expect(theme['--ease-smooth']).toBe(EASE_SMOOTH_CSS)
  })

  it("both are the values Wayne chose: the one bezier (WQ88), 320 ms and 640 ms, and the intro's 480 ms pause (WQ53)", () => {
    expect(constants.ease).toEqual([0.22, 1, 0.36, 1])
    expect(tokens.motion['ease-smooth'].startsWith(`${EASE_SMOOTH_CSS} `)).toBe(true)
    expect(tokens.motion['duration-short'].startsWith(`${theme['--duration-short']} `)).toBe(true)
    expect(tokens.motion['duration-long'].startsWith(`${theme['--duration-long']} `)).toBe(true)
    expect(tokens.motion['intro-pause'].startsWith(`${theme['--intro-pause']} `)).toBe(true)
    expect({ short: constants.short, long: constants.long, pause: constants.pause }).toEqual({ short: 0.32, long: 0.64, pause: 0.48 })
  })

  it('Motion is given the same curve as CSS draws: the bezier itself, worked out for a moment of the time', () => {
    const [x1, y1, x2, y2] = EASE_SMOOTH_BEZIER
    // The bezier as it is defined, by how far along the curve: its time and its movement there.
    const at = (t: number, first: number, second: number) => 3 * (1 - t) ** 2 * t * first + 3 * (1 - t) * t ** 2 * second + t ** 3
    for (let step = 0; step <= 100; step += 1) {
      const t = step / 100
      expect(EASE_SMOOTH(at(t, x1, x2)), `at ${t} along the curve`).toBeCloseTo(at(t, y1, y2), 5)
    }
    expect([EASE_SMOOTH(0), EASE_SMOOTH(1), EASE_SMOOTH(-0.5), EASE_SMOOTH(1.5)]).toEqual([0, 1, 0, 1])
    // Off at once and fast, then a long settling: half-way well before a fifth of the time, and never past the end.
    expect(EASE_SMOOTH(0.2)).toBeGreaterThan(0.5)
    const samples = Array.from({ length: 201 }, (_, index) => EASE_SMOOTH(index / 200))
    expect(samples.every((value, index) => value <= 1 && (index === 0 || value >= samples[index - 1]!))).toBe(true)
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
    expect(motionIn(changed('--intro-pause: 400ms;'))).not.toEqual(constants)
    expect(motionIn(changed(`--ease-smooth: ${EASE_SMOOTH_CSS.replace(/1\)$/, '0.99)')};`))).not.toEqual(constants)
    expect(() => motionIn(changed('--ease-smooth: ease-out;'))).toThrow('not a cubic-bezier curve')
    expect(() => motionIn(changed('--ease-smooth: linear(0, 0.5 20%, 1);'))).toThrow('not a cubic-bezier curve')
    expect(() => motionIn(changed('--duration-short: 0.32s;'))).toThrow('not a millisecond value')
  })
})

describe("WQ88: the spring is gone, and the bezier's numbers are written in two places only", () => {
  const SOURCE_FILE = /\.(ts|tsx|js|jsx|mjs|css|mdx|json)$/
  const filesUnder = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) return filesUnder(full)
      return SOURCE_FILE.test(name) ? [path.relative(WEB, full).split(path.sep).join('/')] : []
    })
  const files = ['app', 'components', 'lib', 'scripts', '.storybook'].flatMap((folder) => filesUnder(path.join(WEB, folder)))
  const read = (file: string) => readFileSync(path.join(WEB, file), 'utf8')

  it('the numbers are in the stylesheet\'s token and in tokens.ts, and nowhere else in the site', () => {
    // Written out as CSS, or as Motion takes four numbers; a test may say what it expects.
    const written = /cubic-bezier\(\s*0?\.22|\[\s*0?\.22\s*,\s*1\s*,\s*0?\.36\s*,\s*1\s*\]/
    const holders = files.filter((file) => !file.endsWith('.test.ts') && file !== 'lib/design/figma-tokens.json' && written.test(read(file)))
    expect(holders.sort()).toEqual(['app/globals.css', 'lib/motion/tokens.ts'])
    expect(read('app/globals.css').match(/cubic-bezier\(/g)).toHaveLength(1)
  })

  it('no curve of straight pieces is left, and nothing reads the spring or its build', () => {
    for (const file of files.filter((one) => !one.endsWith('.test.ts'))) {
      const text = read(file)
      expect(text, file).not.toMatch(/(?<![A-Za-z0-9.-])linear\(/)
      expect(text, file).not.toMatch(/EASE_SMOOTH_POINTS|EASE_SMOOTH_SPRING|EASE_SMOOTH_SECONDS|linearEasingPoints|\/ease-smooth['"]|build-ease|ease:build/)
    }
    expect(read('package.json')).not.toContain('ease:build')
    for (const gone of ['scripts/build-ease.mjs', 'scripts/build-ease.test.ts', 'lib/motion/ease-smooth.ts']) expect(existsSync(path.join(WEB, gone)), gone).toBe(false)
  })

  it('Motion, Lenis and every script that moves something take the curve from tokens.ts', () => {
    expect(read('components/providers/MotionProviders.tsx')).toContain('transition={{ duration: DURATION_SHORT, ease: EASE_SMOOTH }}')
    for (const file of ['components/frame/PageTransition.tsx', 'components/ui/SectionLink.tsx', 'components/modules/content/GalleryCarousel.tsx']) {
      expect(read(file), file).toMatch(/import \{[^}]*\bEASE_SMOOTH\b[^}]*\} from '@\/lib\/motion\/tokens'/)
    }
  })
})
