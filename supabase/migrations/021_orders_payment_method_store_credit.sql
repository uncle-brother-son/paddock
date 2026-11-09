-- 021: orders.payment_method allows 'store_credit'
-- Decision Q9 (W03-decisions): an order paid only with store credit records 'store_credit' (it was saved with no
-- method, checklist item 18); gift card + store credit records 'split' (new orders only). The Worker's T1 writes
-- these from W09. The old Retool createOrder still writes null for a store-credit-only order until W15.
-- Backfill (checked row by row by the lead on 9 Nov 2026): the two paid orders with no method whose store credit
-- covered the whole total (098796a0 £20, 3a7ac67a £15). The three £0 orders stay null (nothing owed); 55b3d376
-- (£15 with a PaymentIntent) is left as it is. Applied live by the lead on 9 Nov 2026.

ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_payment_method_check;
ALTER TABLE public.orders
  ADD CONSTRAINT orders_payment_method_check
  CHECK (payment_method = ANY (ARRAY['card'::text, 'reader'::text, 'cash'::text, 'gift_card'::text, 'split'::text, 'store_credit'::text]));

UPDATE public.orders
   SET payment_method = 'store_credit'
 WHERE id IN ('098796a0-1d3d-43cc-8adc-3b547cb3110b', '3a7ac67a-812e-4b71-9838-167a1a14c999')
   AND payment_method IS NULL
   AND payment_status = 'paid';
