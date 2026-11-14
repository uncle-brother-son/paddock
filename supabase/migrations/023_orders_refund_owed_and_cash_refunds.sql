-- 023: money owed on an order, cash as a refund method on order lines and event places, and an index for refund claims
-- (brief W27, E-plan 4.2, 4.5 and 4.6; Wayne's Q39 and the lead's call L1, 14 Nov 2026).
-- NOT APPLIED by W27. The lead applies it after W27's review and BEFORE the W28 Worker is pushed.
--
-- 1. orders.refund_owed_amount: card money a refund on this order (or on its event booking, which is always paid by
--    one order) should have given back and didn't: Stripe refused it, or never got it. Left for staff as "£X still to
--    refund" with Refund the rest and It already arrived, never turned into store credit by the system (Q39), exactly
--    as bookings.refund_owed_amount (020). Nothing reads or writes it until W28.
-- 2. 'cash' joins the refund methods an order line and an event place can record (Q26: cash paid can be handed back as
--    cash). Nothing writes it until W28 (orders) and W30 (events).
-- 3. A partial index on audit_log for the refund claims. Reconcile's due list and the stuck list read the claim rows
--    by action every 5 minutes (three claim actions from step E, where step D had one), and audit_log has no index on
--    action: each read scans the whole log. Partial, so it holds only the claim rows.
--
-- Safe with the Worker and the staff app that are live today (Worker 31b0ac4, staff app 5e653b6): they name their
-- columns in every INSERT into orders, never write 'cash' to either refund_method, and nothing reads the new column.
-- The staff app's `SELECT * FROM order_line_items` (refundOrder) is unaffected: that table gains no column.
--
-- Check first (read-only). Expect 0 rows from each; if not, stop and tell the builder.
--    SELECT count(*) FROM public.order_line_items WHERE refund_method IS NOT NULL AND refund_method NOT IN ('card', 'credit');
--    SELECT count(*) FROM public.event_attendees  WHERE refund_method IS NOT NULL AND refund_method NOT IN ('card', 'credit', 'none');

-- 1. Money owed on an order.
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS refund_owed_amount numeric(10,2) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_refund_owed_amount_check') THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_refund_owed_amount_check CHECK (refund_owed_amount >= 0);
  END IF;
END $$;

COMMENT ON COLUMN public.orders.refund_owed_amount IS
  'Card refund money still owed to the customer on this order (or its event booking): Stripe refused it or never got it. Given with Refund the rest, or cleared with It already arrived; never given as store credit by the system.';

-- 2. Cash as a refund method. Each check is replaced in one statement pair inside the migration's transaction, so
--    there is no moment without one. The old values stay allowed, so every existing row still passes.
ALTER TABLE public.order_line_items DROP CONSTRAINT IF EXISTS order_line_items_refund_method_check;
ALTER TABLE public.order_line_items
  ADD CONSTRAINT order_line_items_refund_method_check CHECK (refund_method = ANY (ARRAY['card'::text, 'credit'::text, 'cash'::text]));

ALTER TABLE public.event_attendees DROP CONSTRAINT IF EXISTS event_attendees_refund_method_check;
ALTER TABLE public.event_attendees
  ADD CONSTRAINT event_attendees_refund_method_check CHECK (refund_method = ANY (ARRAY['card'::text, 'credit'::text, 'none'::text, 'cash'::text]));

-- 3. The refund claims, by action then time (the due list's order). Plain CREATE INDEX holds a SHARE lock on audit_log
--    while it builds (audit writes wait that long: milliseconds at today's size). CONCURRENTLY would avoid that but
--    can't run inside a migration's transaction.
CREATE INDEX IF NOT EXISTS audit_log_refund_claims_idx
  ON public.audit_log (action, at)
  WHERE action = ANY (ARRAY['booking.refund_claimed'::text, 'order.refund_claimed'::text, 'event_booking.refund_claimed'::text]);

-- After applying: refresh the Worker's test schema from the live catalog (web/server/rules/testing/README.md,
-- "Refreshing the live schema") and run `npm run schema:test -- --check`. The W27 builder added these four changes to
-- the snapshot by hand, each written as Postgres 17.6 prints it, so the refresh should show no difference at all.
--
-- Down (if ever needed, and only while no row uses 'cash' and nothing is owed on an order):
--   DROP INDEX IF EXISTS public.audit_log_refund_claims_idx;
--   ALTER TABLE public.event_attendees DROP CONSTRAINT event_attendees_refund_method_check;
--   ALTER TABLE public.event_attendees ADD CONSTRAINT event_attendees_refund_method_check CHECK (refund_method = ANY (ARRAY['card'::text, 'credit'::text, 'none'::text]));
--   ALTER TABLE public.order_line_items DROP CONSTRAINT order_line_items_refund_method_check;
--   ALTER TABLE public.order_line_items ADD CONSTRAINT order_line_items_refund_method_check CHECK (refund_method = ANY (ARRAY['card'::text, 'credit'::text]));
--   ALTER TABLE public.orders DROP CONSTRAINT orders_refund_owed_amount_check;
--   ALTER TABLE public.orders DROP COLUMN refund_owed_amount;
