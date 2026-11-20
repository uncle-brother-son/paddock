import { requireCanManagePricing } from './shared/pricingStaff'

export interface ResetSessionBandParams {
  sessionId: string
}

export interface ResetSessionBandResult {
  reset: boolean
  reason?: 'session_not_found' | 'not_overridden'
  band?: { code: string; name: string } | null
}

/**
 * Staff action: return an overridden session (public or private) to automatic banding — sets
 * band_overridden = false and recomputes band_id from band_for_session_start(start_time), the
 * same rule the sessions_assign_band trigger applies. The session's own future quotes follow the
 * recomputed band; existing bookings keep the price they were charged.
 */
export default async function resetSessionBand(
  req: { params: ResetSessionBandParams; user: User }
): Promise<ResetSessionBandResult> {
  const { sessionId } = req.params

  // The permission guard and the session lookup are independent reads — run them in parallel.
  // Band resets apply to private sessions too — private pricing is band-based now.
  const [sessionLookup] = await Promise.all([
    paddockData.query<{ id: string; band_overridden: boolean }>(
      'SELECT id, band_overridden FROM sessions WHERE id = $1',
      [sessionId]
    ),
    requireCanManagePricing(req.user.email),
  ])
  const session = sessionLookup.data[0]
  if (!session) {
    return { reset: false, reason: 'session_not_found' }
  }
  if (!session.band_overridden) {
    return { reset: false, reason: 'not_overridden' }
  }

  const result = await paddockData.query<{ id: string; band_id: string | null }>(
    `UPDATE sessions s
     SET band_id = band_for_session_start(s.start_time), band_overridden = false, updated_at = now()
     WHERE s.id = $1
     RETURNING s.id, s.band_id`,
    [sessionId]
  )
  const row = result.data[0]
  if (!row) return { reset: false, reason: 'session_not_found' }

  const bandLookup = row.band_id
    ? await paddockData.query<{ code: string; name: string }>(
        'SELECT code, name FROM session_bands WHERE id = $1',
        [row.band_id]
      )
    : { data: [] as { code: string; name: string }[] }
  const band = bandLookup.data[0]
  return {
    reset: true,
    band: band ? { code: band.code, name: band.name } : null,
  }
}
