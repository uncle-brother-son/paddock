import { resolveStaffId } from './shared/resolveStaffId'

export interface SetOrderLineItemFulfilledParams {
  lineItemId: string
  fulfilled: boolean
}

export interface SetOrderLineItemFulfilledResult {
  updated: boolean
  reason?: 'not_found' | 'not_a_product_line'
  lineItem?: Record<string, unknown>
}

// Direct Postgres write — fulfillment tracking for physical Product lines has no Stripe
// counterpart. Only meaningful for item_type = 'product'; bookings/add-ons/memberships/session
// passes/gift cards each have their own resolution paths (session occurring, digital issuance,
// pickup/shipping tracking on gift_cards).
export default async function setOrderLineItemFulfilled(
  req: { params: SetOrderLineItemFulfilledParams; user: User }
): Promise<SetOrderLineItemFulfilledResult> {
  // Refuses an inactive account before anything happens.
  await resolveStaffId(req.user.email)
  const { lineItemId, fulfilled } = req.params

  const lookup = await paddockData.query<{ item_type: string }>(
    'SELECT item_type FROM order_line_items WHERE id = $1',
    [lineItemId]
  )
  const line = lookup.data[0]
  if (!line) {
    return { updated: false, reason: 'not_found' }
  }
  if (line.item_type !== 'product') {
    return { updated: false, reason: 'not_a_product_line' }
  }

  const result = await paddockData.query(
    `UPDATE order_line_items
     SET fulfillment_status = $1
     WHERE id = $2
     RETURNING *`,
    [fulfilled ? 'fulfilled' : 'pending', lineItemId]
  )
  const row = result.data[0]
  if (!row) throw new Error('The line item was updated but could not be read back.')
  return { updated: true, lineItem: row }
}
