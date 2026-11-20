import { readFileSync } from 'node:fs'
import path from 'node:path'

// Brief W47r-d item 1 (W47r-c report "Noticed" 1, fix a) and brief W47r-e item 2 (W47r-d report "Noticed" 2):
// migration 031 is written but NOT applied to live, and the saved schema (live-catalog.json, live-schema.sql) is left
// as live is today: the lead applies 031 after a diff check. So the tests that need 031 put it in themselves, from
// the migration file, and the tests that show what it mends start from the two functions as they were, kept here
// word for word. Both read the same before and after a refresh of the snapshot. Tests only.

export const MIGRATION_031 = path.resolve(__dirname, '../../../../supabase/migrations/031_a_payment_after_the_last_day_is_not_recorded.sql')
/** The function the Worker calls for a payment: Stripe's invoice.paid notice, the read after a failed-payment notice's write, and "Try the payment again now". */
export const PAID = 'membership_mark_paid'
/** The function the Worker calls for a failed payment: Stripe's invoice.payment_failed notice, and the read after a payment's write. */
export const FAILED = 'membership_mark_payment_failed'

/** membership_mark_paid as live has it before 031 (live-catalog.json at W47r-e), and half of 031's "Down". */
export const PAID_BEFORE_031 = `CREATE OR REPLACE FUNCTION public.membership_mark_paid(p_stripe_subscription_id text, p_period_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE m customer_memberships%ROWTYPE; restored integer := 0; periods integer;
BEGIN
  SELECT * INTO m FROM customer_memberships WHERE stripe_subscription_id = p_stripe_subscription_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('found', false); END IF;
  IF m.subscription_status = 'cancelled' THEN
    RETURN jsonb_build_object('found', true, 'action', 'ignored_cancelled');
  END IF;
  UPDATE customer_memberships
  SET subscription_status = 'active',
      next_renewal_date = COALESCE((p_period_end AT TIME ZONE 'Europe/London')::date, next_renewal_date),
      updated_at = now()
  WHERE id = m.id;
  WITH r AS (
    UPDATE bookings SET status = 'confirmed', payment_due_by = NULL, updated_at = now()
    WHERE redeemed_membership_id = m.id AND redemption_source = 'membership_credit' AND status = 'payment_needed'
    RETURNING 1)
  SELECT count(*) INTO restored FROM r;
  SELECT public.allocate_membership_credit_periods() INTO periods;
  RETURN jsonb_build_object('found', true, 'action', 'reactivated', 'was', m.subscription_status,
                            'bookings_restored', restored, 'periods_created', periods);
END $function$
`

/** membership_mark_paid as 031 leaves it. */
export const PAID_AFTER_031 = `CREATE OR REPLACE FUNCTION public.membership_mark_paid(p_stripe_subscription_id text, p_period_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE m customer_memberships%ROWTYPE; restored integer := 0; periods integer;
BEGIN
  SELECT * INTO m FROM customer_memberships WHERE stripe_subscription_id = p_stripe_subscription_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('found', false); END IF;
  IF m.subscription_status = 'cancelled' THEN
    RETURN jsonb_build_object('found', true, 'action', 'ignored_cancelled');
  END IF;
  -- 031: the membership's last day has passed (London's date). Cancel was pressed here and the row keeps its status
  -- until Stripe ends the subscription, so a payment Stripe takes after that day pays for time the member does not
  -- have. Nothing is written for it; the Worker lists the payment for a refund (W47r-c, W47r-d).
  IF m.cancel_effective_date < (now() AT TIME ZONE 'Europe/London')::date THEN
    RETURN jsonb_build_object('found', true, 'action', 'ignored_cancelled', 'last_day', m.cancel_effective_date);
  END IF; -- 031
  UPDATE customer_memberships
  SET subscription_status = 'active',
      next_renewal_date = COALESCE((p_period_end AT TIME ZONE 'Europe/London')::date, next_renewal_date),
      updated_at = now()
  WHERE id = m.id;
  WITH r AS (
    UPDATE bookings SET status = 'confirmed', payment_due_by = NULL, updated_at = now()
    WHERE redeemed_membership_id = m.id AND redemption_source = 'membership_credit' AND status = 'payment_needed'
    RETURNING 1)
  SELECT count(*) INTO restored FROM r;
  SELECT public.allocate_membership_credit_periods() INTO periods;
  RETURN jsonb_build_object('found', true, 'action', 'reactivated', 'was', m.subscription_status,
                            'bookings_restored', restored, 'periods_created', periods);
END $function$
`

/** membership_mark_payment_failed as live has it before 031 (live-catalog.json at W47r-e), and the other half of 031's "Down". */
export const FAILED_BEFORE_031 = `CREATE OR REPLACE FUNCTION public.membership_mark_payment_failed(p_stripe_subscription_id text)
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

/** membership_mark_payment_failed as 031 leaves it. */
export const FAILED_AFTER_031 = `CREATE OR REPLACE FUNCTION public.membership_mark_payment_failed(p_stripe_subscription_id text)
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
  -- 031: the membership's last day has passed (London's date). It has ended here, whatever Stripe's subscription
  -- still does, so a payment that fails after that day does not mark it past due and flags no booking. Nothing is
  -- written for it; the Worker lists a subscription still live in Stripe for a person (W47r-e).
  IF m.cancel_effective_date < (now() AT TIME ZONE 'Europe/London')::date THEN
    RETURN jsonb_build_object('found', true, 'action', 'ignored_cancelled', 'last_day', m.cancel_effective_date);
  END IF; -- 031
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

/**
 * The line of each function that 031's lines go straight after: the end of its own "this membership has ended"
 * answer. It is the first line that reads so (membership_mark_payment_failed has a second, further down, from 030).
 */
export const ANCHOR_031 = '  END IF;'
/** The same, under its W47r-d name. */
export const PAID_ANCHOR_031 = ANCHOR_031

/** The lines 031 adds to membership_mark_paid, and nothing else. */
export const PAID_ADDED_031 = [
  "  -- 031: the membership's last day has passed (London's date). Cancel was pressed here and the row keeps its status",
  '  -- until Stripe ends the subscription, so a payment Stripe takes after that day pays for time the member does not',
  '  -- have. Nothing is written for it; the Worker lists the payment for a refund (W47r-c, W47r-d).',
  "  IF m.cancel_effective_date < (now() AT TIME ZONE 'Europe/London')::date THEN",
  "    RETURN jsonb_build_object('found', true, 'action', 'ignored_cancelled', 'last_day', m.cancel_effective_date);",
  '  END IF; -- 031',
]

/** The lines 031 adds to membership_mark_payment_failed, and nothing else: the same test and the same answer. */
export const FAILED_ADDED_031 = [
  "  -- 031: the membership's last day has passed (London's date). It has ended here, whatever Stripe's subscription",
  '  -- still does, so a payment that fails after that day does not mark it past due and flags no booking. Nothing is',
  '  -- written for it; the Worker lists a subscription still live in Stripe for a person (W47r-e).',
  "  IF m.cancel_effective_date < (now() AT TIME ZONE 'Europe/London')::date THEN",
  "    RETURN jsonb_build_object('found', true, 'action', 'ignored_cancelled', 'last_day', m.cancel_effective_date);",
  '  END IF; -- 031',
]

/** The migration file, whole. */
export const migration031 = (): string => readFileSync(MIGRATION_031, 'utf8')

/** The two functions as they were before 031, as a script (the file's Down). */
export const BEFORE_031_SQL = `${PAID_BEFORE_031.trimEnd()};\n\n${FAILED_BEFORE_031.trimEnd()};\n`

/** The two functions as the saved schema has them today (before the lead applies 031: the old ones; after the refresh: 031's). */
export function savedFunctionSql(): string {
  const catalog = JSON.parse(readFileSync(path.join(__dirname, 'live-catalog.json'), 'utf8')) as { functions: Array<{ name: string; definition: string }> }
  return [PAID, FAILED]
    .map((name) => {
      const saved = catalog.functions.find((fn) => fn.name === name)?.definition ?? ''
      if (saved === '') throw new Error(`The saved schema is missing migration 031's function ${name}.`)
      return `${saved.trimEnd()};\n`
    })
    .join('\n')
}

/** Whether the saved schema already has 031 (the lead has applied it and the snapshot was refreshed). */
export const savedSchemaHas031 = (): boolean => savedFunctionSql().includes(PAID_ADDED_031[3] as string)

/**
 * Runs a script on a test database (PGlite) as the tables' owner, then goes back to the Worker's role. CREATE OR
 * REPLACE keeps the function's grants, so the Worker's role can still call it.
 */
export async function asOwner(pg: { exec(sql: string): Promise<unknown> }, sql: string): Promise<void> {
  await pg.exec(`RESET ROLE;\n${sql}\nSET ROLE paddock_worker;`)
}
