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
(`load-basket.ts`, the quote's own read), `priceFromFacts` prices, then one statement writes the
booking (`write-booking.ts`), one the order with its lines and credits, one the audit rows. With no
Stripe step it finishes inside T1: seven round trips for any basket W06 takes (BEGIN and the time
limits go as one), plus three in the route (the staff member and the idempotency key, before and
after). The rules it keeps:

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
  `ORDER BY created_at, id` (seats, order lines, booking add-ons, audit rows) get created_at from
  `clock_timestamp()`, a millisecond apart, in the INSERT.
- **What isn't built yet answers NOT_BUILT** before any transaction opens. The list is in
  `place-order.ts`; each slice takes its part off it.

`dryRunOrder` is the same T1 with a read back (`order-rows.ts`) and a rollback. The staff app's
createOrder shadow calls it before the old order runs and compares the two (`createOrder.dryRun` in
`parity_log`). It goes at W16.

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
