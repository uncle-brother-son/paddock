import { londonWallClockToUtc } from './london-time'

export type BillingFrequency = 'monthly' | 'yearly'

export interface MembershipCancellationParams {
  /** customer_memberships.start_date — a plain calendar date (YYYY-MM-DD), no time/timezone component. */
  startDate: string
  /** customer_memberships.next_renewal_date — same format. */
  nextRenewalDate: string
  billingFrequency: BillingFrequency
}

export interface MembershipCancellation {
  /** The day the membership's paid term actually ends (first day access is no longer covered). */
  endDate: string
  /** customer_memberships.cancel_effective_date — last day of access, i.e. endDate minus 1 day. */
  cancelEffectiveDate: string
  /** Stripe subscriptions.update's `cancel_at`, in unix seconds — London midnight on endDate. */
  cancelAtUnix: number
}

function parseDateOnly(dateOnly: string): { year: number; month: number; day: number } {
  const [year, month, day] = dateOnly.split('-').map(Number)
  return { year, month, day }
}

function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10)
}

// Pure calendar-month addition — these are plain DATE columns (no time/timezone component), so
// this is ordinary civil-calendar arithmetic, not a London wall-clock/DST concern at all.
function addMonthsToDateOnly(dateOnly: string, months: number): string {
  const { year, month, day } = parseDateOnly(dateOnly)
  return formatDateOnly(new Date(Date.UTC(year, month - 1 + months, day)))
}

function subtractOneDay(dateOnly: string): string {
  const { year, month, day } = parseDateOnly(dateOnly)
  return formatDateOnly(new Date(Date.UTC(year, month - 1, day - 1)))
}

/**
 * The end date of a membership's current committed term:
 * - Monthly: the later of (start date + 2 months) — the minimum term — and the next renewal date.
 * - Yearly: the next renewal date (the yearly commitment itself is the minimum term).
 */
export function computeMembershipEndDate(params: MembershipCancellationParams): string {
  if (params.billingFrequency === 'yearly') {
    return params.nextRenewalDate
  }
  const minTermEnd = addMonthsToDateOnly(params.startDate, 2)
  // 'YYYY-MM-DD' strings compare lexicographically in chronological order.
  return minTermEnd > params.nextRenewalDate ? minTermEnd : params.nextRenewalDate
}

/**
 * Full cancellation computation: the end date, the DB's cancel_effective_date (last day of
 * access), and the real UTC instant (unix seconds) to pass to Stripe's `cancel_at` — London
 * midnight on the end date, correctly adjusted for BST/GMT via the same helper used for session
 * start times, never a hard-coded offset.
 */
export function computeMembershipCancellation(params: MembershipCancellationParams): MembershipCancellation {
  const endDate = computeMembershipEndDate(params)
  const cancelEffectiveDate = subtractOneDay(endDate)
  const cancelAtUnix = Math.floor(londonWallClockToUtc(`${endDate}T00:00:00.000Z`).getTime() / 1000)
  return { endDate, cancelEffectiveDate, cancelAtUnix }
}
