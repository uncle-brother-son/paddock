// Motion tokens (WQ20-WQ23, WQ53, WQ88): one curve and two durations for the whole site. These are the values Motion
// and script read, in seconds; app/globals.css holds the same as CSS variables (--ease-smooth, --duration-short,
// --duration-long, --intro-pause) and tokens.test.ts fails when the two differ. No animation uses its own curve or a
// typed-in duration: typed-in-motion.test.ts looks for one under app/, components/ and features/.

/**
 * The "smooth" curve's four numbers (WQ88, Wayne, 27 Nov: it replaces the spring of WQ55 and WQ56): the bezier
 * `cubic-bezier(x1, y1, x2, y2)`. Off at once and fast, then a long, soft settling; it never passes its target.
 * This is the one place they are written for Motion and script; the stylesheet's `--ease-smooth` is the other, and
 * tokens.test.ts holds the two together.
 */
export const EASE_SMOOTH_BEZIER = [0.22, 1, 0.36, 1] as const

/** The same curve as CSS writes it: the value of `--ease-smooth`, and what a browser reports for it. */
export const EASE_SMOOTH_CSS = `cubic-bezier(${EASE_SMOOTH_BEZIER.join(', ')})`

/**
 * One coordinate of the bezier at `t` along it (0 to 1), from its two control values: the curve runs from 0 to 1,
 * so it is `a t^3 + b t^2 + c t`. `slope`: how fast that coordinate is changing there.
 */
function bezierPart(first: number, second: number) {
  const c = 3 * first
  const b = 3 * (second - first) - c
  const a = 1 - c - b
  return { at: (t: number) => ((a * t + b) * t + c) * t, slope: (t: number) => (3 * a * t + 2 * b) * t + c }
}

const TIME = bezierPart(EASE_SMOOTH_BEZIER[0], EASE_SMOOTH_BEZIER[2])
const MOVEMENT = bezierPart(EASE_SMOOTH_BEZIER[1], EASE_SMOOTH_BEZIER[3])

/**
 * The "smooth" curve: every animation uses it. As Motion (and Lenis) take an ease: how far along the movement is
 * (0 to 1) at `progress` through the time (0 to 1). It is the same bezier CSS draws from `--ease-smooth`, worked out
 * as a browser does: the place on the curve whose time is `progress` is found (a few steps of Newton's method, then
 * halving if that has not settled), and its movement is the answer.
 */
export function EASE_SMOOTH(progress: number): number {
  if (progress <= 0) return 0
  if (progress >= 1) return 1
  let t = progress
  for (let step = 0; step < 8; step += 1) {
    const off = TIME.at(t) - progress
    if (Math.abs(off) < 1e-7) return MOVEMENT.at(t)
    const slope = TIME.slope(t)
    if (Math.abs(slope) < 1e-6) break
    t -= off / slope
  }
  let [low, high] = [0, 1]
  t = progress
  while (high - low > 1e-7) {
    if (TIME.at(t) < progress) low = t
    else high = t
    t = (low + high) / 2
  }
  return MOVEMENT.at(t)
}

/** Hovers, the menu, and the shade behind it. Seconds. */
export const DURATION_SHORT = 0.32

/** Page transitions, each of the intro's three transitions, and the Product Info Panel's slide with its shade (WQ49: as the Bag is prototyped). Seconds. */
export const DURATION_LONG = 0.64

/**
 * The intro's two holds (WQ53): on the full panel before the logo, and on the logo and the location before the
 * mask. Seconds. A wait between two animations, never an animation's own duration.
 */
export const INTRO_PAUSE = 0.48
