import { requireCanManagePricing } from './shared/pricingStaff'

export interface SetBandPriceParams {
  bandId: string
  /** New band price in pounds (GBP), 0 or more. */
  price: number
}

export interface SetBandPriceResult {
  updated: boolean
  band?: { id: string; code: string; name: string; price: string }
}

/**
 * Edits one session band's price (session_bands.price). Only affects FUTURE quotes — existing
 * bookings keep the price they were charged, and existing sessions keep their band (the price is
 * read live from session_bands at quote time, so sessions already in a band see the new price
 * immediately, which is exactly what a band price change means).
 */
export default async function setBandPrice(req: { params: SetBandPriceParams; user: User }): Promise<SetBandPriceResult> {
  await requireCanManagePricing(req.user.email)
  const { bandId, price } = req.params

  if (!Number.isFinite(price) || price < 0) {
    throw new Error('Price must be a valid non-negative amount.')
  }

  const result = await paddockData.query<{ id: string; code: string; name: string; price: string }>(
    `UPDATE session_bands SET price = $1, updated_at = now() WHERE id = $2
     RETURNING id, code, name, price`,
    [price, bandId]
  )
  const band = result.data[0]
  if (!band) return { updated: false }
  return { updated: true, band }
}
