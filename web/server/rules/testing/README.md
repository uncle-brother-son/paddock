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
reports the second as blocked by it, so the test can't pass by luck of timing. Add a control that
shows the unguarded version going wrong, or a passing test proves nothing.

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

To add the new side at W06, write a `ReplaySide` whose `call` runs the route, then compare its
recording with the golden file, passing each `AllowedDifference` with the decision that allows it.
An allowance that stops being needed fails, so stale ones can't pile up. The new side's database
calls must also tick the clock, or every row in it will look tied.

To re-record after a deliberate change:

    UPDATE_GOLDEN=1 npm run test:unit -- server/rules/testing/replay

Read the diff of `golden/` before keeping it: a re-record accepts whatever the code now does.
