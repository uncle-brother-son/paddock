import { vi } from 'vitest'
import type { StripeClient } from '@/server/stripe/client'
import type { FakeStripe } from '@/server/stripe/fake'

/**
 * The FakeStripe the order route reaches in a test (W10). The replay's new side binds each run's own
 * fake here (order-side.ts), and a test file that places card orders mocks the client module to read
 * it, as server/db/connection is mocked for the database:
 *
 *   vi.mock('@/server/stripe/client', async (importOriginal) => {
 *     const { stripeClientMock } = await import('@/server/rules/testing/replay/stripe-binding')
 *     return stripeClientMock(await importOriginal())
 *   })
 *
 * With nothing bound, the real createStripeClient runs, so the legacy routes' stand-in (legacy-routes.ts)
 * still answers for the old side.
 */
export const replayStripe: { current: StripeClient | null } = { current: null }

/** Every client the route made, with the limits it asked for: the test of the order's time limits reads them. */
export const stripeClientsMade: Array<{ limits: unknown }> = []

export function stripeClientMock<M extends { createStripeClient: (...args: never[]) => StripeClient }>(original: M): M {
  return {
    ...original,
    createStripeClient: ((...args: Parameters<M['createStripeClient']>) => {
      if (!replayStripe.current) return original.createStripeClient(...args)
      stripeClientsMade.push({ limits: args[1] })
      return replayStripe.current
    }) as M['createStripeClient'],
  }
}

/**
 * The replay's clock stands still on the new side, so T1 and T2 (or the undo) would share a now(). A
 * real charge takes time between them: with this, each one moves the clock a second, so T2's rows come
 * after T1's, as they do live. Only the time moves: what the fake answers is unchanged.
 */
export function chargesTakeASecond(stripe: FakeStripe): void {
  const create = stripe.paymentIntents.create
  stripe.paymentIntents.create = (params, options) => {
    vi.setSystemTime(Date.now() + 1_000)
    return create(params, options)
  }
}

/**
 * W13: the same for every Stripe call a membership's pipeline makes before T2 or the undo (the
 * subscription, the refunds, the cancels), so their audit rows come after T1's, as they do live.
 */
export function stripeCallsTakeASecond(stripe: FakeStripe): void {
  chargesTakeASecond(stripe)
  const subscribe = stripe.subscriptions.create
  stripe.subscriptions.create = (params, options) => {
    vi.setSystemTime(Date.now() + 1_000)
    return subscribe(params, options)
  }
  const refund = stripe.refunds.create
  stripe.refunds.create = (params, options) => {
    vi.setSystemTime(Date.now() + 1_000)
    return refund(params, options)
  }
}
