// Made by scripts/build-ease.mjs from Figma's "Slow" spring (npm run ease:build). Never edit by hand:
// scripts/build-ease.test.ts fails when this file is not what the script makes.

/** The spring the curve is made from (WQ55), and the time Figma gives it, in seconds. */
export const EASE_SMOOTH_SPRING = { mass: 1, stiffness: 80, damping: 20, seconds: 1.3334881067276 } as const

/** The stretch of the spring the curve is (WQ56): its first seconds from rest, in real time. */
export const EASE_SMOOTH_SECONDS = 0.64

/** The curve's points: [progress through the animation's time, how far along the movement], each 0 to 1. */
export const EASE_SMOOTH_POINTS: readonly (readonly [number, number])[] = [
  [0, 0],
  [0.016, 0.0041],
  [0.034, 0.0172],
  [0.054, 0.04],
  [0.078, 0.0758],
  [0.109, 0.131],
  [0.163, 0.2388],
  [0.232, 0.3777],
  [0.28, 0.4673],
  [0.325, 0.5436],
  [0.37, 0.6118],
  [0.415, 0.6721],
  [0.462, 0.7271],
  [0.512, 0.7775],
  [0.565, 0.8227],
  [0.623, 0.864],
  [0.686, 0.9005],
  [0.757, 0.9333],
  [0.837, 0.9617],
  [0.93, 0.9862],
  [1, 1],
]

/** The same curve as CSS writes it: the value of `--ease-smooth` in app/globals.css. */
export const EASE_SMOOTH_CSS = 'linear(0, 0.0041 1.6%, 0.0172 3.4%, 0.04 5.4%, 0.0758 7.8%, 0.131 10.9%, 0.2388 16.3%, 0.3777 23.2%, 0.4673 28%, 0.5436 32.5%, 0.6118 37%, 0.6721 41.5%, 0.7271 46.2%, 0.7775 51.2%, 0.8227 56.5%, 0.864 62.3%, 0.9005 68.6%, 0.9333 75.7%, 0.9617 83.7%, 0.9862 93%, 1)'
