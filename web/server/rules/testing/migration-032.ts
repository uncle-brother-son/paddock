import { readFileSync } from 'node:fs'
import path from 'node:path'

// Brief W51 item 1 (G-plan 4.5; bugs GB3 and W51-1; W50 review L3): migration 032 is written but NOT applied to live;
// the lead applies it after W51's review and before the Worker push. The saved schema (live-catalog.json,
// live-schema.sql) carries it already, as W27 did for 023, so every test runs against the schema live will have: the
// Worker's calendar read needs 032's table. Kept here: the two functions as they were before 032, word for word (the
// file's Down; what GB3's and W51-1's controls run; what the replay's recorded side runs), and the lines 032 adds.
// Tests only.

export const MIGRATION_032 = path.resolve(__dirname, '../../../../supabase/migrations/032_sessions_made_up_to_and_the_band_guard.sql')
/** The nightly job's function. */
export const GENERATOR = 'generate_upcoming_sessions'
/** The function a band-window save calls to re-band the sessions its new windows move. */
export const REBAND = 'reassign_session_bands'
/** 032's one-row table: the last date the nightly job has made sessions for, and the closed days it left out. */
export const MADE_UP_TO_TABLE = 'sessions_made_up_to'
/** 032's table of closed dates (W51a): Block Day writes a row, Unblock Day deletes it, the nightly job skips the date. */
export const CLOSED_DATES_TABLE = 'closed_dates'

/** generate_upcoming_sessions as live has it before 032, and the first part of 032's Down. */
export const GENERATOR_BEFORE_032 = `CREATE OR REPLACE FUNCTION public.generate_upcoming_sessions(horizon_days integer DEFAULT 98)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_edge date; v_target date; v_inserted int;
begin
  v_target := (now() at time zone 'Europe/London')::date + horizon_days;
  select coalesce(max(start_time)::date, (now() at time zone 'Europe/London')::date - 1)
    into v_edge from sessions;
  if v_edge >= v_target then return 0; end if;

  insert into sessions (service_type_id, start_time, end_time, type, capacity, status)
  select svc.id, (d.day + sl.start_time),
         (d.day + sl.start_time) + (svc.duration || ' minutes')::interval,
         svc.booking_type, svc.capacity, 'open'
  from generate_series((v_edge + 1)::timestamp, v_target::timestamp, interval '1 day') as g(day_ts)
  cross join lateral (select g.day_ts::date as day) d
  join service_type_schedule_slots sl on sl.day_of_week = extract(dow from d.day)::smallint
  join service_types svc on svc.id = sl.service_type_id
  where svc.active and svc.duration is not null and svc.duration > 0 and svc.booking_type is not null
  on conflict (service_type_id, start_time) do nothing;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end $function$
`

/**
 * Every place 032 changes generate_upcoming_sessions, in the order they come: the old lines taken out (`out`; none
 * where lines are only added, which then go in straight after the line `after`) and the lines put in (`in`). W51a
 * added closed dates: the days a run is for (the new range and the closed days an earlier run left out), one lock a
 * day, the closed ones left out of the insert and kept on the job's row.
 */
export interface GeneratorChange {
  /** For lines only added: the old line they follow. */
  after?: string
  out: readonly string[]
  in: readonly string[]
}
export const GENERATOR_DECLARE_BEFORE_032 = 'declare v_edge date; v_target date; v_inserted int;'
export const GENERATOR_DECLARE_032 = 'declare v_edge date; v_target date; v_inserted int; v_skipped date[]; v_days date[]; v_open date[]; v_closed date[];'
export const GENERATOR_GUARD_032 = [
  '  -- 032 (W51-1): the band guard, shared, before anything is written. A band-window save holds these rows, so a',
  '  -- session made here is banded by the windows the save leaves, and a save that starts later waits for this run.',
  '  perform 1 from session_bands order by id for share;',
]
export const GENERATOR_EDGE_BEFORE_032 = [
  "  select coalesce(max(start_time)::date, (now() at time zone 'Europe/London')::date - 1)",
  '    into v_edge from sessions;',
  '  if v_edge >= v_target then return 0; end if;',
]
export const GENERATOR_EDGE_032 = [
  "  -- 032 (GB3): the job's own date, not the furthest session. Locked, so two runs at once take turns. With no row",
  '  -- (a database never set up) it starts from today, and writes the row below.',
  '  select made_up_to, closed_days_skipped into v_edge, v_skipped from sessions_made_up_to where id for update;',
  "  if not found then v_edge := (now() at time zone 'Europe/London')::date - 1; v_skipped := '{}'; end if;",
]
/** W51a: the days a run is for, their locks, and which of them are closed. */
export const GENERATOR_DAYS_032 = [
  "  -- 032 (closed dates): the days this run is for. Each day after the job's date up to the target, and each closed",
  "  -- day an earlier run left out that hasn't passed. Then one lock for each, in date order: the lock Block Day,",
  '  -- Unblock Day and a one-off session take for their date, so no date is closed or reopened while this run makes it.',
  '  -- Then which of them are closed, read after the locks (a new statement sees what a press that held one committed).',
  "  select coalesce(array_agg(q.day order by q.day), '{}') into v_days",
  "    from (select g.day_ts::date as day from generate_series((v_edge + 1)::timestamp, v_target::timestamp, interval '1 day') as g(day_ts)",
  '          union',
  "          select s.day from unnest(v_skipped) as s(day) where s.day >= (now() at time zone 'Europe/London')::date) q;",
  "  if v_days = '{}' then return 0; end if;",
  "  perform pg_advisory_xact_lock(hashtextextended('session_day:' || to_char(l.day, 'YYYY-MM-DD'), 0)) from unnest(v_days) as l(day);",
  "  select coalesce(array_agg(q.day order by q.day) filter (where c.closed_on is null), '{}'),",
  "         coalesce(array_agg(q.day order by q.day) filter (where c.closed_on is not null), '{}')",
  '    into v_open, v_closed',
  '    from unnest(v_days) as q(day) left join closed_dates c on c.closed_on = q.day;',
]
export const GENERATOR_FROM_BEFORE_032 = "  from generate_series((v_edge + 1)::timestamp, v_target::timestamp, interval '1 day') as g(day_ts)"
export const GENERATOR_FROM_032 = '  from unnest(v_open) as g(day_ts)'
export const GENERATOR_MOVE_032 = [
  '  -- 032 (GB3): made up to the target, whether or not any slot fell on those days (never moved back by a run with a',
  '  -- shorter horizon). The closed days this run left out are kept, so a later run makes one that has been reopened.',
  '  insert into sessions_made_up_to (id, made_up_to, closed_days_skipped) values (true, greatest(v_edge, v_target), v_closed)',
  '  on conflict (id) do update set made_up_to = excluded.made_up_to, closed_days_skipped = excluded.closed_days_skipped, updated_at = now();',
]
export const GENERATOR_CHANGES_032: readonly GeneratorChange[] = [
  { out: [GENERATOR_DECLARE_BEFORE_032], in: [GENERATOR_DECLARE_032] },
  { after: 'begin', out: [], in: GENERATOR_GUARD_032 },
  { out: GENERATOR_EDGE_BEFORE_032, in: [...GENERATOR_EDGE_032, ...GENERATOR_DAYS_032] },
  { out: [GENERATOR_FROM_BEFORE_032], in: [GENERATOR_FROM_032] },
  { after: '  get diagnostics v_inserted = row_count;', out: [], in: GENERATOR_MOVE_032 },
]

/** Where a run of lines sits in a list, once and only once. */
function runAt(lines: readonly string[], run: readonly string[]): number {
  const at = lines.flatMap((_, index) => (run.every((line, offset) => lines[index + offset] === line) ? [index] : []))
  if (at.length !== 1) throw new Error(`Expected these lines once in generate_upcoming_sessions, found them ${at.length} times: ${run[0] ?? ''}`)
  return at[0] as number
}

/** generate_upcoming_sessions as 032 leaves it: the old function with the changes above, and nothing else changed. */
export function generatorAfter032(): string {
  let lines = GENERATOR_BEFORE_032.split('\n')
  for (const change of GENERATOR_CHANGES_032) {
    const from = change.after !== undefined ? runAt(lines, [change.after]) + 1 : runAt(lines, change.out)
    lines = [...lines.slice(0, from), ...change.in, ...lines.slice(from + change.out.length)]
  }
  return lines.join('\n')
}

/** The other way: 032's function with each change taken back out. The old function, if nothing else was changed. */
export function generatorBackFrom032(after: string): string {
  let lines = after.split('\n')
  for (const change of [...GENERATOR_CHANGES_032].reverse()) {
    const from = runAt(lines, change.in)
    lines = [...lines.slice(0, from), ...change.out, ...lines.slice(from + change.in.length)]
  }
  return lines.join('\n')
}

/** reassign_session_bands as live has it before 032, and the second part of 032's Down. */
export const REBAND_BEFORE_032 = `CREATE OR REPLACE FUNCTION public.reassign_session_bands(p_from timestamp with time zone DEFAULT now())
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE sessions s
  SET band_id = band_for_session_start(s.start_time)
  WHERE s.type = 'public'
    AND s.band_overridden = false
    AND s.start_time >= p_from
    AND s.band_id IS DISTINCT FROM band_for_session_start(s.start_time);

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$
`
/** The one line of reassign_session_bands 032 changes (its parameter's default), as Postgres 17.6 prints each. */
export const REBAND_FIRST_LINE_BEFORE_032 = 'CREATE OR REPLACE FUNCTION public.reassign_session_bands(p_from timestamp with time zone DEFAULT now())'
export const REBAND_FIRST_LINE_032 = "CREATE OR REPLACE FUNCTION public.reassign_session_bands(p_from timestamp with time zone DEFAULT ((now() AT TIME ZONE 'Europe/London'::text) AT TIME ZONE 'UTC'::text))"
/** reassign_session_bands as 032 leaves it. */
export const rebandAfter032 = (): string => REBAND_BEFORE_032.replace(REBAND_FIRST_LINE_BEFORE_032, REBAND_FIRST_LINE_032)

/** The migration file, whole. */
export const migration032 = (): string => readFileSync(MIGRATION_032, 'utf8')

/** The file's lines, and where its two function statements start and end. */
export const functionParts032 = (): { lines: string[]; starts: number[]; ends: number[] } => {
  const lines = migration032().split('\n')
  const starts = lines.flatMap((line, index) => (line.startsWith('CREATE OR REPLACE FUNCTION') ? [index] : []))
  const ends = lines.flatMap((line, index) => (line === 'end $function$;' || line === '$function$;' ? [index] : []))
  return { lines, starts, ends }
}
/**
 * One of the FILE's function statements (0: the nightly job, 1: re-banding), as the catalogue gives a function. A
 * test that runs the job installs it from here, so it runs what the lead will apply and a fault in the file is
 * caught by what the job does, not only by its text.
 */
export const functionStatement032 = (which: number): string => {
  const { lines, starts, ends } = functionParts032()
  return `${lines.slice(starts[which], (ends[which] ?? 0) + 1).join('\n').replace(/;$/, '')}\n`
}
/** The nightly job as the migration FILE has it, as a statement the tables' owner can run. */
export const generatorFromFile032Sql = (): string => `${functionStatement032(0).trimEnd()};`

const DOWN_MARK = '-- Down (the two functions as they were before 032, then the two tables gone):'
/** The Down in the file's footer, with its comment marks taken off: a script that can be run as written. */
export function down032(): string {
  const sql = migration032()
  const from = sql.indexOf(DOWN_MARK)
  if (from < 0) throw new Error("Migration 032's Down wasn't found.")
  return sql
    .slice(from)
    .split('\n')
    .slice(1)
    .map((line) => line.replace(/^-- {3}/, '').replace(/^--$/, ''))
    .join('\n')
    .trim()
}

/** The two functions as they were before 032, as a script. */
export const FUNCTIONS_BEFORE_032_SQL = `${GENERATOR_BEFORE_032.trimEnd()};\n\n${REBAND_BEFORE_032.trimEnd()};\n`

/**
 * The nightly job as it was before 032, under its own name, for the replay's recorded side: W48's recordings of the
 * job (the control, and GB3's) were made against it, and that is what their golden files hold. The Worker's side
 * runs the real one (replay/harness.ts, ReplaySide.nightlyJob).
 */
export const GENERATOR_BEFORE_032_NAME = 'generate_upcoming_sessions_before_032'
export const generatorBefore032UnderItsOwnNameSql = (): string => `${GENERATOR_BEFORE_032.replace('FUNCTION public.generate_upcoming_sessions(', `FUNCTION public.${GENERATOR_BEFORE_032_NAME}(`).trimEnd()};`

/**
 * Runs a script on a test database (PGlite) as the tables' owner, then goes back to the Worker's role. CREATE OR
 * REPLACE keeps the function's grants, so the Worker's role can still call it.
 */
export async function asOwner(pg: { exec(sql: string): Promise<unknown> }, sql: string): Promise<void> {
  await pg.exec(`RESET ROLE;\n${sql}\nSET ROLE paddock_worker;`)
}
