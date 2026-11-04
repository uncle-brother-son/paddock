// Ported from backend/paddock/getPostageSettings.ts.
import 'server-only'
import type { PostageSettingsOutput } from '@/contracts'
import type { Queryable } from '@/server/db'
import { ApiError } from '@/server/http/errors'

interface PostageSettingsRow {
  standard_price: string
  express_price: string
  free_shipping_threshold: string
}

export async function getPostageSettings(db: Queryable): Promise<PostageSettingsOutput> {
  try {
    const rows = await db.query<PostageSettingsRow>(
      'SELECT standard_price, express_price, free_shipping_threshold FROM postage_settings LIMIT 1',
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
