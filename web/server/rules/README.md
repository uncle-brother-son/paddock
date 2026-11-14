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
