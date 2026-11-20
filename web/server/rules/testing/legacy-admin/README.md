# legacy-admin: a frozen, test-only copy of the old step G functions and the seven legacy catalogue routes

**Delete this folder at step H**, with `legacy-order/`, `legacy-booking/`, `legacy-refund/` and `legacy-account/`.
Nothing here runs in the app.

Step G (G-plan, `briefs/G-plan.md` in the staff app repo) moves the staff app's last 82 functions that are not a thin
call to the Worker slice by slice (W49 to W57): the staff list, the catalogue, pricing, promo codes, sessions and the
timetable, the booking and order screens' reads and flags, event check-in. Each slice deletes that function's old
body (lead call L4). Step G's golden files were recorded through these functions and routes (brief W48, G-plan 4.9
items 1 and 2, lead call L5), and each slice's replay holds the Worker's routes to them. So that every golden file
keeps replaying exactly whichever actions have switched, W48 froze this copy, as W16, W17, W27 and W36 froze theirs.

- `backend/paddock/`: the staff app's 82 step G functions and every module they import (`globals` and sixteen shared
  modules: `bookingPaymentOpenWords`, `eventAttendance`, `eventAttendeeList`, `eventCheckIn`, `extractApiErrorMessage`,
  `extractStructuredApiError`, `isHtmlErrorPage`, `isoDateTime`, `londonTime`, `pricingStaff`, `promoCodes`,
  `readerPaymentOpen`, `resolveStaffId`, `staffAccess`, `stockAdjustments`, `toggleItemActive`), **exactly as at staff
  app commit `7a4aede`**. Byte for byte: their imports are all relative, so nothing needed changing. The list of the
  82 is `LEGACY_ADMIN_ACTIONS` in `replay/harness.ts`, by screen.
- **Not here:** `getPricingConfig`, `getPostageSettings`, `getWorkerConnection`, `getStuckReaderPayments` and
  `getMoneyOwed`. They were thin calls to the Worker before step G began, so there is no old body to keep.
- `routes/catalog/`: the seven legacy routes the old functions call (`toggle-active`, `update-price`,
  `update-tier-price`, `create-variant`, `sync-stripe`, `create-gift-card-preset`, `update-gift-card-preset-price`:
  each `route.ts`), copied from `app/api/catalog/` at Worker commit `a88c8c8` **while they are still live in the
  app**, with their README. They are bound through `replay/legacy-routes.ts`, so W61 can delete the live ones with
  nothing to move.
- `lib/membership-price-migration.ts`: the plan price move (`lib/membership-price-migration.ts` at `a88c8c8`), which
  the update-price route calls for a membership plan (G-plan GB1).
- **One import line differs from its original,** and nothing else: `routes/catalog/update-price/route.ts` imports the
  copy's `lib/membership-price-migration` (the original imports `@/lib/membership-price-migration`).
  `frozen-admin-code.test.ts` compares each route and the helper with its original, with that one line put back,
  while the originals exist.
- `manifest.json` holds each file's SHA-256 (107 files); `server/rules/testing/frozen-admin-code.test.ts` fails if
  one changes. It was written by `briefs/W48-logs/freeze-admin-copy.py` in the staff app repo, which made the copy.
- Some modules are in the other copies too (`staffAccess`, `resolveStaffId`, `londonTime`…). This copy has its own, as
  at `7a4aede`, rather than reaching into those. `replay/harness.ts`'s `oldFunctionPath` names a module several
  copies hold from the earliest copy, as before; each copy's own functions import their own, relatively.

**What is different from the four copies before it** (G-plan 2.5; W45 row 4; W26 row 1): this copy's shared modules
are not compared with the staff app's live ones. Step G trims and deletes those modules slice by slice, and a
comparison would fail the Worker suite on every such edit. The manifest alone holds them. The two older guards that
did compare their shared modules with the staff app's (`frozen-refund-code.test.ts`, `frozen-account-code.test.ts`)
now compare with this copy's files instead: the staff app's as at W48, which never change. Only the 82 functions
themselves are still looked at in the staff app, with no list to keep up: each must be this copy's own byte for byte
(not switched yet), or a thin call to the Worker (switched), or gone.

Who may use it: only `replay/harness.ts` (`LEGACY_ADMIN_ACTIONS`, `legacyAdminDir`, `oldFunctionPath`) and
`replay/legacy-routes.ts` (the seven routes), and test files through the harness. `frozen-admin-code.test.ts` checks
that nothing in the Worker's app code or the staff app imports it. `backend/` is excluded from the Worker's `tsc` (it
uses Retool's globals) and the whole folder from lint; both were checked where they live. Don't fix or change it: it
stands for what the old code did, including its known faults (G-plan section 3, GB1 to GB24, recorded as golden
scenarios named `w48-gb…`).
