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

`LOCK_ORDER` now starts with an existing order: T2 and the undo lock it first. Nothing calls the route
until W14; until then only the dry run runs live, T1 only, with no Stripe (`dryRunOrder`), taking a
missing card figure as confirmed (W03-decisions, "W10 setup calls").

`dryRunOrder` is the same T1 with a read back (`order-rows.ts`) and a rollback. The staff app's
createOrder shadow calls it before the old order runs and compares the two (`createOrder.dryRun` in
`parity_log`). It goes at W16. The shadow keeps only the keys its own copy of the read-back produces
and records how many others it dropped (W07a), but still: for a slice that extends `OrderRows` or
anything the shadow compares, publish the staff app first, then deploy the Worker.

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
(`POST /api/v1/staff/orders/reconcile`) 10 items and 20 s, every Stripe call answered by 25 s. One item's worst case
(W12a, correcting W12's 70 s) is about 86 s: a held reader order whose tap lands while reconcile cancels it, with
save-card, makes six Stripe calls (the list, read, cancel, read again, then the two card reads) at 10 s each, plus T2
and its row at 13 s each. Each extra page of a Stripe list adds 10 s (ten pages, the cap, about 176 s). So a scheduled
run ends by about 206 s, or about 296 s with ten-page lists, inside the 5 minutes to the next run (overlap would be
safe) and far inside the 15-minute limit. The arithmetic is in `orders/reconcile.ts` (`SCHEDULED_LIMITS`). The stuck
list is `GET /api/v1/staff/orders/stuck`.
Their schemas are in `orders/reconcile-contracts.ts` until W14 moves them into `contracts/`.

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
balance. The reconciler replaces this at step E.

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
