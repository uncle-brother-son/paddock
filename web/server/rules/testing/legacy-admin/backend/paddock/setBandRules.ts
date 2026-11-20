import { requireCanManagePricing } from './shared/pricingStaff'

export interface BandRuleInput {
  bandId: string
  /** "HH:MM" or "HH:MM:SS" — inclusive start of the window. */
  fromTime: string
  /** "HH:MM" or "HH:MM:SS" — exclusive end of the window (half-open [from, to); "24:00" allowed). */
  toTime: string
}

export interface SetBandRulesParams {
  /** 0 = Sunday .. 6 = Saturday. */
  dayOfWeek: number
  /** The COMPLETE set of windows for this day — replaces whatever is stored. */
  rules: BandRuleInput[]
}

export interface SetBandRulesResult {
  saved: boolean
  /** How many future, non-overridden public sessions were re-banded by
   *  reassign_session_bands(now()) after the save. */
  rebandedSessions: number
  rules?: { id: string; band_id: string; from_time: string; to_time: string }[]
}

function toMinutes(time: string): number {
  const [h, m] = time.split(':')
  const hours = Number.parseInt(h ?? '', 10)
  const minutes = Number.parseInt(m ?? '0', 10)
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return Number.NaN
  return hours * 60 + minutes
}

/** Renders minutes-since-midnight back as a "HH:MM:SS" time string (1440 → "24:00:00"). */
function toTimeString(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`
}

/**
 * Replaces one day's band time windows (band_rules). Validation is strict — the windows must
 * tile the whole day with no gaps and no overlaps (half-open [from, to), matching
 * band_for_session_start):
 *   - at least one window
 *   - first window starts at 00:00, last window ends at 24:00
 *   - sorted by start, each window starts exactly where the previous one ends
 *   - every band id must be a real band
 *
 * There is no cross-statement transaction on this resource, so the write is delete-then-insert
 * with the previous rows re-inserted if the inserts fail (best-effort compensation). After a
 * successful save, reassign_session_bands(now()) re-bands every future non-overridden public
 * session and the resulting count is returned for the UI to show.
 */
export default async function setBandRules(req: { params: SetBandRulesParams; user: User }): Promise<SetBandRulesResult> {
  await requireCanManagePricing(req.user.email)
  const { dayOfWeek, rules } = req.params

  if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
    throw new Error('Day of week must be a whole number from 0 (Sunday) to 6 (Saturday).')
  }
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new Error('At least one band window is required — the day must be fully covered.')
  }

  const parsed = rules.map((rule) => {
    const from = toMinutes(rule.fromTime)
    const to = toMinutes(rule.toTime)
    if (Number.isNaN(from) || Number.isNaN(to)) {
      throw new Error('Window times must be valid HH:MM times.')
    }
    if (to <= from) {
      throw new Error('Each window must end after it starts.')
    }
    if (from < 0 || to > 24 * 60) {
      throw new Error('Window times must fall within the day (00:00–24:00).')
    }
    return { bandId: rule.bandId, from, to }
  })

  parsed.sort((a, b) => a.from - b.from)

  // No gaps, no overlaps: the first window starts at midnight, each next window starts exactly
  // where the previous one ends, and the last one ends at midnight.
  if (parsed[0]!.from !== 0) {
    throw new Error('The first window must start at 00:00 — the day must be fully covered.')
  }
  for (let i = 1; i < parsed.length; i++) {
    if (parsed[i]!.from !== parsed[i - 1]!.to) {
      throw new Error('The windows have a gap or overlap — every minute of the day must belong to exactly one band.')
    }
  }
  if (parsed[parsed.length - 1]!.to !== 24 * 60) {
    throw new Error('The last window must end at 24:00 — the day must be fully covered.')
  }

  const bandIds = [...new Set(parsed.map((p) => p.bandId))]
  const bandCheck = await paddockData.query<{ id: string }>(
    `SELECT id FROM session_bands WHERE id = ANY($1::uuid[])`,
    [bandIds]
  )
  if (bandCheck.data.length !== bandIds.length) {
    throw new Error('One of the selected bands no longer exists.')
  }

  const previous = await paddockData.query<{ band_id: string; from_time: string; to_time: string }>(
    'SELECT band_id, from_time, to_time FROM band_rules WHERE day_of_week = $1',
    [dayOfWeek]
  )

  await paddockData.query('DELETE FROM band_rules WHERE day_of_week = $1', [dayOfWeek])
  try {
    const inserted: { id: string; band_id: string; from_time: string; to_time: string }[] = []
    for (const rule of parsed) {
      const result = await paddockData.query<{ id: string; band_id: string; from_time: string; to_time: string }>(
        `INSERT INTO band_rules (band_id, day_of_week, from_time, to_time)
         VALUES ($1, $2, $3, $4)
         RETURNING id, band_id, from_time, to_time`,
        [rule.bandId, dayOfWeek, toTimeString(rule.from), toTimeString(rule.to)]
      )
      const row = result.data[0]
      if (row) inserted.push(row)
    }

    // Re-band every future non-overridden public session under the new windows.
    const rebind = await paddockData.query<{ reassign_session_bands: number }>(
      'SELECT reassign_session_bands(now()) AS reassign_session_bands'
    )

    return { saved: true, rebandedSessions: Number(rebind.data[0]?.reassign_session_bands ?? 0), rules: inserted }
  } catch (err) {
    // Best-effort compensation: put the previous windows back so the day is never left
    // partially covered.
    for (const row of previous.data) {
      await paddockData.query(
        `INSERT INTO band_rules (band_id, day_of_week, from_time, to_time) VALUES ($1, $2, $3, $4)`,
        [row.band_id, dayOfWeek, row.from_time, row.to_time]
      )
    }
    throw err
  }
}
