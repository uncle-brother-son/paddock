import { requireCanIssueRefunds } from './shared/staffAccess'

export interface SetMembershipHerdParams {
  membershipId: string
  /** true/false sets the manual Herd override AND is_herd to that value; null clears the
   *  override and re-applies the automatic rule via public.refresh_herd_flags(). */
  herd: boolean | null
}

export interface SetMembershipHerdResult {
  updated: boolean
  reason?: 'not_found'
  membership?: {
    id: string
    plan_name: string
    subscription_status: string
    is_herd: boolean
    herd_override: boolean | null
    addon_credits_remaining: number
  }
}

/** Staff Herd override for one membership — gated by the Issue refunds permission (the same gate
 *  as adjustMembershipCredits), since toggling Herd on immediately releases add-on credits. */
export default async function setMembershipHerd(
  req: { params: SetMembershipHerdParams; user: User }
): Promise<SetMembershipHerdResult> {
  await requireCanIssueRefunds(req.user.email)
  const { membershipId, herd } = req.params

  if (herd === null) {
    // Clear the override and let the automatic rule re-decide (refresh covers every
    // override-NULL row, including this one now that its override is cleared).
    const cleared = await paddockData.query<{ id: string }>(
      `UPDATE customer_memberships
       SET herd_override = NULL, updated_at = now()
       WHERE id = $1
       RETURNING id`,
      [membershipId]
    )
    const row = cleared.data[0]
    if (!row) return { updated: false, reason: 'not_found' }
    await paddockData.query('SELECT public.refresh_herd_flags()', [])
    const after = await readMembership(membershipId)
    if (!after) return { updated: false, reason: 'not_found' }
    return { updated: true, membership: after }
  }

  const updated = await paddockData.query<{ id: string }>(
    `UPDATE customer_memberships
     SET herd_override = $1, is_herd = $2, updated_at = now()
     WHERE id = $3
     RETURNING id`,
    [herd, herd, membershipId]
  )
  if (!updated.data[0]) return { updated: false, reason: 'not_found' }
  const after = await readMembership(membershipId)
  if (!after) return { updated: false, reason: 'not_found' }
  return { updated: true, membership: after }
}

async function readMembership(membershipId: string): Promise<SetMembershipHerdResult['membership']> {
  const result = await paddockData.query<{
    id: string
    plan_name: string
    subscription_status: string
    is_herd: boolean
    herd_override: boolean | null
    addon_credits_remaining: number
  }>(
    `SELECT cm.id, mp.name AS plan_name, cm.subscription_status, cm.is_herd, cm.herd_override, cm.addon_credits_remaining
     FROM customer_memberships cm
     JOIN membership_plans mp ON mp.id = cm.plan_id
     WHERE cm.id = $1`,
    [membershipId]
  )
  return result.data[0] ?? undefined
}
