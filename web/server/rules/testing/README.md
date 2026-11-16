# server/rules/testing

## Which database a test uses

| Set-up | What it is | Use it for | Used by |
|---|---|---|---|
| `startTestDatabase()` | PGlite, `schema.sql`: the tables the read rules use, no foreign keys or triggers | Read rules, where fixtures set ids directly | The step B rule and route suites |
| `startTestDatabase({ schema: 'live' })` | PGlite, `live-schema.sql`: everything in the live catalog | Anything that writes | Replay, `live-schema.test.ts` |
| `reader-orders-schema.sql` | PGlite, a hand copy from W03a | Nothing since W16 (`reader-rollback.test.ts` went with the old reader order code) | Delete (left for Wayne's yes) |
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

`quote-shadow.test.ts` ran every scenario through the old `createOrder` with its shadow switched on and
compared the quote and the dry run with what the order wrote. W16 removed it with the shadow, the dry run
and `quote-differences.ts`; the golden files it compared against stay, and `order-replay.test.ts` holds the
order route to them.

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

Until W16, `quote-shadow.test.ts` also ran the dry run beside the quote. The order rule's own transaction tests are in
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

### Step D's side (W17)

The old functions run from two frozen test-only copies: `legacy-order/` (W16, the old order code) and
`legacy-booking/` (W17, the twelve old step D functions and every module they import, byte for byte, hashed in its
`manifest.json`). `harness.ts`'s `oldFunctionPath` picks the file: the booking copy for anything it holds, the order
copy for the three old order actions, else the staff app's checkout. `frozen-booking-code.test.ts` keeps the copy as
frozen and out of reach of app code. `replay/booking-side.ts` is step D's new side, as `order-side.ts` is step C's: each
slice moves one old action to the Worker (`BUILT_BOOKING_ACTIONS`; W17: the refund figures), and every other call,
setup included, still runs through the frozen copy. `booking-replay.test.ts` replays every scenario that way and reads
each end state both ways (figures, the open-payment guard, an order's status after refunds). The `w17-*` scenarios are
the golden gaps recorded from the old functions (L6): the W05 review 3 proofs R1a to R4b and the D-plan's N1, N3, N4,
with today's outcomes. A scenario step the old function answers by throwing uses `attempt`, which records
`{ thrown: <words> }`.

W18 moves special requests and status, through the staff app's own thin wrappers (`throughStaffApp`), which call the
real routes through the old side's `paddockWorkerV1` stand-in (`legacy-routes.ts`'s `STAFF_PATTERNS`), so the replay
holds wrapper and route together. Their only named differences are N3's, on W17's three `w17-n3-*` recordings
(`N3_DIFFERENCES`). The W05 invariant sweep is in `replay/invariants.ts` (moved out of `w05d.test.ts` unchanged), so
the new side runs it too: the two breaches the old code records in N3 are gone on the new side. App code may import
nothing under this folder (`frozen-booking-code.test.ts`, W18).

W19 moves Settle (with the figures the dialog sends, `withSettleFigures`, and the switch on, `BOOKING_KINDS_ON`) and the
reader flows' finalise and cancel, all through the staff app's wrappers; the flow wrappers send a Worker flow to the
Worker and an old one (old Move and Add Guest) to their old body. Every scenario that calls Settle, W12's two reader
Settle recordings included, matches with `SETTLE_DIFFERENCES` only: the flow's keys and metadata, its record, the audit
rows (the rows the Worker doesn't replace are checked to be the golden file's, in order), the stored answer, the card
order's `payment_method`, and per scenario the outcomes the old code's faults no longer reach (R1a, R1a's control,
R2c, the lost answers, one press of two, the held C2 fault). `dyingAfter` knows that Settle's charge is now inside the
settle route (`WORKER_DOES_IT_NOW`). Store credit notes' random `[ref ...]` labels are compared unnumbered.

W20 moves Add Guest, as the dialog presses it (`addGuestAsTheDialogPresses`: the figures from the Worker's own quote,
`withAddGuestFigures`, and a press key kept after no answer). 140 scenarios call it: 36 match their golden files
exactly, and 104 differ only as `ADD_GUEST_DIFFERENCES` names. W19 review later 4 tightened the comparison
(`comparable` in `booking-side.ts`): the swapped audit rows (each side's own, by flow), the stored answers and the
Worker's card flow records are set aside and each checked exactly on its own (`newAuditRowProblems`,
`storedAnswerProblems`, `cardRecordProblems`); flow labels are renumbered without the card records; an allowance can
check the new value as well as the path (`AllowedDifference.actual`), so the keys, the reader record's marks, the card
order's method, the seat line (W05c N5) and Settle's settled booking fields pass only with the values their decisions
give. When a Retool function dies after the Add Guest route ran, the route's answer is what is lost
(`WORKER_DOES_IT_NOW`, `chargeLandingLate`, `losingTheAnswerOnTheWorkerToo`). The new side's clock moves 1 ms before
each Worker call, as the old side's does per statement.

W21 moves refundBooking's amount paths (Part refund, Refund the rest, It already arrived) and the refund figures, through
the staff app's wrappers (`refundAsTheDialogPresses`: a press key kept after no answer; the wrapper's new `failed` answer
read as the throw the old function gave, which is what the dialog shows). Cancel & Refund calls (no amount) still go to
the old function (`PARTLY_BUILT`). A refund the Worker holds is settled as reconcile does it (`reconcileClaimNow`, which
never sends) straight after the press and again before the booking's next step (`settleHeldRefund`), as staff would find
it on the Orders page. The swapped audit rows include the refunds' (the old claims, finishes, notes and action rows of
Part refund and Refund the rest; the Worker's, checked by `newAuditRowProblems`); reconcile's `refunds.list` looks for a
held claim are set aside and checked by `claimLookProblems`. 114 scenarios call them: 93 with `REFUND_DIFFERENCES`, 21
exact. The W05 invariants on the new side break nothing the old code doesn't.

W22 moves Remove Guest and Remove add-on, through the staff app's wrappers as the dialogs press them
(`removeGuestAsTheDialogPresses`, `removeAddonAsTheDialogPresses`: the add-on's confirmed refund from the Worker's own
quote, as the dialog asks for it on open; a press key kept after no answer). A call naming a guest or an add-on line is
matched to its booking (`bookingOf`) so a held refund is settled before the next step. 31 scenarios call them: the
Worker's claims and rows are set aside and checked (`newAuditRowProblems`); `REMOVE_DIFFERENCES` names the rest (keys
from the claim, the held store-credit failure and its reconcile, the old store credit statement's lost answer).

W22a (Wayne's decision, 13 Nov: Remove Guest follows the 24-hour rule) adds two recordings from the old code,
`w22a-remove-guest-a-minute-outside-24-hours` and `...-inside-24-hours`, each pressing with the figure its own quote
showed. `REMOVE_GUEST_24_HOURS_DIFFERENCES` names the rule: inside, the old £20 card refund becomes £0 with the guest
still removed (`REMOVE_GUEST_INSIDE_24_HOURS`, each value checked); on every other Remove Guest recording the quote only
gains `insideTwentyFourHours: false` (`GUEST_QUOTE_OUTSIDE_24_HOURS`).

W23 moves refundBooking's Cancel & Refund and cancelCreditBooking, through the staff app's wrappers as the dialogs press
them (the Worker's quote for the ticked add-ons first, then the press with the quote's figures as confirmed; a press key
kept after no answer). No action is partly built any more. The old Cancel & Refund claims (kind `cancel`) are set aside on
the golden side, and the Worker's `booking.cancel` / `booking.cancel_credit` rows checked by `newAuditRowProblems` (which
also refuses two card parts for one order). `CANCEL_DIFFERENCES` names the rest: keys from the claim; one card part per
order (`ONE_PART_PER_ORDER`, item 1); R1 in one transaction where the old cancel's write failed after the money
(`cancelWriteFails`), N4's two recordings, the lost answers (`CANCEL_ANSWER_LOST`, `CANCEL_NO_LOST_ANSWER`), and an
order's status worked out after its credit add-on's stamp. `unsure-cancel-store-credit-arrived`'s last two steps are
`attempt`s (the old side records them as before).

W23a (Wayne, 13 Nov: when the club cancels from Block Session or Block Day, the 24-hour rule doesn't apply) adds two
recordings from the old code, `w23a-block-session-cancel-and-refund-inside-24-hours` and
`w23a-block-day-cancel-credit-inside-24-hours`: 22 hours before the session, the press from the booking page (refused on
both sides, matching), then the block's press with `clubCancelled: true`, which the old code refused and the Worker
answers with everything back. `CLUB_CANCEL_AND_REFUND` and `CLUB_CANCEL_CREDIT` name exactly that, each value checked;
`newAuditRowProblems` accepts `clubCancelled` on a cancel's claim and row only as `true`.

W24 moves Move, through the staff app's wrapper as the dialog presses it (`moveAsTheDialogPresses`: the Worker's quote
for "Check Price Difference", kept per booking as the dialog keeps it on screen, then the press with those figures
(`figures.amountDue`, signed; `toCollect` the cash tick's own figure for cash) and a press key kept after no answer).
Move's flows and claims join the swapped rows (`WORKER_FLOWS`, `REFUND_KINDS_ON_WORKER`, `booking.move`); `MOVE_DIFFERENCES`
names the rest: the flow and claim keys, the reader record's marks, the card order's method, the quote's card choice
(Q37), the first card refusal putting the move back, a store credit write failing in R1 (one transaction), the holds
when R2's store credit or C2's gift card row fails, the lost answers, the W17 gaps R1b, R1d, R3, R4b, and N1. Every value
these allowances let through is checked. W05g's and W05h's money-owed setups (a cheaper move whose store credit failed,
or couldn't be told) can't be made through the Worker, where a move is one transaction, so those steps run on the old
side (`onTheOldSide` in `scenarios.ts`): their old rows are set aside on both sides alike, and everything after them
runs on the Worker. Two recordings from the old code (`w24-q34-*`, written with `UPDATE_GOLDEN=1 -t w24-q34`) show Q34:
the old code kept a credit past the membership's last day and a pass seat past the pass's expiry.

W24a (W24 review): no new allowance. Four checks are tighter, each proved by a plant that passes without it
(`briefs/W24a-logs/plants/` in the staff app repo). `ONE_PART_PER_ORDER`'s "refund gone" branch also needs the
refunds on that PaymentIntent to add up the same on both sides (L2: the add-on's money dropped from a merged part).
`MOVE_QUOTE_REFUND_CHOICE` also needs `card + storeCredit` to equal the refund, to the penny (L3). The R1c allowance
checks the whole change to `customers` and `gift_cards` (one changed balance, nothing added or removed), where only
`changed` was looked at. `flowRowProblems` holds each finalise or cancel row to its own flow's record: `collected` is
the record's expected amount on its PaymentIntent, a cancel's snapshot is the record's (any amount above £0 passed
before). A gift card part written without the card being lowered shows no difference from the R1c golden file (which
has no gift card change either); the test beside it ("R1c: the guest added once...") catches that. The tests of the staff
app's deleted `shared/cashConfirmation.ts` and `shared/bookingRefund.ts` are gone from `server/staff-app-helpers.test.ts`
(31 tests); the frozen copy keeps both files for the replay.

### Step E's side (W27)

`legacy-refund/` is a third frozen test-only copy (its README): the staff app's five old step E functions
(`refundOrder`, `cancelEventPlaces`, `cancelEvent`, `getEventCancellationQuote`, `getEventCancellationOverview`) and
every module they import, byte for byte at staff app `941276f`, hashed in its `manifest.json`, with one stand-in for
the staff app's typecheck barrel. It also holds the three modules the order copy used to take from the staff app's
checkout through the `@retool-app` alias (`cancelMembershipSubscription`, `promoCodes`, `stockAdjustments`); the
order copy imports them from there now, so it keeps working when steps E and G delete them. `oldFunctionPath` loads
the five actions from it. `frozen-refund-code.test.ts` keeps it as frozen and out of reach of app code.

The `w27-*` scenarios (137, `w27Scenarios()` in `scenarios.ts`) are step E's golden files, recorded from the old
functions while they exist (E-plan 4.13 item 1): every refusal of `refundOrder`, the place cancel and the whole-event
cancel; each kind of line (product with and without restock, postage, standalone add-on, gift card, pass, membership,
the payment date change charge); card, store credit and a split; a promo line; a second refund on one order; one
place, several, the last, a whole booking; the cut-off with and without a reason and with none set; a whole event
with a failing booking and its retry; the W05j and W05k lost-answer cases; and today's outcome for the plan's bugs E2
to E5 and E7 to E10 (`w27-e2-…` and so on). `replay.test.ts` holds each to its file as it does every scenario.
`w27.test.ts` says in pounds and pence what each one proves (read from the golden file), that the list covers every
reason, every kind of line and every bug named, and that a deliberate difference is caught and an allowance nobody
needs fails. `w27-contracts.test.ts` runs them all once more and holds `contracts/refunds.ts` and
`contracts/events.ts` to what the old functions take and give. What can't be recorded, and the W27 report says why:
E6 (Retool's 60 seconds); E11 (the dialog losing an answer: the function's own answer is a plain success); an event
cancel's second `order_not_found` and two of `refundOrder`'s three `store_credit_failed` texts (each needs a row the
foreign keys forbid, or an amount of £0 that the function has already ruled out).

W28 adds the first new side: `order-refund-side.ts` sends `refundOrder` to the staff app's thin wrapper and the
Worker's route, as the dialog presses it (the Worker's figures loaded first and their total sent back as `confirmed`;
a press key kept after no answer, with the total the dialog is still showing), and settles a held claim as reconcile
would before the order's next step. `order-refund-replay.test.ts` runs the order refund scenarios
(`w27-order-refund-*`, E2 to E5) through it and holds each to its golden file with the named differences in
`order-refund-differences.ts` only (W28: the 57 that aren't a membership's). The
old code's notes (`card_refund_held`, `order.card_refund_refused`) and the Worker's claim and action rows are set
aside and checked on their own (`orderRefundRowProblems`). W29 moves the 10 membership scenarios
(`MEMBERSHIP_SCENARIOS`) in, so all 67 replay: 19 match exactly, 19 differ only in the key, 29 have their own (E3,
E4 and E10 among them, tied to Wayne's Q40 and Q41 and E-plan 4.3). The E3 recording's order was placed by the old
createOrder, which never recorded the membership's own payment, so it shows the robe going back to the robe's payment
and the membership's Card refund refused; `orders/membership-refund.test.ts` shows Q40 whole, on orders the Worker
placed. The same file checks the W05 invariants on the new side, that a
deliberate difference is caught, and that an allowance nobody needs fails. The E5 recordings model a used pass by
lowering its sessions by hand, with no booking that names it, so they can't show E5: `orders/refund-lines.test.ts`
does, with real bookings.

W30 adds the event places' side: `event-places-side.ts` sends `cancelEventPlaces` and `getEventCancellationQuote` to
the staff app's thin wrappers and the Worker's routes, as the dialog presses them (the quote's value sent back as
`confirmed.refund`, £0 for No refund; where a scenario asks for the quote and then presses for the same places, that
is the figure the dialog is showing, which is how E9's recording is replayed; a press key kept after no answer), and
settles a held claim as reconcile would. `event-places-replay.test.ts` runs the 58 event place scenarios
(`w27-event-cancel-*`, E8, E9, `p3`, `p5`) through it: 18 match exactly, 11 differ only in the key, 29 have their own,
each pinned to its exact value in `event-places-differences.ts`. That file's table is written by
`briefs/W30-logs/generate-event-differences.py` in the staff app repo from a dump of the raw differences
(`W30_DIFFERENCES_OUT=<file>` on the replay test); the names and decisions are written by hand in the script. The
whole-event scenarios (`w27-event-whole-cancel-*`, E7) are W31's. Scenarios whose recording hooks a gap on the old
code's own statements (a line taken away, a place checked in, a second press, between its quote and its recording)
run without the gap here, because the Worker's quote and cancel are one transaction: each is a named difference, and
the real races are on real Postgres (`events/cancel-places-postgres.test.ts`).

W31 adds the whole event's side: `whole-event-side.ts` sends `cancelEvent` and `getEventCancellationOverview` to the
staff app's thin wrappers and the Worker's routes, and drives `cancelEvent` as the Cancel event dialog presses it: the
event's own cancel, then each booking in turn through the thin `cancelEventPlaces` with `wholeEvent`, its own key and
the overview's figure as the confirmed refund, with the answer put back in the old `{ ok, results }` shape (each row
as the dialog lists it; a press that got no answer keeps its key for the scenario's next `cancelEvent`).
`whole-event-replay.test.ts` runs the 14 whole-event scenarios (`w27-event-whole-cancel-*`, E7) through it: 6 match
exactly, 5 differ only in the key, 3 have their own (no permission as data; E6's lost answer; E7), each pinned by hand
in `whole-event-differences.ts` (`W31_DIFFERENCES_OUT=<file>` dumps the raw differences). E7's recording hooks its gap
on the old code's own statement, which the Worker never runs, so on the new side the scenario starts the reader order
straight after the cancel, where it would land; the real races are `events/cancel-event-postgres.test.ts`.

W30 and W31 have each added theirs for the event cancellations.

### Step F's side (W36)

`legacy-account/` is a fourth frozen test-only copy (its README): the staff app's sixteen old step F functions
(the membership cancel, payment date change and its quote, credit and Herd adjustments, the Subscriptions list,
creating, listing and reading a customer, the store credit adjustment, and the five gift card functions) and every
module they import, byte for byte at staff app `cec4ef1`, and the three legacy membership routes they call
(`/api/memberships/cancel`, `/undo-cancel`, `/change-payment-date`, with the cancel's date sum), copied from `app/`
at Worker `982db8f` while they are still live there (they stay until W44). `oldFunctionPath` loads the sixteen from it,
`legacy-routes.ts` binds the three routes to it, and `frozen-account-code.test.ts` keeps it as frozen and out of reach
of app code. Two import lines in the route copy are repointed so it stands alone (its README).

The `w36-*` scenarios (137, `w36Scenarios()` at the end of `scenarios.ts`) are step F's golden files, recorded from the
old code while it exists (F-plan 4.12 item 1): every refusal and each success of the cancel and undo (inside and after
the minimum term, yearly, with no subscription, Stripe refusing, the write failing, an answer lost); the payment date
change (every refusal of the quote in the old order, the window, the six-month rule and its override, each check the
legacy route makes against Stripe, a decline, the date move refused with its refund); credits up and down on both
kinds; Herd on, off and cleared; store credit added, removed and overdrawn; a gift card extended while active, just
expired, long expired and voided, picked up and shipped both ways; a customer created, a duplicate, under 18; each
read's shape; the database's own lapse sweep (`runLapseSweep`: the function the hourly job calls, run as the table
owner); and today's outcome for the plan's bugs FB1 to FB16, FB18, FB19 and FB21 (`w36-fb1-…` and so on).
`replay.test.ts` holds each to its file as it does every scenario. `w36.test.ts` says in pounds and pence what each
one proves (`w36-what-each-proves.ts`, written from the golden files with `W36_OUTCOMES_OUT=<file>` and read through),
that the list covers every reason and every bug named, and that a deliberate difference is caught and an allowance
nobody needs fails. `w36-contracts.test.ts` runs them all once more and holds `contracts/account.ts` to what the old
functions take and give. The sweep in `w05d.test.ts` lists the seven lines six of them break on purpose
(`W36_KNOWN_FAULTS`: a payment date charge that is on no order).

What can't be recorded, and the W36 report says why: FB17 and Q19 (the saved card is already the Worker's own code,
so there is no old function: `server/rules/payments/terminal-today.test.ts` holds what it does today); FB20 (the
legacy routes take the shared key alone: the functions always check the staff member first); the words between Retool
and the Worker ("returned an HTML page", "did not report success"); and the refusals the functions can't reach
("Could not work out the part-month charge.", the route's own checks of the membership row, a payment that "did not
complete", store credit's "The adjustment was refused.").

Keep to one new `gift_card_redemptions` row in a scenario. That table has no `created_at` (its time column is
`redeemed_at`), so a recording reads its new rows by primary key alone, a random id: two in one scenario come out in
either order, and the scenario then fails now and then (W36's `w36-gift-card-redemptions` did, once, before it was cut
to one). `compare.ts`'s `TABLES` shows which column each table is read by.

Three scenario helpers are new: `onceAfter` (another tab's work between two of a function's statements), FB1's
`workerDyingAfterTheCharge` (the legacy route stops dead once the card is charged: nothing after it reaches Stripe and
the function gets no answer), and `FakeStripe.setSubscription` (a subscription as Stripe might already hold it, with no
call recorded). The fake models `subscriptions.update` for exactly what the membership actions send: `cancel_at` (set,
or `''` to clear), `trial_end` with `proration_behavior: 'none'`, and `default_payment_method`; a cancelled
subscription refuses any of them.

### Migration 023 and the saved schema (W27)

`supabase/migrations/023_orders_refund_owed_and_cash_refunds.sql` is written but **not applied to live**: the lead
applies it after W27's review, before W28. `live-catalog.json` and `live-schema.sql` already have its four changes
(`orders.refund_owed_amount` and its check, `cash` on the two refund-method checks, the partial index
`audit_log_refund_claims_idx`), each added by hand exactly as Postgres 17.6 prints it, so `npm run schema:test --
--check` passes and every test runs against the schema live will have. `migration-023.test.ts` holds the two to each
other on real Postgres: the saved schema with 023 taken out and applied again must be the saved schema.

**After the lead applies 023:** refresh as above ("Refreshing the live schema": run `live-catalog-query.sql` against
live, then `npm run schema:test -- --from <that file>`). `git diff server/rules/testing/live-catalog.json
server/rules/testing/live-schema.sql` should then show **nothing**. Any line it does show is a difference between
what W27 expected and what live has: stop and look before W28.

The new column is in every recording: each new `orders` row in a golden file gained `"refund_owed_amount": "0.00"`
(519 files, 676 rows, nothing else: `briefs/W27-logs/golden-column.txt` in the staff app repo).

W33's migration 024 changes what the database's `event_cancellation_quote` answers for an event with no cut-off
(Q43). The old functions were recorded against the function as it was, so `startReplay` keeps that under another name
(`event_cancellation_quote_before_024`, built from the saved schema with 024's one line put back) and `oldSide`'s
`paddockData` points the old functions' SQL at it. Worker code always reads the real function. Without this,
`w27-e8-event-with-no-cut-off-counts-as-after-it` no longer matches its golden file (seen in W33's first full run).

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
(the races, 022). `server/scheduled.test.ts` tests the schedule's handler. W14b: the manual close in
`orders/close-stuck.test.ts` (per item type, refusals, words, L4) and `orders/close-stuck-postgres.test.ts` (racing
reconcile, two closes at once); the staff app's Orders page wrappers in `server/staff-app-orders-page.test.ts`.
