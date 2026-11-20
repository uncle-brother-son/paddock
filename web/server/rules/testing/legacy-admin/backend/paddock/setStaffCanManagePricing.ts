import { requireStaffAdmin } from './shared/staffAccess'

export interface SetStaffCanManagePricingParams {
  staffId: string
  canManagePricing: boolean
}

export interface SetStaffCanManagePricingResult {
  id: string
  can_manage_pricing: boolean
}

export default async function setStaffCanManagePricing(req: {
  params: SetStaffCanManagePricingParams
  user: User
}): Promise<SetStaffCanManagePricingResult | null> {
  const { staffId, canManagePricing } = req.params

  // Admins only — the staff page and every permission switch on it are admin-only now. The
  // pricing page itself is still gated separately by can_manage_pricing (pricingStaff.ts).
  await requireStaffAdmin(req.user.email)

  const target = await paddockData.query<{ can_manage_pricing: boolean | null }>(
    'SELECT can_manage_pricing FROM staff WHERE id = $1 LIMIT 1',
    [staffId]
  )
  const staff = target.data[0]
  if (!staff) {
    throw new Error('Staff member not found.')
  }

  // Never allow removing the permission from the last remaining active staff member who has it:
  // an inactive member can't use it.
  if (!canManagePricing && staff.can_manage_pricing) {
    const others = await paddockData.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM staff WHERE can_manage_pricing = true AND active = true AND id <> $1',
      [staffId]
    )
    if ((others.data[0]?.count ?? 0) === 0) {
      throw new Error(
        'Cannot remove pricing permission: this is the last staff member with can_manage_pricing enabled. Grant it to another staff member first.'
      )
    }
  }

  const result = await paddockData.query<SetStaffCanManagePricingResult>(
    'UPDATE staff SET can_manage_pricing = $1, updated_at = now() WHERE id = $2 RETURNING id, can_manage_pricing',
    [canManagePricing, staffId]
  )
  return result.data[0] ?? null
}
