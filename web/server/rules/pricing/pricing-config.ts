// Ported from backend/paddock/getPricingConfig.ts.
import 'server-only'
import type { PricingConfigOutput } from '@/contracts'
import type { Queryable } from '@/server/db'

/**
 * Everything the Pricing admin page renders, in one read. `canManagePricing` is passed in: the
 * caller knows it from the signed-in staff member.
 */
export async function getPricingConfig(db: Queryable, canManagePricing: boolean): Promise<PricingConfigOutput> {
  const [bands, rules, terms, levels] = await Promise.all([
    db.query<PricingConfigOutput['bands'][number]>(
      'SELECT id, code, name, price, sort_order, active FROM session_bands ORDER BY sort_order, id',
      []
    ),
    db.query<PricingConfigOutput['bandRules'][number]>(
      'SELECT id, band_id, day_of_week, from_time, to_time FROM band_rules ORDER BY day_of_week, from_time, id',
      []
    ),
    db.query<PricingConfigOutput['membershipTerms'][number]>(
      'SELECT id, membership_level, band_id, credit_eligible, discount_percent FROM membership_band_terms ORDER BY membership_level, band_id',
      []
    ),
    db.query<{ membership_level: string }>('SELECT DISTINCT membership_level FROM membership_band_terms ORDER BY membership_level', []),
  ])

  return {
    bands,
    bandRules: rules,
    membershipTerms: terms,
    membershipLevels: levels.map((l) => l.membership_level),
    canManagePricing,
  }
}
