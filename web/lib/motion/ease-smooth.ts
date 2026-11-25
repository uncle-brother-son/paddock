// Made by scripts/build-ease.mjs from Figma's "Slow" spring (npm run ease:build). Never edit by hand:
// scripts/build-ease.test.ts fails when this file is not what the script makes.

/** The spring the curve is made from (WQ55), and the time Figma gives it, in seconds. */
export const EASE_SMOOTH_SPRING = { mass: 1, stiffness: 80, damping: 20, seconds: 1.3334881067276 } as const

/** The curve's points: [progress through the animation's time, how far along the movement], each 0 to 1. */
export const EASE_SMOOTH_POINTS: readonly (readonly [number, number])[] = [
  [0, 0],
  [0.007, 0.0033],
  [0.015, 0.014],
  [0.025, 0.0358],
  [0.036, 0.0677],
  [0.05, 0.1164],
  [0.072, 0.2025],
  [0.11, 0.3552],
  [0.134, 0.4444],
  [0.156, 0.5186],
  [0.177, 0.582],
  [0.199, 0.6407],
  [0.221, 0.6921],
  [0.245, 0.7404],
  [0.271, 0.7846],
  [0.299, 0.8242],
  [0.33, 0.8599],
  [0.365, 0.8917],
  [0.404, 0.9188],
  [0.449, 0.942],
  [0.504, 0.9616],
  [0.572, 0.9771],
  [0.663, 0.9888],
  [0.801, 0.9966],
  [1, 1],
]

/** The same curve as CSS writes it: the value of `--ease-smooth` in app/globals.css. */
export const EASE_SMOOTH_CSS = 'linear(0, 0.0033 0.7%, 0.014 1.5%, 0.0358 2.5%, 0.0677 3.6%, 0.1164 5%, 0.2025 7.2%, 0.3552 11%, 0.4444 13.4%, 0.5186 15.6%, 0.582 17.7%, 0.6407 19.9%, 0.6921 22.1%, 0.7404 24.5%, 0.7846 27.1%, 0.8242 29.9%, 0.8599 33%, 0.8917 36.5%, 0.9188 40.4%, 0.942 44.9%, 0.9616 50.4%, 0.9771 57.2%, 0.9888 66.3%, 0.9966 80.1%, 1)'
