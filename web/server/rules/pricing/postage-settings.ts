// Ported from backend/paddock/getPostageSettings.ts.
import 'server-only'
import type { PostageSettingsOutput } from '@/contracts'
import type { Queryable } from '@/server/db'
import { ApiError } from '@/server/http/errors'
import { rowStampSql } from '@/server/rules/admin/stamp'

interface PostageSettingsRow {
  standard_price: string
  express_price: string
  free_shipping_threshold: string
  stamp: string
}

/**
 * The three postage figures. W54a (the step G rule, admin/stamp.ts): with the settings row's stamp, read in the
 * same statement as the figures. The Pricing page sends it back with its save, which is refused if the row has
 * changed since (pricing/admin.ts).
 */
export async function getPostageSettings(db: Queryable): Promise<PostageSettingsOutput> {
  try {
    const rows = await db.query<PostageSettingsRow>(
      // eslint-disable-next-line no-restricted-syntax -- the stamp is a literal from admin/stamp.ts; nothing from a request goes in
      `SELECT p.standard_price, p.express_price, p.free_shipping_threshold, ${rowStampSql('p')} AS stamp FROM postage_settings p LIMIT 1`,
      []
    )
    const row = rows[0]
    if (!row) {
      throw new ApiError(
        'INTERNAL',
        'Postage settings have not been configured yet. Run the postage_settings migration (CREATE TABLE + seed row) to set them up.'
      )
    }
    return {
      standardPrice: Number.parseFloat(row.standard_price),
      expressPrice: Number.parseFloat(row.express_price),
      freeShippingThreshold: Number.parseFloat(row.free_shipping_threshold),
      stamp: row.stamp,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('does not exist')) {
      throw new ApiError(
        'INTERNAL',
        'The postage_settings table does not exist yet. Run the postage migration (CREATE TABLE postage_settings + seed row) to set it up.'
      )
    }
    throw err
  }
}
