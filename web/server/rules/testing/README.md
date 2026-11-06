# server/rules/testing

## Which database a test uses

| Set-up | What it is | Use it for | Used by |
|---|---|---|---|
| `startTestDatabase()` | PGlite, `schema.sql`: the tables the read rules use, no foreign keys or triggers | Read rules, where fixtures set ids directly | The step B rule and route suites |
| `startTestDatabase({ schema: 'live' })` | PGlite, `live-schema.sql`: everything in the live catalog | Anything that writes | Replay, the probe, `live-schema.test.ts` |
| `reader-orders-schema.sql` | PGlite, a hand copy from W03a | Only `reader-rollback.test.ts` | Move it to `live` when that suite is next touched |
| `startRealPostgres()` | Real Postgres 17.6, `live-schema.sql` | Anything about one connection waiting on another | `two-connections.test.ts` |

PGlite is one session, so it can't show one connection waiting on another's lock. It is also
Postgres 18, where live is 17.

## Real Postgres

`real-postgres.ts` starts the `embedded-postgres` dev package's server on a free port, from a new
temp folder, and `stop()` removes the folder. It takes about a second and needs nothing installed on
the Mac. Each `connect()` is a new Worker client, so two of them are two requests.

Keep the version in `package.json` on the one live runs. `two-connections.test.ts` fails if they
differ.

For a lock test, use the `race` helper in `two-connections.test.ts`: it holds the first transaction
open until Postgres reports the second as blocked by it, so the test can't pass by luck of timing.
Add a control that shows the unguarded version going wrong, or a passing test proves nothing.

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
- `legacy-routes.ts`: the old functions' Worker calls go through the real legacy routes. Only Stripe's
  SDK and supabase-js are swapped, so `FakeStripe` sees what Stripe would.
- `compare.ts`: labels generated ids, shows timestamps as set or unset, compares money to the penny
  and checks row order. `tied` counts rows sharing a `created_at`.
- `golden/`: the old functions' recordings. They outlive the old code.

To add the new side at W06, write a `ReplaySide` whose `call` runs the route, then compare its
recording with the golden file, passing each `AllowedDifference` with the decision that allows it.
An allowance that stops being needed fails, so stale ones can't pile up. The new side's database
calls must also tick the clock, or every row in it will look tied.

To re-record after a deliberate change:

    UPDATE_GOLDEN=1 npm run test:unit -- server/rules/testing/replay

Read the diff of `golden/` before keeping it: a re-record accepts whatever the code now does.
