import 'server-only'

/*
 * The Stripe client's time limits, apart from client.ts so that rule code (collect-saved-card.ts) can
 * read them without loading the SDK client. W10a: when the order's collect step imported them from
 * client.ts, the replay loaded the real client before its Stripe stand-in was installed.
 */

/** How long one Stripe call may take, and how many times the SDK may send it again by itself. */
export interface StripeLimits {
  timeoutMs: number
  networkRetries: number
}

/**
 * The order's limits (W10, W5-26). Retool gives a function 60 seconds, and the SDK's own defaults are
 * 80 seconds a call and 2 retries of its own (up to 240 seconds). An order makes one charge, and
 * collect-saved-card.ts sends it at most twice itself, with the same key, so the SDK retries nothing:
 * its retries would be hidden extra sends. Each send gets 10 seconds. A charge that takes longer is
 * an unknown outcome, never a refusal: the order stays pending, and the key stops a second charge.
 * Worst case for the Stripe part of an order: 2 x 10 = 20 seconds, and the second send only gets
 * what is left before the order's deadline (W10a, collect-saved-card.ts COLLECT_DEADLINE_MS).
 */
export const ORDER_STRIPE_LIMITS: StripeLimits = { timeoutMs: 10_000, networkRetries: 0 }

/**
 * A read Retool waits on (W10a, W10 N1): 10 seconds a call, and one more send by the SDK itself,
 * which is safe for a read. One page of the refund look-up: about 21 seconds at worst, against the
 * SDK's defaults of 80 seconds and 2 retries (up to 240).
 */
export const READ_STRIPE_LIMITS: StripeLimits = { timeoutMs: 10_000, networkRetries: 1 }
