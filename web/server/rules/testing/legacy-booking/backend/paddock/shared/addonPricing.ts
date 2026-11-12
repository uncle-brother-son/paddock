/**
 * Read-only: how an add-on is priced for a customer. New Order (createOrder) and adding add-ons to
 * an existing booking (addBookingGuest) both use this, so the two always charge the same.
 *
 * The system price is the add-on's member price when the customer has an active membership
 * (active and not past a scheduled cancellation — the same gate shared/creditRedemption uses),
 * else its sale price where set, else its base price.
 */
// The runtime globals (paddockData) are typed by the generated declarations in backend/resources/.
import '../globals'

export interface AddonCatalogRow {
  id: string
  name: string
  sku: string | null
  active: boolean | null
  member_price: string | null
  sale_price: string | null
  base_price: string | null
}

/** The add-ons by id (missing ids are simply absent from the map). */
export async function loadAddonCatalog(addonIds: string[]): Promise<Map<string, AddonCatalogRow>> {
  const unique = [...new Set(addonIds)]
  if (unique.length === 0) return new Map()
  const lookup = await paddockData.query<AddonCatalogRow>(
    'SELECT id, name, sku, active, member_price, sale_price, base_price FROM addons WHERE id = ANY($1::uuid[])',
    [unique]
  )
  return new Map(lookup.data.map((row) => [row.id, row]))
}

/** Whether the customer has an active membership (gets member prices). */
export async function customerHasActiveMembership(customerId: string): Promise<boolean> {
  const lookup = await paddockData.query<{ has_active_membership: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM customer_memberships
       WHERE customer_id = $1
         AND subscription_status = 'active'
         AND (cancel_effective_date IS NULL OR cancel_effective_date >= (now() AT TIME ZONE 'Europe/London')::date)
     ) AS has_active_membership`,
    [customerId]
  )
  return lookup.data[0]?.has_active_membership === true
}

/** The add-on's system unit price for this customer (member, else sale, else base). */
export function addonSystemPrice(addon: Pick<AddonCatalogRow, 'member_price' | 'sale_price' | 'base_price'>, hasActiveMembership: boolean): number {
  for (const candidate of [hasActiveMembership ? addon.member_price : null, addon.sale_price, addon.base_price]) {
    if (candidate !== null && candidate !== undefined) return Number.parseFloat(candidate)
  }
  return 0
}
