-- 033: every money column that is plain `numeric` becomes `numeric(10,2)`, with a check
-- (brief W53 item 8; the W35 audit's row 4; G-plan lead call L7; as migrations 020 and 023 did for the columns they added).
-- NOT APPLIED by W53. The lead applies it after W53's review and BEFORE the W53 Worker is pushed.
--
-- Why: a plain `numeric` column keeps whatever is written to it (£4.999, £0.1 + £0.2 as 0.30000000000000004), so a
-- figure that isn't pounds and pence can sit in a money column and be added up, shown and refunded from. With
-- `numeric(10,2)` the database itself holds every figure to the penny, as it already does for every other money column
-- (orders.order_total, order_line_items.line_total, bookings.price_paid...).
--
-- The lead's list of plain `numeric` columns on live, 21 Nov 2026 (15), and what this file does with each:
--
--   column                                          money?  type after     check after
--   addon_order_lines.card_refunded_amount          yes     numeric(10,2)  >= 0 (already there); <= refunded_amount (new)
--   addon_order_lines.refunded_amount               yes     numeric(10,2)  >= 0 (already there); <= price_at_purchase * quantity (new)
--   event_attendees.cancelled_value                 yes     numeric(10,2)  >= 0 (already there)
--   event_attendees.card_refunded_amount            yes     numeric(10,2)  >= 0 (already there)
--   event_attendees.refunded_amount                 yes     numeric(10,2)  >= 0 (already there)
--   membership_payment_date_changes.amount_charged  yes     numeric(10,2)  >= 0 (already there)
--   membership_plans.price_monthly                  yes     numeric(10,2)  null or >= 0 (new)
--   membership_plans.price_yearly                   yes     numeric(10,2)  null or >= 0 (new)
--   order_line_items.card_refunded_amount           yes     numeric(10,2)  >= 0 (new)
--   order_line_items.discount_amount                yes     numeric(10,2)  >= 0 and <= line_total (new)
--   order_line_items.system_unit_price              yes     numeric(10,2)  null or >= 0 (new)
--   pending_reader_payments.expected_amount         yes     numeric(10,2)  >= 0 (new)
--   promo_code_redemptions.discount_amount          yes     numeric(10,2)  >= 0 (already there)
--   promo_codes.min_spend                           yes     numeric(10,2)  null or >= 0 (already there)
--   promo_codes.discount_value                      NO      left `numeric` unchanged (already: > 0, and <= 100 for a percentage)
--
-- Left as it is, and why:
--  - promo_codes.discount_value is pounds for a fixed code and a PERCENTAGE for a percentage code (10 = 10%). A
--    percentage isn't money, and nothing says it must stop at two decimal places (12.5% is fine today; 33.333% would
--    be rounded). Its two checks already hold it above 0 and, for a percentage, at most 100.
--
-- "At most the line" is checked only where the line's own amount is on the same row AND every statement that writes
-- the column keeps within it by construction:
--  - addon_order_lines: what went back is never more than the line cost (price_at_purchase * quantity), and the card's
--    share is never more than what went back. Every writer builds the figures that way (the Worker's stampAddonLines,
--    cancelShares, the "arrived" and "owed settled" stamps, and the refund watch's take-off, which lowers both by the
--    same amount).
--  - order_line_items.discount_amount: a promo's share of a line is never more than the line.
-- Not checked against the line, on purpose (a check that refused one of these writes would stop a refund's own
-- record, after the money had moved, and hold it for a person):
--  - order_line_items.card_refunded_amount: Refund the rest on an order records an event booking's owed card money on
--    the order's event line, which can be more than that line (W47 review L6: £24 on a £10 place).
--  - event_attendees.cancelled_value / refunded_amount / card_refunded_amount: a booking's refund is shared out by
--    each place's unit price with the rounding's remainder on the last place, so one place's share can't be shown to
--    stay within its own unit price to the penny.
--
-- Safe with the Worker and the staff app that are live today (Worker 69545e4, staff app 83d5fea) and with W53's: both
-- write these columns only with figures already rounded to the penny, and read them as text or as numbers. The one
-- thing that changes for a reader is the text: a plain `numeric` prints 12 or 4.5, `numeric(10,2)` prints 12.00 or
-- 4.50. Every screen formats these as money (formatCurrency), and the Worker parses them as numbers.
--
-- Locks: each ALTER ... TYPE rewrites its table under an ACCESS EXCLUSIVE lock (reads wait too). The seven tables are
-- small (hundreds of rows), so each takes milliseconds; set `lock_timeout` to 5s before applying, as for 031, so the
-- file gives up rather than queue behind a long transaction. One transaction: all of it, or none.
--
-- PRE-CHECK (read-only; the lead runs it first). Expect 0 in every `bad` column; if any isn't 0, stop and tell the
-- builder: the file would stop on it too, changing nothing (part 1 below makes the same checks).
--
--   SELECT 'addon_order_lines' AS tbl,
--          count(*) FILTER (WHERE card_refunded_amount <> round(card_refunded_amount, 2) OR refunded_amount <> round(refunded_amount, 2)) AS bad_decimals,
--          count(*) FILTER (WHERE refunded_amount > price_at_purchase * quantity) AS bad_refunded_over_line,
--          count(*) FILTER (WHERE card_refunded_amount > refunded_amount) AS bad_card_over_refunded
--     FROM public.addon_order_lines
--   UNION ALL
--   SELECT 'event_attendees',
--          count(*) FILTER (WHERE cancelled_value <> round(cancelled_value, 2) OR refunded_amount <> round(refunded_amount, 2) OR card_refunded_amount <> round(card_refunded_amount, 2)),
--          0, 0
--     FROM public.event_attendees
--   UNION ALL
--   SELECT 'membership_payment_date_changes', count(*) FILTER (WHERE amount_charged <> round(amount_charged, 2)), 0, 0
--     FROM public.membership_payment_date_changes
--   UNION ALL
--   SELECT 'membership_plans',
--          count(*) FILTER (WHERE price_monthly <> round(price_monthly, 2) OR price_yearly <> round(price_yearly, 2)),
--          count(*) FILTER (WHERE price_monthly < 0 OR price_yearly < 0), 0
--     FROM public.membership_plans
--   UNION ALL
--   SELECT 'order_line_items',
--          count(*) FILTER (WHERE card_refunded_amount <> round(card_refunded_amount, 2) OR discount_amount <> round(discount_amount, 2) OR system_unit_price <> round(system_unit_price, 2)),
--          count(*) FILTER (WHERE card_refunded_amount < 0 OR discount_amount < 0 OR system_unit_price < 0),
--          count(*) FILTER (WHERE discount_amount > line_total)
--     FROM public.order_line_items
--   UNION ALL
--   SELECT 'pending_reader_payments', count(*) FILTER (WHERE expected_amount <> round(expected_amount, 2)), count(*) FILTER (WHERE expected_amount < 0), 0
--     FROM public.pending_reader_payments
--   UNION ALL
--   SELECT 'promo_code_redemptions', count(*) FILTER (WHERE discount_amount <> round(discount_amount, 2)), 0, 0
--     FROM public.promo_code_redemptions
--   UNION ALL
--   SELECT 'promo_codes', count(*) FILTER (WHERE min_spend <> round(min_spend, 2)), 0, 0
--     FROM public.promo_codes;
--
--   -- And nothing too large for numeric(10,2) (expect 0):
--   SELECT (SELECT count(*) FROM public.addon_order_lines WHERE abs(card_refunded_amount) >= 100000000 OR abs(refunded_amount) >= 100000000)
--        + (SELECT count(*) FROM public.event_attendees WHERE abs(cancelled_value) >= 100000000 OR abs(refunded_amount) >= 100000000 OR abs(card_refunded_amount) >= 100000000)
--        + (SELECT count(*) FROM public.membership_payment_date_changes WHERE abs(amount_charged) >= 100000000)
--        + (SELECT count(*) FROM public.membership_plans WHERE abs(price_monthly) >= 100000000 OR abs(price_yearly) >= 100000000)
--        + (SELECT count(*) FROM public.order_line_items WHERE abs(card_refunded_amount) >= 100000000 OR abs(discount_amount) >= 100000000 OR abs(system_unit_price) >= 100000000)
--        + (SELECT count(*) FROM public.pending_reader_payments WHERE abs(expected_amount) >= 100000000)
--        + (SELECT count(*) FROM public.promo_code_redemptions WHERE abs(discount_amount) >= 100000000)
--        + (SELECT count(*) FROM public.promo_codes WHERE abs(min_spend) >= 100000000) AS too_large;

-- 1. Stop, changing nothing, if any row wouldn't fit. ALTER ... TYPE numeric(10,2) ROUNDS a figure with more decimal
--    places without a word, so this is the only thing that says a figure would change; a row that would fail a new
--    check is named here too, in plain words, before any table is touched.
DO $$
DECLARE
  problems text := '';
  bad bigint;
  money record;
BEGIN
  FOR money IN
    SELECT * FROM (VALUES
      ('addon_order_lines', 'card_refunded_amount'),
      ('addon_order_lines', 'refunded_amount'),
      ('event_attendees', 'cancelled_value'),
      ('event_attendees', 'card_refunded_amount'),
      ('event_attendees', 'refunded_amount'),
      ('membership_payment_date_changes', 'amount_charged'),
      ('membership_plans', 'price_monthly'),
      ('membership_plans', 'price_yearly'),
      ('order_line_items', 'card_refunded_amount'),
      ('order_line_items', 'discount_amount'),
      ('order_line_items', 'system_unit_price'),
      ('pending_reader_payments', 'expected_amount'),
      ('promo_code_redemptions', 'discount_amount'),
      ('promo_codes', 'min_spend')
    ) AS columns(tbl, col)
  LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE %I <> round(%I, 2) OR abs(%I) >= 100000000', money.tbl, money.col, money.col, money.col) INTO bad;
    IF bad > 0 THEN
      problems := problems || format(' %s.%s has %s row(s) that are not pounds and pence (more than two decimal places, or too large).', money.tbl, money.col, bad);
    END IF;
  END LOOP;

  SELECT count(*) INTO bad FROM public.addon_order_lines WHERE refunded_amount > price_at_purchase * quantity;
  IF bad > 0 THEN problems := problems || format(' addon_order_lines has %s row(s) refunded more than the line cost.', bad); END IF;
  SELECT count(*) INTO bad FROM public.addon_order_lines WHERE card_refunded_amount > refunded_amount;
  IF bad > 0 THEN problems := problems || format(' addon_order_lines has %s row(s) with more back to the card than was refunded.', bad); END IF;
  SELECT count(*) INTO bad FROM public.membership_plans WHERE price_monthly < 0 OR price_yearly < 0;
  IF bad > 0 THEN problems := problems || format(' membership_plans has %s row(s) with a price below 0.', bad); END IF;
  SELECT count(*) INTO bad FROM public.order_line_items WHERE card_refunded_amount < 0 OR discount_amount < 0 OR system_unit_price < 0;
  IF bad > 0 THEN problems := problems || format(' order_line_items has %s row(s) with a figure below 0.', bad); END IF;
  SELECT count(*) INTO bad FROM public.order_line_items WHERE discount_amount > line_total;
  IF bad > 0 THEN problems := problems || format(' order_line_items has %s row(s) with a discount larger than the line.', bad); END IF;
  SELECT count(*) INTO bad FROM public.pending_reader_payments WHERE expected_amount < 0;
  IF bad > 0 THEN problems := problems || format(' pending_reader_payments has %s row(s) with an amount below 0.', bad); END IF;

  IF problems <> '' THEN
    RAISE EXCEPTION 'Migration 033 stopped and changed nothing:%', problems;
  END IF;
END $$;

-- 2. The fourteen money columns, to the penny. Each column keeps its default, its NOT NULL and the checks it has.
ALTER TABLE public.addon_order_lines
  ALTER COLUMN card_refunded_amount TYPE numeric(10,2),
  ALTER COLUMN refunded_amount TYPE numeric(10,2);

ALTER TABLE public.event_attendees
  ALTER COLUMN cancelled_value TYPE numeric(10,2),
  ALTER COLUMN card_refunded_amount TYPE numeric(10,2),
  ALTER COLUMN refunded_amount TYPE numeric(10,2);

ALTER TABLE public.membership_payment_date_changes
  ALTER COLUMN amount_charged TYPE numeric(10,2);

ALTER TABLE public.membership_plans
  ALTER COLUMN price_monthly TYPE numeric(10,2),
  ALTER COLUMN price_yearly TYPE numeric(10,2);

ALTER TABLE public.order_line_items
  ALTER COLUMN card_refunded_amount TYPE numeric(10,2),
  ALTER COLUMN discount_amount TYPE numeric(10,2),
  ALTER COLUMN system_unit_price TYPE numeric(10,2);

ALTER TABLE public.pending_reader_payments
  ALTER COLUMN expected_amount TYPE numeric(10,2);

ALTER TABLE public.promo_code_redemptions
  ALTER COLUMN discount_amount TYPE numeric(10,2);

ALTER TABLE public.promo_codes
  ALTER COLUMN min_spend TYPE numeric(10,2);

-- 3. The checks that weren't there. Each is added once (the file can be run again), and each validates every
--    existing row as it is added: part 1 has already said, in plain words, if one wouldn't pass.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'addon_order_lines_refunded_within_line_check') THEN
    ALTER TABLE public.addon_order_lines
      ADD CONSTRAINT addon_order_lines_refunded_within_line_check CHECK (refunded_amount <= price_at_purchase * quantity);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'addon_order_lines_card_within_refunded_check') THEN
    ALTER TABLE public.addon_order_lines
      ADD CONSTRAINT addon_order_lines_card_within_refunded_check CHECK (card_refunded_amount <= refunded_amount);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'membership_plans_price_monthly_check') THEN
    ALTER TABLE public.membership_plans
      ADD CONSTRAINT membership_plans_price_monthly_check CHECK (price_monthly IS NULL OR price_monthly >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'membership_plans_price_yearly_check') THEN
    ALTER TABLE public.membership_plans
      ADD CONSTRAINT membership_plans_price_yearly_check CHECK (price_yearly IS NULL OR price_yearly >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_line_items_card_refunded_amount_check') THEN
    ALTER TABLE public.order_line_items
      ADD CONSTRAINT order_line_items_card_refunded_amount_check CHECK (card_refunded_amount >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_line_items_discount_amount_check') THEN
    ALTER TABLE public.order_line_items
      ADD CONSTRAINT order_line_items_discount_amount_check CHECK (discount_amount >= 0 AND discount_amount <= line_total);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_line_items_system_unit_price_check') THEN
    ALTER TABLE public.order_line_items
      ADD CONSTRAINT order_line_items_system_unit_price_check CHECK (system_unit_price IS NULL OR system_unit_price >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pending_reader_payments_expected_amount_check') THEN
    ALTER TABLE public.pending_reader_payments
      ADD CONSTRAINT pending_reader_payments_expected_amount_check CHECK (expected_amount >= 0);
  END IF;
END $$;

-- AFTER APPLYING (read-only; the lead runs these).
--
-- A. The types. Expect 15 rows: the fourteen columns `numeric` with precision 10 and scale 2, and
--    promo_codes.discount_value `numeric` with no precision (null, null).
--   SELECT table_name, column_name, data_type, numeric_precision, numeric_scale
--     FROM information_schema.columns
--    WHERE table_schema = 'public'
--      AND (table_name, column_name) IN (
--        ('addon_order_lines', 'card_refunded_amount'), ('addon_order_lines', 'refunded_amount'),
--        ('event_attendees', 'cancelled_value'), ('event_attendees', 'card_refunded_amount'), ('event_attendees', 'refunded_amount'),
--        ('membership_payment_date_changes', 'amount_charged'),
--        ('membership_plans', 'price_monthly'), ('membership_plans', 'price_yearly'),
--        ('order_line_items', 'card_refunded_amount'), ('order_line_items', 'discount_amount'), ('order_line_items', 'system_unit_price'),
--        ('pending_reader_payments', 'expected_amount'),
--        ('promo_code_redemptions', 'discount_amount'),
--        ('promo_codes', 'min_spend'), ('promo_codes', 'discount_value'))
--    ORDER BY table_name, column_name;
--
-- B. No plain `numeric` money column is left. Expect exactly one row: promo_codes.discount_value.
--   SELECT table_name, column_name FROM information_schema.columns
--    WHERE table_schema = 'public' AND data_type = 'numeric' AND numeric_precision IS NULL
--    ORDER BY table_name, column_name;
--
-- C. The eight new checks are there and valid. Expect 8 rows, each `convalidated` true.
--   SELECT conrelid::regclass AS tbl, conname, convalidated, pg_get_constraintdef(oid) AS def
--     FROM pg_constraint
--    WHERE conname IN ('addon_order_lines_refunded_within_line_check', 'addon_order_lines_card_within_refunded_check',
--                      'membership_plans_price_monthly_check', 'membership_plans_price_yearly_check',
--                      'order_line_items_card_refunded_amount_check', 'order_line_items_discount_amount_check',
--                      'order_line_items_system_unit_price_check', 'pending_reader_payments_expected_amount_check')
--    ORDER BY conname;
--
-- D. Nothing was changed by the type change: run the PRE-CHECK's first query again. Expect the same zeros.
--
-- Then refresh the Worker's test schema from the live catalog (web/server/rules/testing/README.md, "Refreshing the
-- live schema") and run `npm run schema:test -- --check`. The W53 builder made the saved schema carry these changes
-- from a real Postgres 17.6 with this file applied, so the refresh should show no difference at all.
--
-- Down (if ever needed; safe at any time: plain `numeric` holds every numeric(10,2) value):
--   ALTER TABLE public.pending_reader_payments DROP CONSTRAINT IF EXISTS pending_reader_payments_expected_amount_check;
--   ALTER TABLE public.order_line_items DROP CONSTRAINT IF EXISTS order_line_items_system_unit_price_check;
--   ALTER TABLE public.order_line_items DROP CONSTRAINT IF EXISTS order_line_items_discount_amount_check;
--   ALTER TABLE public.order_line_items DROP CONSTRAINT IF EXISTS order_line_items_card_refunded_amount_check;
--   ALTER TABLE public.membership_plans DROP CONSTRAINT IF EXISTS membership_plans_price_yearly_check;
--   ALTER TABLE public.membership_plans DROP CONSTRAINT IF EXISTS membership_plans_price_monthly_check;
--   ALTER TABLE public.addon_order_lines DROP CONSTRAINT IF EXISTS addon_order_lines_card_within_refunded_check;
--   ALTER TABLE public.addon_order_lines DROP CONSTRAINT IF EXISTS addon_order_lines_refunded_within_line_check;
--   ALTER TABLE public.promo_codes ALTER COLUMN min_spend TYPE numeric;
--   ALTER TABLE public.promo_code_redemptions ALTER COLUMN discount_amount TYPE numeric;
--   ALTER TABLE public.pending_reader_payments ALTER COLUMN expected_amount TYPE numeric;
--   ALTER TABLE public.order_line_items ALTER COLUMN card_refunded_amount TYPE numeric, ALTER COLUMN discount_amount TYPE numeric, ALTER COLUMN system_unit_price TYPE numeric;
--   ALTER TABLE public.membership_plans ALTER COLUMN price_monthly TYPE numeric, ALTER COLUMN price_yearly TYPE numeric;
--   ALTER TABLE public.membership_payment_date_changes ALTER COLUMN amount_charged TYPE numeric;
--   ALTER TABLE public.event_attendees ALTER COLUMN cancelled_value TYPE numeric, ALTER COLUMN card_refunded_amount TYPE numeric, ALTER COLUMN refunded_amount TYPE numeric;
--   ALTER TABLE public.addon_order_lines ALTER COLUMN card_refunded_amount TYPE numeric, ALTER COLUMN refunded_amount TYPE numeric;
