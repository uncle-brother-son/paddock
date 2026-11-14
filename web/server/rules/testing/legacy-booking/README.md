# legacy-booking: a frozen, test-only copy of the old step D functions

**Delete this folder at step H**, with `legacy-order/`. Nothing here runs in the app.

Step D (D-plan, `briefs/D-plan.md` in the staff app repo) moves the staff app's booking changes to the Worker one
action per slice (W18 to W25), and each slice deletes that action's old body (lead call L1). But most replay golden
scenarios set up their booking with an old Move, Add Guest, Settle, refund or reader flow before the step they test,
and every golden file was recorded through these functions. So that each golden file keeps replaying exactly, whichever
actions have switched, W17 froze this copy (D-plan 4.11 item 1), as W16 froze the old order code beside it.

- `backend/paddock/`: the staff app's twelve step D functions (`moveBooking`, `addBookingGuest`,
  `settleLapsedBooking`, `removeBookingGuest`, `refundBooking`, `cancelCreditBooking`, `removeBookingAddon`,
  `setBookingSpecialRequests`, `setBookingStatus`, `getBookingRefundFigures`, `finaliseReaderPayment`,
  `cancelReaderPayment`) and every module they import, 46 files, **exactly as at staff app commit `453bf38`**
  (unchanged at `407aeed`). Byte for byte: their imports are all relative, so nothing needed changing.
  `manifest.json` holds each file's SHA-256; `server/rules/testing/frozen-booking-code.test.ts` fails if one changes.
- `legacy-order/backend/paddock/` now imports the modules both copies share from here (W17), not from the staff app's
  checkout, so the old order code keeps working when step D deletes them (`chargeSavedCard`, `bandPricing`,
  `creditRedemption`...). The three modules steps E and G move (`cancelMembershipSubscription`, `promoCodes`,
  `stockAdjustments`) went through the `@retool-app` alias until W27; the order copy now takes them from the frozen
  step E copy (`../legacy-refund/`), so no import in the test tree uses the alias any more.

Who may use it: only `replay/harness.ts` (`LEGACY_BOOKING_ACTIONS`, `legacyBookingDir`, `oldFunctionPath`) and the
order copy's imports, and test files through the harness. `server/rules/testing/frozen-booking-code.test.ts` checks that nothing in
the Worker's app code or the staff app imports it. `backend/` is excluded from the Worker's `tsc` (it uses Retool's
globals) and the whole folder from lint; both were checked where they lived. Don't fix or change it: it stands for what
the old code did, including its known faults (the W05 review 3 findings and N1 to N9, recorded as golden scenarios).
