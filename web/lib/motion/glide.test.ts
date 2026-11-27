import { describe, expect, it } from 'vitest'

import { glideSeconds } from './glide'
import { DURATION_LONG, DURATION_SHORT } from './tokens'

// W84 Level 3 (Wayne, 27 Nov): a glide's length of time follows how far it is sent, so it sets off at the speed the
// strip was let go of at (components/modules/content/GalleryCarousel.tsx).

describe("a glide's duration", () => {
  it('sent as far as it would have gone by itself, it is the long duration', () => {
    expect(glideSeconds(400, 400)).toBe(DURATION_LONG)
  })

  it('sent a shorter way it takes less time, in step: it sets off at the same speed', () => {
    const seconds = glideSeconds(400, 300)
    expect(seconds).toBeCloseTo(DURATION_LONG * 0.75, 10)
    // The same curve over a time in step with the distance: pixels a second at the first moment are the same.
    expect(300 / seconds).toBeCloseTo(400 / DURATION_LONG, 6)
  })

  it('is never shorter than the short duration, however near its end is', () => {
    expect(glideSeconds(400, 199)).toBe(DURATION_SHORT)
    expect(glideSeconds(400, 1)).toBe(DURATION_SHORT)
    // Half the way is exactly the short duration, which is half the long one.
    expect(glideSeconds(400, 200)).toBeCloseTo(DURATION_SHORT, 10)
  })

  it('is never longer than the long duration, however far its end is', () => {
    expect(glideSeconds(400, 401)).toBe(DURATION_LONG)
    expect(glideSeconds(10, 500)).toBe(DURATION_LONG)
  })

  it('with no speed to speak of it is the long duration', () => {
    expect(glideSeconds(0, 300)).toBe(DURATION_LONG)
    expect(glideSeconds(Number.NaN, 300)).toBe(DURATION_LONG)
  })
})
