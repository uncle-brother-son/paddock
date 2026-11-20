import { resolveStaffId } from './shared/resolveStaffId'

export interface DeleteServiceTypeScheduleSlotParams {
  slotId: string
}

export default async function deleteServiceTypeScheduleSlot(
  req: { params: DeleteServiceTypeScheduleSlotParams; user: User }
) {
  // Refuses an inactive account before anything happens.
  await resolveStaffId(req.user.email)
  const { slotId } = req.params
  if (!slotId) {
    throw new Error('slotId is required')
  }
  const result = await paddockData.query(
    `DELETE FROM service_type_schedule_slots WHERE id = $1 RETURNING id`,
    [slotId]
  )
  return { deleted: result.data.length > 0 }
}
