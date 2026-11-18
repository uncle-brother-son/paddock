// New in W43 (F-plan 1.9, 4.8; brief W43 items 1 and 2; Wayne's Q48, 15 Nov; N8, bugs FB18 and FB19): the lapse sweep
// on the Worker. Until now the database's hourly job (run_membership_maintenance -> lapse_sweep_expired_bookings)
// cancelled payment-needed bookings past their deadline with a bare status change: no audit row, none of the Worker's
// locks, nothing of what a cancel does, and never a booking with money on it (which then held its places for ever).
//
// The sweep runs on the Worker's five-minute schedule, before reconcile (server/scheduled.ts), behind its own switch
// kind `lapse_sweep`. Each booking due is cancelled through bookings/cancel.ts on the system channel (lapseBooking):
// one transaction each, under the booking's locks, with its audit rows, and no Stripe call. What happens to money on
// the booking is Q48's rule, in cancel.ts (lapsePlanOf).
//
// - Off (`lapse_sweep` not in the switch): nothing is read and nothing is cancelled; the database's sweep stays in
//   charge. The switch is handed in by the run (a scheduled run's process.env doesn't hold the Worker's secrets).
// - Capped per run, oldest deadline first; whatever is over waits for the next run (`more`).
// - A booking that can't be cancelled now is left, with the reason, and read again by the next run: a payment still
//   being taken on it (Settle on the reader), a refund still being checked, or (`booking_changed`) a change since it
//   was read to the cancel it would be, to whether money comes back, or to its add-on lines. Any other change since
//   the read (a guest removed, money owed) is not left: the booking lapses from what is found under its lock. One that
//   is no longer due under its lock (settled, cancelled by staff, or by the database's sweep) is left as `not_lapsed`.
// - A fault on one booking is logged in the result and never stops the others.
import 'server-only'
import type { Db } from '@/server/db'
import { kindsOn } from '@/server/rules/orders/order-switch'
import { lapseBooking, type LapseOutcome } from './cancel'

/** As reconcile's scheduled bound (SCHEDULED_LIMITS.maxItems): at most this many bookings read in one run. */
export const LAPSE_SWEEP_MAX_ITEMS = 50

export interface LapseSweepOptions {
  /** The run's id: every row the sweep writes carries it. */
  requestId: string
  /** The Worker's ORDER_SWITCH, as the run was handed it. Null or unset: every kind off. Never read from process.env here. */
  orderSwitch: string | null
  maxItems?: number
}

export type LapseSweepItem = ({ bookingId: string } & LapseOutcome) | { bookingId: string; outcome: 'failed'; error: string }

export interface LapseSweepResult {
  /** False when `lapse_sweep` is off: nothing was read. */
  ran: boolean
  lapsed: number
  left: number
  failed: number
  /** Store credit given across the run, in pounds. */
  storeCreditRefunded: number
  /** More bookings were due than the run's cap: the next run carries on. */
  more: boolean
  items: LapseSweepItem[]
}

/** The database sweep's own test of "due" (without its `price_paid = 0`: Q48), oldest deadline first, one over the cap. */
const DUE_SQL = `
SELECT id FROM bookings
WHERE status = 'payment_needed' AND payment_due_by <= now()
ORDER BY payment_due_by, id
LIMIT $1::int`

/** Whether the switch names `lapse_sweep`. */
export const lapseSweepOn = (switchValue: string | undefined | null): boolean => kindsOn(switchValue).has('lapse_sweep')

const round2 = (n: number): number => Math.round(n * 100) / 100
const explain = (err: unknown): string => (err instanceof Error ? `${err.name}: ${err.message}` : String(err))

/** One run of the sweep. Reads nothing when the kind is off. */
export async function lapseSweep(db: Db, options: LapseSweepOptions): Promise<LapseSweepResult> {
  const result: LapseSweepResult = { ran: false, lapsed: 0, left: 0, failed: 0, storeCreditRefunded: 0, more: false, items: [] }
  if (!lapseSweepOn(options.orderSwitch)) return result
  result.ran = true
  const maxItems = options.maxItems ?? LAPSE_SWEEP_MAX_ITEMS
  const due = await db.query<{ id: string }>(DUE_SQL, [maxItems + 1])
  result.more = due.length > maxItems
  for (const { id } of due.slice(0, maxItems)) {
    try {
      const outcome = await lapseBooking(db, id, options.requestId)
      result.items.push({ bookingId: id, ...outcome })
      if (outcome.outcome === 'lapsed') {
        result.lapsed += 1
        result.storeCreditRefunded = round2(result.storeCreditRefunded + outcome.storeCreditRefunded)
      } else {
        result.left += 1
      }
    } catch (err) {
      result.failed += 1
      result.items.push({ bookingId: id, outcome: 'failed', error: explain(err) })
    }
  }
  return result
}
