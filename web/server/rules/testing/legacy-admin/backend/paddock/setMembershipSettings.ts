import { requireCanManagePricing } from './shared/pricingStaff'

export interface SetMembershipSettingsParams {
  addonCreditWaitMonths: number
}

export interface SetMembershipSettingsResult {
  addonCreditWaitMonths: number
  /** Rows whose is_herd flag changed when the automatic rule was re-applied. */
  herdFlagsChanged: number
}

/** Updates the addon-credit waiting period (months) — Manage pricing permission required — then
 *  re-runs public.refresh_herd_flags() so automatic Herd flags reflect the new setting straight
 *  away (manual overrides, herd_override IS NOT NULL, are never touched by the refresh). */
export default async function setMembershipSettings(
  req: { params: SetMembershipSettingsParams; user: User }
): Promise<SetMembershipSettingsResult> {
  await requireCanManagePricing(req.user.email)
  const months = req.params.addonCreditWaitMonths
  if (!Number.isInteger(months) || months < 0 || months > 60) {
    throw new Error('The waiting period must be a whole number of months between 0 and 60.')
  }

  const update = await paddockData.query<{ addon_credit_wait_months: number }>(
    `UPDATE membership_settings
     SET addon_credit_wait_months = $1, updated_at = now()
     WHERE id = true
     RETURNING addon_credit_wait_months`,
    [months]
  )
  if (!update.data[0]) {
    throw new Error('The membership_settings row is missing — insert it (id = true) before editing the setting.')
  }

  const refreshed = await paddockData.query<{ rows_changed: number }>(
    'SELECT public.refresh_herd_flags() AS rows_changed'
  )
  return {
    addonCreditWaitMonths: update.data[0].addon_credit_wait_months,
    herdFlagsChanged: refreshed.data[0]?.rows_changed ?? 0,
  }
}
