-- 022: one PaymentIntent, at most one order (brief W12; proposed in W10, item 7, checklist W5-25).
-- Applied by the lead after checking live data, BEFORE the W12 Worker is pushed (W03-decisions, "W12 calls").
--
-- Nothing in the database stopped two orders recording the same PaymentIntent, which would count its money
-- twice in reports and let two refunds be taken against it. The writers that could do it in a race were the
-- old reader-flow finalise (finaliseReaderPayment: look for an order with the PaymentIntent, then insert) and
-- the legacy saved-card route (charge-saved-card/core.ts, two presses sharing a key). From W12 the Worker's
-- reader-flow finalise is one transaction under the flow row's lock, so it can't race itself, and this index
-- makes any other writer's second insert fail instead of writing a second order.
-- Partial: most orders have no PaymentIntent (cash, store credit, gift card, nothing owed).
--
-- What the old code does when it meets the index (W10 report, "Risk to the old code"):
--  * Old finaliseReaderPayment, two finalises of one flow at once (two tabs, or a screen finalise racing the
--    old sweep): the second insert is refused, which the old code answers as record_failed: it refunds the card
--    and undoes the flow although the first recorded it. Before 022 the same race wrote two orders and ran the
--    flow's later steps twice. Only the old code can race this way, and only on flows it started.
--  * Legacy saved-card route, two presses sharing a key: the second insert is refused and the route answers
--    success with its "verify manually" warning; no second order (an improvement).
--
-- 1. Check first (read-only). Expect no rows (the lead's live check on 9 Nov found none). If any, stop.
--    SELECT stripe_payment_intent_id, count(*) AS orders
--    FROM public.orders
--    WHERE stripe_payment_intent_id IS NOT NULL
--    GROUP BY stripe_payment_intent_id
--    HAVING count(*) > 1;
--
-- 2. The index. If step 1 found rows, this fails and nothing is changed. Plain CREATE INDEX holds a SHARE lock
--    on orders while it builds (order writes wait that long: milliseconds at today's size). CONCURRENTLY would
--    avoid that but can't run inside a migration's transaction.
CREATE UNIQUE INDEX IF NOT EXISTS orders_stripe_payment_intent_id_key
  ON public.orders (stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

-- 3. After applying: refresh the Worker's test schema from the live catalog (web/server/rules/testing/README.md,
--    "Refreshing the live schema") and run `npm run schema:test -- --check`. The W12 builder added this index to
--    the snapshot by hand, written as pg_get_indexdef prints it; the refresh should show no other difference.
--
-- Down (if ever needed): DROP INDEX IF EXISTS public.orders_stripe_payment_intent_id_key;
