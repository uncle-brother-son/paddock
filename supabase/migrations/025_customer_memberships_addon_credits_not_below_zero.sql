-- 025: a membership's add-on credits can never be below zero (brief W37 item 4; F-plan section 3 bug FB10; lead call
-- L10, 15 Nov 2026).
-- NOT APPLIED by W37. The lead applies it after W37's review. It can go on before or after the W37 Worker and staff
-- app are released: see "Order" below.
--
-- Before: nothing in the database stopped customer_memberships.addon_credits_remaining going below zero. The staff
-- app's old adjustMembershipCredits added any whole number to it, so "-5" on a balance of 2 left -3, and the next
-- three add-on credits the member earned vanished into the hole (FB10).
-- After: a CHECK refuses any write that would leave it below zero. The W37 Worker already refuses first, in plain
-- words ("Adjustment rejected: the membership would be left with -3 add-on credit(s), below zero."), under the
-- membership's lock; this is the database's own backstop for every other writer.
--
-- Who writes the column, and why each is safe with the check:
-- - New Order, Add Guest and add-ons (Worker): take a credit only with a guarded UPDATE (enough left), under the
--   membership's lock. Never below zero.
-- - Refunds, cancels, Remove add-on and the reader's undo (Worker): give credits back. Upwards only. A refund of an
--   order's lines that is undone (orders/refund-lines.ts) puts back the figure it saved, which was never below zero.
-- - One undo LOWERS the column (corrected in W37a; W37 review S2): undoCancel (bookings/refunds.ts). When Stripe
--   refuses the first card part of a Cancel & Refund, it takes back the add-on credits the cancel had just returned
--   (`addon_credits_remaining - N`), with no floor of its own. If the member spent one of those credits, or staff
--   adjusted it away, in the seconds before Stripe answered, that statement leaves the balance below zero: 0 -> 1
--   (returned) -> 0 (spent) -> -1 today. With 025 the statement fails, so the whole undo rolls back and W26a's path
--   takes over (finishRefusedNotPutBack, `undo_failed`): the cancel stands and the card money is left owed on the
--   booking for a person. Nothing is given twice and nothing is lost; without 025 it is a silent negative balance.
--   (For later, the lead's step G list: a guard there so staff see the "blocked" words rather than the "failed" ones.)
-- - The credit adjustment (Worker, W37): refuses below zero before it writes.
-- - The staff app's OLD adjustMembershipCredits (published until W37 goes live): a "-N" that would go below zero now
--   fails with the database's own error instead of going through. Nothing is half-written: it is that function's
--   first statement.
-- - The hourly job (run_membership_maintenance) and the Stripe webhook's functions don't lower it.
--
-- Order: either way round is safe. With 025 on and the old staff app still published, the only change is the line
-- above (a refusal where there was a bug). With the W37 Worker and no 025, the Worker's own rule holds the floor.
--
-- Check first (read-only). Expect 0; if not, stop and tell the builder (the ALTER would fail anyway, changing nothing):
--    SELECT count(*) FROM public.customer_memberships WHERE addon_credits_remaining < 0;
-- (The lead's live check on 15 Nov 2026: 0.)
--
-- No data changes: no row is written or rewritten. The ALTER takes a brief ACCESS EXCLUSIVE lock on
-- customer_memberships while it checks the existing rows (a handful today: milliseconds).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customer_memberships_addon_credits_remaining_check') THEN
    ALTER TABLE public.customer_memberships
      ADD CONSTRAINT customer_memberships_addon_credits_remaining_check CHECK (addon_credits_remaining >= 0);
  END IF;
END $$;

-- After applying: refresh the Worker's test schema from the live catalog (web/server/rules/testing/README.md,
-- "Refreshing the live schema") and run `npm run schema:test -- --check`, then the Worker's tests. The refresh should
-- show one new line in live-schema.sql and one new constraint in live-catalog.json:
--    ALTER TABLE public.customer_memberships ADD CONSTRAINT customer_memberships_addon_credits_remaining_check CHECK ((addon_credits_remaining >= 0));
-- The one golden scenario that records the old bug (w36-fb10-addon-credits-taken-below-zero) lifts the check for its
-- own run when it is there, so it replays the same before and after the refresh (migration-025.test.ts and
-- account-replay.test.ts hold that).
--
-- Down (if ever needed):
--   ALTER TABLE public.customer_memberships DROP CONSTRAINT IF EXISTS customer_memberships_addon_credits_remaining_check;
