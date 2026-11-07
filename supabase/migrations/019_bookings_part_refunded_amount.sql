-- 019: bookings.part_refunded_amount
-- The money given back on a booking by part refunds (Cancel & Refund's part-refund path), kept separately so that
-- Add Guest (Q27) and Move (Q28) never ask for it again, and so a cheaper move's refund is never mistaken for one.
-- Raised by a part refund; never raised by a move, Remove Guest or a reversed charge. Set to 0 for existing rows:
-- there is no real use yet and test data is cleared before go-live. Applied live by the lead on 6 Nov 2026 (W05d).

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS part_refunded_amount numeric(10,2) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_part_refunded_amount_check') THEN
    ALTER TABLE public.bookings
      ADD CONSTRAINT bookings_part_refunded_amount_check CHECK (part_refunded_amount >= 0);
  END IF;
END $$;

COMMENT ON COLUMN public.bookings.part_refunded_amount IS
  'Total given back on this booking by part refunds. Not asked for again by Add Guest or Move (decisions Q27, Q28).';
