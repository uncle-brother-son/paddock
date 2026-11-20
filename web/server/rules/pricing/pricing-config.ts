// Ported from backend/paddock/getPricingConfig.ts.
import 'server-only'
import type { PricingConfigOutput } from '@/contracts'
import type { Queryable } from '@/server/db'
import { rowsStamp, rowStampSql, type StampedRow } from '@/server/rules/admin/stamp'

type BandRule = PricingConfigOutput['bandRules'][number]

/**
 * Everything the Pricing admin page renders, in one read. `canManagePricing` is passed in: the
 * caller knows it from the signed-in staff member.
 *
 * W54a (the step G rule, admin/stamp.ts): each member term carries its row's stamp, and `bandRulesStamps` carries
 * one stamp for each day's windows (index 0 = Sunday .. 6 = Saturday). Each stamp comes from the same statement as
 * the rows it is for, so a save landing between two of this read's statements can't leave the page showing one
 * moment's rows with another moment's stamp. The page sends a stamp back with its save, which is refused if the
 * row has changed since (pricing/admin.ts).
 */
export async function getPricingConfig(db: Queryable, canManagePricing: boolean): Promise<PricingConfigOutput> {
  const [bands, rules, terms, levels] = await Promise.all([
    db.query<PricingConfigOutput['bands'][number]>(
      'SELECT id, code, name, price, sort_order, active FROM session_bands ORDER BY sort_order, id',
      []
    ),
    db.query<BandRule & { stamp: string }>(
      // eslint-disable-next-line no-restricted-syntax -- the stamp is a literal from admin/stamp.ts; nothing from a request goes in
      `SELECT r.id, r.band_id, r.day_of_week, r.from_time, r.to_time, ${rowStampSql('r')} AS stamp FROM band_rules r ORDER BY r.day_of_week, r.from_time, r.id`,
      []
    ),
    db.query<PricingConfigOutput['membershipTerms'][number]>(
      // eslint-disable-next-line no-restricted-syntax -- the stamp is a literal from admin/stamp.ts; nothing from a request goes in
      `SELECT t.id, t.membership_level, t.band_id, t.credit_eligible, t.discount_percent, ${rowStampSql('t')} AS stamp FROM membership_band_terms t ORDER BY t.membership_level, t.band_id`,
      []
    ),
    db.query<{ membership_level: string }>('SELECT DISTINCT membership_level FROM membership_band_terms ORDER BY membership_level', []),
  ])

  // Each day's windows as one stamp, from the rows just read. A window's own stamp is not sent with it.
  const byDay: StampedRow[][] = Array.from({ length: 7 }, () => [])
  const bandRules: BandRule[] = rules.map(({ stamp, ...rule }) => {
    byDay[Number(rule.day_of_week)]?.push({ id: rule.id, stamp })
    return rule
  })

  return {
    bands,
    bandRules,
    membershipTerms: terms,
    membershipLevels: levels.map((l) => l.membership_level),
    bandRulesStamps: byDay.map(rowsStamp),
    canManagePricing,
  }
}
