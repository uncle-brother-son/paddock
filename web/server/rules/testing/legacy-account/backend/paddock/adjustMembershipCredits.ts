import { requireStaffId } from './shared/resolveStaffId'
import { getStaffAccessRow } from './shared/staffAccess'

export interface AdjustMembershipCreditsParams {
  membershipId: string
  creditType: 'session' | 'addon'
  amount: number
  reason: string
}

export interface AdjustMembershipCreditsResult {
  adjusted: boolean
  reason?: string
  message?: string
  period?: {
    period_id: string
    credits_allocated: number
    credits_used: number
    period_start: string
    period_end: string
  }
  addon_credits_remaining?: number
}

/**
 * Manual staff credit adjustment. Add-on credits stay on the legacy counter
 * (customer_memberships.addon_credits_remaining — unchanged by the period migration). Session
 * credits, however, live in the membership's CURRENT credit period now: the amount is applied to
 * that period's credits_allocated (never to session_credits_remaining, which is retired).
 */
export default async function adjustMembershipCredits(
  req: { params: AdjustMembershipCreditsParams; user: User }
): Promise<AdjustMembershipCreditsResult> {
  const { membershipId, creditType, amount, reason } = req.params
  const { user } = req

  // Only staff with can_issue_refunds may adjust membership credits (they are money-equivalent
  // value on the customer's account).
  const staffAccess = await getStaffAccessRow(user.email)
  if (!staffAccess?.can_issue_refunds) {
    return {
      adjusted: false,
      reason: 'permission_denied',
      message: 'Needs the Issue refunds permission to adjust membership credits.',
    }
  }

  if (!Number.isInteger(amount) || amount === 0) {
    throw new Error('Amount must be a non-zero whole number.')
  }

  const staffId = await requireStaffId(user.email)

  if (creditType === 'addon') {
    const updated = await paddockData.query<{ addon_credits_remaining: number }>(
      `UPDATE customer_memberships SET addon_credits_remaining = addon_credits_remaining + $1, updated_at = now()
       WHERE id = $2 RETURNING addon_credits_remaining`,
      [amount, membershipId]
    )
    const row = updated.data[0]
    if (!row) throw new Error('Membership not found.')
    await paddockData.query(
      `INSERT INTO membership_credit_adjustments (membership_id, staff_id, amount, credit_type, reason)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [membershipId, staffId, amount, creditType, reason]
    )
    return { adjusted: true, addon_credits_remaining: row.addon_credits_remaining }
  }

  // --- session credits: adjust the CURRENT period's allocation ---
  const current = await paddockData.query<{
    is_unlimited: boolean
    period_id: string | null
    credits_allocated: number | null
    credits_used: number | null
    period_start: string | null
    period_end: string | null
  }>(
    `SELECT mp.is_unlimited, mcc.period_id, mcc.credits_allocated, mcc.credits_used, mcc.period_start, mcc.period_end
     FROM customer_memberships cm
     JOIN membership_plans mp ON mp.id = cm.plan_id
     LEFT JOIN membership_current_credits mcc ON mcc.membership_id = cm.id
     WHERE cm.id = $1`,
    [membershipId]
  )
  const membership = current.data[0]
  if (!membership) throw new Error('Membership not found.')
  if (membership.is_unlimited) {
    throw new Error('This membership is unlimited — its session credits cannot be adjusted.')
  }
  if (!membership.period_id) {
    throw new Error('This membership has no current credit period — there is nothing to adjust.')
  }
  const allocated = membership.credits_allocated ?? 0
  const used = membership.credits_used ?? 0
  const newAllocated = allocated + amount
  if (newAllocated < used) {
    throw new Error(
      `Adjustment rejected: the period would be left with ${newAllocated} allocated credit(s), below the ${used} already used.`
    )
  }
  const updated = await paddockData.query<{ credits_allocated: number }>(
    `UPDATE membership_credit_periods SET credits_allocated = $1 WHERE id = $2 RETURNING credits_allocated`,
    [newAllocated, membership.period_id]
  )
  if (updated.data.length === 0) {
    throw new Error('This membership has no current credit period — there is nothing to adjust.')
  }

  // Audit row written exactly as before (credit_type 'session', signed amount, staff attribution).
  await paddockData.query(
    `INSERT INTO membership_credit_adjustments (membership_id, staff_id, amount, credit_type, reason)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [membershipId, staffId, amount, creditType, reason]
  )

  return {
    adjusted: true,
    period: {
      period_id: membership.period_id,
      credits_allocated: updated.data[0]!.credits_allocated,
      credits_used: used,
      period_start: membership.period_start!,
      period_end: membership.period_end!,
    },
  }
}
