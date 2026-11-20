import { getStaffAccessRow } from './shared/staffAccess'

export type SessionPassLevel = 'core' | 'all_access'

export interface SetSessionPassLevelParams {
  passTypeId: string
  level: SessionPassLevel
}

export interface SetSessionPassLevelResult {
  updated: boolean
  reason?: 'no_pricing_permission' | 'invalid_level' | 'pass_type_not_found'
  passType?: { id: string; level: SessionPassLevel }
}

/**
 * Sets a session pass type's level. A Core pass covers Off-Peak and Core sessions only; an
 * All-Access pass covers any public session (the rule itself is pass_covers_session in SQL).
 * Changing the level applies to passes already sold of this type too — one rule per type, by
 * design. Restricted to staff with can_manage_pricing.
 */
export default async function setSessionPassLevel(
  req: { params: SetSessionPassLevelParams; user: User }
): Promise<SetSessionPassLevelResult> {
  const staff = await getStaffAccessRow(req.user.email)
  if (!staff?.can_manage_pricing) {
    return { updated: false, reason: 'no_pricing_permission' }
  }
  const { passTypeId, level } = req.params
  if (level !== 'core' && level !== 'all_access') {
    return { updated: false, reason: 'invalid_level' }
  }
  const result = await paddockData.query<{ id: string; level: SessionPassLevel }>(
    'UPDATE session_pass_types SET level = $1, updated_at = now() WHERE id = $2 RETURNING id, level',
    [level, passTypeId]
  )
  const row = result.data[0]
  if (!row) return { updated: false, reason: 'pass_type_not_found' }
  return { updated: true, passType: row }
}
