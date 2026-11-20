export interface MembershipSettings {
  /** Monthly memberships become Herd (add-on credits usable) after this many months of membership. */
  addonCreditWaitMonths: number
}

/** The single-row membership settings (addon credit waiting period). Readable by any staff —
 *  editing is gated by requireCanManagePricing in setMembershipSettings.ts. */
export default async function getMembershipSettings(): Promise<MembershipSettings> {
  const result = await paddockData.query<{ addon_credit_wait_months: number }>(
    'SELECT addon_credit_wait_months FROM membership_settings WHERE id = true LIMIT 1',
    []
  )
  const row = result.data[0]
  if (!row) {
    // The seeded row is missing — fall back to the schema default rather than failing the UI.
    return { addonCreditWaitMonths: 6 }
  }
  return { addonCreditWaitMonths: row.addon_credit_wait_months }
}
