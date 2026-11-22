# server/rules/testing

Test code only: nothing under `app/` or `server/` outside the tests may import from here.

## Which database a test uses

| Set-up | What it is | Use it for |
|---|---|---|
| `startTestDatabase()` (`database.ts`) | PGlite, `schema.sql`: the tables the read rules use, no foreign keys or triggers | Read rules, where fixtures set ids directly |
| `startTestDatabase({ schema: 'live' })` | PGlite, `live-schema.sql`: everything in the live catalog, the Worker's role included | Anything that writes; the sweep |
| `startRealPostgres()` (`real-postgres.ts`) | Real Postgres 17.6, `live-schema.sql` | Anything about one connection waiting on another: `two-connections.test.ts` and every `*-postgres.test.ts` |

PGlite is one session, so it can't show one connection waiting on another's lock. It is also Postgres 18, where live
is 17. Never `Promise.all` two presses on PGlite: they run one after the other on its one session.

## Real Postgres

`real-postgres.ts` starts the `embedded-postgres` dev package's server on a free port, from a new temp folder, and
`stop()` removes the folder. It takes about a second and needs nothing installed on the Mac. Each `connect()` is a new
Worker client, so two of them are two requests.

Keep the version in `package.json` on the one live runs. `two-connections.test.ts` fails if they differ.

For a lock test, use `makeRace` from `race.ts` (or `admin-race.ts` for a step G press): it holds the first transaction
open until Postgres reports the second as blocked by it, so the test can't pass by luck of timing. When the test's name
says which lock the second waits on, pass the table as `waitsOn` (checked in `pg_locks` with `waitingOn`): an earlier
lock in `LOCK_ORDER` can queue the second first and hide a missing one. Add a control that shows the unguarded version
going wrong, or a passing test proves nothing.

## Refreshing the live schema

`live-schema.sql` and `live-catalog.json` are generated. Never edit them. After a migration:

1. Run `live-catalog-query.sql` against the live database (Supabase SQL editor or the Supabase MCP `execute_sql`) and
   save the answer to a file. It reads the catalog only, no table's rows.
2. `npm run schema:test -- --from <that file>` updates `live-catalog.json` and `live-schema.sql`.
3. Look at the diff, then run the tests.

`npm run schema:test -- --check` only checks (without `--check` it rewrites the files). `live-schema.test.ts` fails if
the two files disagree. It can't tell if the snapshot is behind the live database, so step 1 belongs in every brief
that has a migration. A migration's own test (`migration-0NN.test.ts`) holds it on real Postgres: the saved schema with
its Down applied, then the file applied, is the saved schema again, and any stop it has is proved.

## Recorded Retool values

`retool-driver-*-values.json` are what the real Retool resource gave, and `server/rules/driver-parity.test.ts` holds
the Worker's driver to them. Each difference is listed in that test.

## No real Stripe

`no-real-stripe.ts` is loaded before every unit test file (`vitest.unit.config.ts`, `setupFiles`). Any request to a
Stripe host, through fetch or Node's http and https `request` and `get` (however they are imported), is refused before
it is sent, and the test that made it fails once it ends with "a test reached real Stripe", naming what was tried, even
if the code under test swallowed the error. Tests use `FakeStripe` (`server/stripe/fake.ts`). `no-real-stripe.test.ts`
proves it, including in a separate vitest run of `no-real-stripe.fixture.test.ts` (skipped in every other run).

`FakeStripe` behaves as Stripe does where a rule depends on it: it refuses to confirm or capture a cancelled
PaymentIntent, keeps idempotency keys (`forgetIdempotencyKeys()` for a key older than Stripe keeps them), and fails the
next call of a kind with `failNext(method, ...)`. `addSubscription` seeds a subscription that already exists; a reader
tap that saves a card is `completeReaderPayment(id, { generatedCard })`. Tests that run many fakes against one database
give each its own `idTag`, or their `pi_fake_0001`s would collide (migration 022: one PaymentIntent, one order).

`quiet-pglite-timer.ts` drops PGlite's one "TimeoutOverflowWarning" (its alarm armed against a clock the tests moved);
every other warning still prints. Proof: `quiet-pglite-timer.test.ts`.

## Helpers for a route test

- `routes.ts`: step B's read routes by path. `admin-routes.ts`: how a step G test presses a real route (the shared key,
  the signed-in email, a press key, the path's parameters). Importing either needs `@/server/db/connection` mocked.
- `webhook.ts`: Stripe's webhook on a test database (the Supabase client's `rpc` and `from`, on the test's own
  Postgres), so a test hands a real event to the real handlers.
- `staff-app-dir.ts`: finds the staff app's checkout (`RETOOL_APP_DIR`, or beside this repo). A missing folder fails
  the suite: skipping would leave a green run that proved nothing.

## The all-Worker sweep (`sweep/`)

Every scenario runs from the same seed on the Worker alone, as each screen presses it, and is compared with its own
recording. Since W65 this is the only replay.

- `replay/scenarios.ts`: the seed (`seed`, `ID`) and most scenarios, in families by name (`p1-…`, `w17-…`, `w27-…`).
  `replay/w48-scenarios.ts`: step G's (`w48-…`). `sweep/flow-presses.ts`: W12's reader flows (`w12-…`). A scenario is
  `{ name, seed, run }`; `run` gets `call` (keeps the answer in the recording; a throw fails the scenario) and `attempt`
  (keeps a throw as `{ thrown: <its words> }`, which is what staff were shown, and carries on).
- `sweep/run.ts`: runs one scenario and records it. The clock is fixed (`REPLAY_NOW`, a Tuesday in winter) and PGlite's
  `now()` follows it, so a recording is exactly repeatable. Start the database before faking the clock: Postgres's
  start-up hangs on a clock that doesn't move. Every table is read by `created_at` (or `at`; gift card redemptions by
  `redeemed_at`), then its key.
- `sweep/worker.ts`, `workerSide()`: every action a scenario or a rule test calls goes to the Worker as its screen
  presses it, through the staff app's own thin wrappers and the Worker's routes (`sweep/staff-routes.ts` binds
  `paddockWorkerV1` to them), reusing each family's press (`sweep/*-presses.ts`: a press key kept after no answer, the
  figures the dialog showed sent back as confirmed, a refund the Worker held settled as reconcile settles it). Every
  press sees the live `ORDER_SWITCH` (`LIVE_KINDS_ON`). The clock moves 50 ms (`PRESS_STEP_MS`) before each press and
  after New Order. The two old Retool resources (`paddockData`, `paddockBackendApi2`) are stand-ins that refuse, so a
  staff app file that still reached one fails loudly.
- `replay/compare.ts`: labels generated ids (`orders#1`, `gone#N` for a row that went), shows timestamps as set or
  unset, compares money to the penny and checks row order; `tied` counts rows sharing a `created_at`. Keep `tied` at 0
  where you can (move the clock): tied rows read in their random ids' order.
- `sweep/sweep.ts` and `sweep/sweep-*.test.ts`: the sweep, split into files by family (`SWEEP_FILES`, by name) so no
  file nears its time limit. On each scenario: the W05 invariants (`replay/invariants.ts`: no booking gets back more than
  was paid, `price_paid` is paid less given back, what is owed is never negative or more than that, Stripe's refunds
  are on the rows, every gift card lost what its redemptions say, every PaymentIntent that took money is on exactly one
  order; exceptions in `WORKER_EXCEPTIONS`, by name, with the reason), G-plan 4.9 item 5's (`sweep/g-invariants.ts`; the staff one read around each staff press), the stamps'
  form, then a comparison with `recordings/<name>.json`. A breach is allowed only as `sweep/named-breaches.ts` names
  it, exactly, with why: a new breach fails, and so does one that stops happening. Request hashes, stamps'
  fingerprints, a set stamp's order and a gift card code no row labels are kept in place but not in value
  (`steadied`).
- `sweep/press-forms.ts`: the forms a scenario is pressed in (told again, attempted, refused reads or presses as
  answers, Q4's confirmed figure, the same press sent twice under one key).
- `sweep/old-states.ts`: SQL fixtures for states only code that is gone could make (an order or a flow with no mark of
  the Worker's, an old Add Guest's guest, an old membership order), for the rule tests that still meet them live.
- `sweep/coverage.test.ts`: every scenario is in exactly one sweep file or dropped, every recording is a swept
  scenario's, and every name the press forms and named breaches give is a scenario's.

### Fault hooks (`replay/scenarios.ts`)

- `whileFailing(db, { table, event, when }, steps)`: a write the database refuses (a trigger), so the route fails at
  the same point whatever its SQL.
- `losingTheWorkersAnswer(path, steps)`: the route runs to the end and its answer is lost on the way back.
  `losingTheAnswerOnTheWorkerToo` and `chargeLandingLate` do the same for Add Guest.
- `dyingAfter(path, steps)`: the function stops dead once the route answered (nothing after it runs), then the clock
  moves past a press's longest run.
- `afterTheCharge`, `afterTheRefund` (`gap` runs once the first press's route answered) and `beforeTheStartedRow`
  (`gap` runs before the first press's request is sent, then it is sent with what the first press read): two presses
  that overlap. Each throws if the second press never ran.
- `path` is one of the step names in `WORKER_DOES_IT_NOW` (`CHARGE_PATH`, `REFUND_PATH`, the membership ones), each
  with the Worker routes that make it.

### Recordings

`recordings/` holds one file per swept scenario, recorded from the Worker (W64, checked then against what the old code
recorded). A difference fails the scenario. After a deliberate change, re-record the files that changed and read the
diff before keeping it: a re-record accepts whatever the code now does.

    UPDATE_RECORDINGS=1 npx vitest run --config vitest.unit.config.ts server/rules/testing/sweep/sweep-<file>.test.ts

`SWEEP_DUMP_DIR=<folder>` writes every recording with its problems, whatever they are, for reading a failure; compare
that with `recordings/` before re-recording. A money figure that moves in a re-record is a finding, not a re-record.

### Dropped scenarios

`DROPPED` in `sweep/sweep.ts` names the 21 scenarios only code that is gone could run (GB15's legacy catalogue
route, GB24's deleted function, and the eighteen W05g / W05h money owed scenarios set up on the old side), each with
where its decided behaviour is held now. The scenarios themselves are gone; the names stay so `sweep/dropped.test.ts`
proves each is held: GB15's and GB24's directly, and each money owed one by the rule test it names (most are in
`bookings/money-owed-next-steps.test.ts`, one test per scenario).

## The old code's words (`old-words.json`)

The failure-messages tests (`server/rules/*/failure-messages.test.ts`, `admin/words.test.ts`) hold each Worker sentence
staff see to the old function's, word for word. The old functions are gone, so what those tests read from them was
recorded once (W64a) in `old-words.json` and is read through `old-words.ts`. It can't be recorded again: change a
sentence deliberately in the test that pins it, with the decision that changed it.

## The guards

- `old-code-reach.test.ts`: nothing in the Worker reaches what W65 deleted (an import of a deleted module, an old-side
  name, a string naming a deleted folder), and each group W65 deleted is gone. It reads every source file with the
  TypeScript parser, comments ignored. A new string literal that names a deleted folder fails it: build such a name
  from parts, as that test does.
- `removed-code.test.ts`: removed code can't come back. It lists, from nothing but itself, every staff app file and
  Worker route deleted and every name removed, and scans the Worker's source (comments ignored) and the staff app's
  `backend/` and `frontend/` for them. A new file that has to name a removed route or name (a test of its own about
  one) trips it: build the name from parts, or give the scan a reason to skip it there.

## Adding a scenario

1. Write it in the family it belongs to (`scenarios.ts`, `w48-scenarios.ts` or `flow-presses.ts`), named with the
   family's prefix, from `seed` and the fixed `ID`s, so it lands in one sweep file (`SWEEP_FILES`). Use `call` for a
   press that must answer and `attempt` for one that may throw. Give any new row the scenario seeds a fixed id, or its
   recording won't repeat.
2. Record it: run its sweep file with `UPDATE_RECORDINGS=1` and read the new `recordings/<name>.json` line by line:
   every figure, every Stripe call, every row.
3. Run the file again without it: it must match. If an invariant breaks, fix the code, or, only when the breach is a
   decided hold for reconcile or a state the scenario made by hand, name it in `named-breaches.ts` (or the scenario in
   `WORKER_EXCEPTIONS`) with why.
4. `coverage.test.ts` then holds it to one file and its recording.
