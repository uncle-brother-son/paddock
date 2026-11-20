import { requireStaffId } from './shared/resolveStaffId'

export interface UnblockDayParams {
  /** The London calendar date ("YYYY-MM-DD") whose blocked sessions should be reopened. */
  date: string
  /**
   * Step 2 only — set once staff have seen the count from the first call. The first call (omit
   * this) only counts what WOULD be reopened.
   */
  confirmed?: boolean
}

export interface UnblockDayResult {
  confirmed: boolean
  /** Blocked sessions currently on this date (what the first call reports, and what the second
   *  call found immediately before reopening them). */
  blockedSessions: number
  /** Step 2 only — how many sessions were actually reopened. */
  unblocked?: number
}

/**
 * Staff action: reopen every BLOCKED session on one London calendar date — the counterpart to
 * blockDay.ts. Sets status='open', blocked_by=NULL, blocked_reason=NULL for sessions on that
 * date that are currently blocked; sessions that were never blocked are left untouched. Two-step
 * (count, then confirm) so the confirm dialog can show exactly how many sessions are affected.
 */
export default async function unblockDay(req: { params: UnblockDayParams; user: User }): Promise<UnblockDayResult> {
  const { date, confirmed } = req.params

  const countResult = await paddockData.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM sessions WHERE start_time::date = $1::date AND status = 'blocked'`,
    [date]
  )
  const blockedSessions = Number.parseInt(countResult.data[0]?.count ?? '0', 10)

  if (!confirmed) {
    return { confirmed: false, blockedSessions }
  }

  // Same staff guard blockDay applies — the action is staff-only, even though blocked_by is
  // cleared (not re-attributed) by the reopen itself.
  await requireStaffId(req.user.email)

  const result = await paddockData.query<{ id: string }>(
    `UPDATE sessions
     SET status = 'open', blocked_reason = NULL, blocked_by = NULL, updated_at = now()
     WHERE start_time::date = $1::date AND status = 'blocked'
     RETURNING id`,
    [date]
  )

  return { confirmed: true, blockedSessions, unblocked: result.data.length }
}
