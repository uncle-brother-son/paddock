import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { EASE_SMOOTH_CSS, EASE_SMOOTH_POINTS, EASE_SMOOTH_SPRING } from '@/lib/motion/ease-smooth'
import { EASE_SMOOTH, linearEasingPoints } from '@/lib/motion/tokens'

import { buildEase, linearEasing, smoothAt, smoothPoints, SPRING, springAt, TOLERANCE } from './build-ease.mjs'

// Brief W74c, item 1 (WQ55): the site's one curve is Figma's "Slow" spring, fitted to the duration of whatever it
// animates, written for CSS as `linear(...)` by scripts/build-ease.mjs.

const WEB = path.resolve(__dirname, '..')

/** Every thousandth of the duration, and the moments between them. */
const MOMENTS = Array.from({ length: 2001 }, (_, step) => step / 2000)

describe('the smooth curve is made from the spring (npm run ease:build)', () => {
  it('the files it is written to are what the script makes today', () => {
    const made = buildEase(WEB) as Record<string, string>
    expect(Object.keys(made).sort()).toEqual(['app/globals.css', 'lib/motion/ease-smooth.ts'])
    for (const [file, text] of Object.entries(made)) expect(readFileSync(path.join(WEB, file), 'utf8') === text, `${file} is behind: npm run ease:build`).toBe(true)
  })

  it("the spring is Figma's Slow: mass 1, stiffness 80, damping 20, and Figma's own time for it", () => {
    expect(SPRING).toEqual({ name: 'SLOW', mass: 1, stiffness: 80, damping: 20, seconds: 1.3334881067276 })
    expect(EASE_SMOOTH_SPRING).toEqual({ mass: 1, stiffness: 80, damping: 20, seconds: 1.3334881067276 })
    // Figma's time is the moment the spring is within a thousandth of its target.
    expect(1 - springAt(SPRING, SPRING.seconds)).toBeGreaterThan(0.0009)
    expect(1 - springAt(SPRING, SPRING.seconds)).toBeLessThan(0.0011)
  })

  it('the spring itself starts at rest at 0, only ever moves towards 1, and never passes it', () => {
    expect(springAt(SPRING, 0)).toBe(0)
    let before = 0
    // Over three seconds, more than twice Figma's time for it, every thousandth of a second is further on.
    for (let step = 1; step <= 3000; step += 1) {
      const now = springAt(SPRING, step / 1000)
      expect(now).toBeGreaterThan(before)
      expect(now).toBeLessThan(1)
      before = now
    }
    // And long after (where the sums run out of digits) it has still not passed 1 nor gone back.
    for (const seconds of [5, 10, 60, 600]) {
      const now = springAt(SPRING, seconds)
      expect(now).toBeGreaterThanOrEqual(before)
      expect(now).toBeLessThanOrEqual(1)
      before = now
    }
  })

  it('a spring that would bounce is refused', () => {
    expect(() => springAt({ name: 'BOUNCY', mass: 1, stiffness: 600, damping: 15 }, 0.1)).toThrow('would bounce')
    expect(() => springAt({ name: 'CRITICAL', mass: 1, stiffness: 100, damping: 20 }, 0.1)).toThrow('would bounce')
  })
})

describe('the curve the site uses', () => {
  const points = linearEasingPoints(EASE_SMOOTH_CSS)

  it('the CSS curve, the points Motion reads and the script agree', () => {
    expect(EASE_SMOOTH_CSS).toBe(linearEasing(smoothPoints()))
    expect(points).toEqual(EASE_SMOOTH_POINTS.map(([progress, value]) => [progress, value]))
    expect(points).toEqual(smoothPoints())
  })

  it('starts at 0 and ends at 1', () => {
    expect(points[0]).toEqual([0, 0])
    expect(points.at(-1)).toEqual([1, 1])
    expect([EASE_SMOOTH(0), EASE_SMOOTH(1), EASE_SMOOTH(-0.5), EASE_SMOOTH(1.5)]).toEqual([0, 1, 0, 1])
  })

  it('never goes back and never overshoots: every point is later and further than the one before, none past 1', () => {
    for (let index = 1; index < points.length; index += 1) {
      expect(points[index]![0]).toBeGreaterThan(points[index - 1]![0])
      expect(points[index]![1]).toBeGreaterThan(points[index - 1]![1])
      expect(points[index]![1]).toBeLessThanOrEqual(1)
    }
    let before = 0
    for (const moment of MOMENTS) {
      const now = EASE_SMOOTH(moment)
      expect(now).toBeGreaterThanOrEqual(before)
      expect(now).toBeLessThanOrEqual(1)
      before = now
    }
  })

  it('matches the spring within 1% at every moment (it is made to stay within 0.2%)', () => {
    // The spring as it is over Figma's time for it, which the animation's own duration stands in for.
    const furthest = Math.max(...MOMENTS.map((moment) => Math.abs(EASE_SMOOTH(moment) - springAt(SPRING, moment * SPRING.seconds))))
    expect(furthest).toBeLessThan(0.01)
    expect(furthest).toBeLessThan(0.0022)
    // And within the tolerance of the same spring brought to end on 1 exactly.
    const fromFitted = Math.max(...MOMENTS.map((moment) => Math.abs(EASE_SMOOTH(moment) - smoothAt(moment))))
    expect(fromFitted).toBeLessThanOrEqual(TOLERANCE + 0.0001)
  })

  it('has enough points to be smooth, and no more than it needs: between 20 and 40', () => {
    expect(points.length).toBeGreaterThanOrEqual(20)
    expect(points.length).toBeLessThanOrEqual(40)
  })

  it('the check sees a curve that is not the spring', () => {
    // The old curve, cubic-bezier(0, 0, 0.2, 1), sampled: it strays from the spring by far more than 1%.
    const old = (progress: number) => {
      let low = 0
      let high = 1
      for (let turn = 0; turn < 40; turn += 1) {
        const middle = (low + high) / 2
        const x = 3 * (1 - middle) * middle * middle * 0.2 + middle * middle * middle
        if (x < progress) low = middle
        else high = middle
      }
      return 3 * (1 - low) * low * low + low * low * low
    }
    expect(Math.max(...MOMENTS.map((moment) => Math.abs(old(moment) - smoothAt(moment))))).toBeGreaterThan(0.05)
  })
})

describe('no other curve is left in the code (W74c)', () => {
  const FOLDERS = ['app', 'components', 'features', 'lib', 'scripts', '.storybook']
  const SOURCE_FILE = /\.(ts|tsx|js|jsx|mjs|css|mdx|json)$/
  // The tests that hold the rule name what they look for.
  const TESTS_OF_THE_RULE = ['scripts/build-ease.test.ts', 'lib/motion/typed-in-motion.test.ts']

  const filesUnder = (folder: string): string[] => {
    let names: string[]
    try {
      names = readdirSync(path.join(WEB, folder))
    } catch {
      return []
    }
    return names.flatMap((name) => {
      const file = `${folder}/${name}`
      if (statSync(path.join(WEB, file)).isDirectory()) return filesUnder(file)
      return SOURCE_FILE.test(name) ? [file] : []
    })
  }

  it('no cubic-bezier anywhere in the site, its tokens, its scripts or its stories', () => {
    const files = FOLDERS.flatMap(filesUnder).filter((file) => !TESTS_OF_THE_RULE.includes(file))
    expect(files.length).toBeGreaterThan(100)
    expect(files).toContain('app/globals.css')
    expect(files).toContain('lib/motion/tokens.ts')
    expect(files).toContain('lib/design/figma-tokens.json')
    expect(files.filter((file) => /cubic-bezier/i.test(readFileSync(path.join(WEB, file), 'utf8')))).toEqual([])
  })

  it('the stylesheet has one curve: the token, used by name everywhere else', () => {
    const css = readFileSync(path.join(WEB, 'app/globals.css'), 'utf8')
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(rules.match(/linear\(/g)).toHaveLength(1)
    expect(css).toContain(`  --ease-smooth: ${EASE_SMOOTH_CSS};`)
    expect(css).not.toMatch(/\b(ease-in|ease-out|ease-in-out|steps\()/)
  })
})
