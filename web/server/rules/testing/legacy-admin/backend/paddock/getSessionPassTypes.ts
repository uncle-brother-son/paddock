export interface SessionPassTypeRow {
  id: string
  sanity_pass_type_id: string | null
  name: string
  thumbnail_url: string | null
  price: string
  sessions_included: number | null
  expiry_months: number | null
  /** 'core' passes can't be used on Peak sessions (pass_covers_session). */
  level: 'core' | 'all_access'
  stripe_product_id: string | null
  stripe_price_id: string | null
  active: boolean | null
  created_at: string
  updated_at: string
}

export interface GetSessionPassTypesParams {
  /** When given, each row also carries covers_session = pass_covers_session(type, session) — used
   *  to offer only pass types that can cover a booking's slot (a Core pass never covers Peak). */
  sessionId?: string
}

export default async function getSessionPassTypes(
  req?: { params?: GetSessionPassTypesParams }
): Promise<Array<SessionPassTypeRow & { covers_session?: boolean }>> {
  const sessionId = req?.params?.sessionId
  if (sessionId) {
    const result = await paddockData.query<SessionPassTypeRow & { covers_session: boolean }>(
      'SELECT spt.*, pass_covers_session(spt.id, $1) AS covers_session FROM session_pass_types spt ORDER BY spt.name',
      [sessionId]
    )
    return result.data
  }
  const result = await paddockData.query<SessionPassTypeRow>('SELECT * FROM session_pass_types ORDER BY name')
  return result.data
}
