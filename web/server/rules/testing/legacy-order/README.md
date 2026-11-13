# legacy-order: a frozen, test-only copy of the removed order code

**Delete this folder at step H.** Nothing here runs in the app.

W16 deleted the staff app's old order code (createOrder's body, createBooking, the old reader finalise and
cancel, and the shared modules only they used) and the legacy routes only it called. But 687 of the 692
replay golden scenarios set up their booking through that old createOrder before running the refund or flow
code they test (the old functions steps D and E port). So that those golden files still replay exactly, Wayne
chose (12 Nov, option B) to keep this copy for the replay's set-up only.

- `backend/paddock/`: the staff app's files exactly as they were at staff app commit `2920db4`, with two
  changes: imports of modules that still exist in the staff app go through the `@retool-app` alias
  (vitest.unit.config.ts) to its checkout, and createOrder, finaliseReaderOrder and cancelReaderOrder default
  to their old bodies (no W14 Worker-first wrapper, no shadow), as the golden files recorded them.
- W17: the modules this copy shares with the old step D functions now come from the frozen booking copy beside it
  (`../legacy-booking/README.md`), not from the staff app's checkout, so this copy keeps working while step D deletes
  them from the staff app. Import paths only; those files are byte for byte the staff app's at `453bf38`. Only
  `cancelMembershipSubscription`, `promoCodes` and `stockAdjustments` (steps E and G) still go through the alias.
- `routes/`: the Worker's deleted `app/api/memberships/create-subscription` (route and core) and
  `app/api/terminal/resolve-saved-card`, exactly as at Worker commit `c966a10`, which the old code calls through
  `replay/legacy-routes.ts`.
- W25: `routes/` also holds the three legacy routes step D's old functions called, moved here (`git mv`, byte for
  byte) from `app/api/` at Worker commit `b7ab0ac` when the app lost them: `payments/charge-saved-card` (route, core
  and the core's test), `terminal/create-payment-intent` (route) and `terminal/payment-intent` (route, core and the
  core's test). The frozen copy of the old step D functions beside this folder (`../legacy-booking/`) and the old
  order code here call them through `replay/legacy-routes.ts`. `server/rules/testing/removed-booking-code.test.ts` checks nothing
  else does.

Who may use it: only `replay/harness.ts` (`LEGACY_ORDER_ACTIONS`, `legacyOrderDir`) and `replay/legacy-routes.ts`,
and test files through the harness. `server/removed-order-code.test.ts` checks that, and that nothing else in
either repo imports what W16 removed. `backend/` is excluded from the Worker's `tsc` (it uses Retool's globals)
and the whole folder from lint; both were checked where they lived. Don't fix or change it: it stands for what
the old code did.
