-- 5 Nov 2026 (applied by the lead). Redemption Source "Gift Card" is removed (brief W02d): a booking is Paid and a
-- gift card pays for it on the payment step. No booking or guest row ever used the value.
ALTER TABLE public.bookings DROP CONSTRAINT bookings_redemption_source_check;
ALTER TABLE public.bookings ADD CONSTRAINT bookings_redemption_source_check
  CHECK (redemption_source = ANY (ARRAY['paid'::text, 'membership_credit'::text, 'session_pass_credit'::text]));
ALTER TABLE public.booking_guests DROP CONSTRAINT booking_guests_pay_by_check;
ALTER TABLE public.booking_guests ADD CONSTRAINT booking_guests_pay_by_check
  CHECK (pay_by = ANY (ARRAY['paid'::text, 'membership_credit'::text, 'session_pass_credit'::text]));
