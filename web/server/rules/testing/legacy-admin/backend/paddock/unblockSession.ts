import { resolveStaffId } from './shared/resolveStaffId'

export interface UnblockSessionParams {
  sessionId: string
}

export default async function unblockSession(req: { params: UnblockSessionParams; user: User }) {
  // Refuses an inactive account before anything happens.
  await resolveStaffId(req.user.email)
  const { sessionId } = req.params
  const result = await paddockData.query(
    `UPDATE sessions
     SET status = 'open', blocked_reason = NULL, blocked_by = NULL, updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [sessionId]
  )
  return result.data[0] ?? null
}
