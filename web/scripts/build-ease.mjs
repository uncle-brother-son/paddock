// npm run ease:build (W74c, WQ55; W74d, WQ56): makes the site's one curve, "smooth", from the spring Wayne's
// prototypes use, and writes it where the site reads it: lib/motion/ease-smooth.ts (for Motion and the tests) and the
// `--ease-smooth` line of app/globals.css (for CSS). scripts/build-ease.test.ts fails when either is behind this
// script, and holds the curve to the spring. With --check it writes nothing and exits 1 when a file is behind.
//
// The spring is Figma's preset "Slow" (stored as SLOW): mass 1, stiffness 80, damping 20. It is more than critically
// damped, so it never passes its target and never bounces. Figma gives it 1.3334881067276 seconds by itself: the
// moment it is within a thousandth of its target (read from the prototypes on 04 Animations, 25 Nov 2026).
//
// A spring is physical: it takes the same real time however long the animation it is given (about half-way at
// 200 ms). So the curve is the spring in real time (WQ56): its first 640 ms from rest, the site's long duration,
// divided by where it has got to by then (95.3% of the way) so that it ends on 1. An animation of 640 ms moves as
// the spring does for its whole length; one of 320 ms plays the same shape in half the time. W74c had squeezed all
// of Figma's 1.333 s into the duration instead, which was half-way at about 100 ms of a 640 ms animation.
//
// CSS has no spring, so the curve is written as `linear(...)`: straight pieces between points on the spring, few
// where it is nearly straight and more where it bends, each piece within a thousandth of the spring.
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Figma's "Slow" spring, and the time Figma gives it (seconds). */
export const SPRING = { name: 'SLOW', mass: 1, stiffness: 80, damping: 20, seconds: 1.3334881067276 }

/**
 * The stretch of the spring the curve is (WQ56): its first 640 ms from rest, in seconds. It is the site's long
 * duration (lib/motion/tokens.ts, DURATION_LONG; the test holds the two together), so an animation of that length
 * moves as the spring does in real time.
 */
export const CURVE_SECONDS = 0.64

/** How far a straight piece may stray from the spring (of the whole movement, 0 to 1). */
export const TOLERANCE = 0.001

/** The moments the pieces may join at: every thousandth of the duration. */
const STEPS = 1000

/**
 * How far along a spring is, `seconds` after it is let go at rest at 0 with its target at 1. Only for a spring that
 * is more than critically damped (no bounce): anything else is refused, because the site's curve must never pass 1.
 */
export function springAt(spring, seconds) {
  const { mass, stiffness, damping } = spring
  const natural = Math.sqrt(stiffness / mass)
  const ratio = damping / (2 * Math.sqrt(stiffness * mass))
  if (!(ratio > 1)) throw new Error(`The ${spring.name} spring would bounce (damping ratio ${ratio}): the site's curve never passes its target.`)
  const spread = natural * Math.sqrt(ratio * ratio - 1)
  const slow = -natural * ratio + spread
  const fast = -natural * ratio - spread
  return 1 - (fast * Math.exp(slow * seconds) - slow * Math.exp(fast * seconds)) / (fast - slow)
}

/**
 * The curve itself: how far along the movement is (0 to 1) at `progress` through the animation's time (0 to 1). It
 * is the spring over its first `seconds` from rest, divided by where the spring has got to at the end of them
 * (0.953 at 640 ms), so that it ends on 1 exactly.
 */
export function smoothAt(progress, spring = SPRING, seconds = CURVE_SECONDS) {
  return springAt(spring, progress * seconds) / springAt(spring, seconds)
}

const round = (value, places) => Number(value.toFixed(places))

/**
 * The points of the `linear(...)` curve, as [progress through the time, how far along the movement], from [0, 0] to
 * [1, 1]. Each piece is made as long as it can be while every moment on it stays within the tolerance of the spring.
 */
export function smoothPoints(spring = SPRING, tolerance = TOLERANCE) {
  const curve = Array.from({ length: STEPS + 1 }, (_, step) => smoothAt(step / STEPS, spring))
  const written = curve.map((value) => round(value, 4))
  const fits = (from, to) => {
    for (let step = from + 1; step < to; step += 1) {
      const onPiece = written[from] + ((written[to] - written[from]) * (step - from)) / (to - from)
      if (Math.abs(onPiece - curve[step]) > tolerance) return false
    }
    return true
  }
  const points = [[0, 0]]
  let from = 0
  while (from < STEPS) {
    let to = from + 1
    while (to < STEPS && fits(from, to + 1)) to += 1
    points.push([to / STEPS, to === STEPS ? 1 : written[to]])
    from = to
  }
  return points
}

/** The points as CSS writes them: `linear(0, 0.0452 2.4%, ..., 1)`. */
export function linearEasing(points) {
  const stops = points.map(([progress, value], index) => (index === 0 || index === points.length - 1 ? String(value) : `${value} ${round(progress * 100, 1)}%`))
  return `linear(${stops.join(', ')})`
}

const TOKEN_LINE = /^( *)--ease-smooth: [^;]*;$/m

/** Every file the curve is written to, by its path from web/, with the text it should hold. */
export function buildEase(web = WEB) {
  const points = smoothPoints()
  const css = linearEasing(points)
  const pointsFile = [
    '// Made by scripts/build-ease.mjs from Figma\'s "Slow" spring (npm run ease:build). Never edit by hand:',
    '// scripts/build-ease.test.ts fails when this file is not what the script makes.',
    '',
    `/** The spring the curve is made from (WQ55), and the time Figma gives it, in seconds. */`,
    `export const EASE_SMOOTH_SPRING = { mass: ${SPRING.mass}, stiffness: ${SPRING.stiffness}, damping: ${SPRING.damping}, seconds: ${SPRING.seconds} } as const`,
    '',
    '/** The stretch of the spring the curve is (WQ56): its first seconds from rest, in real time. */',
    `export const EASE_SMOOTH_SECONDS = ${CURVE_SECONDS}`,
    '',
    '/** The curve\'s points: [progress through the animation\'s time, how far along the movement], each 0 to 1. */',
    'export const EASE_SMOOTH_POINTS: readonly (readonly [number, number])[] = [',
    ...points.map(([progress, value]) => `  [${progress}, ${value}],`),
    ']',
    '',
    '/** The same curve as CSS writes it: the value of `--ease-smooth` in app/globals.css. */',
    `export const EASE_SMOOTH_CSS = '${css}'`,
    '',
  ].join('\n')
  const stylesheet = readFileSync(path.join(web, 'app/globals.css'), 'utf8')
  if (!TOKEN_LINE.test(stylesheet)) throw new Error('app/globals.css has no --ease-smooth line to write the curve to.')
  return {
    'lib/motion/ease-smooth.ts': pointsFile,
    'app/globals.css': stylesheet.replace(TOKEN_LINE, (_, indent) => `${indent}--ease-smooth: ${css};`),
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check')
  let behind = 0
  for (const [file, text] of Object.entries(buildEase())) {
    const full = path.join(WEB, file)
    let now = null
    try {
      now = readFileSync(full, 'utf8')
    } catch {
      now = null
    }
    if (now === text) continue
    behind += 1
    if (check) console.error(`${file} is behind scripts/build-ease.mjs: run npm run ease:build`)
    else {
      writeFileSync(full, text)
      console.log(`wrote ${file}`)
    }
  }
  if (check && behind > 0) process.exit(1)
  if (!check) console.log(`${smoothPoints().length} points; ${behind === 0 ? 'nothing to write' : `${behind} file(s) written`}`)
}
