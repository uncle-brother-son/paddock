// New in W50 (W48 review L5; brief item 2): how a read picks a session's London day in SQL.
//
// A session's start_time (and an event's starts_at, and a booking's copy of its session's times) holds LONDON
// WALL-CLOCK DIGITS LABELLED UTC (web/CLAUDE.md "Session times"; london-time.ts): 00:30 on the wall in London on 1 July
// is stored as 2027-07-01 00:30:00+00. So the London day of a session is the date of those digits read as UTC. It is
// NOT the stored moment converted to London time: that would add the summer hour a second time and put a 23:30
// session on the next day.
//
// The old reads wrote `start_time::date`, which is the date in the CONNECTION's time zone. That is the same day only
// while the connection is on UTC (the Worker's connections and Supabase's default both are). These fragments read
// the digits as UTC whatever the connection is set to, so the day a read picks never depends on a setting. They
// compare the column itself against the day's two ends, so an index on the column can still be used.
//
// "Today" is never worked out here: the screens send London's today (the staff app's utils/londonDate.ts, as
// londonToday in london-time.ts), and a read takes the days it is given.

/** `column` is on or after the London day in `param` (a `$n` placeholder holding `YYYY-MM-DD`). */
export const onOrAfterLondonDaySql = (column: string, param: string): string => `${column} >= (${param}::date::timestamp AT TIME ZONE 'UTC')`

/** `column` is on or before the London day in `param`: before the first moment of the day after. */
export const onOrBeforeLondonDaySql = (column: string, param: string): string => `${column} < ((${param}::date + 1)::timestamp AT TIME ZONE 'UTC')`

/** `column` is on a London day from `fromParam` to `toParam`, both included. */
export const withinLondonDaysSql = (column: string, fromParam: string, toParam: string): string => `${onOrAfterLondonDaySql(column, fromParam)} AND ${onOrBeforeLondonDaySql(column, toParam)}`

/** The moment London's wall clock shows now, in the stored form: for "has this session's time passed" against a stored time. */
export const LONDON_WALL_CLOCK_NOW_SQL = "((now() AT TIME ZONE 'Europe/London') AT TIME ZONE 'UTC')"
