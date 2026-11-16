export interface MembershipCreditAdjustmentRow {
  id: string
  membership_id: string
  staff_id: string | null
  staff_first_name: string | null
  staff_last_name: string | null
  staff_email: string | null
  staff_role: string | null
  amount: number
  credit_type: string
  reason: string
  created_at: string
}

export interface GetMembershipCreditAdjustmentsParams {
  membershipId: string
}

export default async function getMembershipCreditAdjustments(
  req: { params: GetMembershipCreditAdjustmentsParams }
): Promise<MembershipCreditAdjustmentRow[]> {
  const { membershipId } = req.params

  const result = await paddockData.query<MembershipCreditAdjustmentRow>(
    `SELECT
       mca.*,
       s.first_name AS staff_first_name,
       s.last_name AS staff_last_name,
       s.email AS staff_email,
       s.role AS staff_role
     FROM membership_credit_adjustments mca
     LEFT JOIN staff s ON s.id = mca.staff_id
     WHERE mca.membership_id = $1
     ORDER BY mca.created_at DESC`,
    [membershipId]
  )

  return result.data
}
