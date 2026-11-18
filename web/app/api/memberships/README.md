# Memberships API

No route is left in this folder. Each membership action is a `/api/v1/staff/…` route over `server/rules/`.

## `POST /api/memberships/create-subscription` (removed at W16)

Removed with the staff app's old order code, its only caller. A membership's subscription is now made by the
order route (`POST /api/v1/staff/orders`, `server/rules/orders/membership.ts`). A frozen copy stays for the
replay's set-up only (`server/rules/testing/legacy-order/`, deleted at step H).

## `POST /api/memberships/cancel-subscription` (removed at W34)

Removed with the old order refund, its only caller. A frozen copy stays for the replay
(`server/rules/testing/legacy-order/`, deleted at step H).

## `POST /api/memberships/cancel`, `/undo-cancel` and `/change-payment-date` (removed at W44)

The three legacy routes step F replaced (Wayne's yes, 18 Nov 2026). They answer 404 now. What does each job:

| Was | Now | Rule | Switch kind |
|---|---|---|---|
| `/api/memberships/cancel` | `POST /api/v1/staff/memberships/:membershipId/cancel` (W40) | `server/rules/memberships/cancel.ts` | `membership_changes` |
| `/api/memberships/undo-cancel` | `POST /api/v1/staff/memberships/:membershipId/undo-cancel` (W40) | `server/rules/memberships/cancel.ts` | `membership_changes` |
| `/api/memberships/change-payment-date` | `POST /api/v1/staff/memberships/:membershipId/payment-date` (W41) | `server/rules/memberships/payment-date.ts` | `payment_date_changes` |

Removed with them: each route's `core.ts` and tests, `lib/membership-cancellation.ts` (the old cancel's date sum; the
new cancel has its own) and `server/rules/memberships/legacy-guard.ts` (the guards that kept a rolled-back staff app
from cancelling or charging over a change the Worker was still finishing), with the words and the two reads only the
guards used.

**Rollback since W44:** a staff app from before W40 (cancel) or W41 (payment date) gets a 404 from these paths, so
putting the old staff app back no longer brings the old action back. Switching the kind off stops the action (staff
see the switched-off words); the fix is then made forward in the new route. To have an old route again: revert W44's
Worker commit and deploy.

A frozen copy of the three routes, as they were at Worker `982db8f`, stays for the replay's old side only
(`server/rules/testing/legacy-account/routes/`, deleted at step H). `server/rules/testing/removed-account-code.test.ts`
fails if one of the removed files, or anything that names them, comes back.
