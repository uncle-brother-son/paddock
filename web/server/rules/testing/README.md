# server/rules/testing

## Which database a test uses

| Set-up | What it is | Use it for | Used by |
|---|---|---|---|
| `startTestDatabase()` | PGlite, `schema.sql`: the tables the read rules use, no foreign keys or triggers | Read rules, where fixtures set ids directly | The step B rule and route suites |
| `startTestDatabase({ schema: 'live' })` | PGlite, `live-schema.sql`: everything in the live catalog | Anything that writes | Replay, the probe, `live-schema.test.ts` |
| `reader-orders-schema.sql` | PGlite, a hand copy from W03a | Only `reader-rollback.test.ts` | Move it to `live` when that suite is next touched |
| `startRealPostgres()` | Real Postgres 17.6, `live-schema.sql` | Anything about one connection waiting on another | `two-connections.test.ts`, `replay/refund-races.test.ts` |

PGlite is one session, so it can't show one connection waiting on another's lock. It is also
Postgres 18, where live is 17.

## Real Postgres

`real-postgres.ts` starts the `embedded-postgres` dev package's server on a free port, from a new
temp folder, and `stop()` removes the folder. It takes about a second and needs nothing installed on
the Mac. Each `connect()` is a new Worker client, so two of them are two requests.

Keep the version in `package.json` on the one live runs. `two-connections.test.ts` fails if they
differ.

For a lock test, use `makeRace` from `race.ts`: it holds the first transaction open until Postgres
reports the second as blocked by it, so the test can't pass by luck of timing. When the test's name
says which lock the second waits on, pass the table as `waitsOn` (checked in `pg_locks` with
`waitingOn`): an earlier lock in `LOCK_ORDER` can queue the second first and hide a missing one. Add a
control that shows the unguarded version going wrong, or a passing test proves nothing.

`replay/refund-races.test.ts` runs the old functions themselves on two connections. It has no fixed
clock, so it moves the seeded sessions 20 years on, with triggers off, because one works the band out
again from the date.

## Refreshing the live schema

`live-schema.sql` is generated. Never edit it. After a migration:

1. Run `live-catalog-query.sql` against the live database (Supabase SQL editor or the Supabase MCP
   `execute_sql`) and save the answer to a file. It reads the catalog only, no table's rows.
2. `npm run schema:test -- --from <that file>` updates `live-catalog.json` and `live-schema.sql`.
3. Look at the diff, then run the tests.

`live-schema.test.ts` fails if the two files disagree. It can't tell if the snapshot is behind the
live database, so step 1 belongs in every brief that has a migration.

## Recorded Retool values

`retool-driver-*-values.json` are what the real Retool resource gave, and `driver-parity.test.ts`
holds the Worker's driver to them. Each difference is listed in that test. To re-record the `jsonb`
ones, run `retool-driver-jsonb-probe.txt` through `retool resource explore --json` from the staff
app's checkout.

## Replay

`replay/` runs a scenario from the same seed through the old Retool function, and later the new
route, and compares the rows written, the Stripe calls in order, and what staff are told.

- `scenarios.ts`: the seed and the scenarios.
- `harness.ts`: runs one and records it. The clock is fixed and moves 1ms per statement, and PGlite's
  `now()` follows it, so a recording is exactly repeatable. Start the database before faking the
  clock: Postgres's start-up hangs on a frozen one.
- `staff-app-dir.ts` (one level up): finds the staff app's checkout. A missing folder fails the suite:
  skipping would leave a green run that proved nothing.
- `dyingAfter` and `losingTheWorkersAnswer` in `scenarios.ts`: a function stopped dead after a call,
  and an answer lost on its way back. The invariant in `w05d.test.ts` holds every scenario to what the
  fake Stripe really refunded and charged; its exceptions are listed there by name, with the reason.
- `legacy-routes.ts`: the old functions' Worker calls go through the real legacy routes. Only Stripe's
  SDK and supabase-js are swapped, so `FakeStripe` sees what Stripe would.
- `compare.ts`: labels generated ids, shows timestamps as set or unset, compares money to the penny
  and checks row order. `tied` counts rows sharing a `created_at`.
- `golden/`: the old functions' recordings. They outlive the old code.

W08's scenarios (`w08-*`) cover events: every reason of stages 8 and 21 with its words, and what stage
21 writes. `w08-refused-event-with-no-prices` lifts `events_on_sale_complete` for its own run, because
live can't have an event on sale with a price missing, and puts it back `NOT VALID` (the row it leaves
would fail a check of the old rows; new rows are still checked).

W09's scenarios (`w09-*`) cover promo codes, store credit and gift cards used to pay: the discount on
every kind a code applies to (seats, places, add-ons, products, passes, a private booking's whole
price), how a fixed code's pennies are spread, every reason of stages 15, 16, 20, 24, 25a and 30 that
one order can reach, the payment method each mix records (Q9 is the one named difference), and W02's
noise cases (exact cover, fully covered orders, half pennies). The `MEMBERS5` code one scenario adds
has a fixed id, so its recording repeats.

`quote-shadow.test.ts` runs every scenario through the old `createOrder` with its shadow switched on,
against the real quote and parity routes, and reads what the shadow logged. A scenario must match
what the order wrote, except the differences in `quote-differences.ts`, each of which names its
decision. Adding a scenario adds it here too. The shadow goes at W16, and this file with it.

`w05a.test.ts` says in pounds and pence what the W05a scenarios prove on the old functions: Q23, Q24
and its refunds, migration 018, replacing an exhausted membership, and what Q3 does on the reader.

`w05b.test.ts` does the same for Q25: Add Guest on a private booking keeps its promo, and a later
Cancel & Refund gives back what was paid, on every way of paying.

`w05c.test.ts` does the same for Q27, where a part refund isn't asked for again, and for an add-on
paid with a guest going back to its own card. It also runs every scenario to check that only a guest's
card or reader payment counts as having add-ons inside its booking line.

`w05d.test.ts` does the same for `bookings.part_refunded_amount` and Q27 exactly, Q28 (a part refund stays
with the customer on a move), Remove Guest stopping at what is left, and a line that gave nothing back
staying unstamped. It also runs every scenario to check that no booking gets back more seat money than
was paid, and that a confirmed booking's `price_paid` is what was paid less what was given back. Money no
order line records is counted from the call itself: a move's store credit, gift card and cash parts, and
those parts of a guest paid on a card or the reader. A new way of paying must be added there.

`w05e.test.ts` does the same for what W05d left: a Cancel & Refund that fails after the card counting as
a part refund, a line whose seat money has all gone back being refunded when the cancel itself gives £0,
and Remove Guest and Move taking off `price_paid` only what reached the customer when store credit fails
partway. Scenarios make a write fail with `whileFailing`, a trigger in the database, so a new route's
different SQL fails at the same point. A failure that leaves money for staff to sort out by hand stays out
of `scenarios`, because the invariant can't hold until they have.

`w05f.test.ts` does the same for the last refund fixes: a move's refund failing outright, order statuses
after a failed cancel, a store credit refund on a live booking, Remove Guest and Cancel & return credit, and
the refusals while a reader move is open and on a cancelled booking.

`w05g.test.ts` does the same for the Part refund and Refund the rest buttons: the limits and refusals on
each, `bookings.refund_owed_amount`, and what Move, Add Guest, Remove Guest and Cancel & Refund do with
money owed. The invariant in `w05d.test.ts` also holds that what is owed is never negative, never more than
is on the booking, and with the money back never more than was paid.

`w05h.test.ts` does the same for It already arrived, the audit row on Refund the rest, money going back
exactly after a claim, and what an open reader payment refuses. `refund-races.test.ts` proves on real
Postgres that two refunds at once can't overpay, and that a reader opened between check and act is
caught. A claim compares `price_paid` as well as checking for a reader, because a statement that waited
for a row sees other tables as they were when it started: that file has a control showing `NOT EXISTS`
alone letting one through. Scenarios use `losingTheAnswer` for a write that works and whose answer is lost.

`FakeStripe.addSubscription` seeds a subscription that already exists. A reader tap that saves a card
is `completeReaderPayment(id, { generatedCard })`, which a membership on the reader needs to finalise.

The new side (W06 on): `order-side.ts` sends createOrder's params to `POST /api/v1/staff/orders` and
gives its answer back in createOrder's shape, as the staff app's wrapper will at W14.
`order-replay.test.ts` runs every scenario in `W06_SCENARIOS` (`order-differences.ts`) through it and
compares the recording with the golden file, passing each `AllowedDifference` with the decision that
allows it (the idempotency row, and the audit rows of a placed order). An allowance that stops being
needed fails, so stale ones can't pile up. T1 sets created_at itself, a millisecond apart, so its rows
don't tie though its statements don't tick the clock. `NOT_BUILT_SCENARIOS` holds one single-order
scenario for each part the route answers NOT_BUILT for; the slice that builds a part moves its
scenarios into the replay list.

W07 adds `W07_SCENARIOS` (products, the delivery address and postage, session passes, gift cards
bought), and `ORDER_SCENARIOS` is every slice's list. Its named differences are in `W07_DIFFERENCES`, each
with its decision: Q4 (a shipped gift card earns free postage), Q5 (a buy-new order keeps its address
and requests), the address saved inside T1 and, from W07a, Q33 (a pass or gift card dated on a day the
end month doesn't have ends on that month's last day; its scenario moves the clock to 29 Feb 2028). Where a decision changes the figure staff confirm,
`NEW_SIDE_CONFIRMS` sends the new side the figure its screen would show. Gift card codes are labelled
by the comparator, so a recording never shows one; `place-order.test.ts` holds the new codes to the
format.

W08 adds `W08_SCENARIOS` (events), with no named difference: every event scenario matches the old
createOrder exactly, rows and row order included. An event beside a membership bought in the same
basket stays in `NOT_BUILT_SCENARIOS` until W13.

`quote-shadow.test.ts` also runs the dry run beside the quote: every scenario's dry-run rows must
match what the old order wrote, except the differences in `DRY_RUN_DIFFERENCES` (quote-differences.ts),
every single order in `ORDER_SCENARIOS` must have its row, and every other single order must have none
(it is NOT_BUILT). A new single-order scenario the route can take
must go in the list, or that check fails. The order rule's own transaction tests are in
`server/rules/orders/place-order.test.ts` (PGlite) and `place-order-postgres.test.ts` (real Postgres:
the races and the lock order).

W10 adds `W10_SCENARIOS` (the saved card): every single-order card scenario W06 to W09 left as NOT_BUILT,
then W10's own (`w10-*`), every kind on the card alone and with a gift card, store credit and a promo,
declined, needing authentication, with no saved card, and an unclear answer. The Stripe calls match the
old ones apart from the key and `metadata.order_id`; a paid card order keeps its pending record; a
refused one leaves its `order.create` and `order.undo` audit rows. `w10-unclear-answer` is in
`OUTCOME_DIFFERS`: createOrder rolled a 500 back as a decline, the Worker holds the order (its own test
says what it leaves). The route reaches each run's own `FakeStripe` through `replay/stripe-binding.ts`
(a test file mocks `@/server/stripe/client` with `stripeClientMock`); the new side sends the quote's
card figure as confirmed, as the screen will from W14, and each fake charge moves the stopped clock a
second (`chargesTakeASecond`), so T2's rows come after T1's as they do live. The pipeline's own tests,
including crash tests at every step, are in `server/rules/orders/saved-card.test.ts`, and the races (T2
against the undo, Q10's guard with two orders at once, the undo's lock order) in
`saved-card-postgres.test.ts`.

To re-record after a deliberate change:

    UPDATE_GOLDEN=1 npm run test:unit -- server/rules/testing/replay

Read the diff of `golden/` before keeping it: a re-record accepts whatever the code now does.

## No real Stripe (W11)

`no-real-stripe.ts` is loaded before every unit test file (`vitest.unit.config.ts`, `setupFiles`). Any
request to a Stripe host, through fetch (the SDK's fetch client) or Node's http and https `request` and
`get` (its default client), however they are imported (default, named or namespace: W11a calls
`syncBuiltinESMExports()` after patching), is refused before it is sent, and the test that made it fails
once it ends with "a test reached real Stripe", naming what was tried, even if the code under test
swallowed the error. A library with its own HTTP stack (undici's own fetch) isn't covered; nothing imports
one. Tests use FakeStripe.
`no-real-stripe.test.ts` proves it, including in a separate vitest run of `no-real-stripe.fixture.test.ts`
(skipped in every other run).

The reader's replay (W11) drives createOrder, then `finaliseReaderOrder` or `cancelReaderOrder`, on both
sides; the new side calls the finalise and cancel routes (`order-side.ts`). A cancelled order's id is a
`gone#N` label on both sides, renumbered where it is first met (`withCanonicalGoneNumbers`), because the
Worker keeps audit and idempotency rows that name it.

## W12

`replay/flow-replay.test.ts` runs every recorded scenario that finishes or cancels a reader flow (37), plus W12's own
(`w12-*`: a Core pass seat moved into Peak, store credit on Move and Settle, add-on credit on Add Guest, each finalised
and cancelled), with the flow's start and everything else through the old functions and only its finalise and cancel
through the new routes (`replay/flow-side.ts`). The flow's record is given what step D's Worker start will write
(`asWorkerFlow`), the one named difference with the new routes' audit and idempotency rows. A store credit note's random
`[ref …]` is unnumbered on both sides before comparing.

Migration 022 (one PaymentIntent, one order) is in `live-schema.sql`: tests that run many FakeStripes against one
database give each its own `idTag`, or their `pi_fake_0001`s would collide. Reconcile's tests are
`orders/reconcile.test.ts` (each row, crash tests, the refunds, the routes) and `orders/reconcile-postgres.test.ts`
(the races, 022). `server/scheduled.test.ts` tests the schedule's handler.
