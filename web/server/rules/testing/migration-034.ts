import { readFileSync } from 'node:fs'
import path from 'node:path'

// Brief W68 item 5 (H-plan H9, H10, H11; the W45 audit's rows 20 and 59): migration 034 is written but NOT applied to live, and
// the saved schema (live-catalog.json, live-schema.sql) is left as live is today: the lead applies 034 after W68's review,
// once the W68 Worker is live, then refreshes the saved schema. Kept here: the file, its Down, and what it drops as live had it, so
// migration-034.test.ts reads the same before and after that refresh. Tests only.

export const MIGRATION_034 = path.resolve(__dirname, '../../../../supabase/migrations/034_step_h_leftovers.sql')
export const migration034 = (): string => readFileSync(MIGRATION_034, 'utf8')

/** The nightly job's function. */
export const GENERATOR = 'generate_upcoming_sessions'
/** The audit log's new index. */
export const AUDIT_INDEX = 'audit_log_action_entity_idx'
/** The duplicate email index 034 drops. */
export const EMAIL_INDEX = 'idx_customers_email'

/** The lines of the nightly job 034 changes: the times it makes, as they were and as 034 leaves them. */
export const JOB_TIMES_BEFORE_034 = [
  '  select svc.id, (d.day + sl.start_time),',
  "         (d.day + sl.start_time) + (svc.duration || ' minutes')::interval,",
] as const
export const JOB_TIMES_034 = [
  "  -- 034 (H11): a session's time is London's wall-clock digits stored as UTC, named here, so the row is the same",
  '  -- whatever zone the connection running the job is in.',
  "  select svc.id, ((d.day + sl.start_time) at time zone 'UTC'),",
  "         ((d.day + sl.start_time) at time zone 'UTC') + (svc.duration || ' minutes')::interval,",
] as const

const DOWN_MARK = '-- Down ('
/** The file's Down, as SQL: the lines under its "Down" heading, each behind `--   `. */
export function down034(): string {
  const sql = migration034()
  const from = sql.indexOf(DOWN_MARK)
  if (from < 0) throw new Error("Migration 034's Down wasn't found.")
  return sql
    .slice(from)
    .split('\n')
    .slice(1)
    .map((line) => line.replace(/^-- {3}/, '').replace(/^--$/, ''))
    .join('\n')
    .trim()
}

/** The nightly job as it was before 034: the second statement of the file's Down. */
export function jobBefore034(): string {
  const sql = down034()
  return `${sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION')).replace(/;$/, '')}\n`
}

/**
 * What 034 drops, put back as live had it before (the drops have no Down: this is for the test alone, so it can start from
 * before 034 whether or not the saved schema carries it).
 */
export const DROPPED_BY_034_SQL = `
ALTER TABLE public.service_types ADD COLUMN IF NOT EXISTS price numeric(10,2);
CREATE TABLE IF NOT EXISTS public.parity_log (
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  at timestamp with time zone DEFAULT now() NOT NULL,
  action text NOT NULL,
  request_id text,
  old_result jsonb,
  new_result jsonb,
  matches boolean NOT NULL,
  diff jsonb
);
CREATE INDEX IF NOT EXISTS parity_log_action_idx ON public.parity_log USING btree (action, at DESC);
CREATE OR REPLACE VIEW public.membership_credit_period_balances AS
SELECT p.id,
    p.membership_id,
    p.period_start,
    p.period_end,
    p.credits_allocated,
    p.is_unlimited,
    count(b.id) AS credits_used,
        CASE
            WHEN p.is_unlimited THEN NULL::bigint
            ELSE p.credits_allocated - count(b.id)
        END AS credits_remaining
   FROM membership_credit_periods p
     LEFT JOIN bookings b ON b.credit_period_id = p.id AND b.redemption_source = 'membership_credit'::text AND (b.status = ANY (ARRAY['pending'::text, 'confirmed'::text, 'completed'::text, 'no-show'::text]))
  GROUP BY p.id;
CREATE OR REPLACE FUNCTION public.purge_parity_log()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE n integer;
BEGIN
  DELETE FROM parity_log WHERE at < now() - interval '30 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $function$;
CREATE OR REPLACE FUNCTION public.membership_period_for(p_anchor date, p_day date)
 RETURNS TABLE(period_start date, period_end date)
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
DECLARE
  n INTEGER;
BEGIN
  IF p_day < p_anchor THEN
    RETURN;
  END IF;
  n := (EXTRACT(YEAR FROM p_day)::INTEGER - EXTRACT(YEAR FROM p_anchor)::INTEGER) * 12
     + (EXTRACT(MONTH FROM p_day)::INTEGER - EXTRACT(MONTH FROM p_anchor)::INTEGER);
  WHILE (p_anchor + make_interval(months => n))::DATE > p_day LOOP
    n := n - 1;
  END LOOP;
  WHILE (p_anchor + make_interval(months => n + 1))::DATE <= p_day LOOP
    n := n + 1;
  END LOOP;
  period_start := (p_anchor + make_interval(months => n))::DATE;
  period_end   := (p_anchor + make_interval(months => n + 1))::DATE - 1;
  RETURN NEXT;
END;
$function$;
CREATE OR REPLACE FUNCTION public.lapse_sweep_expired_bookings()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE n integer := 0; r record;
BEGIN
  FOR r IN
    SELECT b.id, b.session_id, b.party_size
    FROM bookings b
    WHERE b.status = 'payment_needed' AND b.payment_due_by <= now() AND COALESCE(b.price_paid, 0) = 0
    FOR UPDATE OF b
  LOOP
    UPDATE bookings SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'membership_lapsed', updated_at = now()
    WHERE id = r.id;
    UPDATE sessions SET total_booked = GREATEST(total_booked - r.party_size, 0), updated_at = now()
    WHERE id = r.session_id;
    n := n + 1;
  END LOOP;
  RETURN n;
END $function$;
`
