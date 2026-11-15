-- 024: event_cancellation_quote answers `before_cutoff` by Wayne's Q43 (14 Nov 2026): an event with no refund cut-off
-- uses its start as the cut-off (brief W33 item 3; W30 report "Noticed" 1; bug E8).
-- NOT APPLIED by W33. The lead applies it after W33's review and BEFORE the W33 Worker is pushed.
--
-- Before: 'before_cutoff' was `refund_cutoff_at IS NOT NULL AND now < refund_cutoff_at`, so an event with no cut-off
-- answered false months ahead, and every refund on it counted as "after the cut-off". The Worker has corrected that in
-- its own code since W30 (events/cancel-places.ts, quotePlaces); anything else that read the function (a report, the
-- website) got the old answer.
-- After: 'before_cutoff' is `now < COALESCE(refund_cutoff_at, starts_at)`, and true when the event has neither (a
-- null start counts as before). One line of the function changes; every other line, its signature, STABLE and its
-- grants are as they were (CREATE OR REPLACE keeps the grants). From W33 the Worker reads the answer as it is.
--
-- Order, and why it is safe either way round for a short while:
-- - This migration first, then the W33 Worker. With 024 applied and the OLD Worker (0ec55c5) still live, nothing
--   changes: the old Worker ignores `before_cutoff` when the event has no cut-off and works it out from
--   `event_started` (the same answer: before the start), and reads it as before when there is a cut-off.
-- - The W33 Worker WITHOUT 024 would be wrong: an event with no cut-off would again count every staff refund as after
--   the cut-off (a reason asked for, `refund_after_cutoff` recorded), as before W30. So 024 goes first.
-- - The staff app never calls the function (its event cancels have been the Worker's since W30 / W31).
--
-- No data changes: no row is written or rewritten. Places already recorded with `refund_after_cutoff` under the old
-- rule stay as they are (the lead's live check at W30: no event has been sold).
--
-- Check after applying (read-only): expect `true`.
--    SELECT pg_get_functiondef('public.event_cancellation_quote(uuid, uuid[])'::regprocedure) LIKE '%COALESCE(b.refund_cutoff_at, b.starts_at)%';
--
-- Down (the function as it was before 024): replace the one line
--    'before_cutoff', COALESCE(v_now_london < (COALESCE(b.refund_cutoff_at, b.starts_at) AT TIME ZONE 'UTC'), true),
-- with
--    'before_cutoff', b.refund_cutoff_at IS NOT NULL AND v_now_london < (b.refund_cutoff_at AT TIME ZONE 'UTC'),
-- and run the statement again.

CREATE OR REPLACE FUNCTION public.event_cancellation_quote(p_event_booking_id uuid, p_attendee_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
  b record;
  v_line_total numeric := 0;
  v_line_discount numeric := 0;
  v_net_line numeric;
  v_cancelled_value numeric;
  v_remaining_value numeric;
  v_remaining_count int;
  v_remaining_units numeric;
  v_sel_count int;
  v_sel_units numeric;
  v_sel_ids uuid[];
  v_value numeric;
  v_now_london timestamp := (now() AT TIME ZONE 'Europe/London');
BEGIN
  SELECT eb.id, eb.status, eb.event_id, eb.customer_id, e.refund_cutoff_at, e.starts_at, e.ends_at,
         e.cancelled_at AS event_cancelled_at
  INTO b
  FROM public.event_bookings eb JOIN public.events e ON e.id = eb.event_id
  WHERE eb.id = p_event_booking_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'booking_not_found'); END IF;
  IF b.status <> 'confirmed' THEN RETURN jsonb_build_object('ok', false, 'reason', 'booking_not_confirmed'); END IF;

  SELECT COALESCE(SUM(oli.line_total), 0), COALESCE(SUM(oli.discount_amount), 0)
  INTO v_line_total, v_line_discount
  FROM public.order_line_items oli
  WHERE oli.event_booking_id = p_event_booking_id AND oli.item_type = 'event';
  v_net_line := GREATEST(v_line_total - v_line_discount, 0);

  SELECT COALESCE(SUM(cancelled_value), 0) INTO v_cancelled_value
  FROM public.event_attendees WHERE event_booking_id = p_event_booking_id AND cancelled_at IS NOT NULL;
  v_remaining_value := GREATEST(v_net_line - v_cancelled_value, 0);

  SELECT COUNT(*), COALESCE(SUM(unit_price), 0) INTO v_remaining_count, v_remaining_units
  FROM public.event_attendees WHERE event_booking_id = p_event_booking_id AND cancelled_at IS NULL;

  IF p_attendee_ids IS NULL THEN
    SELECT array_agg(id) INTO v_sel_ids FROM public.event_attendees
    WHERE event_booking_id = p_event_booking_id AND cancelled_at IS NULL;
  ELSE
    SELECT array_agg(DISTINCT x) INTO v_sel_ids FROM unnest(p_attendee_ids) x;
    IF EXISTS (SELECT 1 FROM unnest(v_sel_ids) x
               WHERE NOT EXISTS (SELECT 1 FROM public.event_attendees ea WHERE ea.id = x AND ea.event_booking_id = p_event_booking_id)) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'attendee_not_found');
    END IF;
    IF EXISTS (SELECT 1 FROM public.event_attendees WHERE id = ANY(v_sel_ids) AND cancelled_at IS NOT NULL) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'already_cancelled');
    END IF;
  END IF;
  IF v_sel_ids IS NULL OR cardinality(v_sel_ids) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'nothing_to_cancel');
  END IF;
  IF EXISTS (SELECT 1 FROM public.event_attendees WHERE id = ANY(v_sel_ids) AND checked_in_at IS NOT NULL) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'attendee_checked_in');
  END IF;

  SELECT COUNT(*), COALESCE(SUM(unit_price), 0) INTO v_sel_count, v_sel_units
  FROM public.event_attendees WHERE id = ANY(v_sel_ids);

  IF v_sel_count = v_remaining_count THEN
    v_value := v_remaining_value;  -- the last places take whatever is left, so rounding never drifts
  ELSIF v_remaining_units > 0 THEN
    v_value := LEAST(ROUND(v_remaining_value * v_sel_units / v_remaining_units, 2), v_remaining_value);
  ELSE
    v_value := 0;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'event_id', b.event_id,
    'customer_id', b.customer_id,
    'attendee_ids', to_jsonb(v_sel_ids),
    'places', v_sel_count,
    'whole_booking', v_sel_count = v_remaining_count,
    'value', v_value,
    'refund_cutoff_at', b.refund_cutoff_at,
    'before_cutoff', COALESCE(v_now_london < (COALESCE(b.refund_cutoff_at, b.starts_at) AT TIME ZONE 'UTC'), true),
    'event_started', b.starts_at IS NOT NULL AND v_now_london >= (b.starts_at AT TIME ZONE 'UTC'),
    'event_cancelled', b.event_cancelled_at IS NOT NULL
  );
END;
$function$;
