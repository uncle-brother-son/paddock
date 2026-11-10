import 'server-only'
import type Stripe from 'stripe'
import { ORDER_STRIPE_LIMITS } from './limits'

/*
 * Brief W11: a press's Stripe calls must be answered by a deadline from the request's start, so the
 * press ends well inside Retool's 60 seconds (W10a set this for the saved card's charge). The reader's
 * routes make more than one call (finding the Stripe customer, the intent; or reading the payment, the
 * card, cancelling), so each call gets what is left, at most the client's 10 seconds, and a call with
 * under MIN_SEND_MS left isn't sent: the caller then treats it as no answer, which is always safe.
 */

/** From the request's start (W10a). */
export const STRIPE_DEADLINE_MS = 30_000
/** Below this a send is mostly the connection and TLS set-up: more likely to time out than to answer. */
export const MIN_SEND_MS = 2_000

export interface StripeTiming {
  /** When the answers must be in by (ms since the epoch). */
  deadline: number
  /** The clock: Date.now on the route, the test clock in tests. */
  now: () => number
}

/** A call that wasn't sent: too little time was left. Nothing reached Stripe. */
export class NoTimeLeft extends Error {
  constructor(readonly left: number) {
    super(`Not sent: ${left} ms left before the deadline.`)
    this.name = 'NoTimeLeft'
  }
}

/** The timing for a request that started at `startedAt`. */
export function stripeTiming(startedAt: number, now: () => number = Date.now): StripeTiming {
  return { deadline: startedAt + STRIPE_DEADLINE_MS, now }
}

/**
 * The options for the next call: `base` with the time left (at most the client's own 10 seconds).
 * Throws NoTimeLeft, before anything is sent, with under MIN_SEND_MS left. With no timing (reconcile,
 * W12, which has no Retool limit), `base` as it is.
 */
export function sendOptions(timing: StripeTiming | undefined, base: Stripe.RequestOptions = {}): Stripe.RequestOptions {
  if (!timing) return base
  const left = Math.floor(timing.deadline - timing.now())
  if (left < MIN_SEND_MS) throw new NoTimeLeft(left)
  return { ...base, timeout: Math.min(ORDER_STRIPE_LIMITS.timeoutMs, left) }
}
