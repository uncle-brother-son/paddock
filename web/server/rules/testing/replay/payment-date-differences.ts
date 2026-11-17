import type { AllowedDifference } from './compare'

/*
 * W41 (brief item 8; F-plan 4.12 items 3 and 4): the payment date family (W36's recordings: every refusal, each
 * success, and bugs FB1 to FB4) through the Worker's routes, driven as the dialog presses them, and the only
 * differences allowed in each, every one tied to a decision. A scenario not named in W41_DIFFERENCES must match its
 * golden file exactly (25 of the 42 do); an allowance that stops being needed fails (compareRecordings).
 *
 * Each named difference is pinned: every path it allows carries the one value the new routes give there (an object,
 * such as a Stripe call or a table's rows, is pinned whole, as its JSON), so a path that differs in any other way is
 * not allowed. Written from a dump of the replay's raw differences (briefs/W41-logs/payment-date-differences-second-pass.jsonl,
 * staff app repo), each read against the design; the names and decisions are by hand.
 *
 * Q10 (lead call L8) has no recording of its own (the old code had no such guard): payment-date-replay.test.ts
 * replays the plain change with a card order on hold and names the refusal there (Q10_DIFFERENCE).
 */

/** W41's golden family: every payment date scenario W36 recorded (its refusals, successes and bugs FB1 to FB4). */
export const isW41Scenario = (name: string): boolean => /^w36-(payment-date-|fb[1-4]-payment-date-)/.test(name)

const W41 = 'Brief W41 (F-plan 4.4)'
const STAFF_FIRST = `${W41}; bug FB20 (F-plan section 3: the permission comes from the signed-in staff member; every /api/v1/staff route refuses someone with no staff record or an inactive account before anything else, as steps C to E)`
const INACTIVE = `${STAFF_FIRST}; bug FB16 (every read refuses an inactive or unknown staff member)`
const LOCKS = `${W41}, P1 (the customer's lock, then the membership's; one pending record per membership at a time); F-plan 4.12 item 7 (R4's form: two presses at once, on real Postgres)`
const NO_EXPIRY = `Brief W41 item 4; ${W41}: "A pending row holds the membership until it is settled… There is no 15-minute expiry any more; reconcile ends it"`
const NOT_MOVED = `${W41}, S2; memberships/failure-messages.ts, "What is NOT moved" (words that only describe a state the Worker's version can't leave)`
const FB1 = `Bug FB1 (F-plan section 3): the record is written first, the key comes from it, an unclear charge is held and reconciled, never sent again; ${W41}`
const FB2 = `Bug FB2 (F-plan section 3): the order, the date and the record in one transaction; reconcile finishes one that stopped; ${W41}, P2`
const FB3 = `Bug FB3 (F-plan section 3): a keyed compensation refund on step E's watched path; a refund that fails is listed; ${W41}, S3`
const FB4 = `Bug FB4 (F-plan section 3); Wayne's Q18 (every money action sends the amount staff saw); ${W41}, P1`
const NO_ANSWER = `W20a's rule (a press with no answer keeps its key; the same press again gets the first's answer); bug FB2; ${W41}`
const KEYS = `${W41}, S2 and S3; F-plan 4.2 item 4 (Stripe after the transaction, under a key from the record's id); bug FB1`
/** Lead call L8 (17 Nov: yes): Q10's guard applies to the payment date change, a saved-card charge like any other. */
const RENEWAL_DAY = "Brief W41a item 5 (Wayne, 17 Nov 2026): refused when the next renewal date is today or earlier in London, as W40a's cancel; W41 review B1 (a date moved over a month about to be paid for)"

export const Q10 = `Wayne's Q10 (W03-decisions), lead call L8 (F-plan section 6; lead, 17 Nov: yes); ${W41}, P1`

type Matcher = (value: unknown) => boolean
/** The path holds nothing on the new side (the old side's value is gone). */
const GONE: Matcher = (value) => value === undefined || value === null
/** The path holds exactly this, as JSON: a whole Stripe call, or a table's rows. */
const same =
  (json: string): Matcher =>
  (value) =>
    JSON.stringify(value) === json
type Pin = string | number | boolean | Matcher

const escaped = (path: string): string => path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** One named difference whose every path is pinned to the value the new routes give there. A path that isn't listed is not allowed. */
export function pinned(name: string, decision: string, pins: ReadonlyArray<readonly [string, Pin]>): AllowedDifference {
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

const keys = (pins: ReadonlyArray<readonly [string, Pin]>): AllowedDifference =>
  pinned(
    'Every Stripe call of a payment date change is sent under a key from its record (`<changeId>:charge`, `:move`, `:refund`), and the charge and the refund name the record (`metadata.change_id`). The old route\'s calls had no key and no record to name',
    KEYS,
    pins
  )

/** The scenarios each decision is named on, for the replay test. */
export const W41_DECISION_SCENARIOS = {
  FB1: ['w36-fb1-payment-date-worker-dies-after-the-charge-then-pressed-again'],
  FB2: ['w36-fb2-payment-date-charged-and-moved-then-recording-fails', 'w36-fb2-payment-date-charged-and-moved-then-nothing-can-be-recorded'],
  FB3: ['w36-fb3-payment-date-move-refused-and-the-refund-fails', 'w36-payment-date-move-refused-and-the-charge-refunded'],
  FB4_Q18: ['w36-fb4-payment-date-the-figure-changes-between-the-quote-and-the-press'],
} as const

/**
 * Q10 on the plain change (w36-payment-date-change-17-days-on) with a card order on hold for the customer: the press
 * is refused with the order's own words before anything is asked of Stripe or written.
 */
export const Q10_WORDS = 'This customer has an order still being processed. Check the Orders page before trying again.'

/** W41a item 5: what the quote and the press say on the renewal day, and after it while the renewal is overdue. */
export const RENEWAL_DUE_WORDS = "Today's payment for this membership hasn't gone through yet, so its payment date can't be changed until it has. Try again after the payment."

export const W41_DIFFERENCES: ReadonlyMap<string, readonly AllowedDifference[]> = new Map<string, readonly AllowedDifference[]>([
  [
    "w36-payment-date-refused-the-renewal-is-overdue",
    [
      pinned(
        'The renewal day (W41a): a payment date change on a membership whose renewal is due today or overdue is refused in plain words that say what to do, in the quote and the press, where the old code said only "The renewal payment is overdue" (and took a press on the day itself). Nothing is written and Stripe is asked nothing, as before',
        RENEWAL_DAY,
        [
          [".results[0].refusal", RENEWAL_DUE_WORDS],
          [".results[1].refusal", RENEWAL_DUE_WORDS],
          [".results[2].message", RENEWAL_DUE_WORDS],
        ]
      ),
    ],
  ],
  [
    "w36-payment-date-refused-no-staff-record",
    [
      pinned(
        "No staff record: refused before anything else, in the Worker's own words for it, where the old function (which read the permission itself) said Issue refunds was needed. Nothing changed",
        STAFF_FIRST,
        [
          [".results[0].message", "No staff record matches the logged-in user's email (jo@example.com). Ask an admin to add you as staff before performing this action."],
        ]
      ),
    ],
  ],
  [
    "w36-payment-date-refused-inactive-staff",
    [
      pinned(
        "An inactive account: the quote is refused too (the old quote checked nobody: FB16), and the press is refused as data with the same words, where the old function threw them. Nothing changed",
        INACTIVE,
        [
          [".results[0].membershipId", GONE],
          [".results[0].customerId", GONE],
          [".results[0].planId", GONE],
          [".results[0].stripeSubscriptionId", GONE],
          [".results[0].refusal", GONE],
          [".results[0].needsOverride", GONE],
          [".results[0].lastChangedAt", GONE],
          [".results[0].currentRenewalDate", GONE],
          [".results[0].earliestDate", GONE],
          [".results[0].latestDate", GONE],
          [".results[0].daysInPeriod", GONE],
          [".results[0].monthlyPrice", GONE],
          [".results[0].cardLast4", GONE],
          [".results[0].cardBrand", GONE],
          [".results[0].newRenewalDate", GONE],
          [".results[0].extraDays", GONE],
          [".results[0].amount", GONE],
          [".results[0].thrown", "This staff account is inactive. Ask an admin to reactivate it. (FORBIDDEN)"],
          [".results[1].thrown", GONE],
          [".results[1].changed", false],
          [".results[1].message", "This staff account is inactive. Ask an admin to reactivate it."],
        ]
      ),
    ],
  ],
  [
    "w36-payment-date-change-inside-six-months-with-the-override",
    [
      keys([
        [".stripeCalls[1].params.metadata.change_id", "membership_payment_date_changes#1"],
        [".stripeCalls[1].idempotencyKey", "membership_payment_date_changes#1:charge"],
        [".stripeCalls[2].idempotencyKey", "membership_payment_date_changes#1:move"],
      ]),
    ],
  ],
  [
    "w36-payment-date-change-after-six-months-needs-no-override",
    [
      keys([
        [".stripeCalls[1].params.metadata.change_id", "membership_payment_date_changes#1"],
        [".stripeCalls[1].idempotencyKey", "membership_payment_date_changes#1:charge"],
        [".stripeCalls[2].idempotencyKey", "membership_payment_date_changes#1:move"],
      ]),
    ],
  ],
  [
    "w36-payment-date-change-17-days-on",
    [
      keys([
        [".stripeCalls[1].params.metadata.change_id", "membership_payment_date_changes#1"],
        [".stripeCalls[1].idempotencyKey", "membership_payment_date_changes#1:charge"],
        [".stripeCalls[2].idempotencyKey", "membership_payment_date_changes#1:move"],
      ]),
    ],
  ],
  [
    "w36-payment-date-change-then-a-second-is-refused-until-the-new-date",
    [
      keys([
        [".stripeCalls[1].params.metadata.change_id", "membership_payment_date_changes#1"],
        [".stripeCalls[1].idempotencyKey", "membership_payment_date_changes#1:charge"],
        [".stripeCalls[2].idempotencyKey", "membership_payment_date_changes#1:move"],
      ]),
    ],
  ],
  [
    "w36-payment-date-refused-a-second-press-while-the-first-is-running",
    [
      pinned(
        "Two presses at once. The recording slips a second press's pending row in between the old function's read and its insert, which only its own statements allowed. The Worker's P1 holds the customer's and the membership's locks from before its read to its insert, so nothing can come between them, and the recorded hook never fires: this press goes through as a plain change. What a real second press meets (it waits, then finds the pending record and is refused, with one charge in all) is proved on real Postgres in memberships/payment-date-postgres.test.ts",
        LOCKS,
        [
          [".results[0].changed", true],
          [".results[0].message", GONE],
          [".results[0].newRenewalDate", "2026-12-27"],
          [".results[0].extraDays", 17],
          [".results[0].amountCharged", 21.94],
          [".results[0].paymentIntentId", "pi_fake_0003"],
          [".results[0].orderId", "orders#1"],
          [".stripeCalls[0]", same("{\"method\":\"subscriptions.retrieve\",\"params\":{\"id\":\"sub_mo\"},\"idempotencyKey\":null}")],
          [".stripeCalls[1]", same("{\"method\":\"paymentIntents.create\",\"params\":{\"amount\":2194,\"currency\":\"gbp\",\"customer\":\"cus_member\",\"payment_method\":\"pm_member\",\"off_session\":true,\"confirm\":true,\"description\":\"Payment date change: 17 extra days\",\"metadata\":{\"purpose\":\"membership_payment_date_change\",\"stripe_subscription_id\":\"sub_mo\",\"membership_id\":\"10000000-0000-4000-8000-000000000010\",\"new_renewal_date\":\"2026-12-27\",\"change_id\":\"membership_payment_date_changes#1\"}},\"idempotencyKey\":\"membership_payment_date_changes#1:charge\"}")],
          [".stripeCalls[2]", same("{\"method\":\"subscriptions.update\",\"params\":{\"id\":\"sub_mo\",\"trial_end\":1798329600,\"proration_behavior\":\"none\"},\"idempotencyKey\":\"membership_payment_date_changes#1:move\"}")],
          [".tables.membership_payment_date_changes.added[0].stripe_payment_intent_id", "pi_fake_0003"],
          [".tables.membership_payment_date_changes.added[0].order_id", "orders#1"],
          [".tables.membership_payment_date_changes.added[0].status", "done"],
          [".tables.customer_memberships", same("{\"added\":[],\"changed\":[{\"id\":\"10000000-0000-4000-8000-000000000010\",\"next_renewal_date\":[\"2026-12-10\",\"2026-12-27\"]}],\"removed\":[],\"tied\":0}")],
          [".tables.order_line_items", same("{\"added\":[{\"id\":\"order_line_items#1\",\"order_id\":\"orders#1\",\"booking_id\":null,\"product_variant_id\":null,\"membership_plan_id\":\"10000000-0000-4000-8000-00000000000a\",\"session_pass_type_id\":null,\"gift_card_id\":null,\"item_type\":\"membership\",\"quantity\":1,\"unit_price\":\"21.94\",\"line_total\":\"21.94\",\"created_at\":\"<set>\",\"addon_id\":null,\"refunded_at\":null,\"refund_method\":null,\"restocked\":null,\"fulfillment_status\":null,\"card_refunded_amount\":\"0.00\",\"system_unit_price\":null,\"price_override_reason\":null,\"discount_amount\":\"0.00\",\"event_booking_id\":null}],\"changed\":[],\"removed\":[],\"tied\":0}")],
          [".tables.orders", same("{\"added\":[{\"id\":\"orders#1\",\"customer_id\":\"10000000-0000-4000-8000-00000000000f\",\"order_total\":\"21.94\",\"payment_status\":\"paid\",\"stripe_payment_intent_id\":\"pi_fake_0003\",\"promo_code\":null,\"discount_amount\":\"0.00\",\"shipping_address\":null,\"shipping_status\":null,\"tracking_number\":null,\"order_source\":\"staff_created\",\"created_at\":\"<set>\",\"updated_at\":\"<set>\",\"payment_method\":\"card\",\"reader_payment\":null,\"refund_owed_amount\":\"0.00\"}],\"changed\":[],\"removed\":[],\"tied\":0}")],
        ]
      ),
    ],
  ],
  [
    "w36-payment-date-a-pending-row-stops-blocking-after-15-minutes",
    [
      pinned(
        "A pending record holds the membership until it is settled, however old: the old rule let one go after 15 minutes whatever had become of its charge, and the next press charged again. The second press is refused, nothing is asked of Stripe and nothing is written",
        NO_EXPIRY,
        [
          [".results[1].changed", false],
          [".results[1].newRenewalDate", GONE],
          [".results[1].extraDays", GONE],
          [".results[1].amountCharged", GONE],
          [".results[1].paymentIntentId", GONE],
          [".results[1].orderId", GONE],
          [".results[1].message", "A payment date change is already in progress for this membership"],
          [".stripeCalls[0]", GONE],
          [".stripeCalls[1]", GONE],
          [".stripeCalls[2]", GONE],
          [".tables.customer_memberships", GONE],
          [".tables.membership_payment_date_changes", GONE],
          [".tables.order_line_items", GONE],
          [".tables.orders", GONE],
        ]
      ),
    ],
  ],
  [
    "w36-payment-date-card-declined",
    [
      keys([
        [".stripeCalls[1].params.metadata.change_id", "membership_payment_date_changes#1"],
        [".stripeCalls[1].idempotencyKey", "membership_payment_date_changes#1:charge"],
        [".stripeCalls[3].params.metadata.change_id", "membership_payment_date_changes#2"],
        [".stripeCalls[3].idempotencyKey", "membership_payment_date_changes#2:charge"],
        [".stripeCalls[4].idempotencyKey", "membership_payment_date_changes#2:move"],
      ]),
    ],
  ],
  [
    "w36-payment-date-card-needs-authentication",
    [
      keys([
        [".stripeCalls[1].params.metadata.change_id", "membership_payment_date_changes#1"],
        [".stripeCalls[1].idempotencyKey", "membership_payment_date_changes#1:charge"],
      ]),
    ],
  ],
  [
    "w36-payment-date-declined-and-the-attempt-cannot-be-marked-failed",
    [
      pinned(
        "Declined, and the record can't be marked failed: the refusal is the whole answer (nothing was charged). The old words' tail, \"(The attempt could not be marked failed: …)\", is gone: the record stays pending, holds the membership, and reconcile ends it once Stripe shows no payment for it",
        NOT_MOVED,
        [
          [".results[0].message", "The card was declined: Your card was declined. Nothing was charged and the payment date has not changed."],
        ]
      ),
      keys([
        [".stripeCalls[1].params.metadata.change_id", "membership_payment_date_changes#1"],
        [".stripeCalls[1].idempotencyKey", "membership_payment_date_changes#1:charge"],
      ]),
    ],
  ],
  [
    "w36-payment-date-move-refused-and-the-charge-refunded",
    [
      pinned(
        "The date move refused and the charge refunded: the failed record now names the payment that was taken and given back (the old record held none), and the refund is watched",
        FB3,
        [
          [".tables.membership_payment_date_changes.added[0].stripe_payment_intent_id", "pi_fake_0003"],
        ]
      ),
      keys([
        [".stripeCalls[1].params.metadata.change_id", "membership_payment_date_changes#1"],
        [".stripeCalls[1].idempotencyKey", "membership_payment_date_changes#1:charge"],
        [".stripeCalls[2].idempotencyKey", "membership_payment_date_changes#1:move"],
        [".stripeCalls[3].params.metadata", same("{\"change_id\":\"membership_payment_date_changes#1\",\"refund_key\":\"membership_payment_date_changes#1:refund\",\"reason\":\"payment_date_not_moved\"}")],
        [".stripeCalls[3].idempotencyKey", "membership_payment_date_changes#1:refund"],
      ]),
    ],
  ],
  [
    "w36-fb3-payment-date-move-refused-and-the-refund-fails",
    [
      pinned(
        "Bug FB3 is closed. The date move is refused and the refund gets no clear answer: the old answer was \"refund it in Stripe\" with the record failed and nothing listed. Now the refund is sent once more under the same key, the change is held (the record stays pending, with its payment named), staff are told the automatic check will finish the refund, and reconcile does",
        FB3,
        [
          [".results[0].message", "Stripe refused to move the payment date (This subscription cannot be updated right now.), and the refund of the part-month charge hasn't been confirmed yet. The change is on hold and the automatic check will finish the refund: don't take payment again. Check the Orders page in a few minutes."],
          [".results[0].held", true],
          [".stripeCalls[4]", same("{\"method\":\"refunds.create\",\"params\":{\"payment_intent\":\"pi_fake_0003\",\"metadata\":{\"change_id\":\"membership_payment_date_changes#1\",\"refund_key\":\"membership_payment_date_changes#1:refund\",\"reason\":\"payment_date_not_moved\"}},\"idempotencyKey\":\"membership_payment_date_changes#1:refund\"}")],
          [".tables.membership_payment_date_changes.added[0].stripe_payment_intent_id", "pi_fake_0003"],
          [".tables.membership_payment_date_changes.added[0].status", "pending"],
          [".tables.membership_payment_date_changes.added[0].failure_message", GONE],
        ]
      ),
      keys([
        [".stripeCalls[1].params.metadata.change_id", "membership_payment_date_changes#1"],
        [".stripeCalls[1].idempotencyKey", "membership_payment_date_changes#1:charge"],
        [".stripeCalls[2].idempotencyKey", "membership_payment_date_changes#1:move"],
        [".stripeCalls[3].params.metadata", same("{\"change_id\":\"membership_payment_date_changes#1\",\"refund_key\":\"membership_payment_date_changes#1:refund\",\"reason\":\"payment_date_not_moved\"}")],
        [".stripeCalls[3].idempotencyKey", "membership_payment_date_changes#1:refund"],
      ]),
    ],
  ],
  [
    "w36-fb1-payment-date-worker-dies-after-the-charge-then-pressed-again",
    [
      pinned(
        "Bug FB1 is closed. The Worker dies after the charge: the old record was marked failed (\"check Stripe\"), held nothing, and the second press charged £21.94 again. Now the first press is held (the record stays pending with its payment named), the second press is refused while it is, nothing more is asked of Stripe, and £21.94 is taken once",
        FB1,
        [
          [".results[0].message", "The card payment went through, but the change couldn't be finished. It's on hold: don't take payment again. Check the Orders page in a few minutes."],
          [".results[0].held", true],
          [".results[1].changed", false],
          [".results[1].newRenewalDate", GONE],
          [".results[1].extraDays", GONE],
          [".results[1].amountCharged", GONE],
          [".results[1].paymentIntentId", GONE],
          [".results[1].orderId", GONE],
          [".results[1].message", "A payment date change is already in progress for this membership"],
          [".stripeCalls[2]", GONE],
          [".stripeCalls[3]", GONE],
          [".stripeCalls[4]", GONE],
          [".tables.customer_memberships", GONE],
          [".tables.membership_payment_date_changes.added[0].stripe_payment_intent_id", "pi_fake_0003"],
          [".tables.membership_payment_date_changes.added[0].status", "pending"],
          [".tables.membership_payment_date_changes.added[0].failure_message", GONE],
          [".tables.membership_payment_date_changes.added[1]", GONE],
          [".tables.order_line_items", GONE],
          [".tables.orders", GONE],
        ]
      ),
      keys([
        [".stripeCalls[1].params.metadata.change_id", "membership_payment_date_changes#1"],
        [".stripeCalls[1].idempotencyKey", "membership_payment_date_changes#1:charge"],
      ]),
    ],
  ],
  [
    "w36-payment-date-answer-lost-after-everything-then-pressed-again",
    [
      pinned(
        "The Worker did everything and its answer was lost. The old record was marked failed with nothing written, and the second press met Stripe's no-charge period. Now the charge, the date, the order and the record are one route: the first press gets the staff app's no-answer words and keeps its key, and the same press again gets the first press's answer, with the order written once",
        NO_ANSWER,
        [
          [".results[0].message", "The change didn't get an answer, so the card may or may not have been charged and the payment date may or may not have moved. Don't take the payment another way: press again here (it won't charge twice), or close this and check the membership's payment date and the Orders page first."],
          [".results[0].noAnswer", true],
          [".results[1].changed", true],
          [".results[1].message", GONE],
          [".results[1].newRenewalDate", "2026-12-27"],
          [".results[1].extraDays", 17],
          [".results[1].amountCharged", 21.94],
          [".results[1].paymentIntentId", "pi_fake_0003"],
          [".results[1].orderId", "orders#1"],
          [".stripeCalls[3]", GONE],
          [".tables.membership_payment_date_changes.added[0].stripe_payment_intent_id", "pi_fake_0003"],
          [".tables.membership_payment_date_changes.added[0].order_id", "orders#1"],
          [".tables.membership_payment_date_changes.added[0].status", "done"],
          [".tables.membership_payment_date_changes.added[0].failure_message", GONE],
          [".tables.membership_payment_date_changes.added[1]", GONE],
          [".tables.customer_memberships", same("{\"added\":[],\"changed\":[{\"id\":\"10000000-0000-4000-8000-000000000010\",\"next_renewal_date\":[\"2026-12-10\",\"2026-12-27\"]}],\"removed\":[],\"tied\":0}")],
          [".tables.order_line_items", same("{\"added\":[{\"id\":\"order_line_items#1\",\"order_id\":\"orders#1\",\"booking_id\":null,\"product_variant_id\":null,\"membership_plan_id\":\"10000000-0000-4000-8000-00000000000a\",\"session_pass_type_id\":null,\"gift_card_id\":null,\"item_type\":\"membership\",\"quantity\":1,\"unit_price\":\"21.94\",\"line_total\":\"21.94\",\"created_at\":\"<set>\",\"addon_id\":null,\"refunded_at\":null,\"refund_method\":null,\"restocked\":null,\"fulfillment_status\":null,\"card_refunded_amount\":\"0.00\",\"system_unit_price\":null,\"price_override_reason\":null,\"discount_amount\":\"0.00\",\"event_booking_id\":null}],\"changed\":[],\"removed\":[],\"tied\":0}")],
          [".tables.orders", same("{\"added\":[{\"id\":\"orders#1\",\"customer_id\":\"10000000-0000-4000-8000-00000000000f\",\"order_total\":\"21.94\",\"payment_status\":\"paid\",\"stripe_payment_intent_id\":\"pi_fake_0003\",\"promo_code\":null,\"discount_amount\":\"0.00\",\"shipping_address\":null,\"shipping_status\":null,\"tracking_number\":null,\"order_source\":\"staff_created\",\"created_at\":\"<set>\",\"updated_at\":\"<set>\",\"payment_method\":\"card\",\"reader_payment\":null,\"refund_owed_amount\":\"0.00\"}],\"changed\":[],\"removed\":[],\"tied\":0}")],
        ]
      ),
      keys([
        [".stripeCalls[1].params.metadata.change_id", "membership_payment_date_changes#1"],
        [".stripeCalls[1].idempotencyKey", "membership_payment_date_changes#1:charge"],
        [".stripeCalls[2].idempotencyKey", "membership_payment_date_changes#1:move"],
      ]),
    ],
  ],
  [
    "w36-fb2-payment-date-charged-and-moved-then-recording-fails",
    [
      pinned(
        "Bug FB2 is closed. Charged and moved in Stripe, then the order can't be written: the old answer was \"success\" with a warning to add an order by hand. Now P2 is one transaction: nothing is half recorded, the press is held (the record stays pending), and reconcile writes the order, the new date and the record together",
        FB2,
        [
          [".results[0].changed", false],
          [".results[0].newRenewalDate", GONE],
          [".results[0].extraDays", GONE],
          [".results[0].amountCharged", GONE],
          [".results[0].paymentIntentId", GONE],
          [".results[0].orderId", GONE],
          [".results[0].warning", GONE],
          [".results[0].message", "The card payment went through, but the change couldn't be finished. It's on hold: don't take payment again. Check the Orders page in a few minutes."],
          [".results[0].held", true],
          [".tables.membership_payment_date_changes.added[0].status", "pending"],
          [".tables.membership_payment_date_changes.added[0].failure_message", GONE],
        ]
      ),
      keys([
        [".stripeCalls[1].params.metadata.change_id", "membership_payment_date_changes#1"],
        [".stripeCalls[1].idempotencyKey", "membership_payment_date_changes#1:charge"],
        [".stripeCalls[2].idempotencyKey", "membership_payment_date_changes#1:move"],
      ]),
    ],
  ],
  [
    "w36-fb2-payment-date-charged-and-moved-then-nothing-can-be-recorded",
    [
      pinned(
        "Bug FB2 is closed. Charged and moved in Stripe, then the record can't be written: the old answer was \"success\" with a longer list to fix by hand. Now P2 is one transaction: nothing is half recorded, the press is held, and reconcile finishes it",
        FB2,
        [
          [".results[0].changed", false],
          [".results[0].newRenewalDate", GONE],
          [".results[0].extraDays", GONE],
          [".results[0].amountCharged", GONE],
          [".results[0].paymentIntentId", GONE],
          [".results[0].orderId", GONE],
          [".results[0].warning", GONE],
          [".results[0].message", "The card payment went through, but the change couldn't be finished. It's on hold: don't take payment again. Check the Orders page in a few minutes."],
          [".results[0].held", true],
        ]
      ),
      keys([
        [".stripeCalls[1].params.metadata.change_id", "membership_payment_date_changes#1"],
        [".stripeCalls[1].idempotencyKey", "membership_payment_date_changes#1:charge"],
        [".stripeCalls[2].idempotencyKey", "membership_payment_date_changes#1:move"],
      ]),
    ],
  ],
  [
    "w36-fb4-payment-date-the-figure-changes-between-the-quote-and-the-press",
    [
      pinned(
        "Bug FB4 is closed (Q18). The dialog showed £21.94; the plan's price changed; the old press took £24.68. Now the press sends the figure it showed and is refused with the new one: nothing is charged, nothing is written, and the dialog shows £24.68 to press again",
        FB4,
        [
          [".results[1].changed", false],
          [".results[1].newRenewalDate", GONE],
          [".results[1].extraDays", GONE],
          [".results[1].amountCharged", GONE],
          [".results[1].paymentIntentId", GONE],
          [".results[1].orderId", GONE],
          [".results[1].message", "The part-month charge is now £24.68, not the £21.94 shown. Nothing was charged and the payment date has not changed. Check the new figure with the customer and press again."],
          [".results[1].amountNow", 24.68],
          [".stripeCalls[0]", GONE],
          [".stripeCalls[1]", GONE],
          [".stripeCalls[2]", GONE],
          [".tables.customer_memberships", GONE],
          [".tables.membership_payment_date_changes", GONE],
          [".tables.order_line_items", GONE],
          [".tables.orders", GONE],
        ]
      ),
    ],
  ],
])
