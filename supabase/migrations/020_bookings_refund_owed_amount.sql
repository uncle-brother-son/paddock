-- 020: bookings.refund_owed_amount
-- Money a refund on this booking should have given back but couldn't (store credit or card refund failed during
-- Move, Remove Guest, Cancel & Refund recovery or a part refund). Staff give it with "Refund the rest", which lowers
-- price_paid and this figure but never raises part_refunded_amount (W05e decision 2, W05g). Applied live by the lead
-- on 6 Nov 2026.

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS refund_owed_amount numeric(10,2) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_refund_owed_amount_check') THEN
    ALTER TABLE public.bookings
      ADD CONSTRAINT bookings_refund_owed_amount_check CHECK (refund_owed_amount >= 0);
  END IF;
END $$;

COMMENT ON COLUMN public.bookings.refund_owed_amount IS
  'Refund money owed to the customer after a refund failed partway. Given with Refund the rest; never counted as a part refund.';
