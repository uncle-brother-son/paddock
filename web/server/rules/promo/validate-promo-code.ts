// Ported from backend/paddock/validatePromoCode.ts.
import 'server-only'
import type { PromoDiscountResult, ValidatePromoCodeInput } from '@/contracts'
import type { Queryable } from '@/server/db'
import { londonToday } from '@/server/rules/time/london-time'
import { applyPromoCode } from './promo-codes'
import { loadPromoAndUsage } from './promo-lookup'

/** Validates a promo code against a basket without writing anything. */
export async function validatePromoCode(db: Queryable, input: ValidatePromoCodeInput, now: Date = new Date()): Promise<PromoDiscountResult> {
  const { code, customerId } = input
  const lines = (input.lines ?? []).filter(
    (line) =>
      typeof line?.key === 'string' &&
      typeof line?.amount === 'number' &&
      Number.isFinite(line.amount) &&
      typeof line?.itemType === 'string'
  )

  const loaded = await loadPromoAndUsage(db, code, customerId)
  if (!loaded) {
    return { ok: false, reason: 'not_found', message: 'That promo code does not exist.' }
  }

  return applyPromoCode({
    promo: loaded.promo,
    usage: loaded.usage,
    todayLondon: londonToday(now),
    customerId,
    lines,
  })
}
