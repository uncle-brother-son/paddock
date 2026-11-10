import { describe, expect, it } from 'vitest'

// Run only by no-real-stripe.test.ts, in its own vitest with STRIPE_GUARD_FIXTURE=1, to show that a
// test which reaches Stripe and swallows the error fails all the same. Skipped in every other run.

describe.runIf(process.env.STRIPE_GUARD_FIXTURE === '1')('a test that reaches Stripe and hides it', () => {
  it('swallows the error, as code holding an unclear answer would', async () => {
    const answer = await fetch('https://api.stripe.com/v1/payment_intents', { method: 'POST' }).then(
      () => 'sent',
      () => 'swallowed'
    )
    expect(answer).toBe('swallowed')
  })
})
