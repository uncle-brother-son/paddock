import { requireCanManagePricing } from './shared/pricingStaff'
import type { EventRow } from './getEvents'

export interface SetEventActiveParams {
  eventId: string
  active: boolean
}

export type SetEventActiveResult =
  | { updated: true; event: Pick<EventRow, 'id' | 'active'> }
  | { updated: false; reason: 'event_not_found' | 'event_incomplete'; message: string }

/**
 * Puts an event on or off sale. Catalogue change, so Manage pricing only (27 Oct). The
 * events_on_sale_complete constraint refuses going on sale until the date, capacity, all three
 * prices and the refund cut-off are set (plus the release time for Members first), and never for
 * a cancelled event.
 */
export default async function setEventActive(req: { params: SetEventActiveParams; user: User }): Promise<SetEventActiveResult> {
  await requireCanManagePricing(req.user.email)
  const { eventId, active } = req.params
  try {
    const result = await paddockData.query<{ id: string; active: boolean }>(
      'UPDATE events SET active = $1, updated_at = now() WHERE id = $2 RETURNING id, active',
      [active === true, eventId]
    )
    const row = result.data[0]
    if (!row) return { updated: false, reason: 'event_not_found', message: 'That event no longer exists.' }
    return { updated: true, event: row }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('events_on_sale_complete')) {
      return {
        updated: false,
        reason: 'event_incomplete',
        message:
          'Set the date, capacity, prices and refund cut-off before putting this event on sale (and the public release time for Members first). A cancelled event cannot go on sale.',
      }
    }
    throw err
  }
}
