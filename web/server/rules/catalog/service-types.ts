// Brief W56 (G-plan 1.1 except the weekly slots, 4.1, 4.3, 4.6; bugs GB14, GB15, GB21; lead calls L2 and L11;
// W53 review L7; W54a's stale-page rule): Catalog → Service Types on the Worker: the read (with each type's tiers
// and weekly slots), a type's details, a new size group, a size group's range, and a tier's price. On and off sale
// and a public type's price are items.ts's (setItemActive, setItemPrice). Ported from the staff app's old functions
// as they were at W48, with their words.
//
// GB21. A private service type is priced in size groups: one tier row per band for each group of people ("1 to 4
// people" in Off-Peak, Core and Peak). The old dialog saved a group's range as one call per band, so one failing left
// the bands with different ranges for the same group, and nothing refused a range that overlapped the next group's.
// Now one press changes the group in every band, in one transaction, and refuses an overlap with another group.
//
// Every tier write for a service type (a new group, a group's range) takes the SERVICE TYPE's own row lock first, as
// the guard of its tiers: two of them queue, so an overlap is checked while no other group can move.
import 'server-only'
import type { AdminAction } from '@/contracts'
import type { Db, Queryable, Tx } from '@/server/db'
import { isUuid, lockAdminRows } from '@/server/rules/admin/locks'
import { adminRead } from '@/server/rules/admin/read'
import { adminRefusal, requireAdminPermission, type AdminActor } from '@/server/rules/admin/refusal'
import { fieldsStampSql, NO_ROW_STAMP, rowsStamp } from '@/server/rules/admin/stamp'
import { adminWrite, WRITES_ONLY_WHAT_WAS_PRESSED, type AdminWriteOptions } from '@/server/rules/admin/write'
import { CATALOG_ADMIN_WORDS, LEGACY_CATALOG_ROUTE_WORDS } from './failure-messages'
import { CATALOG_ITEM_NEW_WORDS } from './item-failure-messages'
import { isPoundsAndPence, itemColumnsSql, priceText, withIsoTimes } from './items'

const WORDS = CATALOG_ADMIN_WORDS
const NEW_WORDS = CATALOG_ITEM_NEW_WORDS

/** W54a: what the details dialog writes back (EditServiceTypeDialog sends all three as the page loaded them). */
export const SERVICE_TYPE_DETAILS_COLUMNS = ['duration', 'capacity', 'booking_type'] as const
const serviceTypeStampSql = (alias: string): string => fieldsStampSql(alias, SERVICE_TYPE_DETAILS_COLUMNS)
/** W54a: what a size group's range edit writes back: each of the group's tiers' range. */
export const TIER_RANGE_COLUMNS = ['min_people', 'max_people'] as const
const tierRangeFieldsSql = (alias: string): string => fieldsStampSql(alias, TIER_RANGE_COLUMNS)

/** A tier's row as the old function's `RETURNING *` and the read had it (price as text). */
const TIER_COLUMNS_SQL = (alias: string): string =>
  `${alias}.id, ${alias}.service_type_id, ${alias}.min_people, ${alias}.max_people, ${alias}.price::text AS price, ${alias}.stripe_price_id, ${alias}.created_at, ${alias}.updated_at, ${alias}.band_id`

const SERVICE_TYPES_SQL = `SELECT ${itemColumnsSql('service_type', 'st')}, ${serviceTypeStampSql('st')} AS stamp FROM service_types st ORDER BY st.booking_type, st.duration`
const TIERS_SQL = `
SELECT ${TIER_COLUMNS_SQL('t')}, sb.code AS band_code, sb.name AS band_name, ${tierRangeFieldsSql('t')} AS range_fields
  FROM service_type_price_tiers t
  LEFT JOIN session_bands sb ON sb.id = t.band_id
 ORDER BY t.min_people, sb.code`
const SLOTS_SQL = 'SELECT s.id, s.service_type_id, s.day_of_week, s.start_time::text AS start_time, s.created_at, s.updated_at FROM service_type_schedule_slots s ORDER BY s.day_of_week, s.start_time'

/** The group a tier belongs to: its service type's tiers with the same range. */
const groupKey = (tier: Record<string, unknown>): string => `${String(tier['service_type_id'])}:${String(tier['min_people'])}:${String(tier['max_people'])}`

/**
 * W54a: a size group's stamp. Each of its tiers' id and range, in id order (admin/stamp.ts, rowsStamp), from the
 * same fingerprint the write reads under its locks. A tier added to the group, or one of its ranges changed, since
 * the page read it changes the stamp; a price change doesn't (the range edit doesn't write prices back).
 */
const groupStamp = (tiers: ReadonlyArray<{ id: unknown; range_fields: unknown }>): string => rowsStamp(tiers.map((tier) => ({ id: String(tier.id), stamp: String(tier.range_fields) })))

/**
 * getServiceTypes (`GET catalog/service-types`): every service type (by booking type, then length) with its tiers (by
 * size, then band code, each with its band's code and name) and its weekly slots (by day, then time), as before. Any
 * active staff member (GB14). Each type carries its stamp (the details dialog), and each tier its group's
 * `range_stamp` (the range edit), which every tier of one group shares.
 */
export async function listServiceTypes(db: Queryable, actor: AdminActor): Promise<Array<Record<string, unknown>>> {
  const read = (name: string, sql: string) => adminRead<Record<string, unknown>>(db, { name, needs: 'staff', sql, times: ['created_at', 'updated_at'] }, { actor })
  const types = await read('catalog.service_types', SERVICE_TYPES_SQL)
  const tiers = await read('catalog.price_tiers', TIERS_SQL)
  const slots = await read('catalog.schedule_slots', SLOTS_SQL)
  const groups = new Map<string, Array<Record<string, unknown>>>()
  for (const tier of tiers) groups.set(groupKey(tier), [...(groups.get(groupKey(tier)) ?? []), tier])
  const answered = tiers.map((tier): Record<string, unknown> => {
    const rest = Object.fromEntries(Object.entries(tier).filter(([name]) => name !== 'range_fields'))
    return { ...rest, range_stamp: groupStamp((groups.get(groupKey(tier)) ?? []) as Array<{ id: unknown; range_fields: unknown }>) }
  })
  return types.map((type) => ({
    ...type,
    price_tiers: answered.filter((tier) => tier['service_type_id'] === type['id']),
    schedule_slots: slots.filter((slot) => slot['service_type_id'] === type['id']),
  }))
}

// --- A type's details

const BOOKING_TYPES: readonly string[] = ['public', 'private']

const SERVICE_TYPE_STAMP_SQL = `SELECT ${serviceTypeStampSql('st')} AS stamp FROM service_types st WHERE st.id = $1::uuid`
const SERVICE_TYPE_UPDATE_SQL = `UPDATE service_types SET duration = $1::int, capacity = $2::int, booking_type = $3::text, updated_at = now() WHERE id = $4::uuid
 RETURNING id, duration, capacity, booking_type, ${serviceTypeStampSql('service_types')} AS stamp`

export interface ServiceTypeDetailsInput {
  serviceTypeId: string
  duration?: unknown
  capacity?: unknown
  bookingType?: unknown
  stamp?: unknown
}

/**
 * setServiceTypeCapacityInfo (`POST catalog/service-types/:serviceTypeId/details`): length, capacity and booking type.
 * Manage pricing; the old checks in their words; one transaction under the type's lock, and a `catalog.details_set`
 * row. W54a: the dialog sends all three as the page loaded them, so the press carries their stamp and is refused
 * `changed_since` when one has changed since. As before (Wayne's Q50, 20 Nov), only the type's row changes: sessions
 * already made keep their capacity and length. A type that isn't there is refused `service_type_not_found` (the old
 * function answered null, and its wrapper still does). Answers the four fields and the new stamp.
 */
export async function setServiceTypeDetails(db: Db, input: ServiceTypeDetailsInput, options: AdminWriteOptions): Promise<{ id: string; duration: number | null; capacity: number | null; booking_type: string | null; stamp: string }> {
  const action: AdminAction = 'catalog.details_set'
  requireAdminPermission(options.actor, 'manage_pricing', action)
  const words = WORDS.setServiceTypeCapacityInfo
  const invalid = (message: string, field: string) => adminRefusal('VALIDATION', action, 'invalid_params', message, { field })
  const { duration, capacity, bookingType, serviceTypeId } = input
  if (typeof duration !== 'number' || !Number.isInteger(duration) || duration <= 0) throw invalid(words.durationMustPositiveWholeNumberMinutes, 'duration')
  if (typeof capacity !== 'number' || !Number.isInteger(capacity) || capacity <= 0) throw invalid(words.capacityMustPositiveWholeNumber, 'capacity')
  if (typeof bookingType !== 'string' || !BOOKING_TYPES.includes(bookingType)) throw invalid(words.invalidBookingType(bookingType), 'bookingType')
  const gone = () => adminRefusal('NOT_FOUND', action, 'service_type_not_found', NEW_WORDS.serviceTypeNotFound)
  type Row = { id: string; duration: number | null; capacity: number | null; booking_type: string | null }
  return adminWrite<Row, Row, Row & { stamp: string }>(
    db,
    {
      action,
      needs: 'manage_pricing',
      entity: { type: 'service_type', id: serviceTypeId },
      locks: [{ table: 'service_types', ids: [serviceTypeId] }],
      unchangedSince: {
        seen: input.stamp,
        now: async (tx) => (await tx.query<{ stamp: string }>(SERVICE_TYPE_STAMP_SQL, [serviceTypeId]))[0]?.stamp ?? NO_ROW_STAMP,
      },
      async before(tx, held) {
        if (!held.service_types?.length) throw gone()
        const [row] = await tx.query<Row>('SELECT id, duration, capacity, booking_type FROM service_types WHERE id = $1::uuid', [serviceTypeId])
        if (!row) throw gone()
        return row
      },
      async change(tx) {
        const [row] = await tx.query<Row & { stamp: string }>(SERVICE_TYPE_UPDATE_SQL, [duration, capacity, bookingType, serviceTypeId])
        if (!row) throw new Error('The service type was held but not updated.')
        const { stamp, ...after } = row
        return { after, answer: { ...after, stamp } }
      },
    },
    options
  )
}

// --- Size groups

/** The old range checks, in their order and words (create and range share them). */
function checkedRange(action: AdminAction, words: { minPeopleMustPositiveWholeNumber: string; maxPeopleMustPositiveWholeNumber: string; minPeopleCannotGreaterThanMax: string }, min: unknown, max: unknown): { min: number; max: number } {
  const invalid = (message: string, field: string) => adminRefusal('VALIDATION', action, 'invalid_params', message, { field })
  if (typeof min !== 'number' || !Number.isInteger(min) || min < 1) throw invalid(words.minPeopleMustPositiveWholeNumber, 'minPeople')
  if (typeof max !== 'number' || !Number.isInteger(max) || max < 1) throw invalid(words.maxPeopleMustPositiveWholeNumber, 'maxPeople')
  if (min > max) throw invalid(words.minPeopleCannotGreaterThanMax, 'minPeople')
  return { min, max }
}

const TIER_GROUP_INSERT_SQL = `INSERT INTO service_type_price_tiers (service_type_id, band_id, min_people, max_people, price, stripe_price_id)
 SELECT $1::uuid, b.id, $2::int, $3::int, NULL, NULL FROM session_bands b WHERE b.active = true
 ON CONFLICT (service_type_id, band_id, min_people) DO NOTHING
 RETURNING ${TIER_COLUMNS_SQL('service_type_price_tiers')}`

export interface CreateTierInput {
  serviceTypeId: string
  minPeople?: unknown
  maxPeople?: unknown
}

/**
 * W55a (review S2): any tier of the service type whose range touches the new group's, other than tiers with exactly
 * the new range (those are the same group: the new rows only fill the bands that lack it, as before). Read under the
 * service type's lock, so no other group can move or be made meanwhile. Placeholders in order, each bound once.
 */
const NEW_GROUP_OVERLAP_SQL = `SELECT min_people, max_people FROM service_type_price_tiers
  WHERE service_type_id = $1::uuid AND min_people <= $2::int AND max_people >= $3::int AND NOT (min_people = $4::int AND max_people = $5::int)
  ORDER BY min_people, max_people LIMIT 1`

/**
 * createServiceTypePriceTier (`POST catalog/service-types/:serviceTypeId/tiers`): a new size group, one tier row for
 * each active band, with no price yet, as before. Manage pricing; the old checks; one transaction under the service
 * type's lock (the guard of its tiers), and a `catalog.tier_created` row with the rows made. A service type that isn't
 * there is refused in words (the old function showed the database's foreign-key error). Answers the rows made.
 *
 * W55a (review S2): a new group whose range overlaps another group of the type is refused (`range_overlaps`, naming
 * it, the range edit's words), so a party size never matches two tiers in one band (the quote, the order, Add Guest
 * and Move each read one tier with LIMIT 1, and two would let them differ). That also refuses a band already holding
 * a tier that starts at the new size with another max, which was skipped without a word. A group with exactly the
 * new range only gains the bands it lacks, as before.
 */
export async function createTierGroup(db: Db, input: CreateTierInput, options: AdminWriteOptions): Promise<Array<Record<string, unknown>>> {
  const action: AdminAction = 'catalog.tier_created'
  requireAdminPermission(options.actor, 'manage_pricing', action)
  const { min, max } = checkedRange(action, WORDS.createServiceTypePriceTier, input.minPeople, input.maxPeople)
  const { serviceTypeId } = input
  const gone = () => adminRefusal('NOT_FOUND', action, 'service_type_not_found', NEW_WORDS.serviceTypeNotFound)
  return adminWrite<null, Array<Record<string, unknown>>, Array<Record<string, unknown>>>(
    db,
    {
      action,
      needs: 'manage_pricing',
      entity: { type: 'service_type', id: serviceTypeId },
      locks: [{ table: 'service_types', ids: [serviceTypeId] }],
      unchangedSince: WRITES_ONLY_WHAT_WAS_PRESSED,
      async before(_tx, held) {
        if (!held.service_types?.length) throw gone()
        return null
      },
      async change(tx) {
        const [overlap] = await tx.query<{ min_people: number; max_people: number }>(NEW_GROUP_OVERLAP_SQL, [serviceTypeId, max, min, min, max])
        if (overlap) throw adminRefusal('CONFLICT', action, 'range_overlaps', NEW_WORDS.rangeOverlaps(overlap.min_people, overlap.max_people), { field: 'minPeople' })
        const rows = await tx.query<Record<string, unknown>>(TIER_GROUP_INSERT_SQL, [serviceTypeId, min, max])
        const made = rows.map((row) => withIsoTimes(row))
        return { after: made, details: { minPeople: min, maxPeople: max }, answer: made }
      },
    },
    options
  )
}

const TIER_GROUP_SQL = `SELECT t.id, t.band_id, t.min_people, t.max_people, ${tierRangeFieldsSql('t')} AS range_fields
  FROM service_type_price_tiers t WHERE t.service_type_id = $1::uuid AND t.min_people = $2::int AND t.max_people = $3::int ORDER BY t.id`

/** The group of a tier, read under the locks: its service type's tiers with the same range, in id order. */
async function tierGroup(tx: Tx, serviceTypeId: string, min: number, max: number): Promise<Array<{ id: string; band_id: string; min_people: number; max_people: number; range_fields: string }>> {
  return tx.query(TIER_GROUP_SQL, [serviceTypeId, min, max])
}

export interface TierRangeInput {
  tierId?: unknown
  minPeople?: unknown
  maxPeople?: unknown
  stamp?: unknown
}

type TierRangeRow = { id: string; service_type_id: string; min_people: number; max_people: number; price: string | null }

/**
 * setServiceTypePriceTierRange (`POST catalog/tier-groups/range`). GB21: one press changes a size group's range in
 * every band. The group is the pressed tier's service type's tiers with the pressed tier's range. Manage pricing; the
 * old checks in their words; then one transaction under the service type's lock and the group's tiers' locks:
 *  1. a tier that isn't there is refused `tier_not_found` (the old function answered null, and its wrapper still does);
 *  2. W54a: the dialog sends the range as the page loaded it, so the press carries the group's stamp (every tier's
 *     range) and is refused `changed_since` when the group has changed since (a tier added, a range moved);
 *  3. a range that overlaps another group of the same service type is refused (`range_overlaps`), naming it;
 *  4. every tier of the group set to the new range, and a `catalog.tier_range_set` row with the group before and after.
 * Answers the pressed tier as the old function did, and the group's new stamp.
 */
export async function setTierGroupRange(db: Db, input: TierRangeInput, options: AdminWriteOptions): Promise<TierRangeRow & { range_stamp: string }> {
  const action: AdminAction = 'catalog.tier_range_set'
  requireAdminPermission(options.actor, 'manage_pricing', action)
  const { min, max } = checkedRange(action, WORDS.setServiceTypePriceTierRange, input.minPeople, input.maxPeople)
  const tierId = String(input.tierId ?? '')
  const gone = () => adminRefusal('NOT_FOUND', action, 'tier_not_found', NEW_WORDS.tierNotFound)
  // A tier's service type never changes, so it can be read before the locks: the service type's lock comes first.
  const [owner] = isUuid(tierId) ? await db.query<{ service_type_id: string }>('SELECT service_type_id FROM service_type_price_tiers WHERE id = $1::uuid', [tierId]) : []
  if (!owner) throw gone()
  const serviceTypeId = owner.service_type_id
  type Group = Array<{ id: string; band_id: string; min_people: number; max_people: number }>
  let group: Array<{ id: string; band_id: string; min_people: number; max_people: number; range_fields: string }> = []
  return adminWrite<Group, Group, TierRangeRow & { range_stamp: string }>(
    db,
    {
      action,
      needs: 'manage_pricing',
      entity: { type: 'price_tier', id: tierId },
      locks: [{ table: 'service_types', ids: [serviceTypeId] }],
      unchangedSince: {
        seen: input.stamp,
        now: async () => (group.length === 0 ? NO_ROW_STAMP : groupStamp(group)),
      },
      async before(tx) {
        const [tier] = await tx.query<{ min_people: number; max_people: number }>('SELECT min_people, max_people FROM service_type_price_tiers WHERE id = $1::uuid', [tierId])
        if (!tier) throw gone()
        const ids = (await tierGroup(tx, serviceTypeId, tier.min_people, tier.max_people)).map((row) => row.id)
        // The group's own rows, after the service type's (both are admin_row; service_types comes first).
        await lockAdminRows(tx, [{ table: 'service_type_price_tiers', ids }])
        group = await tierGroup(tx, serviceTypeId, tier.min_people, tier.max_people)
        if (!group.some((row) => row.id === tierId)) throw gone()
        return group.map(({ id, band_id, min_people, max_people }) => ({ id, band_id, min_people, max_people }))
      },
      async change(tx, before) {
        const ids = before.map((row) => row.id)
        const [overlap] = await tx.query<{ min_people: number; max_people: number }>(
          `SELECT min_people, max_people FROM service_type_price_tiers
            WHERE service_type_id = $1::uuid AND NOT (id = ANY($2::uuid[])) AND min_people <= $3::int AND max_people >= $4::int
            ORDER BY min_people, max_people LIMIT 1`,
          [serviceTypeId, ids, max, min]
        )
        if (overlap) throw adminRefusal('CONFLICT', action, 'range_overlaps', NEW_WORDS.rangeOverlaps(overlap.min_people, overlap.max_people), { field: 'minPeople' })
        await tx.query('UPDATE service_type_price_tiers SET min_people = $1::int, max_people = $2::int, updated_at = now() WHERE id = ANY($3::uuid[])', [min, max, ids])
        const after = (await tierGroup(tx, serviceTypeId, min, max)).filter((row) => ids.includes(row.id))
        const [pressed] = await tx.query<TierRangeRow>('SELECT id, service_type_id, min_people, max_people, price::text AS price FROM service_type_price_tiers WHERE id = $1::uuid', [tierId])
        if (!pressed) throw new Error('The tier was held but not updated.')
        return {
          after: after.map(({ id, band_id, min_people, max_people }) => ({ id, band_id, min_people, max_people })),
          details: { serviceTypeId, tiers: ids.length },
          answer: { ...pressed, range_stamp: groupStamp(after) },
        }
      },
    },
    options
  )
}

const TIER_PRICE_UPDATE_SQL = `UPDATE service_type_price_tiers SET price = $1::numeric, updated_at = now() WHERE id = $2::uuid RETURNING ${TIER_COLUMNS_SQL('service_type_price_tiers')}`

/**
 * updateTierPrice (`POST catalog/tiers/:tierId/price`). Manage pricing; the old check ("price must be a non-negative
 * number") and L7's; one transaction under the tier's lock ("Tier not found", the legacy route's words), the price,
 * and a `catalog.price_set` row with the price before and after. L2: no Stripe price is made or archived (GB2: the
 * old route archived the old price first, and a second press made a second price). One value, so no stamp. Answers
 * `{ success: true, tier }`: the legacy route's answer without its `stripePriceId`.
 */
export async function setTierPrice(db: Db, tierId: string, price: unknown, options: AdminWriteOptions): Promise<{ success: true; tier: Record<string, unknown> }> {
  const action: AdminAction = 'catalog.price_set'
  requireAdminPermission(options.actor, 'manage_pricing', action)
  if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) throw adminRefusal('VALIDATION', action, 'invalid_params', WORDS.updateTierPrice.priceMustNonNegativeNumber, { field: 'price' })
  if (!isPoundsAndPence(price)) throw adminRefusal('VALIDATION', action, 'not_pounds_and_pence', NEW_WORDS.notPoundsAndPence('price'), { field: 'price' })
  const gone = () => adminRefusal('NOT_FOUND', action, 'tier_not_found', LEGACY_CATALOG_ROUTE_WORDS['update-tier-price'].tierNotFound)
  type Price = { price: string | null }
  return adminWrite<Price, Price, { success: true; tier: Record<string, unknown> }>(
    db,
    {
      action,
      needs: 'manage_pricing',
      entity: { type: 'price_tier', id: tierId },
      locks: [{ table: 'service_type_price_tiers', ids: [tierId] }],
      unchangedSince: WRITES_ONLY_WHAT_WAS_PRESSED,
      async before(tx, held) {
        if (!held.service_type_price_tiers?.length) throw gone()
        const [row] = await tx.query<Price>('SELECT price::text AS price FROM service_type_price_tiers WHERE id = $1::uuid', [tierId])
        if (!row) throw gone()
        return row
      },
      async change(tx) {
        const [row] = await tx.query<Record<string, unknown>>(TIER_PRICE_UPDATE_SQL, [priceText(price), tierId])
        if (!row) throw new Error('The tier was held but its price not updated.')
        return { after: { price: (row['price'] as string | null) ?? null }, answer: { success: true, tier: withIsoTimes(row) } }
      },
    },
    options
  )
}
