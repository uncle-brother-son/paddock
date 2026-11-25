// What the shop says when it refuses. Imports nothing: the Other amount's words run in the browser too (W76a).

/** "£1", "£1,000": the limits are whole pounds (gift-card-amount.ts). */
const wholePounds = (money: string): string => `£${Number(money).toLocaleString('en-GB')}`

/** WQ19's words, for both ends. */
const outsideLimits = ({ lowest, highest }: { lowest: string; highest: string }): string => `Enter an amount between ${wholePounds(lowest)} and ${wholePounds(highest)}`

/** The first two: what the shop's public routes say (W74a; W75a, events). Unknown and off sale read the same. */
export const SHOP_WORDS = {
  notOnSale: "This product isn't on sale.",
  eventNotOnSale: "This event isn't on sale.",
  /** W76a: a gift card's Other amount (WQ63), by the reason it fails for. Field errors, so no full stop (as WQ19 has it). */
  otherAmount: {
    not_whole_pounds: () => 'Enter an amount in whole pounds',
    below_lowest: outsideLimits,
    above_highest: outsideLimits,
  },
} as const
