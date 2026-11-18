import { readFileSync } from 'node:fs'
import path from 'node:path'

// Brief W46a item 1 (W46 report "Noticed" 1 and 2): migration 030 is written but NOT applied to live, and the saved
// schema (live-catalog.json, live-schema.sql) is left as live is today: the lead applies 030 after a diff check. So
// the tests that need 030 put it in themselves, from the migration file, and the tests that show what it mends start
// from the two functions as they were, kept here word for word. Both read the same before and after a refresh of the
// snapshot. Tests only.

export const MIGRATION_030 = path.resolve(__dirname, '../../../../supabase/migrations/030_a_failed_renewal_flags_the_period_it_did_not_pay_for.sql')
/** The function the webhook calls for a failed payment. */
export const FAILED = 'membership_mark_payment_failed'
/** The function the webhook calls when Stripe ends a subscription. */
export const ENDED = 'membership_mark_cancelled_by_stripe'

/** membership_mark_payment_failed as live has it before 030 (live-catalog.json at W46a), and half of 030's "Down". */
export const FAILED_BEFORE_030 = `CREATE OR REPLACE FUNCTION public.membership_mark_payment_failed(p_stripe_subscription_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE m customer_memberships%ROWTYPE; covered date; flagged integer;
BEGIN
  SELECT * INTO m FROM customer_memberships WHERE stripe_subscription_id = p_stripe_subscription_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('found', false); END IF;
  IF m.subscription_status = 'cancelled' THEN
    RETURN jsonb_build_object('found', true, 'action', 'ignored_cancelled');
  END IF;
  UPDATE customer_memberships SET subscription_status = 'past_due', updated_at = now() WHERE id = m.id;
  SELECT COALESCE(max(period_end), (now() AT TIME ZONE 'Europe/London')::date - 1) INTO covered
  FROM membership_credit_periods WHERE membership_id = m.id;
  flagged := public.flag_uncovered_credit_bookings(m.id, covered);
  RETURN jsonb_build_object('found', true, 'action', 'past_due', 'covered_through', covered, 'bookings_flagged', flagged);
END $function$
`

/** membership_mark_payment_failed as 030 leaves it. */
export const FAILED_AFTER_030 = `CREATE OR REPLACE FUNCTION public.membership_mark_payment_failed(p_stripe_subscription_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE m customer_memberships%ROWTYPE; covered date; flagged integer;
BEGIN
  SELECT * INTO m FROM customer_memberships WHERE stripe_subscription_id = p_stripe_subscription_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('found', false); END IF;
  IF m.subscription_status = 'cancelled' THEN
    RETURN jsonb_build_object('found', true, 'action', 'ignored_cancelled');
  END IF;
  UPDATE customer_memberships SET subscription_status = 'past_due', updated_at = now() WHERE id = m.id;
  SELECT COALESCE(max(period_end), (now() AT TIME ZONE 'Europe/London')::date - 1) INTO covered
  FROM membership_credit_periods WHERE membership_id = m.id;
  -- 030: a payment due today or earlier has not been made, so the period it was for is not covered, whatever credit
  -- period has already been allocated for it. Covered through the day before that payment was due.
  IF m.next_renewal_date <= (now() AT TIME ZONE 'Europe/London')::date THEN
    covered := m.next_renewal_date - 1;
  END IF;
  flagged := public.flag_uncovered_credit_bookings(m.id, covered);
  RETURN jsonb_build_object('found', true, 'action', 'past_due', 'covered_through', covered, 'bookings_flagged', flagged);
END $function$
`

/** membership_mark_cancelled_by_stripe as live has it before 030 (live-catalog.json at W46a), and the other half of 030's "Down". */
export const ENDED_BEFORE_030 = `CREATE OR REPLACE FUNCTION public.membership_mark_cancelled_by_stripe(p_stripe_subscription_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE m customer_memberships%ROWTYPE; covered date; today date := (now() AT TIME ZONE 'Europe/London')::date; flagged integer;
BEGIN
  SELECT * INTO m FROM customer_memberships WHERE stripe_subscription_id = p_stripe_subscription_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('found', false); END IF;
  -- Involuntary end (was past_due) or Stripe-side cancel: access ends today unless an end date was already set.
  covered := COALESCE(m.cancel_effective_date,
                      CASE WHEN m.subscription_status = 'past_due'
                           THEN (SELECT COALESCE(max(period_end), today - 1) FROM membership_credit_periods WHERE membership_id = m.id)
                           ELSE today END);
  UPDATE customer_memberships
  SET subscription_status = 'cancelled',
      cancel_effective_date = COALESCE(cancel_effective_date, covered),
      updated_at = now()
  WHERE id = m.id;
  flagged := public.flag_uncovered_credit_bookings(m.id, covered);
  RETURN jsonb_build_object('found', true, 'action', 'cancelled', 'covered_through', covered, 'bookings_flagged', flagged);
END $function$
`

/** membership_mark_cancelled_by_stripe as 030 leaves it. */
export const ENDED_AFTER_030 = `CREATE OR REPLACE FUNCTION public.membership_mark_cancelled_by_stripe(p_stripe_subscription_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE m customer_memberships%ROWTYPE; covered date; today date := (now() AT TIME ZONE 'Europe/London')::date; flagged integer;
BEGIN
  SELECT * INTO m FROM customer_memberships WHERE stripe_subscription_id = p_stripe_subscription_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('found', false); END IF;
  -- Involuntary end (was past_due) or Stripe-side cancel: access ends today unless an end date was already set.
  covered := COALESCE(m.cancel_effective_date,
                      CASE WHEN m.subscription_status = 'past_due'
                           THEN (SELECT COALESCE(max(period_end), today - 1) FROM membership_credit_periods WHERE membership_id = m.id)
                           ELSE today END);
  -- 030: past due with a payment due today or earlier: that payment was never made, so access ended the day before
  -- it was due, whatever credit period had already been allocated for it.
  IF m.cancel_effective_date IS NULL AND m.subscription_status = 'past_due' AND m.next_renewal_date <= today THEN
    covered := m.next_renewal_date - 1;
  END IF;
  UPDATE customer_memberships
  SET subscription_status = 'cancelled',
      cancel_effective_date = COALESCE(cancel_effective_date, covered),
      updated_at = now()
  WHERE id = m.id;
  flagged := public.flag_uncovered_credit_bookings(m.id, covered);
  RETURN jsonb_build_object('found', true, 'action', 'cancelled', 'covered_through', covered, 'bookings_flagged', flagged);
END $function$
`

/** The line of each function that 030's lines go straight after. */
export const FAILED_ANCHOR_030 = '  FROM membership_credit_periods WHERE membership_id = m.id;'
export const ENDED_ANCHOR_030 = '                           ELSE today END);'

/** The lines 030 adds to membership_mark_payment_failed, and nothing else. */
export const FAILED_ADDED_030 = [
  '  -- 030: a payment due today or earlier has not been made, so the period it was for is not covered, whatever credit',
  '  -- period has already been allocated for it. Covered through the day before that payment was due.',
  "  IF m.next_renewal_date <= (now() AT TIME ZONE 'Europe/London')::date THEN",
  '    covered := m.next_renewal_date - 1;',
  '  END IF;',
]

/** The lines 030 adds to membership_mark_cancelled_by_stripe, and nothing else. */
export const ENDED_ADDED_030 = [
  '  -- 030: past due with a payment due today or earlier: that payment was never made, so access ended the day before',
  '  -- it was due, whatever credit period had already been allocated for it.',
  "  IF m.cancel_effective_date IS NULL AND m.subscription_status = 'past_due' AND m.next_renewal_date <= today THEN",
  '    covered := m.next_renewal_date - 1;',
  '  END IF;',
]

/** The migration file, whole. */
export const migration030 = (): string => readFileSync(MIGRATION_030, 'utf8')

/** Both functions as they were before 030, as one script. */
export const BEFORE_030_SQL = `${ENDED_BEFORE_030.trimEnd()};\n${FAILED_BEFORE_030.trimEnd()};\n`

/** Both functions as the saved schema has them today (before the lead applies 030: the old ones; after the refresh: 030's). */
export function savedFunctionsSql(): string {
  const catalog = JSON.parse(readFileSync(path.join(__dirname, 'live-catalog.json'), 'utf8')) as { functions: Array<{ name: string; definition: string }> }
  const saved = [ENDED, FAILED].map((name) => catalog.functions.find((fn) => fn.name === name)?.definition ?? '')
  if (saved.some((definition) => definition === '')) throw new Error("The saved schema is missing one of migration 030's two functions.")
  return saved.map((definition) => `${definition.trimEnd()};\n`).join('')
}

/** Whether the saved schema already has 030 (the lead has applied it and the snapshot was refreshed). */
export const savedSchemaHas030 = (): boolean => savedFunctionsSql().includes(FAILED_ADDED_030[2] as string)

/**
 * Runs a script on a test database (PGlite) as the tables' owner, then goes back to the Worker's role. CREATE OR
 * REPLACE keeps each function's grants, so the Worker's role can still call them.
 */
export async function asOwner(pg: { exec(sql: string): Promise<unknown> }, sql: string): Promise<void> {
  await pg.exec(`RESET ROLE;\n${sql}\nSET ROLE paddock_worker;`)
}
