// Brief W76a (Wayne's WQ63): the one rule for a gift card's Other amount on the website. Whole pounds only, from the
// type's lowest to its highest. The page asks it as the customer types; the server asks it again when the basket is
// built, and only that answer counts.
//
// PURE, because it runs in the browser too (through lib/shop/gift-card-amount.ts): no 'server-only', no database, and
// nothing imported but the shop's words. A test holds that.
import { SHOP_WORDS } from './failure-messages'

/** The Other amounts a type takes, both included: money text in whole pounds ("1.00", "1000.00"). Made by `otherAmountLimits`. */
export interface OtherAmountLimits {
  lowest: string
  highest: string
}

export type OtherAmountFailure = 'not_whole_pounds' | 'below_lowest' | 'above_highest'

export type OtherAmountAnswer = { ok: true; /** Money text ("25.00"). */ amount: string } | { ok: false; reason: OtherAmountFailure; message: string }

/** A whole number of pounds, as money text. */
const moneyText = (pounds: number): string => `${pounds}.00`

/**
 * A type's limits from the staff app's settings; null when Other isn't allowed. The staff app takes pence and a lowest
 * of 0, so the limits are the whole pounds inside them, from £1. With a limit missing (the staff app saves none without
 * both), or no whole pound between them, Other isn't offered.
 */
export function otherAmountLimits(allowed: boolean, min: string | null, max: string | null): OtherAmountLimits | null {
  if (!allowed || min === null || max === null) return null
  const lowest = Math.max(1, Math.ceil(Number(min)))
  const highest = Math.floor(Number(max))
  return lowest <= highest ? { lowest: moneyText(lowest), highest: moneyText(highest) } : null
}

/** Whole pounds as a customer types them, or as the site's own words show them: "25", "£25", "25.00", "1,000". */
const WHOLE_POUNDS = /^£?(\d+|\d{1,3}(?:,\d{3})+)(?:\.0{1,2})?$/

/** The amount, or which of the three reasons it fails for, with the words the customer sees. */
export function checkOtherAmount(typed: string, limits: OtherAmountLimits): OtherAmountAnswer {
  const fails = (reason: OtherAmountFailure): OtherAmountAnswer => ({ ok: false, reason, message: SHOP_WORDS.otherAmount[reason](limits) })
  const digits = WHOLE_POUNDS.exec(typed.trim())?.[1]
  if (digits === undefined) return fails('not_whole_pounds')
  const pounds = Number(digits.replaceAll(',', ''))
  if (pounds < Number(limits.lowest)) return fails('below_lowest')
  if (pounds > Number(limits.highest)) return fails('above_highest')
  return { ok: true, amount: moneyText(pounds) }
}
