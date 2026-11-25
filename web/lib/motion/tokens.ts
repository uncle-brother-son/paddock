// Motion tokens (WQ20-WQ23, WQ53, WQ55): one curve and two durations for the whole site. These are the values Motion
// reads, in seconds; app/globals.css holds the same as CSS variables (--ease-smooth, --duration-short,
// --duration-long, --intro-pause) and tokens.test.ts fails when the two differ. No animation uses its own curve or a
// typed-in duration: typed-in-motion.test.ts looks for one under app/, components/ and features/.

import { EASE_SMOOTH_CSS, EASE_SMOOTH_POINTS } from './ease-smooth'

/**
 * The "smooth" curve: every animation uses it. It is Figma's "Slow" spring (mass 1, stiffness 80, damping 20: no
 * bounce) in real time (WQ55, WQ56): its first 640 ms from rest, brought to end on 1, so an animation of the long
 * duration moves as the spring does and one of the short duration plays the same shape in half the time.
 * scripts/build-ease.mjs makes its points from the spring (lib/motion/ease-smooth.ts); this is the curve through
 * them, as Motion takes an ease: how far along the movement is (0 to 1) at `progress` through the time (0 to 1). CSS
 * draws the same points as `linear(...)`.
 */
export function EASE_SMOOTH(progress: number): number {
  if (progress <= 0) return 0
  if (progress >= 1) return 1
  const next = EASE_SMOOTH_POINTS.findIndex(([at]) => at >= progress)
  const [fromAt, from] = EASE_SMOOTH_POINTS[next - 1] ?? [0, 0]
  const [toAt, to] = EASE_SMOOTH_POINTS[next] ?? [1, 1]
  return from + ((to - from) * (progress - fromAt)) / (toAt - fromAt)
}

/** The same curve as CSS writes it, for the rare place that needs the words and can't use `var(--ease-smooth)`. */
export { EASE_SMOOTH_CSS }

/** Hovers, the menu, and the shade behind it. Seconds. */
export const DURATION_SHORT = 0.32

/** Page transitions, each of the intro's three transitions, and the Product Info Panel's slide with its shade (WQ49: as the Bag is prototyped). Seconds. */
export const DURATION_LONG = 0.64

/**
 * The intro's two holds (WQ53): on the full panel before the logo, and on the logo and the location before the
 * mask. Seconds. A wait between two animations, never an animation's own duration.
 */
export const INTRO_PAUSE = 0.48

/**
 * The points of a `linear(...)` curve as a browser reports it (`linear(0 0%, 0.0033 0.7%, ..., 1 100%)`) or as the
 * tokens write it, as [progress, value] pairs, for a test to compare the two: a browser writes every stop's place
 * out, the tokens leave the first and last to it.
 */
export function linearEasingPoints(easing: string): [number, number][] {
  const inside = /^linear\((.*)\)$/.exec(easing.trim())?.[1]
  if (inside === undefined) return []
  const stops = inside.split(',').map((stop) => stop.trim().split(/\s+/))
  return stops.map(([value, place], index) => {
    const progress = place === undefined ? (index === 0 ? 0 : 1) : Number(place.replace('%', '')) / 100
    return [Number(progress.toFixed(4)), Number(Number(value).toFixed(4))]
  })
}
