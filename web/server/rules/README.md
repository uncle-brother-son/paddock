# server/rules

The business rules ported from the Retool backend functions, grouped by subject. Each rule takes
plain arguments and a `Queryable`, never a request or a staff context, so the staff, customer and
public routes can all call the same rule. Routes only parse input, call the rule and return.

Each ported file names its Retool source on its first line. `testing/` holds the test databases
and the replay harness: see `testing/README.md`.

`orders/` holds step C. `price-basket.ts` is the only place a basket is added up, and it reads
everything it needs in one statement (`load-basket.ts`), because each database round trip costs about
20 ms through Hyperdrive.

## The order transaction (T1, from W06)

`place-order.ts` places an order in one `db.transaction`: one statement locks (`locks.ts`), one reads
(`load-basket.ts`, the quote's own read), `priceFromFacts` prices, then one statement writes the order
with everything that doesn't need the booking (the gift card bought, the event's places, its booking
and attendees (W08), the lines, the stock claimed and its ledger rows, the pass bought, the address
saved to the customer, and from W09 the promo code's use, the store credit and the gift card used to
pay), one the booking with its line,
add-ons and add-on credits (`write-booking.ts`), one the audit rows. The order comes first (W07)
because a booking can be paid with a pass bought in the same basket, and that pass needs its line.
With no Stripe step it finishes inside T1: seven round trips for a basket with a booking, six
without (BEGIN and the time limits go as one), plus three in the route (the staff member and the
idempotency key, before and after). The rules it keeps:

- **Every refusal is a throw.** A `return` inside `db.transaction` would commit.
- **One lock order:** `LOCK_ORDER` in `locks.ts`. Every later Worker write that takes row locks
  takes them in that order, or two of them can deadlock. A slice that adds a lock adds it in its place.
- **Locks before reads.** The credit period is locked in its own statement before anything counts its
  bookings: a statement that waited for a lock still counts what it saw before waiting.
- **Postgres's own refusals** (the one-booking-a-day trigger, the overlap constraint, quote_booking)
  end the transaction, so they are turned into their reasons after the rollback, from
  `postgresRefusal` in `server/db/errors.ts`.
- **A deadlock is run once more.** Two orders inserting overlapping bookings at once can deadlock in
  the exclusion index (40P01). T1 calls nothing outside the database, so when it opened the
  transaction itself it runs once more (`inTransaction` in `place-order.ts`); a transaction it joined
  is its caller's. Work that calls Stripe or anything else outside the database must not do this.
- **Row order is set explicitly.** now() doesn't move inside a transaction, so rows that are read
  `ORDER BY created_at, id` (seats, order lines, booking add-ons, stock ledger rows, audit rows) get
  created_at from `clock_timestamp()`, a millisecond apart, in the INSERT. The booking's line is
  written from the order statement's clock, passed on, so it keeps its place among the others.
- **A gift card's code must be new, without poisoning the transaction** (W03-plan 2.4 item 3). Its
  INSERT is `ON CONFLICT (code) DO NOTHING`, every other write in the order statement waits on it, so
  a taken code writes nothing and the statement runs again with a new code: five tries, then
  `gift_card_code_exhausted`, as createOrder.
- **Stock is claimed once per variant**, for all the basket takes of it, with a guarded UPDATE, after
  the variants were locked in id order with the rest; the ledger keeps a row per line.
- **An event's places are claimed with claim_event_places's own guard** (on sale, not cancelled, room
  for every place), written into the order statement rather than called: a function in a CTE only runs
  if the CTE is read. The event is locked after the variants. Its booking is written only from the
  claim, its attendees only from its booking, so a claim that finds no room writes none of them and
  T1 refuses with `event_full`; the counts are checked as well (W08).
- **A pass is only written joined to its own line**, and the counts are checked, so neither can be
  kept without the other (checklist B3).
- **A promo code is locked FOR UPDATE, after the customer** (W09). Its uses are counted in the facts,
  after the lock. FOR UPDATE, not FOR NO KEY UPDATE, because the old createOrder claims a use by
  inserting a `promo_code_redemptions` row and then counting: its foreign key check waits for T1, so its
  count sees T1's use. The redemption is written only with the order.
- **Store credit is claimed with store_credit_apply's own guard**, written into the customer's one
  UPDATE in the order statement (which also saves the delivery address: a statement can't update a
  row twice), with its ledger row only from the claim, and the amount exactly as sent. A claim that
  finds the balance short refuses `store_credit_insufficient`, one that writes nothing otherwise
  `store_credit_failed`, as store_credit_apply's two answers did (W09).
- **A gift card used to pay is locked last**, and claimed with createOrder's guarded UPDATE (enough
  left, not voided, not expired on today's London date), marked redeemed when used up, with its
  redemption row only from the claim; `gift_card_insufficient_or_invalid` when it finds nothing (W09).
- **What orders.payment_method records** is W03-decisions Q9's table (`recordedPaymentMethod`), and
  the confirmed figures are checked in W03-plan 2.7's order: the cash figure, then the over-the-total
  reasons, then `payment_method_required`, then `amount_changed` (Q11's words). The amount due is
  checked when it is sent; the screen sends it from W14 (W09).
- **What isn't built yet answers NOT_BUILT** before any transaction opens. The list is in
  `place-order.ts`; each slice takes its part off it.

## The saved card: T1, collect, T2, and the one undo (W10)

A card order with something to charge runs W03-plan 2.1's pipeline:

1. **T1** (`place-order.ts`) does everything above, but writes the order `pending`, with its pending
   record in `orders.reader_payment` (`pending-order.ts`: a superset of the old reader snapshot, never
   with the old reader's `payment_intent_id`, so the old sweep leaves it alone), its event booking
   `pending`, and the delivery address not yet saved to the customer. Its claims are made and held.
   It commits **before** any Stripe call. The Stripe client is made before T1, so a missing key fails
   with nothing written. W03-decisions Q10: a card order while the customer has another order pending
   and under 15 minutes old is refused first, with the decided words (`order_still_processing`).
2. **Collect** (`collect-saved-card.ts`) charges the saved card once: key `<orderId>:charge`,
   `metadata.order_id`, the description createOrder sent, all fixed by the pending record so a retry is
   the same request. A definite refusal (card error, invalid request) means nothing was taken; anything
   else is unknown and is sent once more with the same key. Still unknown: PAYMENT_UNCONFIRMED (502),
   the order held pending and **never undone here**; reconcile decides (W12). The Stripe client has
   10 seconds a call and no retries of the SDK's own (`ORDER_STRIPE_LIMITS`), so the Stripe part of an
   order takes 20 seconds at most.
3. **T2** (`finalise-order.ts`, one transaction) locks the order, re-checks it is pending, checks the
   PaymentIntent (succeeded, exact pence, gbp, this order, this Stripe customer), marks it paid with the
   PaymentIntent, confirms the event booking, saves the address when asked, and records `order.paid`.
   Safe twice. A PaymentIntent that doesn't check out leaves the order pending for a person. A
   database failure after the charge leaves it pending too, answering PAYMENT_UNCONFIRMED: a good sale
   is never refunded for a fault. T2 on an order already undone records `order.charge_without_order`.
4. **The one undo** (`undo-order.ts`, one transaction) on a definite refusal: locks the order (it,
   then LOCK_ORDER), refuses a paid one, gives back every claim exactly once (places, a pass session,
   add-on credits, stock and its ledger rows, event places, store credit and its ledger row, a gift
   card's balance and `redeemed_at` when this order set it, the promo's use with the order) and
   removes every row, recording `order.undo` with the snapshot. Run twice, the second finds nothing.

`LOCK_ORDER` now starts with an existing order: T2 and the undo lock it first.

W16 removed the dry run (`dryRunOrder` and `POST /api/v1/staff/orders/dry-run`), the staff app's shadow and the
parity route with it. `order-rows.ts` (the read-back) stays for the tests. `parity_log` and its 30-day purge stay in
the database until step H; nothing writes to it any more.

## Step F's foundations (W36)

Step F (the staff app's `briefs/F-plan.md`) moves the membership, customer, store credit and gift card actions here,
slice by slice (W37 to W43). W36 adds what they share, with nothing switched on and no route:

- `contracts/account.ts`: every F route's input and output, in the old functions' field names.
- `memberships/failure-messages.ts`, `customers/failure-messages.ts`, `gift-cards/failure-messages.ts`: every word
  staff see from those actions, moved word for word and held to the old code by the test beside each.
- `memberships/membership-switch.ts`: step F's two kinds of `ORDER_SWITCH`. `membership_changes`: the cancel and
  undo, and moving memberships to a replaced card (W42). `payment_date_changes` (W41a): the payment date change's
  press and the legacy change-payment-date route's guard, and nothing else, so the date change can be switched off
  (and the old staff app put back for it) while the cancel and undo stay on. Each is off until the lead adds it; off
  answers `MEMBERSHIP_PATH_OFF`, naming its kind. The quotes, reconcile and the check never ask either.
- `memberships/left.ts`: a Stripe step left to do after the database change, for the two steps that are safe to
  repeat (a subscription's cancel date set or cleared; its card). Written in the action's transaction as a
  `membership.step_left` audit row (no new table), read before it is sent, sent again by reconcile every run, and
  closed by a `done` row (W40: only once it is older than the press's window, and at most 10 a run; see "Turns"
  below). A step Stripe refuses for good gets a `refused` row: it is then listed for a person on the
  stuck list (`steps`) and never sent again, until someone marks it sorted (the manual close's `left_step`). The
  newest step for a subscription and kind closes an older open one as `replaced`. Nothing here charges or refunds.
  W29's left cancel of a refunded membership's subscription (`orders/refund-subscription.ts`) ends the same way from
  W36: refused for good on reconcile's retry, it is recorded as `refused`, listed with its own words and not retried.

## Membership cancel and undo, and the membership reads (W40)

F-plan 4.3. The staff app's `setMembershipCancellation` and `getSubscriptions` are thin calls to these.

- `memberships/cancel.ts`, `POST memberships/:id/cancel` and `POST memberships/:id/undo-cancel`. The database first,
  Stripe second (the old routes did it the other way round):
  - **M1**, one transaction under the membership's lock: who may (staff with Issue refunds, read from the signed-in
    staff member; or, on the customer channel, the membership's own customer: only the staff routes exist); found and
    active; cancel: no cancel scheduled, no payment date change in progress, a next renewal date that is after today
    in London (W40a, Wayne 16 Nov: on the renewal day, or while it is overdue, the cancel is refused
    `renewal_due_today` until the payment has moved the date on; the end would be a day already here); undo: a cancel
    scheduled whose last day hasn't passed; no step of the last change still being sent. Then the last day written or
    cleared, a `membership.cancel_scheduled` or `membership.cancel_undone` audit row with the `cancel_at` it will
    send, and the Stripe step left (`left.ts`) when the membership has a subscription.
  - **The end date** (`membershipEnd`): yearly, the next renewal. Monthly, the later of the next renewal and
    start + 2 months, where a day the later month doesn't have is that month's last day (Q33: started 31 December,
    28 February; the old sum gave 3 March). `cancel_effective_date` is the day before (the last day of access);
    `cancel_at` is London midnight at the start of the end date.
  - **Stripe**, after M1, for the membership's own subscription (never found by its order): read first, then
    `cancel_at` set or cleared with `proration_behavior: 'none'`, under a key from the step's id. Went: the step is
    `done`. Refused: M1 is put back in one transaction (`membership.cancel_put_back`; the date only if it is still
    what M1 wrote), the step closed, and the press refused with Stripe's reason (`stripe_refused`). No clear answer:
    the step stays left, the answer carries `left`, and reconcile finishes it.
  - **The webhook stays.** `customer.subscription.updated` still copies Stripe's date onto the membership
    (`membership_sync_cancel_at_period_end`). An unrelated event between M1 and the Stripe step clears the date for a
    moment; the step's own event puts it back.
  - Gated by `membership_changes`: off, both routes answer `MEMBERSHIP_PATH_OFF` before anything is read.
- **Turns** (`left.ts`; W36 review S1). Reconcile sends a step only once it is older than the press's window
  (`PROCESSING_MINUTES`); a new cancel or undo is refused while a step of the same kind on that subscription is still
  inside the window ("still being sent"); after its send, reconcile looks again under the membership's lock, and for a
  step a newer one has replaced it writes nothing and settles the newest instead; a press Stripe refuses leaves again
  the wish its step had replaced (W40a: only while its own step is still the newest). Reconcile takes at most
  `MAX_STEPS_PER_RUN` (10) steps a run.
  - W40a (W40 review S1). When the newest step was already closed `done` by its own press, and the run's send of it
    isn't confirmed, or the run's own send of the replaced step got no clear answer (it can still land in Stripe
    later), the newest step's wish is left again as a new step (`keepForALaterRead`; its `left` row carries
    `leftAgainFor`). It is listed, a new press waits its window, and the next run past the window reads Stripe after
    any late send and sends the wish again if needed. A newest step still open is left open in the second case.
    Without this a stale send could be the last word with every step closed and nothing listed.
  - W40a. "Newest" (`newestOf`) follows the `replacedBy` links and, past a step that is closed with no link (a
    press's `done`, a put-back), takes the latest step left after it: a closed step is never linked to the next
    press's step.
  - W40b. A newest step still open in that second case is also marked (a `stale_send` row, not an ending), before
    Stripe is asked about it. Its own press, finishing after the run, finds the mark and leaves the wish again
    instead of closing the step `done` (`recordStepDone`). If the transaction that leaves a wish again (or writes the
    mark) fails, the run answers the item as `left` with the reason `step_not_left_again` and its `order.reconcile`
    row names the step (`leaveAgain`); every later run tries again (`leaveAgainLater`, no Stripe call) until a row
    with another outcome settles it. `left.ts`'s header says what is guaranteed and what isn't.
  - W40c. The net under all of that: every step that closes (done, replaced, put back, sorted by hand, left again)
    is checked once more, 20 minutes after it closed (the window plus 5), by one read of its subscription set against
    the newest wish for that subscription and kind (`checksDue`, `checkAfterClosing`; never the membership's row,
    which the webhook makes agree with Stripe). Agrees: one `membership.step_check` row (`checked`). Something else:
    the newest wish is left again as a new step in the same transaction as the row, under the membership's lock and
    only while it is still the newest; it is listed, a new press waits, and the next run past the window sends it.
    A subscription Stripe can't find, or has ended with an undo still wanted, is left again already refused: listed
    for a person, never sent. No clear read: nothing written, tried again every run, and left again (so listed) after
    2 hours (W40d; 24 before). At most 5 checks a run (`MAX_STEP_CHECKS_PER_RUN`), before the run's own steps; a check
    is an item in the run's answer only when it leaves a step (`step_check_disagreed`, `step_check_unread`,
    `step_refused`).
  - W40d (W40c review S1, S2, L4, and a loop guard). A sorted wish is a person's: a step marked sorted is never read,
    held to Stripe or sent again (its check is one `checked` row, no read), so a hand fix that differs from the wish
    stands; a press made after it is checked as any other. The loop guard: when the check disagrees about a wish that
    a check itself left again and that was then sent and closed `done`, it is not left to send again but left already
    refused, for a person with Mark sorted (a Stripe that stores a value differently from the one sent can't make the
    same change go out over and over). W40d also gave the two legacy routes (`app/api/memberships/cancel` and
    `undo-cancel`) a guard, `memberships/legacy-guard.ts`: both routes and the guard were removed at W44.
- `memberships/list.ts`: `GET memberships` (the Subscriptions list) and the profile's membership rows
  (`customerMemberships`, used by `customers/read.ts`), from the same code: named columns, the payment date button's
  refusal (`payment-date-status.ts`), and `refunded`, worked out from the membership's own order line
  (`order_line_items.refunded_at`; no column of its own). Any active staff member.
- The stuck list's `steps` say what each is (`what`: a cancel date to set, with `lastDay`; a cancel date to clear; a
  card), when it was left, and the words: while it is being sent, what to do if it stays (set it in Stripe by hand:
  the step is read first, so the next check closes it); once Stripe has refused it, what to put right before Mark
  sorted; and, when Stripe can't find the subscription at all, that. The manual close of a step writes the
  `order.close` row every other close writes, against the step.

## The payment date change (W41)

`memberships/payment-date.ts` (F-plan 4.4, 4.10; bugs FB1 to FB4; Q10 / lead call L8; Q18; R7). The one step F action
that takes money, on the saved-card pattern: the record first, every Stripe key from the record, an unclear answer
held and reconciled, and the card never charged a second time.

- **The quote** (`GET /api/v1/staff/memberships/:id/payment-date/quote?newRenewalDate=`): the old quote, field for
  field; any active staff member; never asks the switch.
- **The press** (`POST /api/v1/staff/memberships/:id/payment-date`, body `newRenewalDate`, `override`,
  `overrideReason`, `confirmed.amount`; Issue refunds; a press key; behind its own kind, `payment_date_changes`, W41a):
  - **P1**, one transaction, no Stripe: the customer's lock, then the membership's; every old refusal in the old
    order (W41a: and, in the quote too, a renewal due today or earlier in London, `renewal_due_today`, as W40a's
    cancel: Stripe takes that payment later in the day, and the date must not move before it lands); the window; nothing to charge; the six-month rule and its override; Q10 (the order's own test and words);
    Q18 (the figure worked out now against `confirmed.amount`, half a penny either way, else `TOTAL_CHANGED` with the
    new quote); no cancel or undo step still open on the subscription; the `pending` row (one per membership); the
    `membership.payment_date_changed` row `started`, which carries everything the later steps need (no new table).
  - **S1** the subscription read and the legacy route's checks (the stale-date guard included): refused, the row
    `failed`, nothing charged.
  - **S2** the charge, once, key `<changeId>:charge`, `metadata.change_id`: declined, the row `failed`; unclear, held
    (`PAYMENT_UNCONFIRMED`, step D's words).
  - **S3** the date move (`trial_end`, `proration_behavior: 'none'`), key `<changeId>:move`: refused, a `refunding`
    mark is committed, then the charge is refunded once (key `<changeId>:refund`) with its watch (W32) written in the
    transaction that fails the row; unclear, held. A refund Stripe refuses outright leaves the row pending for a person.
  - **P2**, one transaction: the order (paid, card, the payment), its membership line, `next_renewal_date`, the row
    `done`, the audit row.
- **A pending row holds the membership**: no second change, no cancel, no undo, however old it is.
- **Reconcile** (`orders/reconcile.ts`, `reconcilePaymentDateChange`; item kind `date_change`): never charges. It
  lists the customer's payments by `metadata.change_id`: none, the row is failed; one paid, it lists the payment's
  refunds (a refund of ours, or the mark: the refund is recorded or sent and the row failed; with no mark, a refund
  nobody here made: left for a person), then reads the subscription (the date as asked: P2; else the move again under
  a key of the run's own, then P2 or the refund). Only with a key of the record's own mode is "nothing found" taken as
  "nothing charged". W41a (W41 review B1 to B3): before the move is sent again, S1's checks are run again on the
  subscription just read, and a failure (Stripe renewed it since the press, a cancel was set) refunds the charge with
  the check's words instead of moving the date over a month already paid for; a refund reconcile sends goes under
  `<changeId>:refund:<requestId>` (Stripe replays a 500 saved against the press's key for ever); and a refund is ours
  only when its `metadata.change_id` says so: with the mark and a part refund someone made by hand, ours (no amount)
  gives back the rest.
- **The stuck list** (`paymentDates`) shows each one past the window with what it is waiting on. **The manual close**
  (`held_payment_date`, Issue refunds) is only for one reconcile has left for a person (`PAYMENT_DATE_CLOSE_REASONS`):
  it records what Stripe last showed, fails the row, and sends nothing.
- **The legacy route** `/api/memberships/change-payment-date` was removed at W44, with its guards (W41, W41a). With
  `payment_date_changes` off nobody can change a payment date until it is on again: there is no old route behind it.
- Tests: `payment-date.test.ts` (every refusal in order, each Stripe outcome, a crash at each step, reconcile each
  way, the close), `payment-date-postgres.test.ts` (two presses at once; a press against a cancel, both ways),
  `testing/replay/payment-date-replay.test.ts` (the 42 recorded scenarios, with their named differences).

## Credits, Herd and store credit (W37)

Step F's first slice: the four actions that never touch Stripe (F-plan 4.5). Each write is one transaction with its
audit row, behind a press key, and has no switch kind (lead call L3): there is nothing to stop part way.

- `memberships/credits.ts`, `POST memberships/:id/credits` (adjustMembershipCredits). Issue refunds, a whole number
  that isn't 0, `session` or `addon`, and a reason, in that order. Then it locks **the membership's current credit
  period, then the membership** (`CREDIT_ADJUSTMENT_LOCK_SQL`, in `LOCK_ORDER`): a booking paid with a session credit
  locks the credit period (`lockForOrder`, `lockForBooking`), not the membership, and one that draws or returns an
  add-on credit locks the membership, so an adjustment queues behind either (bug FB7). The facts are read after the
  locks, in their own statement. Session credits move the period's allocation **from what is there** and are refused
  below what is used; add-on credits are refused below zero (FB10; migration 025 is the database's backstop). The
  `membership_credit_adjustments` row and a `membership.credits_adjusted` audit row go in the same transaction (FB8).
- `GET memberships/:id/credit-adjustments` (getMembershipCreditAdjustments): the history, newest first. Any active
  staff member.
- `POST memberships/:id/herd` (setMembershipHerd). Issue refunds. Under the membership's lock: true or false sets the
  override and the flag; null clears the override and applies the automatic rule **to this membership only**
  (`HERD_RULE_SQL`, the expression of the database's `refresh_herd_flags()`, held to the saved function word for word
  by `credits.test.ts`: a migration that changes the rule must change both). A `membership.herd_set` audit row holds
  who, and the flag and override before and after (FB11; no reason is asked for, lead call L13).
- `customers/store-credit.ts`, `POST customers/:id/store-credit` (adjustCustomerStoreCredit). The old checks in the old
  order (mode, amount, reason, then Issue refunds), then the database's `store_credit_apply` (which locks the customer)
  and a `customer.store_credit_adjusted` audit row. No upper limit on any of them (lead call L14).
- `account/refusal.ts`: how every step F action refuses (`accountRefusalDetailsSchema`: the reason, the words, the
  action). Issue refunds is checked by the rule, not the route's `permission`, so the refusal carries the old words.
- A fault inside the transaction answers INTERNAL with nothing changed, and that answer is stored against the press
  key like any other: the same press again gets it back (the screens say "no answer" and keep the key); a new press
  runs afresh.


## Gift cards (W38)

The five gift card actions (F-plan 4.6; lead call L2 for picked up and shipped). None touches Stripe: each write is one
transaction with its audit row, behind a press key, and has no switch kind.

- `gift-cards/admin.ts`, `POST gift-cards/:id/extend` (extendGiftCardExpiry). Issue refunds, then a whole number of
  months from 1 to 120 (W38a; Wayne, 16 Nov: above 120 is `invalid_months`, refused before the database is touched),
  then under the card's lock (`FOR NO KEY UPDATE`: the lock an order paying with the card and a refund
  voiding it both take; a gift card is last in `LOCK_ORDER`, and nothing else is locked). The facts are read after
  the lock, in their own statement.
  - **Q46 (Wayne, 15 Nov; bug FB13):** a **voided** card whose own order line has been refunded
    (`order_line_items.gift_card_id`, `refunded_at` set: the refund voids the card and stamps the line in one
    transaction, and its undo clears both) is refused `voided_by_refund`; one whose balance was moved to store credit
    (a `store_credit_transactions` row of reason `migrated_from_gift_card` naming the card: migration 010) is refused
    `voided_to_store_credit`. Each refusal says why in words. A card voided with neither on record is un-voided, as
    before. **Anything new that voids a card must leave one of these two marks, or add its own here,** or Reactivate
    brings the card back. `gift-cards/voided-writers.test.ts` (W38a) holds this: it finds every statement in the
    Worker that writes `gift_cards.voided` and fails when one appears beyond today's (one that voids, in
    `orders/refund-lines.ts`, which stamps the line in the same transaction; two that un-void, the extension here
    and the refund's undo).
  - **Q47 (Wayne, 15 Nov; bug FB14):** a card that has already expired (its expiry before today's London date, as
    `claimGiftCard` reads it) counts the months from today; one still in date has them added to its expiry.
    Postgres's own date sum, so a month on from the 31st is the month's last day (Q33).
  - A `gift_card.extended` audit row: who, the months, the old and new date, where they were counted from, and
    whether the card was voided (FB15).
- `POST gift-cards/:id/picked-up` and `…/shipped` (setGiftCardPickedUp, setGiftCardShipped). The card must be one to
  pick up (or to ship). Under the card's lock: the flag with who and when, or cleared, and a `gift_card.picked_up` /
  `gift_card.shipped` audit row with what was there before. Any active staff member, setting or clearing (FB24: the
  old functions let someone with no staff record clear a flag).
- `GET gift-cards` (getGiftCards: the Gift Cards page and New Order's gift card search) and
  `GET gift-cards/:id/redemptions` (getGiftCardRedemptions). Named fields (`GIFT_CARD_COLUMNS`, held to the saved
  schema by `admin.test.ts`: a new column on `gift_cards` fails the test until someone decides whether staff see it).
  Any active staff member (FB16).

## Customers (W39)

The three customer actions (F-plan 4.6). None touches Stripe: the one write is one transaction with its audit row,
behind a press key, and has no switch kind.

- `customers/create.ts`, `POST customers` (createCustomer). One rule for every channel that makes a customer:
  `staff` today; `customer` is the website's sign-up and guest checkout (F-plan 4.9), which the rule takes but no
  route sends yet. Every field trimmed and the email lower-cased, then the old checks in the old order with the old
  words (a first name, a last name, an email that looks like one, a date of birth, not in the future, 18 or over on
  London's date). Each refusal now carries a reason beside its words (`CREATE_CUSTOMER_REASONS`).
  - **W39a (review L1):** an email holding a control or format character (a zero-width space U+200B, a byte-order
    mark U+FEFF: nobody can see either) is refused with the email words, never stripped. It would otherwise be stored
    as an address of its own that no sign-in matches. The spaces, tabs and line ends around an address are still
    trimmed.
  - **FB23:** the date of birth must be a day the calendar has. The old check asked only whether JavaScript could
    read it, and JavaScript reads 1990-02-30 as 2 March, so the database's own words reached staff.
  - **FB21:** an email already on file in any case is refused with the old duplicate words (`lower(email)` on both
    sides, inside the transaction). Two creates of one address at once both pass that check; the second insert waits
    on the first's and the database's unique rule refuses it: the key on `email` as written, or migration 027's index
    on `lower(email)` (`CUSTOMER_EMAIL_UNIQUE_RULES`). The rule answers that violation as the same duplicate refusal
    once the transaction has rolled back, never as a fault. **A writer that doesn't lower-case is only stopped by
    027** (lead call L10): until it is applied, an address in capitals written outside this rule can still sit beside
    ours if the two are written at the same moment.
  - A `customer.created` audit row: who and the channel (on the customer channel, the new customer).
  - **For the website build (not done here):** the website gives a date of birth only when the account holder
    attends or buys a membership or pass, and `customers.date_of_birth` is NOT NULL. The customer channel will need a
    migration that lets it be null, the rule's date checks skipped when the channel is `customer` and none is given,
    and a check wherever a date of birth is read (an attendee's 18+ check, a membership or pass purchase).
- `customers/read.ts`, `GET customers` (getCustomers: the Customers page, the customer picker and New Order's payment
  step). One customer by id, or a search (every word in a name, the email or the phone, or the whole search in "first
  last"), or the newest 200. Named fields (`CUSTOMER_LIST_FIELDS`): never the Stripe ids, the website login or the
  consents.
- `GET customers/:id` (getCustomerDetail: the profile). Memberships, session passes, booking history, store credit
  and its last 100 movements, event bookings, in the old function's shapes. The membership and pass rows name every
  column the old `cm.*` and `csp.*` gave but `order_line_item_id`, which no screen reads and W36's contract left out
  (`CUSTOMER_MEMBERSHIP_COLUMNS`, `CUSTOMER_PASS_COLUMNS`, `CUSTOMER_COLUMNS_NOT_SENT`, held to the saved schema by
  `customers.test.ts`: a new column on either table fails the test until someone decides whether staff see it).
  From W40 the membership rows are read by `memberships/list.ts`, with the Subscriptions list.
- `memberships/payment-date-status.ts`: why "Change payment date" is refused on a membership row, for the profile
  and, from W40, the Subscriptions list. Ported from the read part of the staff app's `shared/membershipPaymentDate.ts`.
  From W41 it is the rule's one home (the quote and the press read it too), with one change: a pending change holds
  the membership with no 15-minute expiry. `payment-date-status.test.ts` holds it to the frozen copy but for that.
- All three routes: any active staff member (FB16: the old reads checked nobody).

## The reader: T1, the intent, finalise and cancel (W11)

A reader order runs the same pipeline, with the screen collecting between the intent and T2:

1. **T1** (`place-order.ts`) writes the order `pending` with its pending record (`ReaderSnapshot`,
   `method 'reader'`), its event booking `pending`, every claim held, and **no** payment method yet
   (createOrder's reader branch left it unrecorded until finalise; T2 records Q9's). It commits **before**
   the intent (bug 14). Q10 covers the reader as it covers the card: a held Worker card or reader order
   counts however old, any other pending order for 15 minutes, and only when the reader has something to
   take. Nothing left for the reader is refused in T1 with createOrder's `reader_nothing_to_charge`.
2. **The intent** (`reader-intent.ts`): the Stripe customer found or made (`ensureStripeCustomer`, its
   first real user, under `<customerId>:stripe-customer`), then one `paymentIntents.create` with the
   legacy route's parameters (`card_present`, `setup_future_usage` only when the customer agreed to save
   the card, `supabase_customer_id`, `order_id` and `flow` in the metadata), under `<orderId>:reader-intent`,
   for the server's figure. A definite failure, or no Stripe customer, means no intent: the one undo, and
   the old words (`reader_intent_failed`, PAYMENT_FAILED). Anything else is sent once more with the same
   key; still unclear: PAYMENT_UNCONFIRMED, held, never undone. The intent's id, its Stripe customer and its
   Stripe mode (`livemode`, W11a) are then written onto the pending record (in their own transaction, so
   Postgres bounds the write) as the old reader's own `payment_intent_id`, on purpose, so the old
   finalise, cancel, sweep and stuck list can still finish a Worker reader order (switching back,
   W03-plan 3.2). The order answers `pending_reader` with `pendingReaderPayment`. Creating an intent
   takes no money: only the tap, against the secret the screen is given, can.
3. **Finalise** (`reader-order.ts`, `POST /api/v1/staff/orders/:orderId/finalise`): reads the order and
   the PaymentIntent, checks it to the **exact penny** (`amount` and `amount_received`), this order's,
   gbp, this Stripe customer; reads the card when the customer agreed to save it (`server/stripe/saved-card.ts`,
   the legacy resolve route's reading); then T2 marks it paid in one transaction, with the method, the
   card (`customers.saved_*`, `customer.card_saved`), the address and the event booking. A card that
   can't be saved never stops it: paid, with the old warning (bug 7). A payment that doesn't check out,
   a Stripe read with no clear answer, or a database fault in T2 leaves the order pending: never refunded,
   never undone. Answers as data, the old function's union.
4. **Cancel** (`POST /api/v1/staff/orders/:orderId/cancel`): the legacy route's cancel (read; succeeded is
   never cancelled; cancel; read again if that fails), then the one undo. A payment that had in fact
   succeeded is finalised instead, with the PaymentIntent just read. Anything unclear from Stripe changes
   nothing: a 401, 403 or 400 on the read, or a failed cancel whose read after isn't succeeded or
   canceled. A 404 means "never existed" (undone) only when the key in use is of the mode recorded with
   the intent (W11a): Stripe answers 404 to the other mode's key for an intent that exists. The undo takes
   the add-on lines with the order (bug 8) and clears a gift card's `redeemed_at` only when this order
   set it (bug 9).

Every Stripe call on these routes (the setup intent's too, from W11a) is answered by 30 seconds after the
request started, each with what is left (at most 10 s) and none with under 2 s left
(`server/stripe/deadline.ts`). `ensureStripeCustomer`'s read and write-back of the Stripe customer run in
their own transactions with the lock and statement limits cut to what is left, so they end by it too. Finalise and cancel are
safe twice and against each other: T2 and the undo lock the order and re-check it, and Stripe's own state
decides which can go. An order the old checkout started (no `method`), or one its rollback has started on
(`reader_payment.rollback`), is left to the old code: T2 and the undo refuse it. Memberships on the reader
stay NOT_BUILT (W13). Card saving with no order (`payments/terminal.ts`): the connection token, the
SetupIntent (`ensureStripeCustomer`, then `card_present` for off-session use under a key from the customer
and the press), and the saved card, ported as it is (W03-decisions Q19).

## Reader flows, reconcile and the schedule (W12)

**Reader flows** (`orders/reader-flow.ts`, routes `POST /api/v1/staff/reader-flows/:pendingId/finalise` and `/cancel`):
finaliseReaderPayment and cancelReaderPayment for Move, Settle and Add Guest, rows in the old shapes. Finalise
checks the PaymentIntent to the penny, then one transaction locks the flow row, records the payment (order and
line), the gift card part, a move's old places and pass session, an Add Guest's add-on lines, marks the row and
writes `reader_payment.finalise`. The undo is one transaction too (`reader_payment.cancel`). Only flows the Worker
started (their record carries `method: 'reader'` and `request_id`, written by step D); the old screens' are refused
(`old_reader_flow`). A database fault after the payment holds the row (`finalise_failed`); it is never refunded for it.

**The undo refuses `changed_since`** (W10 review L1): T1 writes `held_booking` (session, party size) on the pending
record; if old code has since cancelled, moved or resized the booking, or the event booking isn't pending, the undo
changes nothing and the order waits for a person.

**Reconcile** (`orders/reconcile.ts`): Worker orders and flows pending over 15 minutes (Q14), oldest first, after the
automatic refunds. It reads Stripe with list (never search), cancels an intent nobody can pay, runs T2 or the undo,
and refunds a payment that landed on an order or flow already undone (`<id>:refund-charge` / `:refund-reader`, its
row written first, listed until Stripe confirms). It never sends a charge. A 401/403 stops the run with one
`reconcile.stripe_refused` row. "Nothing found" counts as nothing taken only when the record's `livemode` is the
key's. Every action is an `order.reconcile` row. Old orders and flows are counted and left to the old sweep.

**W12a (the W12 review's fixes).**
- **Orders the old screens moved out of pending** (`orders/changed-elsewhere.ts`, review S1): from minute 15 the old
  Cancel & Refund can reach a held Worker card order's booking, give its money back as store credit and set the order
  `partially_refunded`. Reconcile also selects Worker card and reader orders that are neither `pending` nor `paid`,
  have no PaymentIntent on them and no `order.paid` or `order.undo` row (T2 sets `paid` with its PaymentIntent and
  writes `order.paid`; the undo deletes the order and writes `order.undo`), made in the last 30 days and over the
  15-minute window old. It lists the customer's intents by `metadata.order_id` as for a held order and records what it
  finds (`reason: 'changed_elsewhere'`, `finding`: taken with the amount, nothing taken, still open, unclear, other
  mode), once per finding. It never cancels, refunds, finalises or undoes them. Taken and nothing taken are final: the
  order isn't read again. The stuck list shows them with plain words for a person. The selection reads the last 30
  days of orders through `idx_orders_created` and each candidate's audit rows through `audit_log_entity_idx`.
- A held reader order found paid by listing goes through the reader's finalise (`finaliseReaderOrderFound`), so its
  card is saved, or R6's warning given (L4).
- The refused-key watch covers the whole Stripe client (L6); an item that had already acted keeps its row.
- The late refund's rows are the system's, even on a staff member's run, with `runBy` naming who ran it (L7).
- FakeStripe saves nothing against an idempotency key for a 401 or 403 (Stripe saves a result only once an
  endpoint has started), so the late refund is sent again with the same key once the key works.

**The schedule** (`server/scheduled.ts`, `custom-worker.ts`, `wrangler.jsonc`): every 5 minutes, inside the Worker,
the database from the Hyperdrive binding and Stripe from the Worker's secret. 50 items and 120 s a run; a staff run
(`POST /api/v1/staff/orders/reconcile`) 10 items and no new item after 15 s, every Stripe call answered by 20 s (W13;
`MANUAL_LIMITS`). One item's worst case
(W12a, correcting W12's 70 s) is about 86 s: a held reader order whose tap lands while reconcile cancels it, with
save-card, makes six Stripe calls (the list, read, cancel, read again, then the two card reads) at 10 s each, plus T2
and its row at 13 s each. Each extra page of a Stripe list adds 10 s (ten pages, the cap, about 176 s). So a scheduled
run ends by about 206 s, or about 296 s with ten-page lists, inside the 5 minutes to the next run (overlap would be
safe) and far inside the 15-minute limit. The arithmetic is in `orders/reconcile.ts` (`SCHEDULED_LIMITS`). The stuck
list is `GET /api/v1/staff/orders/stuck`. Their schemas are in `contracts/reconcile.ts` (W14b; exported to the staff app).

**The Orders page (W14b).** The staff app's Resolve now runs two calls: `reconcileOrders` (this run, for what the
Worker made) and the old `sweepPendingReaderPayments`, which now skips every Worker order and flow (one actor per
item). Its stuck list is the Worker's list for Worker items merged with the old function's own query for old ones.
Reconcile's put-back retries come last in a run, and a row Stripe refused for good (`refused`) is listed but never
retried (W13c review L4); a staff run's reader flows keep to the run's deadline (W12-6). **The manual close**
(`orders/close-stuck.ts`, `POST /api/v1/staff/orders/stuck/close`, Issue refunds and a reason, no Stripe call):
- `held_order`: a pending Worker order reconcile left as `changed_since` or `compensation_unfinished` (with its mark,
  and W14c: only when the latest held `order.compensate` row says `definite`, every step left a definite Stripe
  refusal; otherwise `still_checking`, since reconcile finishes it itself, also after a person did the steps in Stripe).
  In one transaction, order locked first: if old code changed nothing, the one undo (a compensation's end, by hand);
  otherwise what old code hasn't changed goes back as the undo gives it (stock, store credit, a gift card used, the
  event places while the event booking is still pending, anything it was buying) and the order goes; the booking's
  places, pass session and add-ons never (its add-on lines stay with the booking, `order_id` cleared). Refused if
  something it was buying is in use.
- `changed_elsewhere` and `subscription_left`: recorded as sorted (`order.close`; a `cancelled` subscription row),
  which the stuck list and reconcile then leave out. Nothing moves.
- `late_refund` (W14c): a late payment's refund Stripe refused (`failed`), once refunded by hand: its refund row
  written again `confirmed` with `byHand`, which the stuck list then leaves out. Refused while the refund is on its way.
Refused, with nothing changed, unless reconcile has left it for a person (for a changed-elsewhere order: a final
finding or the other mode), or once it is settled meanwhile. Racing reconcile, each locks the order first.

## Memberships: the subscription, its compensation, and reconcile (W13)

`orders/membership.ts` holds the membership's Stripe steps; `place-order.ts` (the saved card) and `reader-order.ts`
(the reader's finalise) run them; `finalise-order.ts` (T2) writes the membership; `reconcile.ts` settles what is left.

- **T1** writes the membership's line (and, on a buy-new booking, its row, active with no subscription, and its first
  credit period, so the booking draws its credit; Q3: a pass bought beside it too). Its pending record carries what
  the subscription needs (`membership`: plan, frequency, price, first payment, first invoice, coupon, Stripe price) and
  the exhausted membership it replaces (Q8). `confirmed.firstInvoice` is checked like `toCollect` on the card.
- **The saved card**: the Stripe price checked (exists, active, recurring gbp of the interval, exactly the plan's price),
  the card made the invoice default, the coupon (`order-<orderId>`, key `<orderId>:coupon`) when credit or a promo pays
  part of the first payment, the subscription (`<orderId>:subscription`, `metadata.order_id`), the rest of the basket
  charged (`<orderId>:charge`, Q21), the old subscription cancelled last (Q8), then T2.
- **The reader**: the price checked before the intent; at finalise the card must be reusable, the price again, a coupon
  covering the whole price (the tap took the first payment), the subscription, Q8, then T2 (which saves the card).
- **One rule per kind of failure** (W11 review L3): before anything is taken, the undo; definite after a subscription or a
  payment exists, `compensateOrder` (the `compensation` mark first, then the subscription cancelled and checked, each
  payment refunded under `:refund-subscription`, `:refund-charge` or `:refund-reader`, each answer checked, then the undo
  with `order.compensate`); unclear, held (PAYMENT_UNCONFIRMED); a database fault in T2, held. T2 and the undo refuse a
  marked order (only the finished compensation undoes it).
- **Cancels are DELETEs**: no key (Stripe ignores keys on DELETE); a failed cancel is read back, and only `canceled` counts.
- **Reconcile** lists the customer's subscriptions (`status: 'all'`) and payments by `metadata.order_id`: everything
  planned succeeded, the old cancel then T2; part done, compensate and undo; a marked order, finish the compensation;
  nothing found (in the record's mode), the undo. It never starts a charge or a subscription.
- **Deadline**: every Stripe call of a membership press (the saved card's order, the reader's finalise, and cancel's
  finalise-instead) is answered by 25 s from its start (the charge's first send and the coupon's delete too); a
  compensation starts only with time left, and a mark that returns too late ends there, held, with no row; anything
  not done in time is held for reconcile.
- **W13a, the screen's reader finalise against reconcile (review B1)**: before it asks Stripe for the subscription,
  the finalise writes its start (`membership.subscription_started_at` and `_by`) in a guarded UPDATE that refuses a
  marked order. A compensation that found no subscription (reconcile's "a tap but no subscription", or the screen's own
  before its start) marks the order only when no other press's start is younger than 2 minutes, in one statement on the
  locked row, and once marked lists Stripe again and cancels any subscription it finds. If the screen still makes one
  for an order T2 then finds gone or marked, it cancels it at once and writes `order.subscription_left`; one it can't
  confirm cancelled stays on the stuck list's warnings until put back.
- **W13a, the rest of the review**: the first invoice is checked by what it was for (its `total`; Stripe's minimum
  charge and the customer's balance can change what it took, which is what a compensation refunds) (S1); on the saved
  card, Q8 and T2 wait for the charge to succeed (S2); T2's definite checks are read before Q8's cancel (card, reader,
  reconcile), and a compensation after a confirmed Q8 cancel says the old membership was cancelled too (L1); the late
  refund of a payment the compensation already refunded under the same key counts as done (B1's side effect).
- **W13b**: the saved card's press puts back a subscription it made for an order T2 finds gone or marked, as the
  reader's finalise does (`order.subscription_left`); reconcile adds a saved-card membership's charge that succeeded
  during its own cancel attempt to what a later refusal refunds.
- **W13c (the W13a review)**: one press at a time may start a reader membership's subscription: the start's write also
  refuses while another press's start is younger than 2 minutes, and that press answers `subscription_starting` with
  nothing sent and nothing compensated (B1); a press whose start replaced an expired one lists Stripe again in its own
  compensation (decision "W13c call"). The check before Q8 runs in a transaction; T2 records a subscription its press
  made as `left` in its own transaction when it finds the order gone or marked, and the put-back runs (and writes) only
  with time left to send, so nothing is written after T2 once the window has closed (S1). Reconcile retries each open
  `left` put-back on an order no longer pending: cancelled (checked), its first invoice refunded under its key, then a
  `cancelled` row that closes the stuck list's warning (L3).
- **W13d (the W13c review)**: T2 also records the press's subscription as `left`, and the press puts it back, when the
  old rollback has started on the order, or it was paid with another payment, or it is otherwise not pending (S-1).
  Reconcile's saved-card path passes the subscription it found as made here, so an order undone by another actor
  between its list and T2 leaves a row the next run puts back (S-2). The retry takes only rows whose order no longer
  exists, never a paid one (L3).

## The switch and the screen (W14a)

`ORDER_SWITCH` (a Worker secret) lists the kinds of order the Worker takes: `no_stripe`, `saved_card`, `reader`,
`membership`, `reader_flows`, `booking_changes`, comma or space separated. Empty or unset means every kind is off. `order-switch.ts`
decides a basket's kind from what was sent: any membership is `membership`; otherwise the reader is `reader`, the
saved card `saved_card`, and anything else (cash, gift card or store credit alone, nothing owed) `no_stripe`.
`reader_flows` and `booking_changes` are step D's (below). `POST /api/v1/staff/orders` answers
`ORDER_PATH_OFF` (501) for a kind that is off, before the order is touched; the answer is stored against the
request's key like any other, so a retry with the same key gets it again. The quote, finalise, cancel and
reconcile ignore the switch.

W16: the staff app's old order code is gone, so the switch is an emergency off switch. `createOrder` is a thin
call to this route; on `ORDER_PATH_OFF` it places nothing and tells staff the kind is switched off.
`finaliseReaderOrder` and `cancelReaderOrder` are thin calls too, with no `old_reader_order` fallback (no order the
old checkout started was left, checked live on 11 Nov). No failure falls back. T1 failing in the database (a lock timeout, a deadlock after its retry, a failed write) is a definite answer:
`order_not_saved` with plain words, so the screen's next press gets a new key. Stored answers lose their client
secret after the pending window (`pruneClientSecrets`, run by the schedule). The route stores its answer in a
transaction (8 s statement limit), counted at 8.1 s in the timing convention.

## Booking changes: foundations (step D, W17)

Step D moves the booking changes (Move, Add Guest, Settle, Remove Guest, the refunds, the cancels, the two setters)
here one slice at a time (staff app `briefs/D-plan.md`). W17 laid the ground; nothing is switched and no route exists yet.

- `bookings/load-booking.ts`: the booking, its seats (seat 1 first), its session and type, what is open on it (any
  pending flow, card or reader, old or new, and an order still being paid: the old NO_READER_PAYMENT_OPEN), and its
  refund figures. `lockAndLoadBooking` locks first, in LOCK_ORDER.
- `bookings/locks.ts`: `lockForBooking`, one statement: the booking, its customer, the sessions (id order), credit
  periods, the pass, memberships, the gift card. LOCK_ORDER now has `booking` straight after `order`; a flow's C2 and
  undo lock the flow's row, then the booking.
- `bookings/money-left.ts`: getBookingRefundFigures, the order card portion and an order's status after refunds, as the
  old code worked them out, except W05l later 1 (permanent with Q36): a gift card part with no order is gift card money.
- `bookings/flow.ts`: a booking change on the saved card is a flow with `method: 'card'` (`pending_reader_payments`,
  written by C1 with no PaymentIntent). `settleCardFlow` charges under `<pendingId>:charge` with `metadata.pending_id`,
  then W12's C2 (`finaliseFlowInTransaction`, which now writes `payment_method 'card'` and the PaymentIntent onto the
  row) or, on a definite refusal, W12's undo. Unclear: held (Q35's words), never undone. Safe to run again at any point.
  The reader routes refuse a card flow (`not_a_reader_flow`). Reconcile and the stuck list learn card flows at W19.
- `bookings/booking-switch.ts`: `booking_changes` for any change that moves money, plus `reader_flows` and `reader`
  for the reader (W18: taking `reader` out stops New Order's reader now, and the booking changes on the reader as
  W19 / W20 / W24 move them to the Worker; until then the live Settle, Move and Add Guest on the reader are the old
  Retool code, which reads no switch) and `saved_card` for a card charge; off answers BOOKING_PATH_OFF (501) before anything. Only starting a change is gated: finishing
  or undoing a held one never is. A change that moves no money (special requests, status) needs no kind.
- `bookings/failure-messages.ts`: every word staff see from a booking change, word for word from the four dialogs'
  maps and the old functions, plus W17's (the switch, Q35, Q37, a held card flow).
- `contracts/bookings.ts`: the routes' inputs (old param names, loose; `confirmed`/`figures` for Q18) and the figures.
- Tests: the replay's step D side (`testing/replay/booking-side.ts`, `booking-replay.test.ts`) with setup through the
  frozen copy of the old functions (`testing/legacy-booking/`), and the W17 golden gaps (`w17-*` scenarios).

## Special requests and status (step D, W18)

The first two booking changes on the Worker; the staff app's `setBookingSpecialRequests` and `setBookingStatus` are
thin calls to them. `bookings/edits.ts`, each one transaction: `lockAndLoadBooking` (the booking and its customer),
the rule, the audit row, then the write. A refusal is an ApiError whose `details` (`bookingRefusalDetails`) carry the
old reason and the words staff see; it writes nothing.

- `POST /api/v1/staff/bookings/:bookingId/special-requests` (`booking.special_requests`): trimmed, cut to 500
  characters, null when empty; `booking_cancelled` on a cancelled booking. The audit row keeps lengths, not the text.
- `POST /api/v1/staff/bookings/:bookingId/status` (`booking.status`, `{ from, to }`), N3: only `pending`,
  `confirmed`, `completed`, `no-show` (`invalid_status`); never from `payment_needed` (`booking_payment_needed`) or
  `cancelled` (`booking_cancelled`), and never while a payment is still being taken on the booking (W18 review S1:
  a held Move, Settle or Add Guest flow, or an order still being paid; `card_payment_open` with the card words when
  every open flow is a saved-card one, else `reader_payment_open`), since the undo needs the status the payment left.
  Special requests stay allowed then. A no-show made active again on a day the customer has another booking gets the
  one-a-day trigger's own words (`duplicate_day_booking`); one whose time another booking now overlaps,
  `time_conflict`.
- Neither moves money, so neither checks the switch.

## Settle and the flow pipeline (step D, W19)

`bookings/settle.ts`, `POST /api/v1/staff/bookings/:bookingId/settle`; the staff app's `settleLapsedBooking` is a thin
call to it. Gated first by the switch (`booking_changes`; the card also `saved_card`; the reader `reader_flows` and
`reader`). The amount is seat 1's stored price, never recalculated.

- **C1, one transaction, no Stripe** (with T1's once-only deadlock retry): `lockAndLoadBooking` (the booking, its
  customer, the gift card), the old checks in their order, Q18's confirmed figures (`figures.amountDue`,
  `figures.toCollect`; the cash tick's `confirmedCashAmount` when no `toCollect` is sent; over half a penny refused
  with the new figure and Q11's words), the store credit and the gift card claimed (New Order's words for a voided,
  expired, missing or used-up card), the booking confirmed with seat 1 paid and its credit released, `booking.settle`.
  **W37a (W37 review S1):** with card money still to come the membership credit is NOT released at C1. Its period and
  `membership_credit` stay on the booking (the period still counts it used, so nobody can spend it while the payment
  is pending), the record says `release_credit_on_finalise`, and C2 clears them. The undo has nothing to take back.
  No card money: the gift card's row (the booking, no order), commit, settled. Q36: no order for cash, gift card or
  store credit. A database fault rolls all of it back: `settle_not_saved`, nothing kept.
- **Card money:** the flow's record (`pending_reader_payments`, `method` card or reader, `request_id`, `livemode`,
  `stripe_customer_id`, every part) is C1's last write. The saved card: `settleCardFlow` charges once under
  `<pendingId>:charge` (metadata `pending_id`), then W12's C2 (the card part's order and booking line, as today) or, on
  a definite refusal, the undo; no clear answer is held (Q35's words), never undone here; a C2 fault after the card
  paid is held (never refunded) with its PaymentIntent written onto the row on its own. W17 review S1: nothing is
  sent for a record older than 60 minutes. The reader, pending-first (W12-7): the intent under
  `<pendingId>:reader-intent` with `metadata.pending_id`, written onto the record with its Stripe customer and mode;
  the screen collects, then W12's flow routes finish or cancel it.
- **Reconcile** (`reconcileCardFlow`) never sends a card flow's charge: it lists the customer's payments and matches
  `metadata.pending_id`. One succeeded: C2. None, or only declined or cancelled ones, past the window: the undo.
  Anything else (`payment_processing`, unclear): left held. A charge landing on an undone card flow is refunded by the
  late-refund step. The stuck list shows card flows as the Worker's with their own waiting words; the old sweep, the old
  stuck list and `OLD_DUE_SQL` count a card or reader flow with a `request_id` as the Worker's.
- **W17 review S2:** step C's undo locks the order's booking straight after the order (LOCK_ORDER), so it and a
  booking change's C1 queue rather than deadlock.

## Add Guest and add-ons (step D, W20)

`bookings/add-guest.ts`, `POST /api/v1/staff/bookings/:bookingId/guests`; the staff app's `addBookingGuest` is a thin
call to it (a guest, add-ons, or both). Settle's shared pieces (a part's amount, the held-payment refusal, the store
credit and gift card claims, C1's transaction) are in `bookings/money-in.ts`, used by both.

- **The prices**, in the old order: add-ons as New Order (member, else sale, else base; a sent price only with Manage
  pricing, and then a different one needs a reason); the guest's seat: private, the tier for the new headcount less
  price paid less money owed plus the booking line's promo share plus part refunds, never below £0 (Q25, Q27); public,
  the band's seat price, always paid. With no payment and money due the answer is those figures (`priceImpact`) and
  nothing is added (the dialog's first call); a quote is never gated by the switch, an add with nothing to pay is
  (`booking_changes`), a payment before anything is read.
- **C1, one transaction, no Stripe:** the booking, its customer, its session, the add-on credits' memberships and the
  gift card locked in LOCK_ORDER; the checks; Q18's figures (`amountDue` the guest plus the paid add-ons, `toCollect`);
  the place (+1, public), the add-on credits, the store credit, the gift card (New Order's guarded claim, stamping
  `redeemed_at` when used up: O1) claimed before any Stripe call (bug 9); the guest, the booking, the add-on lines. No
  card money: its own paid order (as today, Q36) with the seat on its booking line, the add-on lines, the gift card's row
  and the store credit's link on it; `booking.guest_add`. Card money: the flow record, then the saved card
  (`settleCardFlow`) or the reader, pending-first, as Settle. The party size is part of the locked booking, so two
  guests at once queue and the second is priced at the new headcount.
- **W05c Noticed 5:** C2 (`finaliseFlowInTransaction`) writes an Add Guest's seat on the booking line and the paid
  add-ons on their own lines of the same order, so the booking line is the card money less the add-ons, never below £0.
  The refund figures' seat money is unchanged.

## The refund pipeline: Part refund, Refund the rest, It already arrived (step D, W21)

`bookings/refunds.ts`; `POST /api/v1/staff/bookings/:bookingId/refunds` (Part refund), `/refunds/owed` (Refund the rest),
`/refunds/owed-arrived` (It already arrived), all Issue refunds; `GET /api/v1/staff/bookings/:bookingId/refund-figures`
(the figures, any active staff member). The staff app's `refundBooking` amount paths and `getBookingRefundFigures` are
thin calls; Cancel & Refund keeps its old body until W23.

- **R1, one transaction, no Stripe:** the booking (and its customer) locked; a payment still being taken, or a Worker
  refund claim still open on the booking, refuses; the figures (`money-left.ts`) and the amount, to half a penny (Q18,
  the old words with the new figures); the claim (`price_paid` lowered, a part refund also in `part_refunded_amount`,
  Refund the rest lowers `refund_owed_amount`); the plan (card parts: the booking's lines newest first, each order's
  card portion used once, each line's seat money, one part per order; the rest to store credit; or, Q26, cash handed
  over, capped at `cashLeft`); the claim's row `booking.refund_claimed` (`worker: true`, the plan, the key's mode). No
  card part: the store credit (or the cash) and the finished row in the same transaction.
- **The card parts:** after R1 commits, each sent once under `<claimId>:refund:<orderId>` with `metadata.claim_id`.
  The first refused (nothing went): R1 undone (`put_back`, or owed again for Refund the rest) and the old words. A
  later one refused (W26a; Wayne, 14 Nov): it and the rest owed on the booking, live or cancelled, never store credit,
  with Stripe's reason in the warning and on the finished row (`refused`); a person checks Stripe, then uses It
  already arrived or Refund the rest. A later one with no time left to send (W21a, review L6): it and the rest owed
  on the booking, live or cancelled (W26b), for Refund the rest to send to the card (Stripe never refused them; store
  credit only on a cancelled booking). No clear answer: held (`held` in the answer,
  Q35's words); no press sends it again. Then **R2**, one transaction: each part on its lines' `card_refunded_amount`,
  the store credit, the orders' status, `booking.part_refund` / `booking.refund_owed` (the old rows' fields) and
  `booking.refund_finished`. R2 failing after money went: held too, with words saying what went.
- **Refund the rest after the old screens' unclear refund:** owed money old Move, Remove Guest or Cancel & Refund put on
  the booking after a card refund with no clear answer (`booking.card_refund_unsure`, until W22 to W24) is looked for in
  Stripe by its old `refund_key` first, every page of each PaymentIntent's refunds (the old 24-hour look-up's job).
  W21a (review L1, L2): the look runs before R1; R1 checks, under the booking's lock, that the notes are still the ones
  looked for, and that each old refund that went is exactly one planned part on its PaymentIntent. Otherwise nothing is
  sent or claimed (`refund_check_failed`; for an old refund that went, words naming it and saying to check Stripe, then
  use It already arrived). A part it matched is stored in the claim (`matched`: the order and the old refund's id): the
  press never sends it, and the press's R2, reconcile and the `held_claim` close all record it as gone, never owed.
  Stripe not answering the look: nothing sent or claimed, `refund_check_failed`.
- **Reconcile** (`orders/reconcile.ts`, `reconcileClaim`): a Worker claim with no finished row, past the window. It lists
  the refunds on each planned PaymentIntent and matches `metadata.claim_id` (never sends): found (succeeded or pending),
  or a part the claim matched to an old refund (W21a), is recorded; not found ends as money owed (Refund the rest), or store credit if the booking has been cancelled since
  (it has no button left). Left for a person: the other Stripe mode, two refunds for a part, a refund of another
  amount. Its rows are `order.reconcile` against `refund_claim` / the claim's id.
- **The stuck list** shows held claims (`claims`); the manual close has `held_claim` (the card money not recorded goes on
  the booking as owed, for It already arrived or Refund the rest) and `held_flow` (W19 review later 1: W12's undo for a
  card or reader flow reconcile left for a person, the payment found named for a person to refund).

## Remove Guest and Remove add-on (step D, W22)

`bookings/remove-guest.ts` and `bookings/remove-addon.ts`, through the W21 pipeline (`refunds.ts`: claim kinds
`remove_guest` and `remove_addon`). `POST /api/v1/staff/bookings/guests/:guestId/remove/quote` and `.../remove`;
`POST /api/v1/staff/bookings/addon-lines/:lineId/remove/quote` and `.../remove`. The quotes are reads (any active staff
member, never gated). The removals take the amount staff confirmed (Q18, half a penny either way), are idempotent, and
are gated by `booking_changes` only when money goes back. The staff app's `removeBookingGuest` and `removeBookingAddon`
are thin calls.

- **Remove Guest R1, one transaction:** the booking, its customer and session locked; the guest read again under the
  lock (a second tab finds it gone: W02 finding 11); a payment still being taken (W18a's words) or a Worker refund
  claim still open refuses; Issue refunds only when money goes back; the confirmed amount; then the guest deleted, a
  public place released, the party size and price paid lowered, the refund planned (W21's `planRefund`: the booking's
  lines newest first) and the claim written with the guest (its row too, when there are card parts, for the undo).
  Private guests (no seat price, and Q38), credit and pre-band seats refund £0: no claim, `booking.guest_remove` only.
- **Remove add-on R1:** the line claimed (`removed_at`); inside 24 real hours nothing back (`none`, the old note);
  a credit add-on's credits back while its membership is active (`credit_returned`), else the old note; a paid add-on
  refunded: card first on the order that paid for it (`planAddonRefund`, capped at that order's card portion), the rest
  to store credit linked to that order. Its card part's lines are add-on lines.
- **The press and R2 are W21's:** each card part once under `<claimId>:refund:<orderId>`. R2 records a guest's card
  part on the booking lines and stamps the guest's line once nothing is owed (the old `stampRemovedGuestLine`); it
  stamps the add-on line with what went back and how. The first card part refused: the undo puts the guest back
  (their row, place, party size, money) or the add-on back on the booking, with the old words. Unclear: held; the guest
  or add-on stays removed; reconcile records what went and puts what never went on the booking as owed (store credit
  on a cancelled booking). `booking.guest_remove` / `booking.addon_remove` are the actions' own rows.
- **W22a: Remove Guest follows the 24-hour rule** (Wayne's decision, 13 Nov), with the add-on's check on the same
  wall-clock start (`load-booking.ts`'s `sessionStartWallClock`): inside 24 real hours of the session the quote is £0
  (`insideTwentyFourHours: true`), the guest is removed with the place released and nothing back (no claim, no Issue
  refunds, the line not stamped, the seat's money left on the booking for Part refund), and `booking.guest_remove`
  carries `reason: 'inside_24_hours'`.

## Cancel & Refund, Cancel & return credit and Cancel (payment needed) (step D, W23)

`bookings/cancel.ts`, through the W21 pipeline (`refunds.ts`: claim kinds `cancel` and `cancel_credit`).
`POST /api/v1/staff/bookings/:bookingId/cancel-and-refund/quote` and `.../cancel-and-refund` (Issue refunds);
`POST /api/v1/staff/bookings/:bookingId/cancel-credit/quote` and `.../cancel-credit` (any active staff member; Issue
refunds only when ticked paid add-ons are refunded). The quotes take the ticked add-on lines and are reads: never
refused for an open payment or refund, they say what a press would be refused with now (`blocked`, the old words). The
presses take `confirmed: { refund, addonsRefund }` (Q18, half a penny each; missing counts as £0), are idempotent, and
are gated by `booking_changes` only when money goes back (W26a, audit S3: Cancel & return credit counts the club's
refund of paid guests, `confirmed.refund`, with the add-ons', so the emergency stop stops it too). The staff app's
`refundBooking` (no amount) and `cancelCreditBooking` are thin calls.

- **One card part per order per claim (item 1).** `planRefund` takes a cancel's ticked paid add-on lines after the
  booking lines: each against the order that paid for it, sharing that order's card portion (used once), each capped at
  its own amount; the rest to store credit. An order's seat and add-on money are one part, one refund, one key (order
  £45 on the card, seat £40 and towel £5: one £45 refund). A part's add-on lines carry `addon: true`; R2 records the
  booking lines' share on them and stamps the add-on lines with theirs. With no add-on lines the plan is W21's.
- **Cancel & Refund R1, one transaction:** the booking, customer, session and the ticked credit add-ons' memberships
  locked; the ticked lines read again under the lock; a payment still being taken, a Worker refund claim open, a
  booking already cancelled or the 24-hour rule refuse (old words); the confirmed figures; then the booking cancelled
  with nothing owed (it gives what is owed too; `price_paid` stays, as on every cancelled booking), its places released
  (a private booking's whole session, a public one's party), the ticked lines claimed with their credits back while the
  membership is active, the refund planned (price paid and the ticked paid add-ons) and the claim written with what R1
  changed (`cancel`: status, cancelled time, owed, places, add-on lines and their stamps as they were). To the card, an
  old screen's unclear card refund is looked for first (W21a's look-up): one that went must be exactly one planned part,
  or nothing is sent. With no money at all there is no claim; R1 writes `booking.cancel`.
- **Cancel & return credit R1 (N4: one transaction):** the old checks in the old order (not a credit booking, not
  cancellable, a payment open, a refund open, money paid: "Remove paid guests first, then cancel." when seat 1 is
  credit-covered and guests are paid, the 24-hour rule except on a payment-needed booking); the cancel, its places, a
  pass's session back while the pass is unexpired, whether the credit can be used again (its period still current, or
  the pass unexpired), the ticked lines' credits, and paid lines refunded when staff chose card or store credit (£0
  inside 24 hours, the old note). The booking's lines are stamped only when all its seat money had gone back already
  (the old `stampLinesIfSeatMoneyAllBack`), after the add-ons.
- **The press and R2 are W21's.** R2 gives a cancel's store credit as the old functions did: the seat's (note "Booking
  refund", linked to the booking's own order), then the add-ons' per paying order ("Add-on refund: 1× Towel."), each
  row a millisecond after the one before (one transaction, one `now()`); stamps the add-on lines; stamps Cancel &
  Refund's booking lines (the old last statement); works out the orders' status after both. The first card part
  refused: R1 undone exactly (`undoCancel`) with the old words (Cancel & return credit: new words, the cancel put back:
  N4). A later part refused (W26a): owed on the cancelled booking, never store credit. Unclear: held, the booking
  stays cancelled; reconcile records what went, and what Stripe never got ("not found") ends owed on the cancelled
  booking too (W26b; Wayne, 14 Nov), never store credit.
- **A held claim closed by hand on a cancelled booking (any kind):** its money stays owed on the booking, never store
  credit: reconcile left it because Stripe shows something it can't settle, so the card money may have gone. The close's
  words say to check Stripe and give what didn't arrive as store credit on the customer's page.
- **The club's cancel (W23a, Wayne 13 Nov).** Block Session and Block Day send `clubCancelled: true` with the quote and
  the press of both cancels. The 24-hour rule doesn't apply: Cancel & Refund gives the whole booking back (card or store
  credit), Cancel & return credit gives the credit, a pass session and add-on credits back and refunds ticked paid
  add-ons, at any time before the session starts; once it has started the club's cancel is refused
  (`session_already_started`). Money back still needs Issue refunds, and (W26a; Wayne, 14 Nov; audit S6) so does any
  club cancel inside 24 hours of the session, since the flag comes from the screen (`no_refund_permission`; a
  payment-needed booking, which the rule never covered, is as before; outside 24 hours nothing changes). The claim's `cancel` record and the cancel's own
  audit row carry `clubCancelled: true` (only then). A cancel from the booking page keeps the 24-hour rule.

## Move (step D, W24)

`bookings/move.ts`, through W19's flow pipeline for a dearer move and W21's refund pipeline (claim kind `move`) for a
cheaper one. `POST /api/v1/staff/bookings/:bookingId/move/quote` (a read: the old `priceImpact`, `blocked` with the words
a press would be refused with now, and for a cheaper move `cardRefundAvailable` and `refundParts` for Q37) and `.../move`
(`confirmed: true` with `figures: { amountDue, toCollect }`: Q18, `amountDue` signed, negative a refund, half a penny
either way, a missing figure counting as £0; idempotent; without `confirmed`, the quote). Any active staff member; Issue
refunds for a move that gives money back. Gated before anything is read: a payment as Settle and Add Guest, money back
by `booking_changes`. The staff app's `moveBooking` is a thin call.

- **The price, as the old function worked it out:** public moves seat by seat at the new band (`quote_booking`), paid
  seats settling their difference, a dearer move stopping at the new paid seats less what was paid toward them and the
  part refunds (Q28 and the W05 review's cap); private moves at the new band's tier less those two; a refund never more
  than is left; a legacy booking (no seat prices) keeps its price (N9 left); public to private and promo bookings refused.
- **Q34 (Wayne, 12 Nov):** a membership credit stays only while the new band is credit-eligible for the level and the
  booking's membership covers the new date (active, `cancel_effective_date` not before it); a pass seat only while the
  pass covers the new session (`pass_covers_session`) and its `expiry_date` isn't before it. Otherwise the seat is paid
  its full new price, the booking's credit cleared, and a pass session given back (while the pass is unexpired today).
  **W37a (W37 review S1):** with card money still to come (saved card or reader) a released membership credit stays on
  the booking until C2 (`release_credit_on_finalise`), as the pass session is given back at C2, so the flow's undo
  never takes a credit back. A cheaper Move's put back after a refused first card part (`undoMoveClaim`) takes the
  credit back only while its period still has one free (`takeCreditBack`, under the period's lock: unlimited, or used
  below allocated); otherwise `PutBackBlocked`: the move stands and the card money is owed, as for places and passes.
  Used is never above allocated (`bookings/credit-held-postgres.test.ts`, real Postgres).
- **N1:** the one-booking-a-day check runs before any money moves (quote and press) with New Order's words; should
  another booking race past it, the trigger's refusal gets the same words (`duplicate_day_booking`), never the raw text.
- **One transaction (C1, or R1):** the booking, its customer, both sessions (id order: two moves the other way round
  queue rather than deadlock), the session pass and the gift card locked; the old checks in the old order, with a payment
  still being taken and a refund still being checked first; the new session's places claimed; the old session's given
  back, unless card money is still to come, when the old seat is held until C2 (as the reader always did); store credit
  and gift card (dearer); the booking and seats moved; a released pass session given back (on a flow, at C2).
- **Dearer on the card or reader:** the flow record last (the old move snapshot plus the Worker's marks), then W19's
  saved card (`<pendingId>:charge`) or reader intent (`<pendingId>:reader-intent`); W12's C2 writes the card's order and
  gives back the old places and the pass session; a definite refusal undoes it; no clear answer holds it (Q35). Cash,
  gift card and store credit write no order (Q36: today's way); the gift card's row names the booking.
- **Cheaper:** the refund planned and claimed (`move`: what R1 changed, for the undo). To store credit, R2 runs inside
  R1 (note "Refund of the price difference after a booking move."). To the card, each part once under
  `<claimId>:refund:<orderId>`, then R2. The first part refused: the move put back exactly (`undoMoveClaim`: the booking,
  its seats, both sessions' places, the pass session); a later part refused (W26a): owed on the booking; unclear: held (the booking
  stays moved), reconcile records what went, and what Stripe never got ends as owed (Refund the rest).
- **Its own row:** `booking.move` (old and new session, the signed amount, the parts, method, refund method and where it
  went, the flow record, the credit or pass released): C1's for every move but a cheaper one, whose row R2 writes once
  the money's fate is known (an undone move leaves none).
- **A booking awaiting payment can't be moved (W24a, W24 review S1):** refused on the quote and the press before
  anything is priced (`booking_not_movable`, "Take the payment first, then move the booking."). Its first seat is
  unpaid, so a dearer move charged that seat and Settle then charged it again (£40 for a £20 seat).

## The old payment code out, and step D's "for later" fixes (step D, W25)

Read this first where an earlier section names something W25 removed: those sections are history, this one is now.

**What went.** The staff app's old flow code (the old sweep, the stuck list's own queries, the flow wrappers' old
bodies, `chargeSavedCard`, `createTerminalPaymentIntent`) and the three legacy routes only it called
(`/api/payments/charge-saved-card`, `/api/terminal/create-payment-intent`, `/api/terminal/payment-intent`: moved, byte
for byte, into `testing/legacy-order/routes/`, where the frozen copies still call them for the golden set-ups). Here:
- **No "old" items.** `old_reader_flow`, `old_reader_order`, `old_code`, `OLD_DUE_SQL`, the run's `oldLeftAlone` and the
  stuck list's `madeBy` are gone. A pending order or flow with no mark of the Worker's (none can be made any more) is
  refused by the reader routes as `not_a_reader_order` / `not_a_reader_flow`, left alone by reconcile, and listed for a
  person as `not_started_here` ("tell a manager"), never "press Resolve now": Resolve now is this reconcile and nothing
  else.
- **The look-up of old `booking.card_refund_unsure` notes** (W21a, W23) is gone with its `matched` parts: nothing writes
  those notes and live has none.

**Part B.**
- **Money still owed on a cancelled booking** (W23 review later 1): what is owed there lives in `refund_owed_amount`
  alone (`price_paid` stays, as on every cancelled booking). Refund the rest (store credit only, exactly what is owed;
  the card is refused, `cancelled_store_credit_only`) and It already arrived run on it; a part refund is still refused.
- **The undo after a refused first card part** (W22 later 2, W23 later 2, W24 review L1): it takes a session's places
  back only while the session has room, and a pass session only while the pass has one (`PutBackBlocked`). Otherwise
  nothing of the undo is kept: the change stands, and (W25a, W25 review S1) the press finishes the claim there and then
  as a close by hand does: every card part owed on the booking, kept owed on a cancelled booking too (never store
  credit unseen: Stripe's refusal may mean the customer has the money already). The press still answers held
  (`refund_refused_not_put_back`); its words carry Stripe's reason and point to It already arrived / Refund the rest.
  The finished row says `by.how: 'undo_blocked'` with the reason. Reconcile never sees the claim (only if that finish
  itself fails does the claim stay open for it).
- **Every Stripe refusal is held for a person, never store credit unseen (W26a; Wayne, 14 Nov; audit S2, table 34 and
  35):** a refused card part is marked on the claim first (`booking.refund_refused`: the claim, the part, Stripe's
  reason; its own transaction, tried twice). An undo that fails for any other reason (a database fault) ends as a
  blocked one does (`by.how: 'undo_failed'`, its own words). A later part refused ends owed (above). Reconcile reads
  the mark, and also takes a failed or cancelled refund naming the claim in Stripe as a refusal (`findCardPart`:
  `refused`, where the press got no clear answer): a claim the press couldn't finish ends with what never went owed
  on the booking, live or cancelled (`refused` on the finished row).
- **Money owed on a cancelled booking is always left for staff (W26b; Wayne, 14 Nov; W26a's unsure 1):** R2
  (`finishClaimInTransaction`) never gives card money that didn't go as store credit, whatever the booking's status and
  however the claim ends: the press (a later part with no time left to send), reconcile's "not found", a refusal, a
  close by hand. It is owed on the booking (`refund_owed_amount`; a cancelled booking's `price_paid` stays), for
  Refund the rest (store credit only on a cancelled booking) or It already arrived. Only the plan's own store credit
  (what the cards can't take) is given. This closes what W26a left: Stripe refusing with an error (no refund object)
  while the database can write nothing at all, the mark included, which reconcile reads as "not found" and used to
  give as store credit on a cancelled booking. The not-sent warning on a cancel says Refund the rest goes to store
  credit there (`laterCardRefundNotSentMessage(amount, cancelled)`).
- **The club's Cancel & return credit with paid guests** (W23a): from Block Session / Block Day it refunds the guests'
  money (the booking's price paid) through the same claim, to the method chosen, with `confirmed.refund`; Issue refunds.
  From the booking page it is still "Remove paid guests first".
- **The manual close** (W21 review L4, L5): reconcile looks at every card part before leaving a claim for a person and
  keeps what it found on its left row (`parts`); `held_claim` records the parts that went and puts only the others
  owed, naming each. A `held_flow` closed while its saved-card payment was still processing has that payment watched
  (`reader_payment.payment_watched`): each run reads it (and cancels it when Stripe allows); if it lands it is recorded
  as `reader_payment.charge_without_record`, which the automatic refund gives back.
- **Smaller:** an Add Guest flow's undo clears `guests_over_18_confirmed_at` when its own tick set it
  (`over_18_confirmed_here`); a Move press with both a payment method and a refund method is refused
  (`payment_and_refund`); a held move's undo that meets the customer's other booking says so plainly (`undo_blocked`,
  `FlowUndoBlocked`); Q18 confirms a cheaper move's amount, not its card / store credit split (the rule is card first,
  the rest to store credit, and the answer says what went where: left as it is, for the spec).

## The step D audit fixes (W26a)

- **Stripe refusals** (S2, table 34 and 35): see "Every Stripe refusal is held for a person" above.
- **The switch on Cancel & return credit** (S3) and **the club's cancel inside 24 hours needs Issue refunds** (S6):
  in the Cancel section above.
- **Add Guest and Settle refuse a booking with an open Worker refund claim** (A1): `refund_open` with W21's words, in
  Add Guest's checks (the first call and the press, under the booking's lock in C1) and Settle's C1, as Move and the
  removals: an undo after a refused refund puts places and prices back as R1 found them.
- **The paid line** (S5, Q37): the figures route also sends `paidWords` ("Paid £15.00 by card and £5.00 by gift card /
  store credit."), `paidLineWords` over the figures' parts: the money on the booking now, so money already refunded
  or still owed isn't in it. The booking detail shows it.
- **Screens** (S1, S4): a customer's Booking History row opens the booking by id; the calendar's cards list cancelled
  bookings under the Cancelled filter; Part refund, Refund the rest / It already arrived, Add Guest and Take Payment
  reload the booking on close after no answer or a throw (source tests in `server/staff-app-helpers.test.ts`).

## Step E foundations: the shared refund core, claims on orders and event bookings, money owed on an order (W27)

Step E (staff app `briefs/E-plan.md`) moves order refunds and event cancellations onto step D's refund pipeline, one
slice at a time (W28 to W35). W27 laid the ground. **Nothing is switched, no route exists yet and no booking behaviour
changed:** step D's suite, replay and planted bugs pass as before.

- `refunds/pipeline.ts`: the parts of the pipeline that don't care what is refunded, lifted out of
  `bookings/refunds.ts` with every statement and its timing the same: a claim's read and write on `audit_log`, the
  open-claim look, the due list, one card part's key (`<claimId>:refund:<orderId>`), request and send, the refusal
  mark and its read, the Stripe look-up (never a send) and the held answer. A claim is on a **subject**
  (`BOOKING_CLAIMS`, `ORDER_CLAIMS`, `EVENT_BOOKING_CLAIMS`): one set of three actions each (`<subject>.refund_claimed`,
  `…refund_finished`, `…refund_refused`; lead call L2). `bookings/refunds.ts` keeps everything about a booking (the
  R1s, R2, the undo, money owed on a booking) under the same exported names, and calls the core for a booking.
- `refunds/claims.ts`: an order's and an event booking's claim, with the same details and keys as a booking's. Two
  rules are kept where the claim is written: **one card part at most**, on the claim's own order (an event booking is
  always paid by one order), and **an open claim holds its subject** (`refund_open`). An order and its event booking
  share one card payment and one "money owed", so an open claim on either holds both, and so does an open booking
  claim with a card part on that order's payment. **What makes the look hold (W27a):** both writers take the order's
  row lock themselves (FOR UPDATE; the event booking's on its `details.orderId`) before they look, so order and event
  booking claims queue even if a caller forgot `lockForRefund`. A booking's claim is seen **only once it is
  committed, and one way** (lead's call (a), 14 Nov): step D's booking refunds never lock the order row and never look
  for an order's claim, and step D's lock order is unchanged. Money still can't go twice: the two claims are never for
  the same line, each card part has its own key, and Stripe never refunds more than the payment took; the worst case
  is a card part refused for going over what is left, which ends as the refusal's words or as money owed.
  `refunds/claim-writers.test.ts` (a text search) keeps every other app file from passing `ORDER_CLAIMS` or
  `EVENT_BOOKING_CLAIMS` to `writeClaimRow`, which would skip the writers' rules.
- `refunds/locks.ts` (`lockForRefund`): one statement, in LOCK_ORDER: the order (FOR UPDATE, as T2, the undo and the
  close by hand take it), its customer, then the session passes, memberships and product variants the refunded lines
  sold, the event, **the event booking (after its event: LOCK_ORDER's new `event_booking`)**, the gift cards. The
  caller reads the ids, locks, then reads again under the lock.
- `orders/money-owed.ts`: `orders.refund_owed_amount` (migration 023; Wayne's Q39): raise, lower (never below £0; any
  amount up to what is owed), read. An event booking's money owed is its order's (`moneyOwedOnEventBooking`): the
  failed card refund was on that order's payment and Refund the rest goes back to it, so one figure serves both.
- `refunds/refund-switch.ts`: `ORDER_SWITCH` gains `order_refunds` and `event_cancels` (lead call L3), both off unless
  the secret names them; off answers `REFUND_PATH_OFF` (501) before anything is read. A cancel with no refund needs
  no kind. The value live runs today turns neither on.
- `refunds/failure-messages.ts` and `events/failure-messages.ts`: every reason `refundOrder`, the event cancellations
  and their dialogs answer with, and its words, word for word (held to the frozen old code by the tests beside them).
  Not moved: the warnings for half-finished states and the "settle on the next press" words, which have no state left
  to describe once a refund is one claim.
- `contracts/refunds.ts`, `contracts/events.ts`: the routes' inputs and outputs (E-plan 4.8), loose where the old
  function answered for itself, with `confirmed` for Q18. `REFUND_PATH_OFF` joins the error codes.
- `supabase/migrations/023_orders_refund_owed_and_cash_refunds.sql`: **written, not applied.** The saved test schema
  already has it (testing/README.md).

## Order refunds on the Worker (W28)

`refundOrder` is the Worker's now: `POST /api/v1/staff/orders/:orderId/refunds`, with
`GET …/refund-figures`, `POST …/refunds/owed` (Refund the rest) and `POST …/refunds/owed-arrived` (It already
arrived). The rule is `orders/refund-lines.ts`, on W27's pieces. Gated by `order_refunds` (the figures and It already
arrived, which move no money, are not). W29 adds the membership line and the payment date change charge (below); W28
and W29 are released together.

- **R1 (one transaction, no Stripe):** `lockForRefund` (the order, its customer, the passes, variants and gift cards
  the lines need), `refund_open` while any claim holds the order, the old checks in the old order with the old words,
  E2 (only an order that is `paid` or `partially_refunded`), E5 (a pass is used when a booking that names it holds its
  seat: not cancelled, or cancelled with the session not returned; W28a: or while a Move off its seat still waits for
  its payment, when no booking names the pass and its session hasn't come back; never the pass type's sessions today), the amount
  staff confirmed (Q18; **no `confirmed`, nothing moves**), the plan, the lines' reversals (gift card voided, pass
  emptied, stock back with its `stock_adjustments` row), the lines stamped, the claim. With no card part R1 also gives
  the store credit (or records the cash) and finishes.
- **The plan:** card capped at the order's card money left (`loadOrderCardPortion`), the rest to store credit; or
  cash (Wayne's Q42) capped at the cash paid on the order less cash already handed back (`orderCashLeft`), the rest to
  store credit; or all store credit. One card part at most, keyed `<claimId>:refund:<orderId>`.
- **The card part:** sent once after R1 commits. Went: R2 (the card money on its lines, the store credit, the order's
  status, `order.refund`, `order.refund_finished`). Refused: marked (`order.refund_refused`), then R1 undone in one
  transaction (run once more after a deadlock, W29a: it writes a refunded membership's credit bookings after locking
  the customer) and the old words answered; never store credit instead. If the undo can't run (a restocked item sold
  since: `OrderPutBackBlocked`) or fails, the refund stands and the card money is **owed on the order**
  (`orders.refund_owed_amount`) with Stripe's reason. No clear answer: held; reconcile lists the payment's refunds by
  `metadata.claim_id` and runs R2 (found) or leaves the money owed (not found). Never sent again by anyone.
- **Money owed on an order (Q39):** Refund the rest gives exactly what is owed (card as a new claim, store credit, or
  cash within the cap, never split). It already arrived takes any amount up to what is owed (the W26 audit's row 31;
  a booking's does too now), with a reason, and moves no money.
- **Reconcile, the stuck list, the manual close** take order claims (`ORDER_CLAIMS_DUE_SQL`, `reconcileOrderClaim`,
  `closeHeldOrderClaim`): the same rules as a booking's claim, with the money left on the order.
- **Words (W27 review L4):** an order held by a *booking's* card part answers "A refund on this order's card payment
  is still being checked…".
- **The claim writers** (`refunds/claims.ts`) now throw for an order with no row, and allow cash beside store credit
  (Q42), never beside a card part.
- `orders/lock-statements.test.ts` reads `lockForOrder`'s and `lockForBooking`'s statements as W27's test reads
  `lockForRefund`'s: each lateral must name the one before it.

## The membership line and the payment date change charge (W29)

In `orders/refund-lines.ts`, with the subscription's cancel in `orders/refund-subscription.ts`. Wayne's Q40 and Q41
(14 Nov); bugs E3, E4, E10.

- **The line (R1):** the membership is marked cancelled with no add-on credits and no end date, as the old function
  wrote it. `membership_instance_not_found` keeps its words. The undo puts the row back exactly as it was (its status,
  credits and end date are on the claim's line).
- **Q41, a used membership still refunds, and says so:** the figures carry `membership.creditSessionsTaken` and
  `membership.futureCreditBookings` on the line, for the dialog to show before the press. R1 flags the future credit
  bookings as payment needed **in the same transaction**, through the database's own
  `flag_uncovered_credit_bookings` (covered through yesterday: a refund in full covers nothing from now on). The old
  code left that to Stripe's webhook, and a membership with no subscription was never flagged. The claim keeps the
  flagged ids; the undo confirms those that are still as R1 left them.
- **Q40, each line goes back to the card payment that took it:** a saved-card membership order with a remainder
  charge has two card payments. `loadOrderCardPortion` now answers `membershipPayment` for it (the first invoice's
  PaymentIntent from `orders.reader_payment`, what it took, what has gone back) and no longer counts the membership
  line's card money against the remainder. A Card refund of the membership line is a refund of that payment, made on
  its own (`membership_refund_alone` when chosen with other lines: a claim has one card part). The other lines go
  back to the order's own payment as before. An order placed by the old createOrder (before 11 Nov 2026) never
  recorded the membership's payment: Card is refused for its membership line (`membership_payment_not_recorded`),
  never taken from the other payment (E3). Every other membership order has one card payment (the first invoice's,
  which the order names, or the reader's tap) and refunds as any line. A reader order is known by its record
  (`orders.reader_payment`), not only by `payment_method`: one part-paid by gift card is written `split`, and its whole
  tap is still its card money (W29a, W29 review S1). Refund the rest follows the same rule (`owedPayment`).
- **The subscription is cancelled last (E10):** only once the claim has finished with its refund standing. R2 records
  each refunded membership's subscription as left in the same transaction as the money
  (`order.subscription_left`, `found: 'refund'`); the press (or reconcile after its own R2) then cancels it, checked,
  and writes the `cancelled` row. A cancel refused or unclear stays left: the answer carries a warning, the stuck list
  shows it (Mark sorted closes it by hand), and every reconcile run cancels again (`retryRefundCancel`), which is
  harmless twice. **No refund is ever sent by that retry.** A card refund Stripe refuses is undone and never cancels
  anything; a claim held for reconcile cancels nothing until reconcile's R2. W13's put-back retry
  (`retryLeftSubscription`, which also refunds a first invoice) never takes a `found: 'refund'` row.
- **The payment date change charge** is a membership line that sold no membership (its order has a row in
  `membership_payment_date_changes`): a plain line, with no cancel and no membership change; the new date stays.

## Event places on the Worker (W30)

In `events/cancel-places.ts`, with the booking as the attendee list shows it in `events/attendee-list.ts`. Routes:
`POST /api/v1/staff/event-bookings/:id/cancel/quote` (a read, never gated) and `POST …/cancel`. They replace the staff
app's `getEventCancellationQuote` and `cancelEventPlaces` (and `shared/eventCancellation.ts` for a place cancel). The
whole-event cancel is W31; W30 and W31 are released together. Wayne's Q39, Q42 and Q43 (14 Nov); bugs E8, E9, E12, E13.

- **Who may:** any money back (card, store credit, cash) needs Issue refunds, checked in the route; No refund is open
  to every active staff member, as before. Someone with no staff record, or inactive, is refused by `defineRoute`
  whatever they choose (E12: the old function cancelled the place for them, with nobody's name on it).
- **The switch:** `event_cancels` gates a cancel with money back only (`eventCancelPathOff`). No refund needs no kind.
- **R1 (one transaction, no Stripe):** `lockForRefund` (the booking's order, its customer, the event, the event
  booking; with no order line, the event then the booking); `refund_open` while any claim holds the order, **for
  every cancel on the booking, No refund too, and for the quote** (an open claim's undo puts its places back); the
  database's own `event_cancellation_quote` under the lock, with the old refusals and words; the reason rule; the
  refund staff confirmed (Q18: `confirmed.refund`, half a penny, £0 for No refund; without it nothing is cancelled:
  E9); the plan; the places stamped with what they were worth (each must still be not cancelled and not checked in,
  in the same statement: `changed_by_someone_else` otherwise), the booking's places lowered (cancelled at none), the
  event's places released; the claim (`event_booking.refund_claimed`), **only when money goes back**. With no card
  part R1 also gives the store credit (or records the cash) and finishes.
- **Q43:** the database function answers `before_cutoff: false` for an event with no cut-off. The rule reads that as
  "the cut-off is the event's start": before it, refund freely; after it, a reason is needed and the refund is
  recorded as after the cut-off. The database function is unchanged.
- **The plan:** Card is capped at the order's card money left (`loadOrderCardPortion`: the order's own payment, also
  for an event bought with a membership on a saved card), the rest to store credit; no card payment, all store
  credit, as before. Cash (Q42) is capped at the cash paid on the order less cash already handed back
  (`orderCashLeft`), the rest to store credit, with who handed it over on the claim; `no_cash_left` with none.
- **A card part (E13: nothing is sent before the cancel and its claim are saved):** sent once under
  `<claimId>:refund:<orderId>`, then R2 (`finishEventClaimInTransaction`): what was given back on the places (shared
  by unit price, the remainder on the last), the card money on the event line, the store credit, the order's status,
  `event_booking.cancel_places` and `event_booking.refund_finished`. Refused: marked, then R1 undone (the places
  booked again), with the old words; never store credit instead. **If the released places have been sold** (the event
  has no room) or the undo fails, the cancel stands and the card money is owed on the order with Stripe's reason.
  No clear answer: held, the places stay cancelled; reconcile settles it and never sends a refund.
- **The event line** is stamped refunded once the booking is fully cancelled and a refund was made on any of its
  places (`card` when card money went back on it or is owed for it, `cash` when cash was handed back, else `credit`).
- **Money owed (Q39)** is the order's (`orders.refund_owed_amount`): the attendee list shows it on the booking and
  opens the order's own Refund the rest and It already arrived. Refund the rest's card money for an event booking is
  recorded on its event line, not the order's oldest line (W28 review L2, `owedCardLines`), also when another line of
  the order has already been refunded to the card: the stamped lines' own shortfalls come first, and what is left
  over goes on the event line with owed money (W30a, W30 review S2). The words after a refused card refund that
  can't be put back say the card refund didn't go back and name the plan's store credit, which R2 gives all the same
  (W30a, review S1; the order refund's words too). A place's own figures
  record what its cancel gave; they aren't changed by what is done about owed money later on the order.
- **Reconcile, the stuck list, the manual close** take event booking claims (`reconcileEventClaim`,
  `EVENT_CLAIMS_SQL`, `closeHeldEventClaim`): found, R2; not found or refused, owed on the order; the stuck list shows
  them with the event booking and its event, so the `refund_open` words that send staff to the Orders page are true.
- **Check-in stays the staff app's until step G** and takes none of these locks. R1's guard refuses a place checked in
  at the same moment, and the staff app's check-in refuses a cancelled place (its own guard in the same statement).
- **`wholeEvent`** is W31's (next section): honoured only once the event is cancelled in the database.

## The whole event on the Worker (W31)

`events/cancel-event.ts`, with `wholeEvent` on the place cancel (`events/cancel-places.ts`). Replaces the staff app's
`cancelEvent` and `getEventCancellationOverview`. Lead call L5; bugs E6 and E7; Wayne's Q42 for a whole event; W30
review L1 and L2. Released with W30.

| Route | Does | Gate |
|---|---|---|
| `POST events/:id/cancel` | The event off sale and cancelled, who and why. Answers the bookings still to cancel | Issue refunds, then `event_cancels` |
| `GET events/:id/cancel/overview` | The dialog's list: each booking still to cancel, its figure, any problem, any money owed | any active staff; not switched |
| `POST event-bookings/:id/cancel` with `wholeEvent` | One booking of a cancelled event, cancelled in full | Issue refunds and `event_cancels`, whatever is sent |

- **The event's cancel is one transaction under the event's row lock** (`FOR NO KEY UPDATE`, the lock New Order
  takes before it claims places: `orders/locks.ts`). Refused if the event has ended (unless it is already cancelled:
  that is the retry), or if any booking is `pending` (a payment in progress). It moves no money. An order either
  commits first, and is seen (a pending one refuses the cancel; a confirmed one is listed), or waits and is refused
  `event_cancelled` (bug E7; `cancel-event-postgres.test.ts`, both ways round).
- **It is safe to run again** and takes no idempotency key: on an event already cancelled it keeps the first reason
  and person, writes no second `event.cancel` row, and answers the bookings as they now stand.
- **The screen then presses each booking** (bug E6: the old function did them all in one Retool call): the place
  cancel with `wholeEvent: true`, the one choice of Card or Store credit, the overview's `value` as
  `confirmed.refund` (Q18), its own key and its own claim. Retry is the same again for the bookings still confirmed.
- **`wholeEvent` is honoured only when the event is cancelled in the database**, read under the event's lock in R1;
  on a live event it is refused (`event_not_cancelled`), so no screen can use it to skip the cut-off. With it: every
  place the booking has left (`attendeeIds` are not read), no cut-off rule and no `refund_after_cutoff`, Card or
  Store credit only (Q42: a cash booking goes to store credit; staff who want cash cancel that booking from the
  attendee list first), and the event's own reason when none is sent.
- **The undo and a cancelled event (W30 review L1).** R1 records on the claim whether the event was already
  cancelled (`cancel.eventCancelled`). After a refused card refund, the undo never puts places back, or the booking
  back to confirmed, on an event cancelled *since* R1: the cancel stands and the card money is owed on the order
  (`EventPlacesPutBackBlocked`, `why: 'event_cancelled'`), as when the places were resold. A cancel made when the
  event was already cancelled (the whole-event run's own press) is put back as before, so the booking is still to
  cancel, the overview lists it and Retry presses it again.
- **Audit:** `event.cancel` on the event, once; each booking's claim and `event_booking.cancel_places` row carry
  `wholeEvent: true`.

## The refund watch and the compensation fixes (W32)

`server/rules/refunds/refund-watch.ts` (the record) and `refund-watch-settle.ts` (reconcile's side). Lead call L7
(15 Nov): the watch runs in reconcile, not from a webhook, and ends after 30 days. W13 review L2, W21 review L3 and the
W26 audit's row 11; W13a review L1 (R6, R7); W25 review L3 (audit row 30); W31 review S2.

- **What is kept.** Every finished claim (`booking.` / `order.` / `event_booking.refund_finished`) keeps each card
  refund's id and status (`refunds`), from the press (Stripe's answer), reconcile or a close by hand (Stripe's list).
  A refund that wasn't `succeeded` when it was recorded gets one `refund.watch` row (`watching`, entity
  `refund_watch`, the Stripe refund's id) in the same transaction as the finished row. The part's PaymentIntent is the
  claim's own: a membership's first invoice (W29), the order's for an event booking (W30).
- **What reconcile does**, each run, last of all, for every watch with no end: lists the refunds on the payment and
  finds this one by its id. **It never sends a refund.**
  - `succeeded`: the watch ends. Nothing else changes.
  - `failed` or `canceled`: in one transaction under the subject's own locks, the card money is taken off the lines R2
    recorded it on and put back as owed where R2 puts a part that never went: on the booking (with `price_paid` on a
    live one; `refund_owed_amount` alone on a cancel's claim or a cancelled booking), or on the order (Q39; an event
    booking's is the order that paid for it, and its places keep only what the plan's store credit and cash gave).
    Never store credit by the system. A `<subject>.refund_failed_later` row is written on the subject.
  - still going after `WATCH_DAYS` (30): the watch ends `expired`, for a person. Nothing is changed.
  - Stripe didn't answer, or the key is the other mode's: read again next run.
  - Twice, or two runs at once: the end rows are written under an advisory lock on the refund's id (after the
    subject's row locks), so the money goes back once.
- **Compensation refunds (step C).** `refundOnce` answers the refund's status, and `compensateOrder`,
  `putBackSubscription` and `retryLeftSubscription` have a pending one watched (`on: 'compensation'`), once however
  often the same refund is seen. A watch that can't be written holds the compensation (or leaves the put-back's row
  `left`), so the next run records it. A failure can't be owed anywhere (the order was undone, or isn't a refunded
  order), so it ends as a line for a person. W12's late refunds keep their own watch (`order.reconcile` refund rows).
- **The stuck list** has one more field, `watched`: watches that ended `failed` or `expired`, each with words that say
  what to do, until a person marks it sorted (the manual close's `refund_watch`, Issue refunds, nothing moves). The
  other fields are unchanged, so the staff app published before W32 reads the list as before.
- **A compensation puts the customer's Stripe balance back (R6, R7).** `MadeSubscription.balanceApplied` is what the
  first invoice did to the balance (`ending_balance - starting_balance`); `putBalanceBack` reverses it with a customer
  balance transaction under `<orderId>:balance`. The customer's balance transactions are listed first and one naming
  the key in its metadata counts as done, because Stripe forgets a key after a day. With no change to the balance no
  Stripe call is made.
- **A watched payment's automatic refund is keyed by its PaymentIntent** (`<paymentIntentId>:refund-watched`), so two
  payments watched on one flow never share a key (audit row 30).
- **Words (W31 review S2):** the booking sentence after a refused, not-put-back card refund names the add-ons' store
  credit with the seat's.

## Every card refund is watched (W32a)

Lead calls 1 and 2 on W32's report and the W32 review's S1 to S5, L2 and L4 (15 Nov). Released with W32, the staff app
first. No migration.

- **Every card refund Stripe accepts is watched for `WATCH_DAYS` (50), whatever its first status.** Stripe can answer a
  refund `succeeded` and fail it afterwards (its "refund fails" test card, 4000 0000 0000 5126), and can fail a pending
  one on day 45. `succeeded` no longer ends a watch before its days are up. A claim's refund, a compensation's and (S3)
  a late payment's automatic refund all get the row; only one already `failed` or `canceled` has nothing to watch.
- **Which watches a run reads** is decided by `WATCHES_DUE_SQL`: one still going every run; one that reads `succeeded`
  once it hasn't been read for `WATCH_READ_HOURS` (24); one past its days at once. The one read longest ago comes first
  and the list stops at the run's item limit, so a run's budget is never spent on the same few. Staff's run (Resolve
  now) passes 0 hours: it reads the oldest-read ones whatever their last read, inside its 10 items.
- **"Last read"** is the newest `refund.watch` row with state `checked` (the status seen, and why the watch goes on),
  written by every read that ends nothing. It is found on `audit_log_entity_idx (entity_type, entity_id)`.
- **At the end of its days** a watch that reads `succeeded` ends quietly (`succeeded`); any other ends `expired`, with
  a line. Past its days with Stripe not readable, a watch that last read `succeeded` is read again next run (no
  answer) or ended quietly (the other Stripe mode); one still going ends `expired`.
- **Counting (S2).** A read that ends nothing for a person is not an item of the run, and is in neither `refunds` nor
  `left`. `refundsWaiting` is how many watched refunds are still on their way at Stripe; Resolve now says "N refunds
  waiting on Stripe". Only a failure or a watch that ran out is left for a person. A refund still pending no longer
  counts as left either.
- **W12's late refunds (S3).** `settleLateRefund` writes the watch (`watchLateRefund`: `on: 'compensation'`,
  `step: 'late-refund'`, `late`: the entity) in the transaction that records the refund's id, and
  `LATE_REFUNDS_DUE_SQL` and the stuck list's refunds leave a payment whose refund is watched to the watch. One refund
  is watched once (a compensation's refund the late path meets under the same key keeps its one watch) and listed once.
- **A late refund keeps its key (S4):** `refundKey` uses the key on the payment's `started` row and works one out only
  for a first send.
- **`charge_already_refunded` in a compensation (L2):** the refund the step made is found by `metadata.refund_key` in
  the payment's refunds and watched; none with the key means it was refunded by hand.
- **Not built (review L1, for H):** listing a payment's refunds by key before a compensation's send. It adds a Stripe
  call to every compensation refund, which changes the Stripe calls the order replay compares with its recordings.

## The website's cancels (W33)

Four customer routes, built before the website exists (E-plan 4.11, lead call L9; Wayne's Q44, 15 Nov), all under
`/api/v1/customer/`, the customer from their own sign-in:

| Route | What it is |
|---|---|
| `POST bookings/:bookingId/cancel/quote` | What cancelling their session booking gives, or why it can't be done now |
| `POST bookings/:bookingId/cancel` | The whole booking cancelled; everything paid to store credit; the credit back |
| `POST event-bookings/:eventBookingId/cancel/quote` | The same for places on their event booking |
| `POST event-bookings/:eventBookingId/cancel` | Chosen places, or the whole booking, to store credit |

They are step D's and E's own rules on a customer channel, not copies: `bookings/cancel.ts` (`cancelForCustomer`,
`quoteCancelForCustomer`) and `events/cancel-places.ts` (`cancelEventPlacesForCustomer`,
`quoteEventPlacesCancelForCustomer`) run the same R1 the staff routes run. What the channel changes:

- **Their own booking only.** Anyone else's is refused exactly as one that doesn't exist (`NOT_FOUND`), checked on
  the read with no lock and again under the lock.
- **Always store credit.** The method is fixed, so the plan never has a card part, no Stripe client is made, and R1
  finishes its own claim: one transaction, nothing held, nothing for reconcile. The session R1 throws if a card part
  is ever planned on this channel, the event R1 if a card or cash part is (a session's plan to store credit can hold
  no cash part).
- **Sessions:** the whole booking, with every add-on line still on it. Which cancel it is comes from the booking
  (`customerKindOf`): a credit, pass or payment-needed booking is Cancel & return credit, anything else Cancel &
  Refund. Paid guests on a credit booking go to store credit with the cancel (staff are told to remove them first,
  except on the club's own cancel). The 24-hour rule as from the booking page. Refused as well: a cancelled, finished
  or still-pending booking, and one with card refund money still owed on it (Q39: staff settle that; Cancel & Refund
  would give it as store credit).
- **W33a (the W33 review; Wayne, 15 Nov):**
  - A private booking is cancellable online like any other, 24 hours or more before: Cancel & Refund to store credit
    (the whole tier price and every paid add-on), and the whole session is freed.
  - A payment-needed booking is exempt from the 24-hour rule only when nothing comes back: with money on it (a paid
    guest, a paid add-on) it is refused inside 24 hours, and once the session has started a customer is refused
    whatever the booking (`customerTooLate`, the `within_24_hours` words).
  - A pass booking that holds money not recognised as its paid guests' (an older booking whose seats have no price or
    pay-by) would go through Cancel & Refund and lose its pass session: refused (`pass_session_not_returned`), and
    staff handle it. A membership credit booking in that state is left, since its credit comes back by itself.
- **Events:** before the cut-off only (Q43; staff can refund later with a reason, a customer can't give one), and
  never on a cancelled event (the club's whole-event cancel gives that money back).
- **No Issue refunds, no club cancel, no reason.** The amount confirmed is required (Q18).
- **The rows are the customer's.** `actor_type` is `customer` on the claim, its finish and the cancel's own row;
  `removed_by`, `cancelled_by` and the store credit row's `staff_id` are null; the claim's details and the cancel's
  row carry `channel: 'customer'`. `ClaimActor`, `staffIdOf` and `claimRowsActor` in `refunds/pipeline.ts` hold this.
  The staff claim statements are left word for word (`pipeline.test.ts` pins them); a customer's claim has its own.

`server/rules/customer/` holds what is the channel's alone: `cancels.ts` shapes the answers and turns every refusal
into the customer's words (`cancel-words.ts`: a reason with no words of its own gets the fallback, so no staff
sentence reaches the website), and `cancel-switch.ts` is the switch: all four routes answer `REFUND_PATH_OFF` (before any booking is read)
unless ORDER_SWITCH names `customer_cancels`, and a cancel that gives money back also needs the kind staff need for it
(`booking_changes`, `event_cancels`).

Migration 024 goes with this slice: `event_cancellation_quote` answers `before_cutoff` by Q43 itself (an event with
no cut-off uses its start; a null start counts as before), and `quotePlaces` reads it as it is. It must be applied
before this code is live. `testing/migration-024.test.ts` holds the file to the saved schema.

## Refund claims with no finish

The staff app claims a refund's money before it moves. Each claim writes `booking.refund_claimed` to
`audit_log` in its own statement, and `booking.refund_finished` once the money's fate is on the
booking. A claim with no finish is a function that died with money on its way: the booking shows the
refund, and the customer may not have had it. Nothing on the booking says so, so run this:

```sql
SELECT c.at, c.entity_id AS booking_id, c.details->>'kind' AS kind, c.details->>'amount' AS amount,
       c.details->>'method' AS method, c.details->>'pricePaidBefore' AS price_paid_before
FROM audit_log c
WHERE c.action = 'booking.refund_claimed'
  AND c.at < now() - interval '5 minutes'
  AND NOT EXISTS (
    SELECT 1 FROM audit_log f
    WHERE f.action = 'booking.refund_finished' AND f.details->>'claimId' = c.id::text
  )
ORDER BY c.at;
```

The five minutes leaves out claims still running. Check each one in Stripe and in the customer's
balance. W21: a Worker claim (`details->>'worker' = 'true'`) is reconcile's, and the stuck list shows it; this query is
for the old screens' claims (Move's) until W24.

## Card refunds held with no clear answer

Since W05j, a card refund from `refundOrder` or an event cancellation that gets no clear answer is
held: `card_refund_held` in `audit_log`, with the PaymentIntent, amount, Stripe key and lines. The next
press on that order or event booking sends it again with the same key before anything else, and marks
the row `settled` (`given` or `refused`). A held row nobody has pressed again on is money that may or
may not have gone:

```sql
SELECT h.at, h.entity_type, h.entity_id, h.details->>'amount' AS amount,
       h.details->>'paymentIntentId' AS payment_intent, h.details->>'key' AS stripe_key
FROM audit_log h
WHERE h.action = 'card_refund_held' AND h.details->>'settled' IS NULL
ORDER BY h.at;
```

Stripe keeps a key for at least 24 hours, and may forget it after that, when a resend could be a
second refund. So since W05k a held refund older than 23 hours is never sent again: the next press
looks for it on the payment by its key (the Worker writes the key on every refund's metadata,
`refund_key`, and `GET /api/v1/staff/payments/refunds` lists them). Found means it went; not found
means it never did, and counts as a refusal. Booking card refunds with no clear answer are kept the
same way (`booking.card_refund_unsure`), so Refund the rest a day later looks rather than resends.
(W34: this was the staff app's old refund code. It and that route are gone from the app; the route's frozen copy is in
`testing/legacy-order/routes/`, for the replay only. The Worker's refund pipeline looks by key itself.)

Store credit given on a refund carries `[ref <uuid>]` at the end of its note, so after a database
error the staff app can look for it (`shared/storeCreditRefund.ts`).

Each saved-card charge for Move, Add Guest and Settle writes `booking.card_charge_started` with its
key just before charging, so a press after a death can tell its own order from another action's.
Since W05k the flow's final statement writes `booking.card_charge_finished` (the key, the
PaymentIntent, and whose parts it counted), and a press that gave its parts back after a lost answer
writes `booking.card_charge_parts_returned`. Two presses on one booking share one key, so these
rows are what keep a losing press from refunding the winner's payment (`shared/bookingCardCharge.ts`
in the staff app).

Since W05l a press of Move, Add Guest or Settle with no card charge (cash, gift card, store credit,
credits, the reader, or nothing to pay) writes `booking.press_finished` in its final statement, with
a new id for that press and the ids the statement wrote. A press whose statement threw looks for it
first: found means the write landed and its answer was lost, so nothing is undone and the press
carries on; not found means nothing was written. If the look fails too, nothing is put back and staff
are told to check the booking (`shared/pressFinished.ts` in the staff app). The same statements also
write a gift card part to `gift_card_redemptions` (this booking, no order), as Add Guest's does; on
the reader that row is written at finalise.

## Card charges with nothing to show for them

A saved-card charge for Move, Add Guest or Settle whose order is there, with no finished row for its
payment and the order not refunded, is money taken with nothing added: a function that died after
the charge (and nobody pressed again), or after retiring the key and before refunding it. Nothing on
the booking says so, so run this:

**What this query does not show (W05 review 3, finding 2; fixed when Move, Add Guest and Settle move to the Worker at
step D):** it lists the card money only. A dead press's store credit, gift card, place and add-on credits are not
listed, and a press that died with no order (a declined card, or the Worker wrote none) is not listed at all. When a
row appears, check the customer's store credit, gift card balance and the session's places by hand as well.

```sql
SELECT s.at, s.entity_id AS booking_id, s.details->>'flow' AS flow, s.details->>'amount' AS amount,
       o.id AS order_id, o.stripe_payment_intent_id AS payment_intent
FROM audit_log s
JOIN bookings b ON b.id::text = s.entity_id
JOIN orders o ON o.customer_id = b.customer_id
             AND o.order_total = (s.details->>'amount')::numeric
             AND o.created_at >= s.at
             AND o.stripe_payment_intent_id IS NOT NULL
             AND o.payment_method IS NULL
             AND o.payment_status <> 'refunded'
WHERE s.action = 'booking.card_charge_started'
  AND s.at < now() - interval '5 minutes'
  AND (
    EXISTS (SELECT 1 FROM order_line_items oli WHERE oli.order_id = o.id AND oli.booking_id = b.id AND oli.item_type = 'booking')
    OR NOT EXISTS (SELECT 1 FROM order_line_items oli WHERE oli.order_id = o.id)
  )
  AND NOT EXISTS (
    SELECT 1 FROM audit_log f
    WHERE f.action = 'booking.card_charge_finished' AND f.entity_id = s.entity_id
      AND f.details->>'paymentIntentId' = o.stripe_payment_intent_id
  )
ORDER BY s.at;
```

The five minutes leaves out presses still running. For each, check the booking and the payment in
Stripe: either finish what the press was doing by hand, or refund the payment. The step C
reconciler replaces this.

## Replace card (W42, W42a, W42b)

`POST /api/v1/staff/customers/:customerId/saved-card` (F-plan 4.7; Q19; Wayne's Q45; W11 F4 / FB17; lead call L11),
behind its own switch kind `card_moves` (`memberships/membership-switch.ts`, `cardMovesOn`). Off: the card is saved
exactly as W11 built it (`payments/terminal.ts`, `saveCustomerCard`, untouched) and no membership is moved. On:
`customers/saved-card.ts`, `replaceCustomerCard`.

- **The tap is read** as before (`stripe/saved-card.ts`, which now also answers the intent's Stripe customer), and a
  card that can't be charged later is refused in the old words.
- **K1**, one transaction under the customer's lock, then each of their memberships' locks in id order (LOCK_ORDER:
  customer, then membership): F4 / FB17 first (refused, `other_customer`, with nothing written, unless the intent's
  Stripe customer is this customer's); the card on the customer; `customer.card_saved` (with the card it replaced and
  the subscriptions to move); one card step (`memberships/left.ts`, kind `payment_method`) per live membership
  (`active` or `past_due`, with a subscription). An open card step on the same subscription is closed as `replaced`.
- **Then Stripe**, none of it money (`customers/card-steps.ts`, `sendCardSteps`): each subscription's
  `default_payment_method`, and only that field, under the step's key. Went: the step is done. Refused or unclear: the
  step stays left, is listed on the Orders page, is sent again by reconcile past the press's window, and is checked 20
  minutes after it closes (W40 to W40d's machinery, unchanged). A refusal reconcile itself gets is for a person. Then,
  last (W42a, W42 review L4), the Stripe customer's invoice default (once, recorded as `customer.invoice_default`; not
  listed and not sent again on its own, because every live subscription gets a card of its own and nothing else is
  charged from the default: see `saved-card.ts`'s header).
- **The card is never put back**, whatever Stripe says about a membership. A second replace is never refused for a
  step still being sent: the newest card wins. W42a (W42 review S2): the first press may still be at Stripe then, so
  the second's step is left with W40b's `stale_send` mark (`left.ts`, `leaveStepReplacing`'s `markStaleSends`); its
  press's ending leaves the wish again instead of closing it, it stays listed, and the first run past the window sends
  the newest card if the older one landed over it. A press also sends nothing for a step that has been replaced by
  the time it comes to send it. The check after closing is still the net under both.
- **One rule, the order's T2 included (W42a; W42 review S1; W42 report, Noticed 1).** With `card_moves` on, an order's
  T2 (`orders/finalise-order.ts`) that writes a membership, or saves a card on the reader, takes the customer's lock
  before it writes anything of theirs (LOCK_ORDER: order, then customer, then memberships) and, after its writes,
  leaves a card step for every live membership against the customer's saved card as it is then
  (`card-steps.ts`, `followSavedCard`). The caller sends them after the commit, as the press does (the saved card's
  press, the reader's finalise, reconcile). K1 holds the same lock, so a replace and an order take turns: either K1
  finds the new membership, or T2 reads the new card. A step whose subscription already shows the card is settled by
  one read. T2 asks the switch from the Worker's environment; the scheduled run passes its own
  (`ReconcileOptions.orderSwitch`), since its env is not copied into `process.env`. Off, T2 is as it was.
- **W42b (W42a review S1): every T2 of a run hears the run's switch.** A run settles ORDER_SWITCH once when it starts
  (`reconcile.ts`, `runSwitch`: the scheduled run's own, or the request's environment for staff's Resolve now) and
  reaches T2 only through three helpers (`runT2`, `runReaderCancel`, `runReaderFinalise`), each given the switch by
  its type. The usual reader path (`reconcileReaderOrder`, through the reader's cancel) had been left without it.
- **W42b (W42a review S2): an older tap never takes the place of a newer card.** With `card_moves` on, T2 saves the
  card its tap left only when no `customer.card_saved` row for the customer is later than the tap (the charge's
  `created`, `ResolvedCard.tappedAt`), asked under the customer's lock. Otherwise the customer's card stays, a
  `customer.card_not_saved` row (`reason: newer_card_on_file`) says why, `order.paid` says `cardSaved: false`, and
  the rule moves every membership (a reader membership order's new one, made on the tapped card, included) to the
  customer's card as it is. Off, the tap's card is saved whatever came after it, as W11 had it.
- **W42b (W42a review L3, L4; W42a report, Noticed 1).** The invoice default is not sent when the customer's saved
  card, read again just before, is no longer the action's card (recorded with outcome `replaced`). The open steps
  are read once per action, not once per membership. And a T2 that writes a membership takes the customer's lock
  first whatever the kind, so T2 and the payment date change (customer, then membership) lock in the same order.
- **The answer** is the customer's five fields plus `membershipsMoved` and `membershipsToMove` (absent with the kind
  off). The staff app's wrapper names them `moved` and `toMove`, and answers a refusal as data.
- **W40d Noticed 2** (the legacy cancel routes' guard counted `cancel_at` steps only): the guard was removed at W44.
- **Who writes a subscription's card:** a step, and `subscriptionRequest` when a subscription is made
  (`orders/membership.ts`). `customers/saved-card.test.ts` holds the list.
- **Parity:** `testing/replay/saved-card-replay.test.ts` runs each press with the kind off and on and allows only the
  named differences in `saved-card-differences.ts` (Q19, FB17). W42a: `order-replay.test.ts` runs the three W11
  scenarios that save a card on the reader again with the kind on (`W42A_CARD_MOVES_DIFFERENCES`).
- **Races on real Postgres:** `customers/card-steps-postgres.test.ts` (a membership order and a replace, both ways
  round, each held until Postgres reports the other waiting on the customer's row; and free-running rounds). W42b:
  with the kind off, a membership order's T2 shown waiting on a customer's row another transaction holds.

## The lapse sweep (W43)

F-plan 1.9 and 4.8; Wayne's Q48 (15 Nov); N8, bugs FB18 and FB19. `bookings/lapse-sweep.ts`, and the system channel
of `bookings/cancel.ts` (`lapseBooking`, `lapsePlanOf`).

- **What it replaces.** The database's hourly job (`run_membership_maintenance`) called
  `lapse_sweep_expired_bookings`: every payment-needed booking past its deadline with `price_paid = 0` set cancelled
  (`membership_lapsed`) and its places released. No audit row, nothing of what a cancel does, and a booking with
  money on it was never lapsed (it held its places for ever).
- **Where it runs.** On the Worker's five-minute schedule, before reconcile (`server/scheduled.ts`), behind its own
  switch kind `lapse_sweep`. The run hands it the switch from the handler's `env` (never `process.env`). Off: it
  reads nothing, and the database's sweep stays in charge. No route runs it.
- **One booking, one transaction.** Each due booking (oldest deadline first, capped at 50 a run; `more` says some
  wait for the next) goes through the cancel's R1 on the system channel: the booking's locks in LOCK_ORDER, checked
  again under them (still payment needed, the deadline passed, the same cancel the read saw), the cancel with the
  database sweep's reason, its places released, every add-on line still on it removed. No Stripe client is made.
- **Money on it (Q48).** 24 hours or more before the session: everything paid (paid guests, paid add-ons) to store
  credit, through the same claim as the customer's online cancel, finished in the same transaction; add-on credits
  back while the membership is active. Inside 24 hours, or once the session has started: cancelled with nothing
  back. That money is kept: the cancelled booking keeps its price paid, the paid add-on lines are removed with
  nothing back, and `booking.lapsed` records both. **No refund button gives it afterwards** (Part refund refuses
  every cancelled booking, Remove add-on a removed line): goodwill on a lapsed booking is Adjust store credit
  (Wayne, 18 Nov; W43a, the W43 review's S3). Never a card part: R1 throws if one is planned.
- **Card refund money owed on it (Q39; W43a, review S1).** Never turned into store credit by the system and never
  cleared by a lapse: `refund_owed_amount` stays as it is on the cancelled booking, for staff (Refund the rest, store
  credit only there, or It already arrived). 24 hours or more before, the rest still goes back: the price paid
  **less what is owed**, and every paid add-on (a £20 guest with £5 owed: £15 to store credit, £5 still owed, £20 in
  all once staff give the £5). Inside 24 hours nothing goes back and what is owed stays owed.
- **Whose rows.** The system's: `actor_type` system, no id; `removed_by` and the store credit row's staff are null.
  The claim, the cancel's record and its own row carry `channel: 'system'` and the lapse's record (`back`, `kept`,
  `paymentDueBy`); `booking.lapsed` is written with every lapse: `pricePaid`, `refundOwed` (left owed, part of the
  price paid), `addonsKept` (W43a, review S2: paid add-on lines removed with nothing back, price × quantity; never
  part of the price paid), `storeCreditRefunded`, `placesReleased`. Money a lapse kept: `back` false and
  `pricePaid - refundOwed + addonsKept > 0`. The system's claim is `refunds/pipeline.ts`'s third writer (`SystemActor`, `writeSystemClaimSql`),
  taken only by a booking's cancel.
- **What it leaves, for the next run.** A payment still being taken on the booking (`reader_payment_open`,
  `card_payment_open`: Settle), a refund still being checked (`refund_open`), a booking whose cancel, "does money
  come back" or add-on lines changed between the read and the lock (`booking_changed`; any other change, such as a
  guest removed, is not left: it lapses from what is under the lock, W43a review L1). One no longer due under its lock (settled, cancelled by staff, cancelled by the
  database's sweep) is `not_lapsed`. A fault on one booking is counted as `failed` and never stops the others; a
  fault in the sweep itself is logged and never stops reconcile.
- **The log.** `lapse_sweep.run` when the run found anything (the counts, and each booking not lapsed with why);
  `lapse_sweep.failed`.
- **Migration 028** (file only) takes the database's sweep out of the hourly job and keeps the function. Both
  running is harmless, with one exception while it lasts: the database's sweep can reach a `price_paid = 0` booking
  with a paid add-on first, and then the add-on's money is kept as before with nothing recorded. So (W43a, review
  S4; the order is in 028's header): the pre-check (no such booking waiting), the kind on, then 028 **in the same
  sitting**. Rollback: the kind off first, then 028's Down straight after.
- **Parity:** `testing/replay/lapse-replay.test.ts` runs W36's four recordings of the database's sweep through the
  Worker's on the same seed: nothing paid and a deadline not passed match exactly (the sweep's audit rows apart,
  held to `lapseRowProblems`); FB18 and FB19 have one pinned, named difference each (`lapse-differences.ts`), and
  every pinned path must differ.
- **Races on real Postgres:** `bookings/lapse-sweep-postgres.test.ts` (against Settle, Remove Guest, a staff cancel,
  the database's sweep and a second run, each held until Postgres reports both waiting on the booking; the cap).

## First in line 1: the webhook, the membership check, the lapse reason, line stamping (W46)

G-plan 2.1 and 5; lead call L8. Worker only, with no switch kind and no migration.

- **The webhook** (`app/api/stripe/webhook/dispatch.ts`, `idempotency.ts`).
  - `invoice.paid` reads the subscription, as the other two events do since W45a. Only one Stripe shows as `active`
    or `trialing` records the payment, and the next payment date is the period's end as Stripe has it, never the
    invoice's. A date change's £0 invoice handled after the first full payment failed is ignored
    (`subscription_not_paid_up`, with the status): the member stays past due.
  - Stripe answering that it has no such subscription (`resource_missing`) is ignored with the reason
    (`subscription_missing`), not an error. Any other failed read is still an error, so Stripe sends the event again.
  - L8: after each write to a live membership the subscription is read again, and what it then shows is written if
    it is something else (`writeAndConfirm`), up to two more writes; after that the event is an error. So every
    write is followed by a read that agrees with it. A read after the write that fails is an error too.
  - The folder's client is typed (`RpcClient`, `WebhookEventsClient`); the route names the real client as that.
- **The check after a step closes** (`memberships/left.ts`).
  - It also sets the membership's own last day against the one Stripe's subscription gives (the webhook's sum). A
    difference leaves the newest wish again as a refused step carrying both days (`row_differs`,
    `step_check_row_differs`): listed with its own words and Mark sorted, never sent, and the row is not changed.
  - A sorted wish's `checked` row is written with its `sorted` row.
  - A wish a run could not leave again (`step_not_left_again`) is on the stuck list until a run settles it.
- **Reconcile** (`orders/reconcile.ts`).
  - Steps and checks are taken by when they were last tried: a run that could not get to every one due writes one
    `reconcile.steps_tried` row, and the next runs take the others first. A run that gets to everything writes none.
  - On staff's run the steps go before the checks.
  - A membership with no Stripe subscription whose last day has passed is marked cancelled
    (`memberships/no-subscription.ts`): the day kept, its credit bookings after that day flagged as the database
    flags them when Stripe ends a subscription, one `membership.ended_without_subscription` row. Only `active` ones.
- **The lapse sweep** (`bookings/lapse-sweep.ts`) starts no booking after 30 seconds; the rest go with the next run.
- **The lapse reason** (`bookings/lapse-facts.ts`): the booking's refund-figures read carries `lapse` (when, the
  deadline, given back, kept and why, owed then, and the line of words), only for a booking that lapsed: any other
  booking's answer is exactly as it was.
- **Line stamping** (`bookings/refunds.ts`, `stampWhenOwedSettled`): when Refund the rest or It already arrived
  leaves nothing owed on a cancelled booking, its booking lines are stamped if all of their seat money is then back,
  Refund the rest also stamps the add-on lines whose refund was part of what was owed, and the orders' status is
  worked out again. Money a lapse kept is never stamped as refunded.

## A failed renewal flags the period it did not pay for (W46a, migration 030)

No Worker code: a migration file and its tests. 030 is written and **not applied** by W46a; the lead applies it.

- **What it mends.** The credit allocation gives every active member their new period at the start of its first day,
  before Stripe has taken the payment for it. The database's `membership_mark_payment_failed` and
  `membership_mark_cancelled_by_stripe` took "covered through" from the newest credit period's end, so a failed
  renewal flagged no credit booking, and Stripe ending the subscription wrote the unpaid month's end as the last day.
- **030** adds five lines to each function: when the membership's `next_renewal_date` is today or earlier (London),
  the member is covered through the day before it. Otherwise the old sum, untouched. It never flags less than before.
- **The tests put 030 in themselves** (`testing/migration-030.ts`: the two functions before and after, word for
  word, and `asOwner`), so they read the same before and after the saved schema is refreshed:
  `testing/migration-030.test.ts` (the file, on real Postgres) and `memberships/covered-through.test.ts` (the edges on
  the replay's clock: the allocation first, a retry that succeeds, Stripe ending the subscription, a payment date
  change, a yearly membership, the renewal day, the lapse sweep).
- **The credit period given for the unpaid month is left as it is.** A past-due or ended membership can't spend it
  (the credit read and the booking write both need `active`), and it becomes the paid period if a retry goes through.
- **Not mended** (held by a test): an `invoice.paid` handled late in the hour Stripe holds a renewal's invoice as a
  draft writes next month's date, and a failure after that still uses the old sum.

## The webhook records a payment only for the newest invoice; a live "no such subscription" is an error (W46b)

The W46 review's blocker (B1) and should-fix (S1), both in `app/api/stripe/webhook/dispatch.ts`. No migration, no
switch kind, no contract. This section corrects two lines above: W46's "Stripe answering that it has no such
subscription is ignored" (test mode only, now) and W46a's "Not mended" (mended here).

- **What Stripe shows at a renewal.** The period moves on at once. The new invoice is held as a draft for about an
  hour before the charge is tried, and in that hour the subscription reads `active` with the draft as its
  `latest_invoice`. W46's `invoice.paid` went by the status alone, so an older `invoice.paid` handled in that hour
  (one Stripe is sending again after a failed delivery: a date change's £0 invoice, say) wrote next month's date.
  030 goes by that date, so the renewal's failure an hour later flagged nothing.
- **B1.** `invoice.paid` records a payment only when the subscription's `latest_invoice` (an id; no expand) is the
  event's own invoice. Otherwise it is ignored with `not_latest_invoice` and nothing is written.
  - The same holds for the read after the write (L8), for both invoice events: `paymentWrite` takes the event's
    invoice id and asks for `membership_mark_paid` only while that invoice is the newest. A payment whose second read
    lands in the next renewal's draft hour writes nothing more, and a failure's second read records a payment only
    for the invoice that failed (a retry that goes through leaves it the newest).
  - An older invoice paid while a newer one exists (a hand change in Stripe) is ignored: the newer invoice's own
    events set the state.
  - `invoice.payment_failed` does not look at the newest invoice before its write: a subscription behind on its
    payment is marked past due whichever invoice the event is for.
- **S1.** "No such subscription" (`resource_missing`) is ignored only when the event's own `livemode` is `false`.
  For a live event it is an error: answered 500, left as `error`, sent again by Stripe for three days. A live event
  is signed for a subscription Stripe has, so that answer means the key in use is the wrong one (the test key still
  in place at go-live); ignored, each payment and failed payment in those hours was dropped for good. The same on the
  read after the write.
- **The fake Stripe** (`server/stripe/fake.ts`): `setSubscription(..., { latestInvoice })`, `latestInvoice(id)`, and
  `startRenewal(id, periodEnd?)`, the draft hour (active, the period moved on, a new draft the newest invoice).
  Expanding a later invoice is not modelled and throws.
- **Tests.** Every invoice event the tests make says which invoice it is for (`testing/webhook.ts`: `invoiceEvent`
  takes `id`; events are test mode, `asLive` gives the live one). The review's proofs A and B turned round, the £0
  invoice on time, a paid retry, a payment between the failure's read and its write, an older invoice, and the L8
  read in the draft hour: `memberships/latest-invoice.test.ts`, with 030 put in as W46a's tests do. The 404 tests run
  in both modes (`dispatch.test.ts`, `idempotency.test.ts`, `memberships/webhook-live-state.test.ts`).

## First in line 2: money still to refund, Resolve now, the banner, watched payments, It already arrived (W47)

G-plan 4.7 and section 2's rows placed in W47. No migration and no switch kind. The saved schema was refreshed for
migration 030 first (the lead's catalogue answer: ten lines in two functions, nothing else).

- **`GET /api/v1/staff/money-owed`** (`refunds/money-owed-list.ts`, `contracts/money-owed.ts`): every order and
  every booking with `refund_owed_amount` above £0, whatever its status, each once. An event booking has no money owed
  of its own (it is its order's), so it is shown beside its order. Each line has the customer, the amount, when it
  became owed (the first record that raised it since money was last taken off: a claim finished `owed`, or a refund
  that failed later; null when no record says) and where Refund the rest runs, in words. Below, for information, the
  money a lapse kept in the last 90 days, from `booking.lapsed` (`bookings/lapse-facts.ts`, `lapseFacts`, the same sum
  the booking detail shows), with a note that names Adjust store credit as the goodwill route (Wayne, 18 Nov). A
  read: nothing is written. Any active staff member.
- **The stuck list** (`orders/stuck-list.ts`) gains two optional fields, as `paymentDates` was added:
  - `watchedPayments` (`orders/payment-watch.ts`; W25 review L1, L2): a card payment still at the bank when its booking
    change was undone by hand. While it is watched it is a line with nothing to do, and reconcile's read of it is no
    item of the run: counted in `paymentsWatched`, never in `left` (it was "1 left for a person" on every Resolve
    now, with nothing listed). After `PAYMENT_WATCH_DAYS` (30) with Stripe still giving no clear answer, the watch
    ends `expired`, once: a line for a person, closed with the manual close's new kind `payment_watch` (Mark sorted;
    nothing moves).
  - `webhook` (W46 review L2): one line when Stripe's notices (`stripe_webhook_events`) have been in error, or never
    finished, for over an hour, or a live one was ignored because Stripe had no such subscription. Only notices
    received in the last 30 days (Stripe can't send an older one again, so it could never clear). The row of an
    ignored "no such subscription" now says which mode the event was (`detail.livemode`); none is written for a live
    event today (W46b makes that an error). `not_latest_invoice` rows are not counted. Words in
    `memberships/failure-messages.ts` (`WEBHOOK_NOTICE_WORDS`): what the notices are for, that it is a set-up fault
    and not a member's doing, and who to call. If the table can't be read, the line says so and the rest of the list
    still answers.
- **A payment date change's line** (`memberships/payment-date.ts`, `memberships/failure-messages.ts`): a payment
  that is neither paid nor "took nothing" is left as `payment_processing` (the bank is still working on it: wait) or
  `payment_needs_action` (waiting on the customer: it ends only when the payment is cancelled in Stripe), each with
  its own words. Neither has a Close: one is offered once Stripe says how the payment ended and the automatic check
  has left the change for a person. A change whose refund Stripe refused reads `refund_refused` (with its Close)
  from the press's own mark, before reconcile's first run; it said "waiting" for up to 5 minutes.
- **Refund the rest's figures** (`orders/refund-lines.ts`): the order's refund figures carry `owedCard` while money
  is owed: the payment Refund the rest would use (`order`, or `membership` on a saved-card membership order with two
  payments) and what it can take. It is `owedPayment`'s own answer, so the screen's split is the press's. An event
  line with money owed now counts as the order's own payment's (the W35 audit's row 19): it went to the membership's
  payment when the membership's line was short.
- **It already arrived can record the card money on the lines** (the W35 audit's row 6; Wayne, 19 Nov). Staff say
  where they saw the money (`arrivedOn` on both routes). `card` (the refund is in Stripe): what arrived is recorded
  where Refund the rest to the card would record it, with no money moving and nothing sent to Stripe. On an order:
  `owedPayment` and `owedCardLines`, capped at what the payment can still take. On a booking (`bookings/refunds.ts`,
  `stampArrivedCard`): on a cancelled booking, the removed add-on lines whose card refund is part of what is owed
  first, then the booking's lines as `planRefund` plans a card refund. The action's row then says so, how much was
  recorded and on which lines (`arrivedOn`, `card`, `lines`); what the cards can't account for is on no line.
  `other`, or no choice (a staff app from before W47): nothing on the lines and the row exactly as before W47. Money
  found on the customer's store credit balance is already in the store credit rows, and recorded as card money too it
  would be counted twice (the replay's `owed-arrived-*` scenarios are that case, and are unchanged).
  `SEAT_MONEY_SETTLED_SQL` no longer adds the whole of each `booking.refund_owed_arrived` row (W46): only the part a
  row says is on no line (`amount` less `card`), so nothing is counted twice. When It already arrived settles what
  was owed on a cancelled booking it stamps the add-on lines, as Refund the rest does.
- **The staff app** (W47): `getMoneyOwed` (thin), the "Money still to refund" section on the Orders page with Refund
  the rest on each line, a count on Overview, Resolve now always on the Orders page, the banner's count by kind, the
  line for Stripe's notices, watched payments, the lapse reason on the booking detail, the card or another-way choice
  in both It already arrived windows, and "The card refund didn't go through" decided from the press's own `held`. `getOrders` counts an order with money owed as needing action.

## The W47 review's fixes: the event line's owed money, watched payments, three sets of words (W47a)

The W47 review (19 Nov) found no blocker and two things to fix before release. No migration, no switch kind.

- **An event line counts as owed only while its booking's money is still owed** (review S1; `orders/refund-lines.ts`,
  `EVENT_LINE_OWED_SQL`, read by `owedPayment` and `owedCardLines`). Until W47a the flag was true for ever once the
  event booking had a claim that ended owed or a refund that failed later. W47 had made it choose the payment too, so
  on a saved-card membership order whose event place's owed money had long been given, a later owed membership refund
  went to store credit instead of the membership's own payment. Now the line counts only while one of these is later
  than the last time nothing was owed on the order (its newest Refund the rest, which takes all that is owed off
  first, or its newest It already arrived that left nothing owed):
  - a claim of its booking that ended owed, or a refund of its booking that failed later; or
  - a Refund the rest that put card money on the line and didn't stand (refused and put back, never found, or failed
    later): the same money is owed again, by the order's own row this time, and it is still the event line's.
  An It already arrived for part of what is owed clears nothing: the rest is still that line's. The money-owed list's
  `owedSince` (`refunds/money-owed-list.ts`) is a different question (since when, not whose) and is unchanged.
- **A watched payment's watch ends only when Stripe can't find the payment with the key in use** (review S2;
  `orders/reconcile.ts` `checkWatchedPayment`, `orders/payment-watch.ts`). `settleIntent`'s `unclear`
  (`orders/reader-order.ts`) now says which kind it is (`cause`): `not_found` (the other Stripe mode, or a record that
  never said its mode), `no_answer` (the read failed), or `moving` (Stripe read it and it hasn't ended). Only
  `not_found` past `PAYMENT_WATCH_DAYS` (30) ends the watch `expired`. A payment Stripe reads as `processing` or
  `requires_…` stays watched for as long as it takes, and is refunded automatically if it then goes through; a read
  with no answer ends nothing. W47 ended the watch on any unclear read, so a payment still `processing` at 30 days
  was never read again. The expired line now says the one thing it can mean, in its own words.
- **Mark sorted reads the payment first** (review S2, the second guard; `orders/close-stuck.ts` `closePaymentWatch`,
  the close route). One read, nothing sent. Refused while Stripe shows the payment hasn't ended
  (`payment_still_moving`, with its status), and when the read got no answer (`payment_not_read`). Allowed when Stripe
  shows it ended, or still can't find it. The close's row keeps what Stripe showed (`stripeStatus`). It is the one
  close that makes a Stripe client, and only for this kind.
- **Words.** It already arrived "on the card" that could record less than arrived says so (review L2): both answers
  carry `arrivedOnCard: { recorded, other }` and a `warning` in words (`refunds/failure-messages.ts`,
  `arrivedCardShortWords`), and both staff app windows show it. `payment_needs_action` reads "waiting for a step
  Stripe needs (usually the customer's bank approval)" (L7). The staff app's quiet banner line reads "No card payments
  or membership changes need attention." (L8). `stuck-list.ts`'s comment on the Stripe notices line now says a wrong
  API key leaves notices in error, and a wrong signing secret writes no row at all, so the line can't see it (L4).

## Mark sorted never sorts a payment Stripe can see (W47b)

W47a's report noticed two things with one root (its "Noticed" 1 and 2), and the lead called them for now (19 Nov):
money kept with nothing recorded is never "for later". No migration, no switch kind, no contract field.

- **Until W47b.** A watch that ran out (`expired`: Stripe couldn't find the payment with the key in use for 30 days)
  was never read again by the automatic check, even once the key was put right. Mark sorted then read the payment,
  refused while it was still moving, and sorted it when Stripe showed `succeeded` or `canceled`, without checking a
  payment that went through had been refunded. Example: the wrong key for 30 days, the key put right, the bank
  completes Mo's £5, staff press Mark sorted without refunding: sorted, £5 kept for a change that was undone.
- **Now** (`orders/close-stuck.ts` `closePaymentWatch`; `orders/payment-watch.ts`). When Mark sorted's one read finds
  the payment at all (`succeeded`, `canceled`, `processing`, a `requires_…` state), it is not sorted: a
  `reader_payment.payment_watched` row with `state: 'handed_back'` is written, naming the `expired` rows it ends
  (`ends`, by id), who pressed, why, and what Stripe showed (`stripeStatus`). From then on the watch is due again in
  `WATCHED_PAYMENTS_DUE_SQL` and reads as `watching` on the stuck list, and `checkWatchedPayment`
  (`orders/reconcile.ts`, unchanged code) reads it every run as before it ran out: gone through, recorded
  (`landed`, `charge_without_record`) and refunded by the automatic refund on the run after, once, under its own key
  (`<paymentIntentId>:refund-watched`); nothing taken, the watch ends; still at the bank, watched for as long as it
  takes; not found again, `expired` again (it is past its days) and a line for a person again.
- **The answer** is `closed: true` with `reason: 'handed_back'` and its own words (`CLOSE_WORDS.payment_handed_back`):
  the line for a person is gone, so the screen shows the words and reads the list again. No `order.close` row is
  written (nothing was closed). A second press is refused as for any watched payment (`payment_still_watched`).
- **Only "still not found" sorts it**, as before, with `stripeStatus: 'not_found'` on the close's row. A read with no
  answer is still refused (`payment_not_read`). `payment_still_moving` and its words are gone: nothing answers it.
- **Refunded by hand first.** The expired line tells staff to refund in Stripe by hand, so a handed-back payment may
  already be refunded. The automatic refund's send is then refused by Stripe (`charge_already_refunded`), which
  `settleLateRefund` has recorded as done since W12 (`confirmed`, `alreadyRefunded`): one refund in Stripe, nothing
  owed, nothing listed, no retry. Part refunded by hand: the automatic refund names no amount, so Stripe gives back
  what is left (as the fake models it; tested).
- **Why by id, not by time.** An `expired` row stops counting only when a hand-back names it. Rows written in one
  moment can't be ordered by `at`, two runs at once can each write an `expired` row (the hand-back names both), and
  an expiry after the hand-back must count again.
- The staff app's Mark sorted dialog for a watched payment says both things the press can do.

## "Try the payment again now": a past-due member's failed renewal, charged from the desk (W47r)

`memberships/retry-payment.ts` (Wayne, 18 Nov 2026; the W47 review's point 10, all five points). When a renewal
fails, the member's credit bookings in the unpaid month are flagged payment needed and lapse at 72 hours (migration
030, Q48). Replacing the card at the desk (W42) takes no payment, so they still lapse unless one of Stripe's own
retries lands in time. Example: Mo's £40 fails at 14:00 on the 10th; he replaces his card at 16:00; his 18:00 booking
on the 11th still lapses. This pays the subscription's open invoice there and then. No migration, no new table.

- **The routes.** `GET /api/v1/staff/memberships/:id/retry-payment/quote` (what the window shows; read only; any
  active staff member) and `POST /api/v1/staff/memberships/:id/retry-payment` (the press; body `confirmed:
  { invoiceId, amount, paymentMethodId }` (W47r-a: the card too); press key required; Issue refunds, checked by the rule). Both ask the kind
  **`payment_retries`** (`memberships/membership-switch.ts`): off, they answer MEMBERSHIP_PATH_OFF with the existing
  "switched off" words before anything is read. No other kind turns it on, and it turns nothing else on. Reconcile
  never asks.
- **Refusals before anything is sent** (each ends "Nothing was charged."; the words are `PAYMENT_RETRY_REFUSALS`):
  - the row: not `past_due`; its last day passed; no subscription; no saved card. Stripe is not read for these;
  - Stripe read now (review point 2), the subscription and then its newest invoice: can't be read or found; another
    customer's; `canceled` (Stripe leaves a cancelled subscription's invoices open, and paying one charges a member
    whose membership has ended); a cancel date already reached; neither behind (`past_due`, `unpaid`) nor paid up;
    the invoice not `open`, not in pounds, or with nothing left to pay;
  - the card (review point 1): the subscription's default card in Stripe is not the customer's saved card as the
    Worker has it, or ANY card step of the customer's is open: being sent, held past its window, or refused by
    Stripe and left for a person (`openSteps`). The words say to finish the card replace first;
  - taking turns (W40): a payment date change pending on the membership; a step open on its subscription; another
    retry open on the membership (review point 3);
  - what the window showed (Q18's rule): the invoice is no longer the subscription's newest, or the amount differs
    by more than half a penny (TOTAL_CHANGED, with the amount now). W47r-a (the W47r review's S3): or the customer's
    saved card under the lock is no longer the card the window named (`card_changed`). The quote carries the card's
    `paymentMethodId` for this. A press with no invoice, amount or card in `confirmed` is refused
    (`amount_not_confirmed`).
- **The record first, then one send.** P1 is one transaction under the customer's lock and then the membership's:
  the row and every database check again, then a `membership.payment_retried` row with `state: 'started'` naming the
  membership, the subscription, the invoice, the amount and the card. Then ONE `invoices.pay` with `payment_method`
  (the card on the record) and the key `<retryId>:pay`. Nothing else in the code sends for a record: not the press a
  second time (W41's charge allows itself one repeat; this does not), not reconcile. A repeat of the key after
  Stripe has dropped it (24 hours) would be a new attempt, so the one-send rule is the guard, not the key (review
  point 5). Stripe itself never takes an invoice's amount twice: a paid invoice refuses a pay.
- **The answer.**
  - **Paid** (Stripe answers the invoice `paid`; or it refuses the pay and the invoice then reads `paid`, because one
    of its own retries got there first; or the answer was lost and the invoice reads `paid`): the route runs the
    webhook's own `invoice.paid` steps for that invoice (`app/api/stripe/webhook/dispatch.ts`, `recordInvoicePaid`:
    the subscription read now, `membership_mark_paid` only when it is paid up and the invoice is its newest, read
    again after the write), on the Worker's own connection (`membershipRpc`). The flagged bookings go back to
    confirmed at once; the event, when it arrives, changes nothing. The answer says what changed. A write that finds
    nothing to do (Stripe has started a newer invoice, say) still ends the record `paid`, and the words say why the
    membership was not changed.
  - **Already paid before the press** (Stripe shows the subscription paid up and its newest invoice paid, and the
    membership here hasn't caught up): nothing is sent and no record is opened; the same write is run, and one
    `paid` row says who pressed (`sent: false`). That row is a **lone `paid` row**: it has a `retryId` of its own
    and no `started` row before it, so a count of `started` rows against endings finds one ending more for each
    such press (the W47r review's L6).
  - **Declined** (Stripe answered no, and nothing of the invoice is still going): the record ends `declined`. Nothing
    is written to the membership; the words say Stripe's own retries carry on and the bookings keep their deadline.
  - **No clear answer** (a 500, a timeout, no time left to read; or the invoice's PaymentIntent is `processing`,
    `requires_action` or in any state that can still take money): HELD. PAYMENT_UNCONFIRMED, with the record's id. A
    new press is refused while it is open. After a timeout only "the invoice reads paid" is believed; "still open"
    is not "not taken" while the send may still land.
  - **Paid in Stripe and the write here failed:** held as `paid_not_recorded`; reconcile makes the write.
  - **Not sent** (no time left, or Stripe turned the key away before the endpoint ran): the record ends `not_sent`.
- **Reconcile** (`orders/reconcile.ts` `reconcilePaymentRetry`, `settlePaymentRetry`), for a record still open (see
  W47r-a below for when a run takes it up): it reads the invoice with its payments, then each payment's
  PaymentIntent, and nothing else.
  Paid: the same write, and the record ends `paid` (`finalised`). Not paid with every payment ended and nothing taken
  (`requires_payment_method`, `canceled`, or no payment): the record ends `not_taken` (`undone`), and the payment can
  be tried again. A payment still at the bank or waiting on the customer: left (`payment_processing`,
  `payment_needs_action`) for as long as it takes. Stripe not readable: left (`unclear`); "no such invoice" is
  `other_mode` when the key isn't of the record's own mode, else `invoice_missing`. It never sends, cancels or refunds.
- **The stuck list** (`orders/stuck-list.ts`): `paymentRetries`, a field of its own and optional in the contract, with
  what each is waiting on (`PAYMENT_RETRY_STUCK_WORDS`). **There is no manual close and no time limit** (review point
  3; W47a S2's lesson): only what Stripe shows ends a retry. The one exception is W47r-a's `paid_after_end`, below.
- **W47r-a (the W47r review's S1 to S4; before the kind goes on).**
  - **S1: money taken after the subscription ended is held for a person, never closed as paid.** Stripe can end a
    subscription in the second between the press reading it and the one send (its own dunning, or a manager), and a
    cancelled subscription's open invoice can still be paid. Example: Mo's press reads `past_due`; Stripe cancels;
    £40 is taken on the Visa ending 4444; the paid write rightly marks nothing. Until W47r-a the record ended `paid`
    and nothing was listed. Now, whenever the invoice reads paid and the write finds the subscription `canceled` or
    `incomplete_expired`, the row here cancelled (`ignored_cancelled`) or no membership with the subscription
    (`found: false`) (`paidAfterEnd`), the record stays **open**, with a `held` row whose reason is
    `paid_after_end`: at the press (PAYMENT_UNCONFIRMED, "£40.00 was taken on the card ending 4444 after this
    membership's subscription had ended. Refund it in Stripe (tell a manager), then press Mark refunded on the Orders
    page.") and in reconcile (left `paid_after_end`; the run writes the `held` row once if the press didn't). The
    stuck list shows it at once with those words and one close, **Mark refunded** (close kind
    `retry_paid_after_end`, Issue refunds, `markRetryRefunded`): it reads the invoice's payments and their refunds in
    Stripe first (reads only), refuses unless every payment that went through is refunded in full by refunds that
    have `succeeded` (one still `pending` is not money back yet), and then ends the record `refunded`, with an
    `order.close` row against `payment_retry`. Nothing in the Worker sends a refund for it. A write that left the
    membership alone for any other reason (a newer invoice, Stripe still showing `past_due`) is not money to give
    back, and ends the record `paid` as before.
  - **S2: a paid retry is recorded fast, and its booking doesn't lapse in the gap.** (a) A run takes an open record
    as soon as it has a `held` row (the press writes that last, so it has finished); the 15-minute window is only for
    a record with no `held` row. The stuck list shows the same records the run reads. Inside the window a run records
    a payment it finds paid, and **never ends a record as not taken** (left `waiting`): a send that got no clear
    answer may still land, and "nothing taken" a minute later proves nothing. (b) The lapse sweep leaves (`left`,
    `payment_retry_held`) a credit booking whose membership has an open record younger than an hour
    (`memberships/retry-record.ts`, `PAYMENT_RETRY_HOLDS_LAPSE_MINUTES`: the hour the banner's line for Stripe's
    notices uses), checked in the lapse's own transaction under the booking's locks (`bookings/cancel.ts`). Older
    than that the booking lapses as before: a retry waiting on the customer for ever must not keep unpaid bookings
    for ever. Example: Mo pays at 13:55, the write's read gets a 500, his booking's deadline is 14:00; the 14:00 run's
    sweep leaves the booking and its reconcile records the payment, so the booking is confirmed.
  - **S4 and L1: words.** "Authentication needed" no longer offers paying online (there is nowhere to); Stripe's
    plain "Your card was declined" is not said twice; a subscription still `past_due` straight after its invoice is
    paid says Stripe's notice will bring the membership up to date; the held `payment_needs_action` line says that
    when Stripe has ended the subscription a manager voids the invoice, and the run then ends it as not taken.
- **W47r-b (W47r-a "Noticed" 1, 2 and 5; the lead's call, 19 Nov): an invoice paid after its subscription ended is
  always listed for a refund.** This part is not behind the kind: the webhook's half is live as soon as the Worker is.
  - **The gap.** Stripe leaves a cancelled subscription's open invoice payable. Its own retry can land, or the
    customer can approve the payment with their bank, after the subscription has ended. `invoice.paid` then finds the
    subscription ended and (W46) rightly marks nothing, and until W47r-b nothing was listed: the money was kept. The
    retry's "already paid before the press" path had the same gap. Example: Mo's subscription is cancelled at
    16:00:00; his bank approval goes through at 16:00:05 and £40 is taken.
  - **The rule, in the one place both paths share** (`app/api/stripe/webhook/dispatch.ts`, `recordInvoicePaid`): the
    subscription reads `canceled` or `incomplete_expired`; the invoice is then read (one more read, on this path
    only) and must be `paid` with money taken (`amount_paid` above nothing); and it was paid **at or after** the
    moment the subscription ended: `status_transitions.paid_at` >= the subscription's `ended_at` (`canceled_at` only
    when Stripe gives no `ended_at`: for a scheduled cancel `canceled_at` is the day it was asked for, not the end).
    Stripe's times are whole seconds, so the same second counts as after; a time Stripe didn't give counts as after
    too (it can't be shown the payment came first).
  - **Not listed: paid before the end.** That money was owed. Stripe's retry pays at 16:00:00 and a manager cancels at
    16:00:01; or a member's last paid month, whose `invoice.paid` Stripe sends again after the membership has ended.
  - **The line** (`memberships/paid-after-end.ts`, `listPaidAfterEnd`): one audit row
    (`membership.invoice_paid_after_end`, entity `membership_invoice`, the invoice's id), written in one transaction
    under the membership's lock and only while (a) the invoice has no row yet (the same notice again, another notice
    for the invoice, or a press after the notice writes nothing more; a line marked refunded is never listed again)
    and (b) no retry's record holds the invoice: one still open (W47r-a's own `paid_after_end` hold lists it) or one
    ended `refunded`. So an invoice has one line, whoever finds it first. The webhook has only Supabase's client, which
    can't hold a transaction, so its route (`route.ts`) gives the handler a listing on the Worker's own connection,
    opened only when there is a line to write. A read or a write that fails throws: the notice is an error and Stripe
    sends it again. What was found is on the notice's row (`detail.paid_after_end`: `listed`, `already_listed`,
    `retry_holds`, `paid_before_end`, `nothing_taken`, `no_membership`, `invoice_missing`).
  - **The stuck list** shows it with the retries (`paymentRetries`, reason `paid_after_end`, no card named:
    "£40.00 was taken by Stripe after this membership's subscription had ended. Refund it in Stripe (tell a manager),
    then press Mark refunded.") and the same close, **Mark refunded** (`retry_paid_after_end`; `orderId` is the
    line's own id; `markInvoiceRefunded`): the same read of the refunds in Stripe, the same refusals and words, then
    its `refunded` row and an `order.close` row against the invoice. Nothing sends a refund. A run reads nothing for
    it.
  - **No membership here has the subscription:** nothing is written (there is nobody to list it against); the
    notice's row says `no_membership`.
  - **The press's words** for "already paid before the press" with the subscription ended go by what the write found:
    listed ("…then press Mark refunded on the Orders page"), paid before the end ("…it paid for time the member had.
    Nothing needs refunding."), else W47r-a's.
  - **Words ("Noticed" 2 and 5).** A retry held because the membership's row had ended here while Stripe's
    subscription was still live (`ignored_cancelled`; its `held` row carries `cancelledHere`) says "…after this
    membership had ended here. Refund it in Stripe (tell a manager) and check the subscription is cancelled in
    Stripe, then press Mark refunded." `unpaid` straight after the pay is said as `past_due` is.
  - **The fake:** a subscription's `ended_at` and `canceled_at` (set when it ends; `setSubscription` takes
    `endedAt`, `canceledAt`), and an invoice's `status_transitions.paid_at` (`setInvoicePaidAt`).
- **W47r-c (W47r-b "Noticed" 1 and 2): the last two gaps.** The second is not behind the kind: the webhook's half is
  live as soon as the Worker is.
  - **1. A retry's own hold goes by the same time rule as the line** (`retry-payment.ts`, `paidAfterEnd`). Until
    W47r-c a retry's record was held for a refund whenever its invoice was paid and the subscription had ended,
    whenever the money was taken. Example: Mo's press takes £40 at 16:00:00; a manager cancels at 16:00:01; the
    press's write reads the subscription at 16:00:02. That £40 was owed, and it was held "Refund it in Stripe". Now
    the hold reads what the paid write already found (`detail.paid_after_end.why`): `paid_before_end` (taken before
    Stripe ended the subscription) ends the record `paid`, at the press (answered 200: "…it paid for time the member
    had. Nothing needs refunding.") and in reconcile (`finalised`). Taken at or after the end, in the same second, or
    with a time Stripe didn't give: held `paid_after_end` with Mark refunded, as before.
  - **A record once held stays held.** A record with its `paid_after_end` row is never ended `paid` by a later read
    (`settlePaymentRetry`): only Mark refunded ends it. Example: held because the row had ended here (Stripe's
    subscription still live); a manager then cancels the subscription in Stripe, as the line's words ask; Stripe now
    shows the payment "before the end", but it was still taken after the membership ended here.
  - **2. A renewal Stripe takes on a live subscription whose membership's row has ended here is listed** (Wayne's
    rule: a cancelled member is never charged with nothing listed). The paid write gets as far as the row and
    `membership_mark_paid` answers `ignored_cancelled`; until W47r-c the notice ended there. Now (`dispatch.ts`,
    `recordInvoicePaid`) the invoice is read (one more read, on this answer only) and, `paid` with money taken, is
    listed by the same line (`listPaidAfterEnd`: `membership.invoice_paid_after_end`, once for an invoice, under the
    membership's lock, never beside a retry's own hold), with `cancelledHere` and the row's `lastDay` on the audit
    row. Example: Mo's row is ended here with its last day on 9 January and the cancel never reaches Stripe; on 10
    January Stripe takes £40. Listed: "£40.00 was taken by Stripe after this membership had ended here. Refund it in
    Stripe (tell a manager) and check the subscription is cancelled in Stripe, then press Mark refunded." The close
    is the same Mark refunded.
  - **Not listed: paid before the row's last day.** Stripe shows no end for a live subscription, so the time is the
    row's own: `cancel_effective_date`, read under the lock, against London's date of the invoice's `paid_at`. Paid
    before that day was for a month the member had (a late or re-sent notice): `paid_before_last_day`, nothing
    written. Paid on the last day itself or after it, a row with no last day (a refunded membership's row has none),
    or no `paid_at`: listed (it can't be shown the payment came first). A retry's record whose write answers
    `paid_before_last_day` ends `paid`, by the same rule as 1.
  - **The press's words** for a row ended here go by what the write found (`PAYMENT_RETRY_WORDS.notUpdated
    .ignored_cancelled`): listed ("…then press Mark refunded on the Orders page"), paid before the last day ("…it
    paid for time the member had. Nothing needs refunding. Tell a manager to check the subscription is cancelled in
    Stripe."), else W47r-a's.
  - What was found is on the notice's row (`detail.paid_after_end`, with `cancelled_here: true`): `listed`,
    `already_listed`, `retry_holds`, `paid_before_last_day`, `nothing_taken`, `no_membership`, `invoice_missing`.
    The notice's outcome stays `processed` with `action: 'ignored_cancelled'`, as before.
- **W47r-d (W47r-c "Noticed" 1 to 3): a renewal Stripe takes after Cancel was pressed here is listed.** Not behind
  the kind either.
  - **1. Migration 031** (`supabase/migrations/031_a_payment_after_the_last_day_is_not_recorded.sql`; written, NOT
    applied: the lead applies it). Cancel pressed here writes the last day and leaves the status `active`; the row is
    marked cancelled only when Stripe ends the subscription. So when the cancel never reaches Stripe and Stripe
    renews, `membership_mark_paid` answered `reactivated`: marked paid, next payment a month on, nothing listed.
    With 031 it answers `ignored_cancelled` (with `last_day`) for a row whose `cancel_effective_date` is before
    today in London, and writes nothing; W47r-c's listing above then lists the payment. Example: Mo's last day is
    9 January; on 10 January Stripe takes £40: nothing written, one line. A payment on 8 January, or on the 9th
    itself, is recorded as before. **Without 031** the Worker does what it did (recorded, not listed): it works on
    live before and after. Order: this Worker first, then 031 (the migration's header says why).
  - **Every caller reads the answer.** `invoice.paid` (`recordInvoicePaid`): listed, as W47r-c. The read after a
    failed-payment notice's write (L8, `dispatchStripeEvent`): when the payment went through meanwhile and the paid
    write answers `ignored_cancelled`, it is listed there too (once for an invoice; the invoice's own notice then
    finds it listed). "Try the payment again now", at the press and in reconcile: held `paid_after_end` for a
    person (the press itself refuses a membership past its last day, so this is a last day that passes mid-press).
  - **2. A notice handled after the subscription was cancelled in Stripe** (`dispatch.ts`, `paidAfterEnd`,
    `beforeStripeEnd`). Stripe then shows the payment "before the end", which until W47r-d was never listed. Now the
    listing is still asked, reads the row's last day under the lock, and lists when the row has one and the
    payment was on or after it (London's date), with `pastLastDay` and `lastDay` on the audit row and words that
    name the day. Example: last day 9 January; £40 taken on 10 January at 14:00, the notice fails; a manager
    cancels in Stripe at 15:00; the notice at 15:05 lists it. No last day on the row, a payment before it, or no
    membership with the subscription: `paid_before_end`, nothing written, as before. A retry's record goes by the
    same answer (held, not ended `paid`).
  - **3. Mark as owed** (`close-stuck.ts`, kind `paid_after_end_owed`; `closeOwed` on the line beside `close`): the
    second close of a paid-after-end line, for a payment that was for a period the member had. Issue refunds and a
    reason (the route checks both); the reason goes on the line's `owed` row and on the `order.close` row. No
    Stripe client is made and nothing is sent. A listed invoice (`markInvoiceOwed`) or a retry's own record
    (`markRetryOwed`, closing state `owed`); either way the invoice is never listed again.
- **W47r-e (W47r-d "Noticed" 1 to 3): a cancel pressed here is never undone by Stripe, and a live subscription
  past its last day is listed.** Not behind the kind either.
  - **1. Stripe's update notice never clears a last day a cancel here still wants** (`dispatch.ts`,
    `customer.subscription.updated`; `memberships/cancel-kept.ts`). Stripe sends that notice at every renewal, about
    an hour before it takes the money. For a cancel that had not reached Stripe it showed a subscription with no
    end, the sync function cleared the last day, and the payment was then recorded as any member's (031 goes by the
    last day and found none). Now a notice for a subscription with NO end is written on the Worker's own
    connection, in one transaction under the membership's row lock: when the row has a last day, has not ended, and
    a cancel step wanting an end is still open (left, being sent, or refused and listed), nothing is written and
    the notice is answered `ignored`, reason `cancel_wanted_here`, with the step and the day kept on its row; the
    step settles it. Anything else calls `membership_sync_cancel_at_period_end` in that transaction, as the webhook
    always did: an Undo pressed here (its step wants no end), a cancel that finished (`done`), one put back
    (`undone`), one a person marked sorted, and a membership with no step. A notice that sets or moves an end is
    written through Supabase's client as before. Example: Mo's last day is 9 January and Stripe refused the cancel;
    on 10 January the update is handled first: last day kept; then the £40: listed once (with 031).
  - **2. 031 gains the same lines in `membership_mark_payment_failed`**: a failed payment for a row past its last
    day answers `ignored_cancelled` (with `last_day`) and writes nothing: not marked past due, no booking flagged.
    Still not applied; the Worker works before and after.
  - **3. A membership past its last day whose subscription is still live in Stripe is listed**
    (`memberships/still-live.ts`; `reconcile.ts`, with the step checks). Each run reads Stripe for at most 5
    memberships that have not ended here (status `active` or `past_due`), have a subscription, and whose last day
    ended at least 20 minutes ago in London; the ones read longest ago first (`reconcile.steps_tried`, `live`).
    Stripe shows it live: one `membership.still_live_in_stripe` row (`listed`), once for a membership and
    subscription, under the membership's lock and only while it is still past its last day; the stuck list shows it
    in `steps` as `what: 'still_live'`, state `refused`, with no close: "Mo Member's membership ended here on 9
    January, but Stripe's subscription is still live and will keep charging. Tell a manager: cancel it in Stripe."
    Not listed while Stripe's own end for it has already fallen due (Stripe is ending it). Stripe shows it ended:
    one `ended` row, which takes the line off and stops the reads; the membership's row is left alone. The line
    also goes as soon as the row is no longer past its last day (Stripe's notice marked it cancelled). Read only:
    nothing is sent and the membership is never changed here.
- **The fake** (`server/stripe/fake.ts`): renewal invoices as objects (`startRenewal` makes the draft, `renewalFails`
  finalises it with its payment declined), `invoices.retrieve` (with `payments` when asked) and `invoices.pay` (the
  card named, declines, already paid, `processing`, `requires_action`), and `stripeRetryPays` for one of Stripe's own
  retries. What it says of an already-paid invoice's refusal is a guess, marked as one; the rule reads the invoice
  after any refusal and doesn't go by the refusal's code.
- Tests: `memberships/retry-payment.test.ts` (the brief's case end to end through the card replace route, each
  refusal, each Stripe outcome, a Worker that dies at the send, reconcile each way, 31 days still held, the one-send
  rule, the staff app's wrappers through the real routes; W47r-a: paid after the subscription ended at the press and
  in reconcile, Mark refunded before and after the refund, the sweep and the hour, the card the window showed;
  W47r-b: paid before and after the end through the notice and through the press, the notice sent again, a retry's own
  hold never listed twice, Mark refunded on a listed invoice, an end-of-term cancel, the times Stripe gives, what
  can't be read or written; W47r-c: a press's money taken a second before and a second after the end, at the press
  and in reconcile, a record once held staying held, a renewal taken for a row ended here listed once and December's
  notice not, the last day by London's date, Mark refunded refused then allowed; W47r-d: the press and reconcile
  reading 031's answer, a retry held by the last day after a cancel in Stripe, Mark as owed on a held retry),
  `memberships/cancelled-here.test.ts` (W47r-d: Mo's last day 9 January and £40 taken on 10 January, before 031 and
  with it; 8 January recorded; the edges of the day; L8; the notice after a cancel in Stripe; Mark as owed refused
  without a reason or Issue refunds, then recorded), `testing/migration-031.test.ts` (031 on real Postgres: the
  diff of each function, twice, its Down, its header's SQL, ten memberships for a payment and ten for a failed one),
  `memberships/cancel-wins.test.ts` (W47r-e: the update handled first with a real Cancel Stripe refused, then the
  payment, before 031 and with it; a step still left; Undo then the update; a cancel that landed; sorted, put back,
  no step; the read after the write; a failed renewal past the last day; the still-live line listed once, cleared
  by Stripe's ending, never for an ended subscription, the 20 minutes, five a run by last read, the staff app's
  heading), `memberships/cancel-kept-postgres.test.ts` (the notice's write and Cancel at once on real Postgres,
  each way round), `memberships/retry-payment-postgres.test.ts` (two presses
  at once on real Postgres: one record, one send, one charge; W47r-b: two listings of one invoice at once write one
  line; W47r-c: the same for a row ended here), `server/staff-app-retry-payment.test.ts` (the staff
  app's wrappers, words and screens), `server/stripe/fake.test.ts` (what the fake holds Stripe to do).

## Step G foundations: the admin contracts and words, `plan_changes`, the three helpers (W48)

Dark: no route, nothing switched, no screen changed. What W49 to W57 build on (G-plan 4.1, 4.2, 4.6, 4.9).

- **`contracts/admin.ts`** (exported last from `contracts/index.ts`): a pair of contracts for each of the staff app's
  82 functions that were not a thin call when step G began (`ADMIN_CONTRACTS`, by function name: lead call L11, one
  staff app function per old function). Each answer is the old function's own, in its field names; each input is
  loose where the old function answered for itself (a word from a set is any text, a number may be empty), so the
  rule refuses in the old words. `adminRefusalDetailsSchema` is every step G refusal's `details` (the reason, the
  words, the action); `ADMIN_ACTIONS` the 39 audit actions of G-plan 4.6. `replay/w48-contracts.test.ts` holds the
  file to every call the 271 step G scenarios make of the old functions.
- **Words**, moved word for word and unused yet: `staff/failure-messages.ts`, `catalog/failure-messages.ts` (with
  the legacy routes' own refusals and the plan price move's), and `admin-failure-messages.ts` in `promo/`,
  `pricing/`, `sessions/`, `bookings/`, `events/` and `orders/` (beside the words files those folders already have
  for steps B to F). 144 sentences and the reasons of the eleven result types that name any.
  `admin/words.test.ts` reads the old sentences from the frozen copy with the TypeScript parser and holds the files
  to them both ways. Not moved, on purpose: the plumbing between Retool and the legacy routes, and "saved but could
  not be read back".
- **`plan_changes`** (`catalog/plan-switch.ts`, lead call L3): step G's one switch kind, for the plan actions that
  touch Stripe (a plan made, a plan's price changed, a plan on or off sale). Off until the lead adds it to
  ORDER_SWITCH when W57 goes live; off, it answers MEMBERSHIP_PATH_OFF in every switch's words, with
  `kinds: ['plan_changes']`. Nothing asks it yet. Reconcile never will.
- **`LOCK_ORDER` gains `admin_row`, first of all** (`orders/locks.ts`): a row a step G action edits (a staff member, a
  catalogue item, a weekly slot, a band or its windows, a setting). An admin write locks its own row first and then
  only rows after it; no money transaction locks one, so nothing can be waiting on it while holding a later row. A
  row the list already names keeps its place: an admin action on a session takes `session` where an order and a
  booking change take it. `admin/locks.ts` (`lockAdminRows`) takes them: a statement a table, tables in LOCK_ORDER,
  ids in id order.

### The three helpers (`server/rules/admin/`)

| Helper | For | What it does |
|---|---|---|
| `adminWrite` (`write.ts`) | Level B: prices, tiers, bands and windows, member terms, postage, promo codes, pass and gift card type settings, event details, stock, variants, block and unblock, band override, start time, one-off session, weekly slots, staff | The press's key must be there; the permission from the signed-in staff member, in the old words, before anything is read; then one transaction: the locks, the row read in its own statement, the old checks and the change, and one audit row with who, the row before and after, and the key |
| `flagWrite` (`flag.ts`) | Level C: check-in, waivers, add-on prepared, line fulfilled | The call's key; the permission; then one transaction: one guarded statement (the guard is the rule) and, when it changed a row, one audit row. No row means the guard refused: the reason is read in the same transaction and thrown, so nothing is kept |
| `adminRead` (`read.ts`) | The 30 reads | An active staff member (the route's own check: GB14), the admin role for the staff list, in the old words; a statement that names its columns (one that reads `*` is thrown before it runs); each moment as ISO text. `ownStaffRow` is L10's one exception: a staff member's own row whether active or not |

- **The press key is the route's.** Every step G write is run by an idempotent route (`idempotent: true`), which
  answers a repeated key from the stored answer without running the rule again. The helpers take the key
  (`pressKey`) so the audit row can carry it, and refuse to run without one, so a route can't be built without it.
- **A refusal is a throw** (`adminRefusal`), inside the transaction or before it, so nothing of it is kept: no change
  and no audit row. Its `details` carry the old reason and words; each thin wrapper puts the old result shape back.
- **Level A (the plan actions, W57) does not use `adminWrite`**: it is step F's discipline (a record before any Stripe
  call, keys from the record, held or left, reconcile).
- Tests: `admin/helpers.test.ts` (PGlite, each helper through a route made as the app's are: the permission, the
  audit row, a repeated key, a refused write) and `admin/helpers-postgres.test.ts` (real Postgres: two presses queue
  on the row's lock, with a control that loses a press without it; the lock order; a check-in against a cancel).
  The examples in them (a band's price, a booking checked in, the staff list) are not routes of the app.

## Staff, Pricing and promo codes on the Worker (W49 + W54)

The first step G screens to move: the Staff page (G-plan 1.8), the Pricing page's four setters (1.7) and the Promo
Codes page (1.6). Fourteen of the staff app's functions are now thin calls. No Stripe, so no switch kind: each write
is one transaction with nothing to stop part way (lead call L3). Level B throughout (G-plan 4.2).

| Route (under `/api/v1/staff/`) | Staff app function | Rule |
|---|---|---|
| `GET staff/me` | `getCurrentStaff` | `staff/admin.ts` `getOwnStaffRow` |
| `GET staff` | `getStaff` | `listStaff` (admins) |
| `POST staff` | `createStaff` | `createStaff` (admins) |
| `POST staff/:staffId/role` | `setStaffRole` | `setStaffRole` (admins) |
| `POST staff/:staffId/permissions` | `setStaffPermission` (Issue refunds, active) and `setStaffCanManagePricing` | `setStaffPermission` (admins): one switch a press, named by its column |
| `POST pricing/bands/:bandId/price` | `setBandPrice` | `pricing/admin.ts` `setBandPrice` (Manage pricing) |
| `POST pricing/band-rules/:dayOfWeek` | `setBandRules` | `setBandRules` (Manage pricing) |
| `POST pricing/member-band-terms` | `setMembershipBandTerm` | `setMembershipBandTerm` (Manage pricing) |
| `POST postage/settings` | `setPostageSettings` | `setPostageSettings` (Manage pricing) |
| `GET promo-codes` | `getPromoCodes` | `promo/admin.ts` `listPromoCodes` (any active staff) |
| `GET promo-codes/:promoCodeId/redemptions` | `getPromoCodeRedemptions` | `listPromoCodeRedemptions` (any active staff) |
| `POST promo-codes` | `createPromoCode` | `createPromoCode` (Manage pricing) |
| `POST promo-codes/:promoCodeId` | `updatePromoCode` | `updatePromoCode` (Manage pricing) |

Every write goes through `adminWrite`: the permission in the old words, one transaction under the lock, an audit row
with the row before and after and the press's key (`staff.created`, `staff.role_set`, `staff.permission_set`,
`pricing.band_price_set`, `pricing.band_rules_set`, `pricing.member_term_set`, `postage.set`, `promo.created`,
`promo.updated`). A route's input is loose where the old function checked for itself (`contracts/admin.ts`, the
route schemas at its end), so each refusal is the rule's, in the old words.

**The sign-in email (GB16; W48 call 12).** `server/auth/staff.ts` `staffRowBySignInEmail` is the one way a sign-in
finds its staff row: `lower(email) = lower($1)`, the row spelt exactly as the sign-in first. The staff check
(`authenticateStaff`) and `GET staff/me` (`ownStaffRow`) both call it, so they can't disagree. The old functions
compared exactly. The staff app's remaining old functions (W50 to W57) still do, through `shared/staffAccess.ts`,
until each moves.

**`GET staff/me` and the `staff_sign_in` mode (lead call L10).** The route factory (`server/http/route.ts`) has one
more auth mode: the shared key and the signed-in email, with no staff row asked for. The handler gets the email and
nothing else, and such a route can't be idempotent (a write). `staff/me` is its only user: it answers the sign-in's
own row whether active or not (so the screen can say "inactive"), and null for a sign-in with no row. Every other
staff route still refuses both.

**The staff guard (GB16).** Every staff change locks every staff row, in id order, before it reads
(`admin/locks.ts`, `EVERY_ROW`). "Keep one active admin" and "keep one active Manage pricing holder" are about the
whole table, so a lock on the one row being changed would let two presses on two rows both pass; under the guard
they take turns, and each rule is a count read after the lock. The pricing rule is applied to the switch itself (the
old words) and to switching the last active holder off (the same words; the old functions let that through).

**A day's band windows (GB8; W48 review L1).** `setBandRules` is one transaction: the band guard (every
`session_bands` row: a day's windows may name any band, and the day's own rows are deleted and made again, so they
are nothing two saves can queue on), the bands checked, the day's windows deleted and inserted, the sessions that
will change band read and locked in id order (`lockAdminRows`), then re-banded by the database's own
`reassign_session_bands(now())`, and the audit row. A reader sees the day's old windows until the commit, then the
new ones: never none, never half. A failure anywhere rolls all of it back. **Any step G write that changes many
sessions (or memberships) must lock those rows through `lockAdminRows` first**: a bare multi-row update takes its row
locks in the order its scan meets them and can deadlock with another press that locks in id order
(`pricing/admin-postgres.test.ts` shows both). Until W51 moves it, the staff app's old Block Day is such a bare
update: against a band-window save on the same day's sessions it can still be stopped by a deadlock (a failed press,
no money).

**The settings rows (W48 review S1).** `postage_settings` and `membership_settings` are in `ADMIN_LOCK_TABLES`
(`admin_row`) and are locked as `ids: SETTINGS_ROW`, by a statement that names the one row as `id = true`. Nothing is
cast and no boolean goes in as a parameter: the Worker's driver sends the text `'true'` in a boolean array as false
(which locked nothing, silently, on real Postgres) and a boolean array as a single boolean. Postage uses it; W57's
membership settings will.

**Promo codes (GB18).** An edit locks the code's row (`FOR NO KEY UPDATE`), which queues with the `FOR UPDATE` an
order using the code takes before it writes its redemption (`orders/locks.ts`). So "the text can't change once
used" is a count read while no order can be using the code. A code already there in another letter case is refused
before the write (create and edit), and by the table's own index on `upper(code)` behind it, which is answered as
the same refusal. A create has no row to lock: two creates of one code at once are settled by that index.

**New words** (`pricing/admin-failure-messages.ts`, `PRICING_ADMIN_NEW_WORDS`, kept apart from the old sentences):
"That band no longer exists. Reload the page and try again." (a band price or a member term for a band that isn't
there: the old functions answered `updated: false` with no words, or showed the database's foreign key error) and
"Membership level must be Core or All-Access." (the database's check error before).

**The fake Stripe (W48 review S2).** A subscription's price switch refuses an archived price (`price_inactive`), as
`subscriptions.create` does.

Tests: `staff/admin.test.ts`, `pricing/admin.test.ts`, `promo/admin.test.ts` (the real routes on the live schema:
every refusal, the audit rows, a repeated key, the lock statements in order); `staff/`, `pricing/` and `promo/`
`admin-postgres.test.ts` (real Postgres, each race held until the second press is reported blocked by the first,
each with a control); `testing/replay/admin-replay.test.ts` (the 49 golden scenarios through the staff app's thin
functions). The staff app's side: `server/staff-app-helpers.test.ts` (the fourteen ask only the Worker).

## An edit from a page loaded before someone else's change is refused (W54a)

**The step G rule (the lead's call, 20 Nov; W49 + W54 review S1).** An edit that writes a whole row, or a whole day's
rows, is refused when the row has changed since the screen read it. W55 to W57's catalogue edits follow it.

Why: such a press sends every field as its page loaded it. The lock makes two presses take turns, but the second
still writes its own page's values over the first's. The money case (the review's): WELCOME is 100% by mistake; B
corrects it to 10%; A, whose page still shows 100%, switches it off and on again, and the switch sends
`discountValue: 100`. The next £25 session booked with WELCOME is £0 instead of £22.50.

**How (`server/rules/admin/stamp.ts`, `admin/write.ts`).**

1. Each read answers a **stamp** beside what it shows, from the same statement as the rows it is for.
2. The press sends it back (`stamp` on the route's input).
3. `adminWrite` compares it under the locks the write already holds, after the row is read and before the change:
   a different stamp, or none, is refused `changed_since` (409), "This was changed by someone else since the page
   loaded. The page has been reloaded: check it and save again." Nothing is written and there is no audit row.
4. The answer carries the row's new stamp, so the screen can save again without reading again.

Every `adminWrite` must say which it is (`unchangedSince`, a required field, so a new write can't leave the
question out): `{ seen, now }` for a whole-row edit, or `WRITES_ONLY_WHAT_WAS_PRESSED` for a new row or one value set.

**What a stamp is.** `rowStampSql(alias)`: the row's `updated_at` to the microsecond in UTC, then `#` and the md5 of
the whole row as text. Both, because the moment alone misses a change made in the same instant (the test
database's clock ticks in milliseconds; the replay's is frozen) and a change that doesn't move `updated_at`
(`promo_codes` and `postage_settings` have no `update_updated_at_column` trigger: a correction made by hand in SQL
might not set it). A row put back exactly as it was has its old stamp again, which is right: it is what the screen
shows. A set of rows (`rowsStamp`): each row's id and stamp, in id order; `'none'` (`NO_ROW_STAMP`) for no rows,
and for a single row that isn't there yet.

| Edit | Stamp | Read that answers it | Lock it is compared under |
|---|---|---|---|
| `updatePromoCode` (the dialog's save **and the list's on/off switch**) | the code's row | `GET promo-codes`: `stamp` on each row | the code's row |
| `setPostageSettings` | the settings row | `GET postage/settings`: `stamp` | the settings row |
| `setMembershipBandTerm` | the term's row (`'none'` before its first save) | `GET pricing/config`: `stamp` on each `membershipTerms` row | the band's row |
| `setBandRules` | the day's windows, as one | `GET pricing/config`: `bandRulesStamps[day]` (0 = Sunday) | the band guard |

**Left as it is, on purpose: `setBandPrice`**, and every staff write (role, a switch, a new member) and
`createPromoCode`. Each writes only what was pressed (one value, or a new row), so a page loaded before someone
else's change has nothing of theirs to put back.

**Order of refusals.** The permission (before anything is read); then anything the rule checks before its
transaction (a window that isn't valid, a figure that isn't a number); then the row not being there; then
`changed_since`; then the rule's other checks under the lock (a promo code's text, its lock, its fields).

**An older staff app** (a press with no stamp) is refused the same way. Nothing in these screens was live, so the
Worker and the staff app that sends the stamp go out together.

**The `staff_sign_in` mode can only be a read (review F3).** Its config must say `method: 'GET'`; anything else is
thrown when the route is defined, and the route refuses a request that isn't a GET before the handler runs.

Tests: `admin/helpers.test.ts` (the rule in the helper, and the stamp itself); `pricing/admin.test.ts` and
`promo/admin.test.ts` (each of the four: a stale press refused with nothing written and no audit row, a fresh one
saved, the reviewer's two examples, a press with no stamp); `pricing/` and `promo/` `admin-postgres.test.ts` (two
presses at once from pages loaded before either: the second waits, then is refused; a control with the comparison
made before the lock lets it through); `http/route.test.ts` (F3); `testing/replay/admin-replay.test.ts` (the golden
files pressed as the screens press them); `server/staff-app-helpers.test.ts` (the staff app sends and keeps the stamp).

## Bookings admin and Overview on the Worker (W50)

G-plan 1.10, 1.12, 4.3 and 4.8; bugs GB14 and GB17; Wayne's Q49 (20 Nov); W48 review L2 and L5. `bookings/admin.ts`,
its words in `bookings/admin-failure-messages.ts` (`BOOKING_ADMIN_NEW_WORDS`: every one is new, because the old flag
functions refused nothing about the booking), the day fragments in `time/london-day-sql.ts`, the waiver methods in
`waivers/methods.ts`.

| Staff app function | Route | What |
|---|---|---|
| `getBookings` | `GET bookings` | The bookings whose session is on a London day from `startDate` to `endDate` (each optional), with a status; none of the three lists every booking |
| `getBookingById` | `GET bookings/:bookingId` | One booking's row, or null |
| `getBookingDetail` | `GET bookings/:bookingId/detail` | Guests, add-on lines, special requests, money still to give back, the open-payment words |
| `getAddonPrepChecklistForRange` | `GET bookings/addon-prep` | Add-ons still on bookings that aren't cancelled, for the days |
| `getWaiverGapsForRange` | `GET bookings/waiver-gaps` | Guests without a signed waiver on bookings that aren't cancelled, for the days |
| `getPaymentAttentionItems` | `GET overview/payment-attention` | Bookings at Payment needed and memberships whose payment is overdue |
| `setBookingCheckedIn` | `POST bookings/:bookingId/check-in` | Check In and its undo |
| `setGuestWaiverStatus` | `POST bookings/guests/:guestId/waiver` | Mark Signed and Revoke |
| `setAddonLinePrepared` | `POST bookings/addon-lines/:lineId/prepared` | The prepared tick, on and off |

**The reads.**

- **GB14:** an active staff member, through `adminRead`. The old six checked nobody.
- **Named columns:** every column the old `b.*` and `RETURNING *` gave is named, so the answers are the old ones
  field for field (the replay holds that), and a new column is a decision.
- **The channel (4.8).** Every read takes a `BookingReader`: `{ channel: 'staff', actor }` or `{ channel: 'customer',
  customerId }`. On the customer channel every statement carries `AND b.customer_id = $n` (`ownOnly`), so a customer
  is only ever shown their own bookings; a booking that isn't theirs reads as one that isn't there. No customer route
  exists (lead call L13). `guestsOfBookings` and `addonLinesOfBookings` take a LIST of bookings, so the website's
  account pages can later say "1 of 2 signed", list the add-ons and word what was paid (each guest's `unit_price` and
  `pay_by`: "£18.00 + 1 credit") for a page of bookings in two statements. Not built now.
- **The open-payment words** moved with the detail: the card words when every open flow on the booking is one the
  Worker started on a saved card, the reader words otherwise, including an order still being paid with no flow open.
  The "order still being paid" test is `load-booking.ts`'s own (`ORDER_BEING_PAID_SQL`), so the detail and every
  refusal ask the same question. The staff app's `shared/readerPaymentOpen.ts` and `shared/bookingPaymentOpenWords.ts`
  have no caller left.

**London days (W48 review L5).** A session's `start_time` holds London wall-clock digits labelled UTC (CLAUDE.md
"Session times"), so its London day is the date of those digits read as UTC. The old reads wrote `start_time::date`,
the date in the connection's time zone: the same day only while the connection is on UTC, which the Worker's and
Supabase's both are. So **no answer changes**: a session at 00:30 London in summer was, and is, on its own day. What
changes is that the day no longer depends on a setting: `time/london-day-sql.ts` compares the column against the
day's two ends as UTC moments (`withinLondonDaysSql`), which also lets an index on `start_time` be used. It is NOT
the stored moment turned into London time, which would add the summer hour twice and put a 23:30 session on the next
day. "Today" is the screen's (the staff app's `londonTodayIso`), sent as the range. `getAvailableSessions` (step B)
and the session reads W51 moves still write `start_time::date`: W51's to change with the same fragments.

**The three flags** (level C: `admin/flag.ts`, one guarded statement and an audit row in one transaction, under the
call's own key).

| | Cancelled booking | Payment needed booking | Also refused | Audit row |
|---|---|---|---|---|
| Check In | refused | **refused (Q49)**: "This booking needs payment first. Use Take Payment." | while a payment is still being taken on the booking (W50a, `payment_open`) | `booking.checked_in` |
| Undo check-in | refused | allowed | | `booking.check_in_undone` |
| Waiver signed / revoked | refused | allowed | a method that isn't `in_person` or `email_link` (the old words) | `booking.guest_waiver_set` |
| Add-on prepared / not | refused | allowed | a line already removed from its booking | `booking.addon_prepared_set` |

- A row that isn't there is `booking_not_found`, `guest_not_found` or `addon_line_not_found` (404): the staff app's
  functions answer null for exactly these, as the old ones answered a row that isn't there.
- **A repeat press keeps the flag and who set it** (G-plan 4.2): a second Check In keeps the first time; a waiver
  already signed keeps how and when; an add-on already prepared keeps who and when. (The old functions overwrote
  each.) It is not quite "changes nothing" (W50 review, "Claims" 1): a repeat Check In still moves the booking's
  `updated_at`, and every repeat press writes another audit row (`booking.checked_in`, `booking.guest_waiver_set` or
  `booking.addon_prepared_set`) carrying the unchanged value and who pressed.
- The check-in time is the database's clock (`now()`), as every other Worker write's. The staff app sends none.
- The audit row keeps who and the flag as set (`after`), never a guest's name, email or date of birth.
- **W54a's stale-page rule doesn't apply:** a flag writes only what was pressed.

**The booking is held first (W48 review L2).** Postgres re-checks only the row a statement updates after it has
waited for it. Check In's guard is on the row it updates, so it is safe by itself. A waiver's and a prepared tick's
guard reads the BOOKING's status, another table's row: without more, a tick pressed while a cancel is half way
would be judged on the status before the cancel and go through. So each first holds its booking `FOR SHARE` in a
statement of its own (`FlagWrite.holdFirst`): a cancel in progress is waited for, and the flag's own statement,
which starts after the wait, is decided on the committed status; a cancel that starts later waits for the flag.
`FOR SHARE` conflicts with the lock every booking change takes (`lockForBooking`) and not with another flag's, so
two flags on one booking don't queue. It is LOCK_ORDER's `booking`, the first lock the press takes and its only one
besides the row it updates. No booking action reads these flags today, so nothing went wrong before; the hold makes
it a rule rather than luck. (W50a: Check In's guard now also reads the booking's open payments, another table's
rows, so Check In holds its booking first as well, `FOR NO KEY UPDATE`: the W50a section below.)

**The waiver rule for the website (4.8; backend log 12 and 18): the rule only, no route.** `waivers/methods.ts` is
the one place the methods live: staff `in_person` and `email_link`; the customer channel `email_link`. The website's
`checkout` is added there when its checkout is built (`booking_guests_waiver_method_check` allows only the first two
today: the lead's migration first). `setGuestWaiver` takes a `WaiverPress` of either channel. On the customer
channel: only a guest on one of the customer's own bookings (told nothing about anyone else's), never a revoke,
refused once the booking is cancelled, and refused once the session has passed (its end, on London's wall clock).
Staff can still record a waiver after the session. The audit row's actor is then the customer.

**The cancel quotes read together (brief item 12).** `quoteCancel` (Cancel & return credit, Cancel (payment needed)
and Cancel & Refund's dialogs) made 13 reads one after another for a booking with a paid add-on. The six that need
only the booking's id now go together, then the three that need those answers but not each other's. The same reads
and the same answer; six waits where there were thirteen. Only the quote on the request's own client: inside a
change's transaction every read is still one after another (`loadBooking`'s `reads` defaults to `'in_turn'`).

Tests: `bookings/admin.test.ts` (each read's fields, ranges, the staff check and capitals, London days at 00:30 and
23:30 under three connection time zones, the customer channel; every refusal of each flag with its words, the audit
rows, the customer's waiver rule); `bookings/admin-postgres.test.ts` (a waiver, a tick and a check-in each against
a cancel, both ways round, with a control without the hold; Q49 under a race);
`testing/replay/booking-admin-replay.test.ts` (W48's 16 recordings: ten exact, six with named differences);
`bookings/cancel-quote-reads.test.ts` (the quote's reads); `server/staff-app-helpers.test.ts` (the nine thin
functions and the screens).

## W50's review fixes: Take Payment, Undo, Check In while a payment is open, the customer channel (W50a)

W50's review (Opus 5.5, no blocker) and Wayne's three answers of 20 Nov. No route, contract, migration or switch
kind is new; the same nine routes.

**Q49's words name the button.** "This booking needs payment first. Use Take Payment." (`paymentNeededCheckIn`).
"Settle" is the dialog's name; "Take Payment" is what the button on the booking window says. The replay's named
difference for the GB17 check-in recording is pinned to the new sentence. The line the booking window carried under
Check In ("Needs payment first: use Take Payment below.") is gone: it would say the same thing as the refusal.

**Undo check-in (review L5).** A screen change only: a small "Undo" beside the check-in time in the staff app's
`BookingDetailDialog`, not drawn on a cancelled booking. It calls `POST bookings/:bookingId/check-in` with
`checkedIn: false`, which already existed with its audit row (`booking.check_in_undone`).

**Check In is refused while a payment is still being taken on the booking (review L2).** Reason `payment_open`,
409, "A payment on this booking is still going through. Check in once it has completed." (`paymentOpenCheckIn`).

- **The test is the window's own.** `PAYMENT_OPEN_ON_BOOKING_SQL` in `bookings/admin.ts` is one condition: a pending
  `pending_reader_payments` row of a booking flow (Move, Settle, Add Guest; card reader or saved card, the Worker's
  or an old screen's), or an order still being paid for the booking (`ORDER_BEING_PAID_SQL`: a reader intent, or
  under 15 minutes old). The detail's `readerPaymentOpenMessage` and Check In's guard both use it, so Check In is
  refused exactly while the window shows its payment-open line.
- **Why:** a new order's booking is `confirmed` while its reader or saved-card payment is pending. A customer
  checked in on it would lose the check-in with the booking if the payment then failed and the order was undone.
- **Only Check In.** Undo, waivers and the prepared tick go through while a payment is open, as before.
- **Which words win.** Cancelled first, then payment open, then Payment needed. A Payment needed booking with a
  payment open is one whose Settle is in progress: "Use Take Payment" would be the wrong thing to say then.
- **The booking is held first here too.** An open payment is another table's row, and Postgres re-checks only the
  row a statement updates (the same reason as the waiver's hold above). Without more, a Check In pressed while a
  flow is opening would wait for the flow's lock on the booking and then go through on what it read before the
  wait. So Check In first takes its booking in a statement of its own (`HOLD_BOOKING_FOR_CHECK_IN_SQL`), and its
  own statement, which starts after the wait, sees the flow's committed record. A flow's C1 locks the booking
  (`lockForBooking`) and then writes its record in one transaction, so there is no moment a record exists that the
  hold didn't wait for. The other way round, a flow that starts while a Check In is open waits for it: checked in
  first, then the payment opens, which is fine.
- **`FOR NO KEY UPDATE`, not `FOR SHARE`.** The row held is the row Check In updates. Two presses that each held it
  `FOR SHARE` would each wait for the other when they came to update it, and Postgres would end one with a
  deadlock error. `FOR NO KEY UPDATE` is the lock the UPDATE takes anyway, so two presses queue at the hold. It is
  still LOCK_ORDER's `booking`, the press's first and only lock.
- **A window too small to matter:** an order that is paid or undone between the guard's statement and the refusal's
  read answers `booking_changed` ("…Reload the page and try again."), which is true.

**The customer channel (review L6; the rule only, no route).**

- **(a) Nobody else's booking is ever locked.** On the customer channel the waiver's hold is
  `HOLD_OWN_BOOKING_OF_GUEST_SQL`: the same statement with `AND b.customer_id = $2`. A customer pressing on someone
  else's guest locks nothing, waits for nothing and holds nothing up; the guard then refuses and they are told only
  "This guest isn't on one of your bookings…". Staff's hold is unchanged.
- **(b) Each flag says which channels it accepts** (`FlagWrite.channels`, required). `flagWrite` refuses any other
  before the key, the permission or any statement: 403, reason `channel_not_accepted`, "This can't be changed from
  here." (`FLAG_CHANNEL_NOT_ACCEPTED_MESSAGE`; nobody can see it today). Check In, its undo and the prepared tick
  say `['staff']`; a guest's waiver says `['staff', 'customer']`. This matters because `flagWrite` checks the
  permission only for staff: a flag that never said "customer" can no longer run for one.

Tests: `bookings/admin.test.ts` ("W50a: Check In while a payment is still being taken on the booking": each kind of
open payment with its words, exactly when the window shows its line; what isn't the booking's; undo, waivers and
prepared unchanged; which words win; the hold and the guard's statement; and the two customer-channel tests);
`bookings/admin-postgres.test.ts` (a flow opening as Check In is pressed, both ways round, with a control without
the hold that checks the booking in; two Check Ins at once; and a customer's press on someone else's guest against
a cancel, both ways round, with its control); `admin/helpers.test.ts` (the channel refusal, at the start);
`server/staff-app-helpers.test.ts` (the Undo on the screen, the words, the line gone).
