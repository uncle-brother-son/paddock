import { requireStaffId, resolveStaffId } from './shared/resolveStaffId'

export interface SetAddonLinePreparedParams {
  lineId: string
  prepared: boolean
}

export default async function setAddonLinePrepared(
  req: { params: SetAddonLinePreparedParams; user: User }
) {
  // Refuses an inactive account before anything happens.
  await resolveStaffId(req.user.email)
  const { lineId, prepared } = req.params

  if (prepared) {
    const preparedBy = await requireStaffId(req.user.email)
    const result = await paddockData.query(
      `UPDATE addon_order_lines
       SET prepared = true, prepared_at = now(), prepared_by = $1
       WHERE id = $2
       RETURNING *`,
      [preparedBy, lineId]
    )
    return result.data[0] ?? null
  }

  const result = await paddockData.query(
    `UPDATE addon_order_lines
     SET prepared = false, prepared_at = NULL, prepared_by = NULL
     WHERE id = $1
     RETURNING *`,
    [lineId]
  )
  return result.data[0] ?? null
}
