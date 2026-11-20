import { requireCanManagePricing } from './shared/pricingStaff'

export interface SetMembershipBandTermParams {
  membershipLevel: string
  bandId: string
  creditEligible: boolean
  /** Percentage discount (0–100) applied to the account-holder seat in this band. */
  discountPercent: number
}

export interface SetMembershipBandTermResult {
  saved: boolean
  term?: { id: string; membership_level: string; band_id: string; credit_eligible: boolean; discount_percent: string }
}

/**
 * Upserts one membership level's terms for one band (membership_band_terms): whether the
 * account-holder seat can use a membership credit in that band, and the discount percentage
 * applied to that seat (the Core / Peak 12.5% lives here). Only affects future quotes —
 * existing bookings keep the price they were charged.
 */
export default async function setMembershipBandTerm(
  req: { params: SetMembershipBandTermParams; user: User }
): Promise<SetMembershipBandTermResult> {
  await requireCanManagePricing(req.user.email)
  const { membershipLevel, bandId, creditEligible, discountPercent } = req.params

  const level = membershipLevel.trim()
  if (!level) throw new Error('Membership level is required.')
  if (!Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 100) {
    throw new Error('Discount percent must be between 0 and 100.')
  }

  const result = await paddockData.query<{
    id: string
    membership_level: string
    band_id: string
    credit_eligible: boolean
    discount_percent: string
  }>(
    `INSERT INTO membership_band_terms (membership_level, band_id, credit_eligible, discount_percent, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (membership_level, band_id)
     DO UPDATE SET credit_eligible = EXCLUDED.credit_eligible,
                   discount_percent = EXCLUDED.discount_percent,
                   updated_at = now()
     RETURNING id, membership_level, band_id, credit_eligible, discount_percent`,
    [level, bandId, creditEligible, discountPercent]
  )
  const term = result.data[0]
  if (!term) throw new Error('The band term was saved but could not be read back.')
  return { saved: true, term }
}
