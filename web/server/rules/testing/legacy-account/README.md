# legacy-account: a frozen, test-only copy of the old step F functions and the three legacy membership routes

**Delete this folder at step H**, with `legacy-order/`, `legacy-booking/` and `legacy-refund/`. Nothing here runs in
the app.

Step F (F-plan, `briefs/F-plan.md` in the staff app repo) moves the staff app's membership, customer, store credit and
gift card functions to the Worker slice by slice (W37 to W42), and each slice deletes that function's old body (lead
call L4). Step F's golden files were recorded through these functions and routes (brief W36, F-plan 4.12 items 1 and 2,
lead call L5), and each slice's replay holds the Worker's routes to them. So that every golden file keeps replaying
exactly whichever actions have switched, W36 froze this copy, as W16, W17 and W27 froze theirs beside it.

- `backend/paddock/`: the staff app's sixteen step F functions (`setMembershipCancellation`,
  `changeMembershipPaymentDate`, `getMembershipPaymentDateQuote`, `adjustMembershipCredits`,
  `getMembershipCreditAdjustments`, `setMembershipHerd`, `getSubscriptions`, `createCustomer`, `getCustomers`,
  `getCustomerDetail`, `adjustCustomerStoreCredit`, `extendGiftCardExpiry`, `setGiftCardPickedUp`,
  `setGiftCardShipped`, `getGiftCards`, `getGiftCardRedemptions`) and every module they import (`globals` and eleven
  shared modules), **exactly as at staff app commit `cec4ef1`**. Byte for byte: their imports are all relative, so
  nothing needed changing.
- **Not here:** `saveCustomerCardOnFile`, `createTerminalSetupIntent` and `getCustomerCreditOptions`. They are already
  thin calls to the Worker (W11, W14a, step B), so there is no old body to keep. What the saved card does today (Q19,
  W11 F4) is the Worker's own code, held by `server/rules/payments/terminal-today.test.ts`.
- `routes/memberships/`: the three legacy routes the old functions call (`cancel`, `undo-cancel`,
  `change-payment-date`: each `core.ts` and `route.ts`), copied from `app/api/memberships/` at Worker commit `982db8f`
  while they were still in the app. They are bound through `replay/legacy-routes.ts`. **W44 removed the live routes**
  (Wayne's yes, 18 Nov 2026), with nothing to move: this copy is the only one left.
- `lib/membership-cancellation.ts`: the cancel route's date sum (`lib/membership-cancellation.ts` at `982db8f`,
  removed from the app at W44), which
  holds FB6 (the minimum term's end rolls over instead of ending on the month's last day, Q33). W40 fixes that in the
  Worker's own rule; the copy keeps what the old route did.
- **Two import lines differ from their originals,** and nothing else: `routes/memberships/cancel/core.ts` imports the
  copy's `lib/membership-cancellation` (the original imports `@/lib/membership-cancellation`), and that file imports
  `@/lib/london-time` (the original's `./london-time`), which stays in the app until step H for this copy alone.
  `frozen-account-code.test.ts` compared each with its original, with that one line put back, while the originals
  existed; since W44 `manifest.json` alone holds them.
- `manifest.json` holds each file's SHA-256; `server/rules/testing/frozen-account-code.test.ts` fails if one changes.
- Some modules are in the other copies too (`staffAccess`, `storeCredit`, `resolveStaffId`...). This copy has its
  own, as at `cec4ef1`, rather than reaching into those: a copy that stands alone can't be changed by another's.
  `replay/harness.ts`'s `oldFunctionPath` names a module several copies hold from the earliest copy, as before; each
  copy's own functions import their own, relatively, whatever it answers.

Who may use it: only `replay/harness.ts` (`LEGACY_ACCOUNT_ACTIONS`, `legacyAccountDir`, `oldFunctionPath`) and
`replay/legacy-routes.ts` (the three routes), and test files through the harness. `frozen-account-code.test.ts` checks
that nothing in the Worker's app code or the staff app imports it. `backend/` is excluded from the Worker's `tsc` (it
uses Retool's globals) and the whole folder from lint; both were checked where they live. Don't fix or change it: it
stands for what the old code did, including its known faults (F-plan section 3, FB1 to FB21, recorded as golden
scenarios named `w36-fb…`).
