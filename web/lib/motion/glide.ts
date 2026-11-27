import { DURATION_LONG, DURATION_SHORT } from './tokens'

/**
 * How long a glide lasts, in seconds (W84 Level 3; Wayne, 27 Nov). A strip let go of while it is moving glides on
 * along the slowing part of the site's curve. Played over the long duration, a glide that sets off at the speed the
 * strip was let go of at goes `natural` pixels; the strip is sent `wanted` pixels instead, to a picture's place. The
 * same curve played over the long duration times wanted / natural sets off at that same speed, so nothing jolts at
 * the release: a short way takes less time, a long way more. It is never shorter than the short duration nor longer
 * than the long one (the site's two): outside them the strip sets off a little slower, or faster, than the hand.
 */
export function glideSeconds(natural: number, wanted: number): number {
  if (!(natural > 0)) return DURATION_LONG
  return Math.min(Math.max((DURATION_LONG * wanted) / natural, DURATION_SHORT), DURATION_LONG)
}
