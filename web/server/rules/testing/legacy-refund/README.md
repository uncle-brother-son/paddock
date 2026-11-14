# legacy-refund: a frozen, test-only copy of the old step E functions

**Delete this folder at step H**, with `legacy-order/` and `legacy-booking/`. Nothing here runs in the app.

Step E (E-plan, `briefs/E-plan.md` in the staff app repo) moves the staff app's order refunds and event
cancellations to the Worker one action per slice (W28 to W31), and each slice deletes that action's old body (lead
call L4). The golden files for those actions were recorded through these functions (brief W27, E-plan 4.13 items 1
and 2, lead call L6), and each slice's replay holds the Worker's routes to them. So that every golden file keeps
replaying exactly whichever actions have switched, W27 froze this copy, as W16 froze the old order code and W17 the
old step D functions beside it.

- `backend/paddock/`: the staff app's five step E functions (`refundOrder`, `cancelEventPlaces`, `cancelEvent`,
  `getEventCancellationQuote`, `getEventCancellationOverview`) and every module they import, **exactly as at staff
  app commit `941276f`**. Byte for byte: their imports are all relative, so nothing needed changing.
  `manifest.json` holds each file's SHA-256; `server/rules/testing/frozen-refund-code.test.ts` fails if one changes.
- **One file is not a copy:** `backend/paddock/typecheckAll.ts`. The staff app's `refundOrder.ts` has a side-effect
  import of its typecheck barrel, which imports every module the staff app has. The stand-in here imports only what
  the barrel's first line does (`./globals`), so `refundOrder.ts` itself stays byte for byte. It has no exports and
  no behaviour, as the barrel had none. Its hash is in the manifest too, so it can't change unseen.
- **The three modules the frozen order copy still took from the staff app** (W17 later 1, the W26 audit's row 1):
  `shared/cancelMembershipSubscription.ts`, `shared/promoCodes.ts` and `shared/stockAdjustments.ts` are here (the
  first and the last are `refundOrder`'s own; `promoCodes` is here only for this), and `legacy-order/backend/paddock/`
  now imports them from this folder, not through the `@retool-app` alias. Import paths only. So the old order code,
  which every golden scenario sets up with, keeps working when steps E and G delete those modules from the staff app.
- Some modules are in `legacy-booking/` too (`staffAccess`, `storeCredit`, `refundPaymentIntent`...). This copy has
  its own, as at `941276f`, rather than reaching into that one: two of them (`shared/orderCardPortion.ts` and the
  generated `shared/workerContracts.ts`) have changed in the staff app since `453bf38`, and a copy that stands alone
  can't be changed by another's.
- The legacy routes these functions call (`/api/payments/refund-order`, `/api/v1/staff/payments/refunds`,
  `/api/memberships/cancel-subscription`) are still the app's own (`app/api/...`), bound through
  `replay/legacy-routes.ts`. They leave the app at W34, and move into the test tree then (E-plan 4.12), as W25 moved
  step D's.

Who may use it: only `replay/harness.ts` (`LEGACY_REFUND_ACTIONS`, `legacyRefundDir`, `oldFunctionPath`) and the
order copy's three imports, and test files through the harness. `server/rules/testing/frozen-refund-code.test.ts`
checks that nothing in the Worker's app code or the staff app imports it. `backend/` is excluded from the Worker's
`tsc` (it uses Retool's globals) and the whole folder from lint; both were checked where they lived. Don't fix or
change it: it stands for what the old code did, including its known faults (E-plan section 3, E1 to E11, recorded as
golden scenarios).
