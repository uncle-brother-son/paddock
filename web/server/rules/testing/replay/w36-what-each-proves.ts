// Brief W36 item 4: what each W36 scenario's steps do on the old functions today, one line per step, as
// w36.test.ts's `outcome` words it (a set-up order that went through has no line). Written from the golden files by
// that test (W36_OUTCOMES_OUT=<file>) and read through by hand before it was kept: a scenario that stops reaching the
// branch it is named for no longer matches its lines.
//
// "last day … ends …" is a cancel; "no cancellation scheduled" an undo; "quote:" the payment date quote; "payment date
// moved" the change; "session credits" and "add-on credits" an adjustment; "Herd" the Herd control; "store credit" the
// manual adjustment; "gift card expires" an extend or a flag; "N rows" and "profile:" the reads; "thrown:" an error the
// screen shows as it is; "refused:" an answer with the reason and the words staff see. "(+warning …)" marks a success
// that left something for staff to fix by hand: the half-finished states step F's one transaction removes.
export const WHAT_EACH_PROVES: Readonly<Record<string, readonly string[]>> = {
  "cancel-refused-no-membership-id": ["refused: no reason \"membershipId is required\""],
  "cancel-refused-without-issue-refunds": [
    "refused: permission_denied \"Needs the Issue refunds permission to cancel or re-activate a membership.\"",
    "refused: permission_denied \"Needs the Issue refunds permission to cancel or re-activate a membership.\"",
  ],
  "cancel-refused-no-staff-record": [
    "refused: permission_denied \"Needs the Issue refunds permission to cancel or re-activate a membership.\"",
  ],
  "cancel-refused-inactive-staff": ["thrown: This staff account is inactive. Ask an admin to reactivate it."],
  "cancel-refused-unknown-membership": [
    "refused: membership_not_found \"Membership not found\"",
    "refused: membership_not_found \"Membership not found\"",
  ],
  "cancel-monthly-after-the-minimum-term": ["last day 2026-12-09, ends 2026-12-10"],
  "cancel-monthly-inside-the-minimum-term": ["last day 2027-01-09, ends 2027-01-10"],
  "cancel-yearly": ["last day 2027-01-09, ends 2027-01-10"],
  "cancel-then-undo": [
    "last day 2026-12-09, ends 2026-12-10",
    "no cancellation scheduled",
  ],
  "cancel-with-no-subscription": [
    "last day 2026-12-09, ends 2026-12-10, no Stripe change",
    "no cancellation scheduled",
  ],
  "cancel-with-no-next-renewal-date": [
    "refused: no reason \"Internal server error: Cannot read properties of null (reading 'split')\"",
  ],
  "cancel-refused-by-stripe": ["refused: no reason \"This subscription cannot be updated right now.\""],
  "cancel-stripe-went-then-the-database-write-fails": ["refused: no reason \"Failed to update membership record\""],
  "cancel-answer-lost-then-pressed-again": [
    "refused: no reason \"socket hang up\"",
    "last day 2026-12-09, ends 2026-12-10",
  ],
  "undo-refused-by-stripe": [
    "last day 2026-12-09, ends 2026-12-10",
    "refused: no reason \"This subscription cannot be updated right now.\"",
  ],
  "undo-stripe-went-then-the-database-write-fails": [
    "last day 2026-12-09, ends 2026-12-10",
    "refused: no reason \"Failed to update membership record\"",
  ],
  "undo-answer-lost-then-pressed-again": [
    "last day 2026-12-09, ends 2026-12-10",
    "refused: no reason \"socket hang up\"",
    "no cancellation scheduled",
  ],
  "fb5-cancel-on-a-cancelled-membership": ["last day 2026-12-09, ends 2026-12-10, no Stripe change"],
  "fb5-cancel-on-a-membership-whose-payment-is-failing": ["last day 2026-12-09, ends 2026-12-10"],
  "fb5-cancel-twice": [
    "last day 2026-12-09, ends 2026-12-10",
    "last day 2026-12-09, ends 2026-12-10",
  ],
  "fb5-undo-with-no-cancel-scheduled": ["no cancellation scheduled"],
  "fb5-undo-on-a-membership-that-ended-yesterday": [
    "order refused: membership_not_found",
    "no cancellation scheduled",
  ],
  "fb5-undo-on-an-ended-subscription-is-refused-by-stripe": [
    "refused: no reason \"A canceled subscription can only update its cancellation_details and metadata.\"",
  ],
  "fb6-monthly-started-31-december-ends-3-march": ["last day 2027-03-02, ends 2027-03-03"],
  "fb6-monthly-started-31-july-ends-1-october": ["last day 2026-09-30, ends 2026-10-01"],
  "payment-date-refused-missing-params": [
    "refused: \"membershipId and newRenewalDate are required\"",
    "refused: \"membershipId and newRenewalDate are required\"",
    "null",
  ],
  "payment-date-refused-without-issue-refunds": [
    "quote: allowed, 2026-12-11 to 2027-01-09, 17 days £21.94",
    "refused: \"Needs the Issue refunds permission to change a payment date.\"",
  ],
  "payment-date-refused-no-staff-record": ["refused: \"Needs the Issue refunds permission to change a payment date.\""],
  "payment-date-refused-inactive-staff": [
    "quote: allowed, 2026-12-11 to 2027-01-09, 17 days £21.94",
    "thrown: This staff account is inactive. Ask an admin to reactivate it.",
  ],
  "payment-date-refused-unknown-membership": [
    "null",
    "refused: \"Membership not found.\"",
  ],
  "payment-date-refused-yearly": [
    "quote: refused \"Yearly memberships renew once a year, so the payment date can't be changed\", 2027-01-11 to 2027-02-09",
    "quote: refused \"Yearly memberships renew once a year, so the payment date can't be changed\", 2027-01-11 to 2027-02-09, date refused \"Choose a date from 11 Jan 2027 to 9 Feb 2027\"",
    "refused: \"Yearly memberships renew once a year, so the payment date can't be changed\"",
  ],
  "payment-date-refused-a-payment-is-failing": [
    "quote: refused \"A payment is failing on this membership\", 2026-12-11 to 2027-01-09",
    "quote: refused \"A payment is failing on this membership\", 2026-12-11 to 2027-01-09, 17 days £21.94",
    "refused: \"A payment is failing on this membership\"",
  ],
  "payment-date-refused-not-active": [
    "quote: refused \"This membership isn't active\", 2026-12-11 to 2027-01-09",
    "quote: refused \"This membership isn't active\", 2026-12-11 to 2027-01-09, 17 days £21.94",
    "refused: \"This membership isn't active\"",
  ],
  "payment-date-refused-a-cancellation-is-scheduled": [
    "quote: refused \"A cancellation is scheduled on this membership\", 2026-12-11 to 2027-01-09",
    "quote: refused \"A cancellation is scheduled on this membership\", 2026-12-11 to 2027-01-09, 17 days £21.94",
    "refused: \"A cancellation is scheduled on this membership\"",
  ],
  "payment-date-refused-the-renewal-is-overdue": [
    "quote: refused \"The renewal payment is overdue\", 2026-11-10 to 2026-12-08",
    "quote: refused \"The renewal payment is overdue\", 2026-11-10 to 2026-12-08, date refused \"Choose a date from 10 Nov 2026 to 8 Dec 2026\"",
    "refused: \"The renewal payment is overdue\"",
  ],
  "payment-date-refused-no-next-renewal-date": [
    "quote: refused \"The renewal payment is overdue\", no window",
    "quote: refused \"The renewal payment is overdue\", no window, date refused \"This membership has no next renewal date\"",
    "refused: \"The renewal payment is overdue\"",
  ],
  "payment-date-refused-payment-needed-bookings": [
    "quote: refused \"Bookings on this membership are waiting for payment (Payment needed)\", 2026-12-11 to 2027-01-09",
    "quote: refused \"Bookings on this membership are waiting for payment (Payment needed)\", 2026-12-11 to 2027-01-09, 17 days £21.94",
    "refused: \"Bookings on this membership are waiting for payment (Payment needed)\"",
  ],
  "payment-date-refused-no-subscription": [
    "quote: refused \"This membership has no Stripe subscription\", 2026-12-11 to 2027-01-09",
    "quote: refused \"This membership has no Stripe subscription\", 2026-12-11 to 2027-01-09, 17 days £21.94",
    "refused: \"This membership has no Stripe subscription\"",
  ],
  "payment-date-refused-no-saved-card": [
    "quote: refused \"The customer has no saved card for the charge\", 2026-12-11 to 2027-01-09",
    "quote: refused \"The customer has no saved card for the charge\", 2026-12-11 to 2027-01-09, 17 days £21.94",
    "refused: \"The customer has no saved card for the charge\"",
  ],
  "payment-date-refused-one-already-in-progress": [
    "quote: refused \"A payment date change is already in progress for this membership\", 2026-12-11 to 2027-01-09",
    "quote: refused \"A payment date change is already in progress for this membership\", 2026-12-11 to 2027-01-09, 17 days £21.94",
    "refused: \"A payment date change is already in progress for this membership\"",
  ],
  "payment-date-refused-the-plan-has-no-monthly-price": [
    "quote: refused \"The plan has no monthly price\", 2026-12-11 to 2027-01-09",
    "quote: refused \"The plan has no monthly price\", 2026-12-11 to 2027-01-09",
    "refused: \"The plan has no monthly price\"",
  ],
  "payment-date-refused-date-outside-the-window": [
    "quote: allowed, 2026-12-11 to 2027-01-09, date refused \"Choose a date from 11 Dec 2026 to 9 Jan 2027\"",
    "refused: \"Choose a date from 11 Dec 2026 to 9 Jan 2027\"",
    "quote: allowed, 2026-12-11 to 2027-01-09, date refused \"Choose a date from 11 Dec 2026 to 9 Jan 2027\"",
    "refused: \"Choose a date from 11 Dec 2026 to 9 Jan 2027\"",
    "quote: allowed, 2026-12-11 to 2027-01-09, date refused \"Choose a date from 11 Dec 2026 to 9 Jan 2027\"",
    "refused: \"Choose a date from 11 Dec 2026 to 9 Jan 2027\"",
    "quote: allowed, 2026-12-11 to 2027-01-09, date refused \"Choose a date from 11 Dec 2026 to 9 Jan 2027\"",
    "refused: \"Choose a date from 11 Dec 2026 to 9 Jan 2027\"",
    "quote: allowed, 2026-12-11 to 2027-01-09, 1 days £1.29",
    "quote: allowed, 2026-12-11 to 2027-01-09, 30 days £38.71",
  ],
  "payment-date-refused-the-charge-works-out-at-nothing": [
    "quote: allowed, 2026-12-11 to 2027-01-09, 1 days £0.00",
    "refused: \"The part-month charge works out at £0.00, so there is nothing to charge.\"",
  ],
  "payment-date-refused-inside-six-months-without-the-override": [
    "quote: allowed, 2026-12-11 to 2027-01-09, 17 days £21.94, needs override",
    "refused: \"The payment date was changed in the last 6 months. Tick Override and give a reason to change it again.\"",
    "refused: \"The payment date was changed in the last 6 months. Tick Override and give a reason to change it again.\"",
    "refused: \"The payment date was changed in the last 6 months. Tick Override and give a reason to change it again.\"",
  ],
  "payment-date-change-inside-six-months-with-the-override": [
    "quote: allowed, 2026-12-11 to 2027-01-09, 17 days £21.94, needs override",
    "payment date moved to 2026-12-27: £21.94 for 17 days, order written",
  ],
  "payment-date-change-after-six-months-needs-no-override": [
    "quote: allowed, 2026-12-11 to 2027-01-09, 17 days £21.94",
    "payment date moved to 2026-12-27: £21.94 for 17 days, order written",
  ],
  "payment-date-change-17-days-on": [
    "quote: allowed, 2026-12-11 to 2027-01-09",
    "quote: allowed, 2026-12-11 to 2027-01-09, 17 days £21.94",
    "payment date moved to 2026-12-27: £21.94 for 17 days, order written",
  ],
  "payment-date-change-then-a-second-is-refused-until-the-new-date": [
    "payment date moved to 2026-12-27: £21.94 for 17 days, order written",
    "quote: refused \"Changed on 10 Nov 2026. It can be changed again from 27 Dec 2026.\", 2026-12-28 to 2027-01-26, needs override",
    "refused: \"Changed on 10 Nov 2026. It can be changed again from 27 Dec 2026.\"",
  ],
  "payment-date-refused-a-second-press-while-the-first-is-running": ["refused: \"A payment date change is already in progress for this membership.\""],
  "payment-date-a-pending-row-stops-blocking-after-15-minutes": [
    "refused: \"A payment date change is already in progress for this membership\"",
    "payment date moved to 2026-12-27: £21.94 for 17 days, order written",
  ],
  "payment-date-refused-stripe-subscription-is-another-customers": [
    "quote: allowed, 2026-12-11 to 2027-01-09",
    "quote: allowed, 2026-12-11 to 2027-01-09, 17 days £21.94",
    "refused: \"The subscription doesn't belong to this customer's Stripe account\"",
  ],
  "payment-date-refused-stripe-subscription-not-active": [
    "quote: allowed, 2026-12-11 to 2027-01-09",
    "quote: allowed, 2026-12-11 to 2027-01-09, 17 days £21.94",
    "refused: \"The Stripe subscription is past_due, not active\"",
  ],
  "payment-date-refused-stripe-has-a-cancellation-scheduled": [
    "quote: allowed, 2026-12-11 to 2027-01-09",
    "quote: allowed, 2026-12-11 to 2027-01-09, 17 days £21.94",
    "refused: \"The Stripe subscription has a cancellation scheduled\"",
  ],
  "payment-date-refused-stripe-subscription-not-monthly": [
    "quote: allowed, 2026-12-11 to 2027-01-09",
    "quote: allowed, 2026-12-11 to 2027-01-09, 17 days £21.94",
    "refused: \"The Stripe subscription is not a single monthly price\"",
  ],
  "payment-date-refused-stripe-next-payment-is-on-another-date": [
    "quote: allowed, 2026-12-13 to 2027-01-11, 15 days £19.35",
    "refused: \"Stripe's next payment is on 10 Dec 2026, but the membership shows 12 Dec 2026. Refresh and try again.\"",
  ],
  "payment-date-refused-more-than-a-full-month-at-stripes-price": [
    "quote: allowed, 2026-12-11 to 2027-01-09",
    "quote: allowed, 2026-12-11 to 2027-01-09, 17 days £54.84",
    "refused: \"partMonthAmount is more than a full month at the subscription price\"",
  ],
  "payment-date-refused-stripe-cannot-read-the-subscription": ["refused: \"An error occurred with our API.\""],
  "payment-date-card-declined": [
    "refused: \"The card was declined: Your card was declined. Nothing was charged and the payment date has not changed.\"",
    "payment date moved to 2026-12-27: £21.94 for 17 days, order written",
  ],
  "payment-date-card-needs-authentication": [
    "refused: \"The card was declined: Card requires additional authentication and cannot be charged off-session. Ask the customer to complete a new payment. Nothing was charged and the payment date has not changed.\"",
  ],
  "payment-date-declined-and-the-attempt-cannot-be-marked-failed": [
    "refused: \"The card was declined: Your card was declined. Nothing was charged and the payment date has not changed. (The attempt could not be marked failed: connection lost.)\"",
  ],
  "payment-date-move-refused-and-the-charge-refunded": [
    "refused: \"This subscription cannot be updated right now.. The part-month charge was refunded in full.\"",
  ],
  "fb3-payment-date-move-refused-and-the-refund-fails": [
    "refused: \"This subscription cannot be updated right now.. The £21.94 charge (pi_fake_0003) could not be refunded automatically (An error occurred with our API.): refund it in Stripe.\"",
  ],
  "fb1-payment-date-worker-dies-after-the-charge-then-pressed-again": [
    "refused: \"socket hang up. If unsure, check Stripe for a \"Payment date change\" charge on this customer.\"",
    "payment date moved to 2026-12-27: £21.94 for 17 days, order written",
  ],
  "payment-date-answer-lost-after-everything-then-pressed-again": [
    "refused: \"socket hang up. If unsure, check Stripe for a \"Payment date change\" charge on this customer.\"",
    "refused: \"The Stripe subscription is trialing, not active\"",
  ],
  "fb2-payment-date-charged-and-moved-then-recording-fails": [
    "payment date moved to 2026-12-27: £21.94 for 17 days, order none (+warning \"The card was charged £21.94 (pi_fake_0003) and Stripe now bills on 27 Dec 2026, but recording it failed (connection lost). Fix by hand: add a paid card order for £21.94 with PaymentIntent pi_fake_0003 (one membership line), set this membership's next renewal date to 27 Dec 2026.\")",
  ],
  "fb2-payment-date-charged-and-moved-then-nothing-can-be-recorded": [
    "payment date moved to 2026-12-27: £21.94 for 17 days, order none (+warning \"The card was charged £21.94 (pi_fake_0003) and Stripe now bills on 27 Dec 2026, but recording it failed (connection lost). Fix by hand: add a paid card order for £21.94 with PaymentIntent pi_fake_0003 (one membership line), set this membership's next renewal date to 27 Dec 2026, and mark payment date change membership_payment_date_changes#1 'done' with that PaymentIntent.\")",
  ],
  "fb4-payment-date-the-figure-changes-between-the-quote-and-the-press": [
    "quote: allowed, 2026-12-11 to 2027-01-09, 17 days £21.94",
    "payment date moved to 2026-12-27: £24.68 for 17 days, order written",
  ],
  "credits-refused-without-issue-refunds": [
    "refused: permission_denied \"Needs the Issue refunds permission to adjust membership credits.\"",
    "refused: permission_denied \"Needs the Issue refunds permission to adjust membership credits.\"",
  ],
  "credits-refused-no-staff-record": [
    "refused: permission_denied \"Needs the Issue refunds permission to adjust membership credits.\"",
  ],
  "credits-refused-inactive-staff": ["thrown: This staff account is inactive. Ask an admin to reactivate it."],
  "credits-refused-amount-not-a-whole-number-or-zero": [
    "thrown: Amount must be a non-zero whole number.",
    "thrown: Amount must be a non-zero whole number.",
  ],
  "credits-refused-unknown-membership": [
    "thrown: Membership not found.",
    "thrown: Membership not found.",
  ],
  "credits-session-refused-unlimited-plan": ["thrown: This membership is unlimited — its session credits cannot be adjusted."],
  "credits-session-refused-no-current-period": ["thrown: This membership has no current credit period — there is nothing to adjust."],
  "credits-session-refused-below-what-is-used": [
    "thrown: Adjustment rejected: the period would be left with 0 allocated credit(s), below the 1 already used.",
    "session credits: 1 allocated, 1 used",
  ],
  "credits-session-up-and-down-with-the-history": [
    "0 rows",
    "session credits: 6 allocated, 0 used",
    "session credits: 5 allocated, 0 used",
    "2 rows",
  ],
  "credits-addon-up-and-down": [
    "add-on credits: 5",
    "add-on credits: 4",
    "2 rows",
  ],
  "fb7-two-session-adjustments-at-once-lose-one": [
    "session credits: 6 allocated, 0 used",
    "session credits: 5 allocated, 0 used",
  ],
  "fb7-a-credit-booking-lands-between-the-check-and-the-write": ["session credits: 0 allocated, 0 used"],
  "fb8-the-record-fails-after-the-credits-moved-then-retried": [
    "thrown: connection lost",
    "session credits: 8 allocated, 0 used",
    "thrown: connection lost",
    "add-on credits: 6",
  ],
  "fb9-the-same-adjustment-pressed-twice-adds-twice": [
    "session credits: 6 allocated, 0 used",
    "session credits: 8 allocated, 0 used",
  ],
  "fb10-addon-credits-taken-below-zero": ["add-on credits: -3"],
  "fb10-an-empty-reason-is-accepted": [
    "session credits: 5 allocated, 0 used",
    "add-on credits: 3",
  ],
  "herd-refused-without-issue-refunds": ["thrown: Needs Issue refunds permission — this action moves money back to the customer."],
  "herd-refused-no-staff-record": [
    "thrown: No staff record matches the logged-in user's email (jo@example.com). Ask an admin to add you as staff before performing this action.",
  ],
  "herd-refused-unknown-membership": [
    "refused: not_found",
    "refused: not_found",
  ],
  "herd-off-then-cleared-goes-back-to-the-automatic-rule": [
    "Herd off (override false), 2 add-on credits",
    "Herd on (override null), 2 add-on credits",
  ],
  "herd-on-for-a-new-member-then-cleared": [
    "Herd on (override true), 2 add-on credits",
    "Herd off (override null), 2 add-on credits",
  ],
  "fb11-herd-clear-stops-before-the-automatic-rule-runs": [
    "Herd on (override true), 2 add-on credits",
    "thrown: connection lost",
  ],
  "store-credit-refused-bad-params": [
    "refused: no reason \"Customer id is required.\"",
    "refused: no reason \"Mode must be \"add\" or \"remove\".\"",
    "refused: no reason \"Amount must be greater than 0.\"",
    "refused: no reason \"Amount must be greater than 0.\"",
    "refused: no reason \"Amount must be greater than 0.\"",
    "refused: no reason \"Amount must be greater than 0.\"",
    "refused: no reason \"A reason of at least 5 characters is required.\"",
    "refused: no reason \"A reason of at least 5 characters is required.\"",
    "refused: no reason \"A reason of at least 5 characters is required.\"",
    "refused: no reason \"A reason of at least 5 characters is required.\"",
  ],
  "store-credit-refused-without-issue-refunds": ["thrown: Needs Issue refunds permission — this action moves money back to the customer."],
  "store-credit-refused-no-staff-record": [
    "thrown: No staff record matches the logged-in user's email (jo@example.com). Ask an admin to add you as staff before performing this action.",
  ],
  "store-credit-refused-inactive-staff": ["thrown: This staff account is inactive. Ask an admin to reactivate it."],
  "store-credit-refused-unknown-customer": ["refused: customer_not_found \"That customer no longer exists.\""],
  "store-credit-add": ["store credit +£20.00, balance £50.00"],
  "store-credit-remove": ["store credit -£10.00, balance £20.00"],
  "store-credit-remove-all-of-it": ["store credit -£30.00, balance £0.00"],
  "store-credit-overdraw-refused": [
    "refused: insufficient_store_credit \"Removing that much would take the balance below zero — the adjustment was refused.\"",
  ],
  "store-credit-amount-rounded-to-the-penny": [
    "store credit +£12.35, balance £42.35",
    "store credit +£0.01, balance £42.36",
  ],
  "fb12-the-same-adjustment-pressed-twice-gives-twice": [
    "store credit +£20.00, balance £50.00",
    "store credit +£20.00, balance £70.00",
  ],
  "gift-card-extend-refused-without-issue-refunds": [
    "refused: permission_denied \"Needs the Issue refunds permission to extend or re-activate a gift card.\"",
  ],
  "gift-card-extend-refused-no-staff-record": [
    "refused: permission_denied \"Needs the Issue refunds permission to extend or re-activate a gift card.\"",
  ],
  "gift-card-extend-refused-inactive-staff": ["thrown: This staff account is inactive. Ask an admin to reactivate it."],
  "gift-card-extend-refused-months-not-a-whole-number-above-zero": [
    "refused: invalid_months",
    "refused: invalid_months",
    "refused: invalid_months",
    "refused: invalid_months",
  ],
  "gift-card-extend-refused-unknown-card": ["refused: gift_card_not_found"],
  "gift-card-extend-an-active-card": ["gift card expires 2030-07-01, not voided"],
  "gift-card-extend-a-card-that-has-just-expired": ["gift card expires 2026-12-01, not voided"],
  "gift-card-extend-from-the-31st-ends-on-the-months-last-day": ["gift card expires 2027-02-28, not voided"],
  "gift-card-extend-a-voided-card-un-voids-it": ["gift card expires 2030-07-01, not voided"],
  "fb13-a-card-voided-by-its-refund-is-reactivated-and-spent": ["gift card expires 2027-12-10, not voided"],
  "fb14-a-long-expired-card-is-still-expired-after-extend": ["gift card expires 2025-10-10, not voided"],
  "fb15-extend-pressed-twice-adds-twice": [
    "gift card expires 2030-02-01, not voided",
    "gift card expires 2030-03-01, not voided",
  ],
  "gift-card-picked-up-and-back": [
    "gift card expires 2029-01-01, not voided, picked up true (by staff), shipped no (by nobody)",
    "gift card expires 2029-01-01, not voided, picked up false (by nobody), shipped no (by nobody)",
  ],
  "gift-card-picked-up-refusals": [
    "refused: not_found",
    "refused: not_pickup_fulfillment",
    "refused: not_pickup_fulfillment",
  ],
  "gift-card-shipped-and-back": [
    "gift card expires 2029-01-01, not voided, picked up false (by nobody), shipped yes (by staff)",
    "gift card expires 2029-01-01, not voided, picked up false (by nobody), shipped no (by nobody)",
  ],
  "gift-card-shipped-refusals": [
    "refused: not_found",
    "refused: not_shipping_fulfillment",
    "refused: not_shipping_fulfillment",
  ],
  "gift-card-flags-refused-inactive-staff": [
    "thrown: This staff account is inactive. Ask an admin to reactivate it.",
    "thrown: This staff account is inactive. Ask an admin to reactivate it.",
  ],
  "gift-card-flags-with-no-staff-record": [
    "thrown: No staff record matches the logged-in user's email (jo@example.com). Ask an admin to add you as staff before performing this action.",
    "gift card expires 2029-01-01, not voided, picked up false (by nobody), shipped no (by nobody)",
    "thrown: No staff record matches the logged-in user's email (jo@example.com). Ask an admin to add you as staff before performing this action.",
    "gift card expires 2029-01-01, not voided, picked up false (by nobody), shipped no (by nobody)",
  ],
  "gift-cards-list-and-search": [
    "3 rows",
    "1 row",
    "1 row",
    "1 row",
    "2 rows",
    "2 rows",
    "0 rows",
  ],
  "gift-card-redemptions": [
    "0 rows",
    "1 row",
    "0 rows",
  ],
  "create-customer": [
    "customer created: Dee Dale <dee.dale@example.com>, born 1992-02-29, phone 07700 900123",
    "customer created: Dee Dale <dee.two@example.com>, born 1992-02-29, phone null",
  ],
  "create-customer-refused-missing-or-bad-fields": [
    "thrown: First name is required",
    "thrown: Last name is required",
    "thrown: A valid email address is required",
    "thrown: A valid email address is required",
    "thrown: A valid date of birth is required",
    "thrown: A valid date of birth is required",
    "thrown: Date of birth cannot be in the future",
  ],
  "create-customer-under-18-refused": [
    "thrown: Customers must be 18 or over.",
    "customer created: Dee Dale <dee@example.com>, born 2008-11-10, phone null",
  ],
  "create-customer-duplicate-email-refused": [
    "thrown: A customer with this email address already exists",
    "thrown: A customer with this email address already exists",
  ],
  "create-customer-a-date-that-does-not-exist": ["thrown: date/time field value out of range: \"1990-02-30\""],
  "create-customer-refused-inactive-staff": ["thrown: This staff account is inactive. Ask an admin to reactivate it."],
  "fb21-create-customer-with-no-staff-record": ["customer created: Dee Dale <dee@example.com>, born 1992-02-29, phone null"],
  "fb21-the-same-email-in-another-case-added-by-another-writer": ["thrown: A customer with this email address already exists"],
  "customers-list-and-search": [
    "2 rows",
    "1 row",
    "0 rows",
    "1 row",
    "1 row",
    "1 row",
    "2 rows",
    "1 row",
    "2 rows",
  ],
  "customer-detail": [
    "store credit +£15.00, balance £15.00",
    "profile: 1 memberships, 0 passes, 1 bookings, 1 event bookings, store credit £15.00 (1 movements), payment date refused \"Bookings on this membership are waiting for payment (Payment needed)\"",
    "profile: 0 memberships, 1 passes, 0 bookings, 0 event bookings, store credit £30.00 (0 movements)",
    "profile: 0 memberships, 0 passes, 0 bookings, 0 event bookings, store credit £0.00 (0 movements)",
  ],
  "subscriptions-list-and-search": [
    "2 rows",
    "1 row",
    "2 rows",
    "1 row",
    "0 rows",
  ],
  "membership-reads-carry-the-payment-date-refusal": [
    "1 row",
    "profile: 1 memberships, 0 passes, 0 bookings, 0 event bookings, store credit £0.00 (0 movements)",
    "last day 2026-12-09, ends 2026-12-10",
    "1 row",
    "profile: 1 memberships, 0 passes, 0 bookings, 0 event bookings, store credit £0.00 (0 movements), payment date refused \"A cancellation is scheduled on this membership\"",
  ],
  "fb16-every-read-answers-an-inactive-staff-member": [
    "1 row",
    "profile: 0 memberships, 1 passes, 0 bookings, 0 event bookings, store credit £30.00 (0 movements)",
    "1 row",
    "1 row",
    "0 rows",
    "0 rows",
    "quote: allowed, 2026-12-11 to 2027-01-09",
  ],
  "lapse-sweep-a-booking-with-nothing-paid-is-cancelled": [],
  "lapse-sweep-leaves-a-booking-whose-deadline-has-not-passed": [],
  "fb18-lapse-sweep-never-lapses-a-booking-with-a-paid-guest": [],
  "fb19-lapse-sweep-cancels-a-credit-booking-and-keeps-its-paid-add-on": [],
}
