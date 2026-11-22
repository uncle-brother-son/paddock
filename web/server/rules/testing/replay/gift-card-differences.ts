import type { AllowedDifference } from './compare'

/*
 * W38 (brief item 5; F-plan 4.12 items 3 and 4): the gift card golden families (W36's recordings) through the Worker's
 * routes, driven as the screens press them, and the only differences allowed in each, every one tied to a decision. A
 * scenario not named in W38_DIFFERENCES must match its golden file exactly; an allowance that stops being needed
 * fails (compareRecordings).
 *
 * Each named difference is pinned: every path it allows carries the one value the new routes give there, so a path
 * that differs in any other way is not allowed. Written by hand from a dump of the replay's raw differences
 * (briefs/W38-logs/gift-card-differences-second-pass.jsonl, staff app repo), each read against the design.
 */

/**
 * W38's golden families: extend (with FB13 to FB15), picked up and shipped, the list and the history (W36's
 * recordings). FB16's recording calls reads that later slices move, on a scenario that stops at the first refusal:
 * gift-card-replay.test.ts holds the switched reads on its seed instead.
 */
export const isW38Scenario = (name: string): boolean => /^w36-(gift-card-|gift-cards-|fb(13|14|15)-)/.test(name)

/** The scenario that records the same press sent twice (FB15): the dialog now sends the second under the first's key. */
export const REPEATED_PRESS_SCENARIOS: ReadonlySet<string> = new Set(['w36-fb15-extend-pressed-twice-adds-twice'])

const W38 = 'Brief W38 (F-plan 4.6)'
const AS_DATA = `${W38}; F-plan 4.2 item 5 (refusals come back in the old result shape, with the old words)`
const STAFF_FIRST = `${W38}; F-plan 4.2 item 3 (every /api/v1/staff route refuses someone with no staff record or an inactive account before anything else, as steps C to E)`

type Matcher = (value: unknown) => boolean
/** The path holds nothing on the new side (the old side's value is gone). */
const GONE: Matcher = (value) => value === undefined || value === null
type Pin = string | number | boolean | Matcher

const escaped = (path: string): string => path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** One named difference whose every path is pinned to the value the new routes give there. A path that isn't listed is not allowed. */
function pinned(name: string, decision: string, pins: ReadonlyArray<readonly [string, Pin]>): AllowedDifference {
  const byPath = new Map(pins)
  return {
    name,
    decision,
    path: new RegExp(`^(${pins.map(([path]) => escaped(path)).join('|')})$`),
    actual: (value, _expected, path) => {
      const pin = byPath.get(path)
      if (pin === undefined) return false
      return typeof pin === 'function' ? pin(value) : value === pin
    },
  }
}

export const NO_STAFF_RECORD_WORDS = "No staff record matches the logged-in user's email (jo@example.com). Ask an admin to add you as staff before performing this action."
export const INACTIVE_WORDS = 'This staff account is inactive. Ask an admin to reactivate it.'
/** Q46's sentence for a card voided by its order's refund (gift-cards/failure-messages.ts; the replay test holds the two together). */
export const VOIDED_BY_REFUND_WORDS = "This gift card was voided because its order was refunded, so it can't be reactivated or extended. Its value was refunded with the order: check the order for where it went."

/** The pins of one answer that the old function threw and the wrapper now gives as data, with the same words. */
const asData = (index: number, message: string): ReadonlyArray<readonly [string, Pin]> => [
  [`.results[${index}].thrown`, GONE],
  [`.results[${index}].updated`, false],
  [`.results[${index}].reason`, 'permission_denied'],
  [`.results[${index}].message`, message],
]

// --- Who may

const EXTEND_NO_STAFF_RECORD = pinned(
  'No staff record: refused with the words every staff route gives for it, where the old function said the Issue refunds sentence (it took a missing record for a missing permission). Still `permission_denied`, nothing changed',
  STAFF_FIRST,
  [['.results[0].message', NO_STAFF_RECORD_WORDS]]
)
const EXTEND_INACTIVE = pinned('An inactive account: the extension is refused as data (`permission_denied`, the same words), where the old function threw them', STAFF_FIRST, asData(0, INACTIVE_WORDS))
const FLAGS_INACTIVE = pinned(
  'An inactive account: picked up and shipped are each refused as data (`permission_denied`, the same words), where the old functions threw them. Neither card is touched',
  `${STAFF_FIRST}; ${AS_DATA}`,
  [...asData(0, INACTIVE_WORDS), ...asData(1, INACTIVE_WORDS)]
)

// --- Wayne's two decisions, and the bugs (F-plan section 3; the W36 report for FB24)

/**
 * Q47 (FB14). A card that expired on 1 November, extended by a month on 10 November: the old function added the
 * month to the stored expiry (1 December); now a card that has already expired counts from today (10 December).
 */
const Q47_JUST_EXPIRED = pinned(
  "Wayne's Q47 (bug FB14): a card that has already expired counts the months from today. Expired on 1 November and extended by a month on 10 November, it now expires on 10 December. (The old code added the month to the old expiry: 1 December.)",
  `Wayne's Q47, 15 Nov (bug FB14, F-plan section 3); ${W38}; brief W38 item 1`,
  [
    ['.results[0].giftCard.expiry_date', '2026-12-10'],
    ['.tables.gift_cards.changed[0].expiry_date[1]', '2026-12-10'],
  ]
)

/** Q47 (FB14). Expired 14 months ago, extended by a month: the old function left it expired by 13 and said it worked. */
const Q47_LONG_EXPIRED = pinned(
  "Wayne's Q47 (bug FB14 is closed): a card that expired 14 months ago and is extended by a month on 10 November now expires on 10 December, a month from today. (The old code left it expiring on 10 October 2025, still expired by 13 months, and told staff it had worked.)",
  `Wayne's Q47, 15 Nov (bug FB14, F-plan section 3); ${W38}; brief W38 item 1`,
  [
    ['.results[0].giftCard.expiry_date', '2026-12-10'],
    ['.tables.gift_cards.changed[0].expiry_date[1]', '2026-12-10'],
  ]
)

/**
 * Q46 (FB13). A £60 card is bought on a card and its order refunded (£60 back to the buyer, the gift card voided).
 * The old function reactivated it, and £20 of it then paid for a booking: £60 given back and £20 spent. Now the
 * reactivation is refused with the reason why, the card stays voided as the refund left it (£60, expiring as it was
 * issued), and New Order refuses to take it.
 */
const Q46_A_REFUNDED_CARD_STAYS_VOIDED = pinned(
  "Wayne's Q46 (bug FB13 is closed): a card voided because its order was refunded can't be reactivated. The press is refused (`voided_by_refund`, with the reason in words), the card stays voided with its £60 and its date as the refund left it, and New Order then refuses to take it (`gift_card_voided`): no order, booking, place or redemption. (The old code un-voided it after £60 had gone back to the buyer, and £20 of it was spent.)",
  `Wayne's Q46, 15 Nov (bug FB13, F-plan section 3); ${W38}; brief W38 item 1`,
  [
    ['.results[2].updated', false],
    ['.results[2].giftCard', GONE],
    ['.results[2].reason', 'voided_by_refund'],
    ['.results[2].message', VOIDED_BY_REFUND_WORDS],
    // New Order, with the voided card.
    ['.results[3].success', false],
    ['.results[3].orderId', GONE],
    ['.results[3].bookingId', GONE],
    ['.results[3].cardCharged', GONE],
    ['.results[3].cardAmount', GONE],
    ['.results[3].giftCardRedeemedAmount', GONE],
    ['.results[3].paymentMethodUsed', GONE],
    ['.results[3].stage', 'validation'],
    ['.results[3].reason', 'gift_card_voided'],
    // Nothing of the booking exists, and the card is as the refund left it.
    ['.tables.booking_guests', GONE],
    ['.tables.bookings', GONE],
    ['.tables.gift_card_redemptions', GONE],
    ['.tables.sessions', GONE],
    ['.tables.order_line_items.added[1]', GONE],
    ['.tables.orders.added[1]', GONE],
    ['.tables.gift_cards.added[0].remaining_balance', '60.00'],
    ['.tables.gift_cards.added[0].expiry_date', '2027-11-10'],
    ['.tables.gift_cards.added[0].voided', true],
  ]
)

/** FB15. The same month pressed twice added two. The dialog now sends the second press under the first's key: one month, once. */
const FB15_ONE_PRESS_EXTENDS_ONCE = pinned(
  "Bug FB15 is closed: the press has a key, so the same month sent again gets the first press's answer (1 February 2030) and adds nothing more, and the extension has its audit row (who, the old and the new date). (The old code added the month twice: 1 March 2030, with no record of who.)",
  `Bug FB15 (F-plan section 3); ${W38}; brief W38 item 1 (press key; an audit row with the old and new date and who); F-plan 4.2 item 2`,
  [
    ['.results[1].giftCard.expiry_date', '2030-02-01'],
    ['.tables.gift_cards.changed[0].expiry_date[1]', '2030-02-01'],
  ]
)

const refusedFlag = (index: number): ReadonlyArray<readonly [string, Pin]> => [
  [`.results[${index}].updated`, false],
  [`.results[${index}].giftCard`, GONE],
  [`.results[${index}].reason`, 'permission_denied'],
  [`.results[${index}].message`, NO_STAFF_RECORD_WORDS],
]

/**
 * FB24. Someone signed in with no staff record couldn't set a flag (nobody to record) but could clear one: a card
 * marked collected, and one marked shipped, each went back to "not" with nothing recorded. Now all four presses are
 * refused before anything is read, and both cards stay as they were.
 */
const FB24_NO_STAFF_RECORD_CHANGES_NOTHING = pinned(
  'Bug FB24 is closed: someone with no staff record is refused on every press, setting or clearing (`permission_denied`, the words every staff route gives), and both cards stay marked collected and shipped. (The old code refused the two that set a flag, by throwing, and let the two that clear one through: both flags cleared, nothing recorded.)',
  `Bug FB24 (W36 report, "For the Worker step"); ${W38}; brief W38 item 2 (anyone without an active staff record refused, setting or clearing)`,
  [...asData(0, NO_STAFF_RECORD_WORDS), ...refusedFlag(1), ...asData(2, NO_STAFF_RECORD_WORDS), ...refusedFlag(3), ['.tables.gift_cards', GONE]]
)

/** Wayne's two decisions and the two bugs W38's recordings hold, with the recordings of what the old code did. */
export const DECISION_SCENARIOS = {
  Q46: ['w36-fb13-a-card-voided-by-its-refund-is-reactivated-and-spent'],
  Q47: ['w36-gift-card-extend-a-card-that-has-just-expired', 'w36-fb14-a-long-expired-card-is-still-expired-after-extend'],
  FB15: ['w36-fb15-extend-pressed-twice-adds-twice'],
  FB24: ['w36-gift-card-flags-with-no-staff-record'],
} as const

export const W38_DIFFERENCES: ReadonlyMap<string, readonly AllowedDifference[]> = new Map<string, readonly AllowedDifference[]>([
  ['w36-gift-card-extend-refused-no-staff-record', [EXTEND_NO_STAFF_RECORD]],
  ['w36-gift-card-extend-refused-inactive-staff', [EXTEND_INACTIVE]],
  ['w36-gift-card-flags-refused-inactive-staff', [FLAGS_INACTIVE]],
  [DECISION_SCENARIOS.Q46[0], [Q46_A_REFUNDED_CARD_STAYS_VOIDED]],
  [DECISION_SCENARIOS.Q47[0], [Q47_JUST_EXPIRED]],
  [DECISION_SCENARIOS.Q47[1], [Q47_LONG_EXPIRED]],
  [DECISION_SCENARIOS.FB15[0], [FB15_ONE_PRESS_EXTENDS_ONCE]],
  [DECISION_SCENARIOS.FB24[0], [FB24_NO_STAFF_RECORD_CHANGES_NOTHING]],
  [
    'w36-gift-cards-list-and-search',
    [
      {
        name: 'W58: each listed card says why Reactivate would be refused (`reactivate_refused`, Q46\'s words), null for every card here (none was voided by a refund or moved to store credit)',
        decision: 'Brief W58 (W45 audit row 12, W38 call 3 and review L4)',
        path: /^\.results\[\d+\]\[\d+\]\.reactivate_refused$/,
        actual: (value) => value === null,
      },
    ],
  ],
])
