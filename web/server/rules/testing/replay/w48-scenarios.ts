import { vi } from 'vitest'
import type { Db, SqlParam } from '@/server/db'
import { fakeStripeErrors, type FakeStripe } from '@/server/stripe/fake'
import { insert } from '../database'
import type { Scenario, ScenarioContext } from '../sweep/run'
import {
  atItsFirstTransaction,
  ID,
  paidSeat,
  PROMO_CODE_PATH,
  sam,
  seed,
  SESSION_BLOCK_PATH,
  SESSION_START_TIME_PATH,
  STAFF_PERMISSIONS_PATH,
  VARIANT_STOCK_PATH,
  whileFailing,
} from './scenarios'

// Brief W48 item 4 (G-plan 4.9 item 1, lead call L5): step G's scenarios. They hold every refusal of G-plan section
// 1's functions (the staff app's admin presses), each success, the outcome for each bug in section 3 (GB1 to GB24,
// named `gbN-…`), and each read's shape against a seeded database, pressed through the Worker's routes with the fake
// Stripe. A `gbN-…` name keeps the bug it was written for; where the Worker no longer has the bug, the scenario holds
// what it does instead.
//
// They are their own list, not part of `scenarios`; the all-Worker sweep runs them in its step-g files
// (sweep/sweep.ts, SWEEP_FILES), each against its recording. Nothing here moves a customer's money.

/** The name every step G scenario starts with. */
export const W48_PREFIX = 'w48-'

/** Fixed ids for what these scenarios add to the seed, and an id nothing has. */
export const W48_ID = {
  unknown: '10000000-0000-4000-8000-000000000f4f',
  manager: '10000000-0000-4000-8000-000000000a01',
  secondAdmin: '10000000-0000-4000-8000-000000000a02',
  teamMember: '10000000-0000-4000-8000-000000000a03',
  slot: '10000000-0000-4000-8000-000000000a10',
  tierPeak: '10000000-0000-4000-8000-000000000a11',
  tierSmallCore: '10000000-0000-4000-8000-000000000a12',
  tierSmallPeak: '10000000-0000-4000-8000-000000000a14',
  secondVariant: '10000000-0000-4000-8000-000000000a15',
  stockRow: '10000000-0000-4000-8000-000000000a16',
  secondPreset: '10000000-0000-4000-8000-000000000a17',
  unsyncedPlan: '10000000-0000-4000-8000-000000000a18',
  bandRuleMorning: '10000000-0000-4000-8000-000000000a20',
  bandRuleEvening: '10000000-0000-4000-8000-000000000a21',
  offPeakBand: '10000000-0000-4000-8000-000000000a22',
  promoUsed: '10000000-0000-4000-8000-000000000a23',
  blockedSession: '10000000-0000-4000-8000-000000000a30',
  sameDaySession: '10000000-0000-4000-8000-000000000a31',
  farSession: '10000000-0000-4000-8000-000000000a32',
  eventBooking: '10000000-0000-4000-8000-000000000a40',
  attendeeOne: '10000000-0000-4000-8000-000000000a41',
  attendeeTwo: '10000000-0000-4000-8000-000000000a42',
  draftEvent: '10000000-0000-4000-8000-000000000a43',
  todayEvent: '10000000-0000-4000-8000-000000000a44',
  secondMember: '10000000-0000-4000-8000-000000000a50',
  secondMembership: '10000000-0000-4000-8000-000000000a51',
  thirdMember: '10000000-0000-4000-8000-000000000a52',
  thirdMembership: '10000000-0000-4000-8000-000000000a53',
  seededBooking: '10000000-0000-4000-8000-000000000a60',
}

type Prepare = (db: Db, stripe: FakeStripe) => Promise<void>
type Steps = (context: ScenarioContext) => Promise<void>

/** One step G scenario: the common seed, then what it prepares, then its steps. */
const g = (name: string, steps: Steps, ...prepares: Prepare[]): Scenario => ({
  name: `${W48_PREFIX}${name}`,
  async seed(db, stripe) {
    await seed(db, stripe)
    for (const prepare of prepares) await prepare(db, stripe)
  },
  run: steps,
})

/** One statement of set-up: test data only, each a literal below. */
const sql =
  (statement: string, params: SqlParam[] = []): Prepare =>
  async (db) => {
    await db.query(statement, params)
  }

const staffIs = (statement: string): Prepare => sql(statement, [ID.staff])
const noManagePricing = staffIs('UPDATE staff SET can_manage_pricing = false WHERE id = $1')

/** Two more staff: a manager with Manage pricing, and a team member with nothing. */
const moreStaff: Prepare = async (db) => {
  await insert(db, 'staff', { id: W48_ID.manager, role: 'manager', first_name: 'Max', last_name: 'Manager', email: 'max@example.com', can_issue_refunds: true, can_manage_pricing: true })
  await insert(db, 'staff', { id: W48_ID.teamMember, role: 'staff', first_name: 'Tia', last_name: 'Team', email: 'tia@example.com' })
}
const secondAdmin: Prepare = async (db) => {
  await insert(db, 'staff', { id: W48_ID.secondAdmin, role: 'admin', first_name: 'Ada', last_name: 'Admin', email: 'ada@example.com', can_issue_refunds: true, can_manage_pricing: true })
}

/**
 * "Who may": the same call three times, with the staff row changed in between, so one scenario records all three
 * refusals in the function's own words: (1) signed in without the permission, (2) an inactive account, (3) no staff
 * row for the email. `without` is the statement that takes the permission away (none for "any active staff", where
 * the first call simply goes through or is refused for another reason).
 */
const whoMay =
  (action: string, params: unknown, without: 'manage_pricing' | 'admin' | 'none'): Steps =>
  async ({ attempt, db }) => {
    if (without === 'manage_pricing') await db.query('UPDATE staff SET can_manage_pricing = false WHERE id = $1', [ID.staff])
    if (without === 'admin') await db.query("UPDATE staff SET role = 'manager' WHERE id = $1", [ID.staff])
    if (without !== 'none') await attempt(action, params)
    await db.query('UPDATE staff SET active = false WHERE id = $1', [ID.staff])
    await attempt(action, params)
    await db.query("UPDATE staff SET active = true, email = 'someone.else@example.com' WHERE id = $1", [ID.staff])
    await attempt(action, params)
  }

/** Each set of params tried in turn: for the refusals that change nothing, so several fit in one scenario. */
const each =
  (action: string, ...tries: unknown[]): Steps =>
  async ({ attempt }) => {
    for (const params of tries) await attempt(action, params)
  }

// W65a: `onceAfter` (another tab's step between two of the old function's statements) and `failingOnce` (one of its
// statements failing), and GB13's cut-off, wrapped the old side's `paddockData`, which the Worker side never calls: since
// W64 each scenario that used them had run its press alone. They went. W65b: each overlap is rebuilt on the Worker
// (atItsFirstTransaction) or, where only the old code could fail between its statements, renamed for what it does;
// each is marked where it is.

/** A catalogue item as one synced from Sanity is: it has a Stripe product (and the fake knows it). */
const synced =
  (table: string, id: string, product: string, prices: Record<string, [string, number]> = {}): Prepare =>
  async (db, stripe) => {
    stripe.addProduct(product)
    const sets = ['stripe_product_id = $1']
    const params: SqlParam[] = [product]
    for (const [column, [priceId, pence]] of Object.entries(prices)) {
      stripe.addPrice(priceId, pence, null)
      params.push(priceId)
      sets.push(`${column} = $${params.length}`)
    }
    params.push(id)
    // eslint-disable-next-line no-restricted-syntax -- test data only: the table and columns are literals in this file; every value goes in as a parameter
    await db.query(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = $${params.length}`, params)
  }

const refusedByStripe = () => fakeStripeErrors.invalid('parameter_invalid', 'Stripe refused this change.')

// ---------------------------------------------------------------------------------------------------------------------
// 1.8 Staff

function staffScenarios(): Scenario[] {
  const newPerson = { firstName: ' Nia ', lastName: ' New ', email: ' Nia.New@Example.COM ', role: 'staff' }
  return [
    // getCurrentStaff: the caller's own row whether active or not (L10), and null for an email with no row.
    g('staff-me-active-then-inactive-then-unknown', async ({ call, db }) => {
      await call('getCurrentStaff', {})
      await db.query('UPDATE staff SET active = false WHERE id = $1', [ID.staff])
      await call('getCurrentStaff', {})
      await db.query("UPDATE staff SET email = 'someone.else@example.com' WHERE id = $1", [ID.staff])
      await call('getCurrentStaff', {})
    }),
    g('staff-list', async ({ call }) => {
      await call('getStaff', {})
    }, moreStaff),
    g('staff-list-who-may', whoMay('getStaff', {}, 'admin'), moreStaff),
    g('staff-create-who-may', whoMay('createStaff', newPerson, 'admin')),
    g(
      'staff-create-refusals',
      each(
        'createStaff',
        { ...newPerson, firstName: '  ' },
        { ...newPerson, lastName: '' },
        { ...newPerson, email: 'not-an-email' },
        { ...newPerson, email: '' },
        { ...newPerson, role: 'owner' },
        // An address already on file, typed in capitals: lower-cased first, so it is the same one.
        { ...newPerson, email: 'MAX@example.com' }
      ),
      moreStaff
    ),
    g('staff-create', async ({ call }) => {
      await call('createStaff', newPerson)
      await call('createStaff', { firstName: 'Rae', lastName: 'Refunds', email: 'rae@example.com', role: 'manager', canIssueRefunds: true })
    }),
    g('staff-role-who-may', whoMay('setStaffRole', { staffId: W48_ID.teamMember, role: 'manager' }, 'admin'), moreStaff),
    g('staff-role-refusals', each('setStaffRole', { staffId: W48_ID.teamMember, role: 'owner' }, { staffId: W48_ID.unknown, role: 'manager' }, { staffId: W48_ID.unknown, role: 'admin' }), moreStaff),
    g('staff-role-up-and-down', async ({ call }) => {
      await call('setStaffRole', { staffId: W48_ID.teamMember, role: 'manager' })
      await call('setStaffRole', { staffId: W48_ID.teamMember, role: 'admin' })
      // Two active admins now, so either may step down.
      await call('setStaffRole', { staffId: W48_ID.teamMember, role: 'staff' })
    }, moreStaff),
    // The last active admin can't be demoted (one guarded statement), and an inactive admin doesn't count as one.
    g('staff-role-last-active-admin-refused', async ({ attempt, call, db }) => {
      await attempt('setStaffRole', { staffId: ID.staff, role: 'manager' })
      await db.query('UPDATE staff SET active = false WHERE id = $1', [W48_ID.secondAdmin])
      await attempt('setStaffRole', { staffId: ID.staff, role: 'staff' })
      await db.query('UPDATE staff SET active = true WHERE id = $1', [W48_ID.secondAdmin])
      await call('setStaffRole', { staffId: ID.staff, role: 'manager' })
    }, moreStaff, secondAdmin, sql('UPDATE staff SET active = false WHERE id = $1', [W48_ID.secondAdmin])),
    g('staff-permission-who-may', whoMay('setStaffPermission', { staffId: W48_ID.teamMember, field: 'can_issue_refunds', value: true }, 'admin'), moreStaff),
    g(
      'staff-permission-refusals',
      each('setStaffPermission', { staffId: W48_ID.teamMember, field: 'can_manage_pricing', value: true }, { staffId: W48_ID.unknown, field: 'can_issue_refunds', value: true }, { staffId: W48_ID.unknown, field: 'active', value: true }, { staffId: W48_ID.unknown, field: 'active', value: false }),
      moreStaff
    ),
    g('staff-permission-issue-refunds-on-and-off', async ({ call }) => {
      await call('setStaffPermission', { staffId: W48_ID.teamMember, field: 'can_issue_refunds', value: true })
      await call('setStaffPermission', { staffId: W48_ID.teamMember, field: 'can_issue_refunds', value: false })
    }, moreStaff),
    g('staff-permission-active-off-and-on', async ({ call }) => {
      await call('setStaffPermission', { staffId: W48_ID.teamMember, field: 'active', value: false })
      await call('setStaffPermission', { staffId: W48_ID.teamMember, field: 'active', value: true })
    }, moreStaff),
    g('staff-permission-last-active-admin-refused', async ({ attempt, call }) => {
      await attempt('setStaffPermission', { staffId: ID.staff, field: 'active', value: false })
      await call('setStaffRole', { staffId: W48_ID.manager, role: 'admin' })
      await call('setStaffPermission', { staffId: ID.staff, field: 'active', value: false })
    }, moreStaff),
    g('staff-manage-pricing-who-may', whoMay('setStaffCanManagePricing', { staffId: W48_ID.teamMember, canManagePricing: true }, 'admin'), moreStaff),
    g('staff-manage-pricing-refusals', each('setStaffCanManagePricing', { staffId: W48_ID.unknown, canManagePricing: true }), moreStaff),
    g('staff-manage-pricing-on-and-off', async ({ call }) => {
      await call('setStaffCanManagePricing', { staffId: W48_ID.teamMember, canManagePricing: true })
      await call('setStaffCanManagePricing', { staffId: W48_ID.teamMember, canManagePricing: false })
      // Taking it from someone who never had it is allowed and changes nothing.
      await call('setStaffCanManagePricing', { staffId: W48_ID.teamMember, canManagePricing: false })
    }, moreStaff),
    // Only active holders count: with Max inactive, Jo is the last one.
    g('staff-manage-pricing-last-holder-refused', async ({ attempt, call, db }) => {
      await db.query('UPDATE staff SET active = false WHERE id = $1', [W48_ID.manager])
      await attempt('setStaffCanManagePricing', { staffId: ID.staff, canManagePricing: false })
      await db.query('UPDATE staff SET active = true WHERE id = $1', [W48_ID.manager])
      await call('setStaffCanManagePricing', { staffId: ID.staff, canManagePricing: false })
    }, moreStaff),
    // GB16: the "last holder" check is a read, then a write. Two admins each take the other's Manage pricing at once:
    // both checks pass, both writes land, and nobody can change a price. W65b: on the Worker the check and the write
    // are one transaction; the other admin's write (a statement standing for their press, as before W65a) lands at the
    // nearest point, just before that transaction opens.
    g('gb16-two-admins-remove-each-others-manage-pricing', async ({ attempt, db, stripe }) => {
      await atItsFirstTransaction(
        { db, stripe },
        STAFF_PERMISSIONS_PATH,
        () => db.query('UPDATE staff SET can_manage_pricing = false, updated_at = now() WHERE id = $1', [ID.staff]),
        () => attempt('setStaffCanManagePricing', { staffId: W48_ID.secondAdmin, canManagePricing: false })
      )
    }, secondAdmin),
    // GB16: the sign-in email is compared exactly. A row stored with a capital is nobody's.
    g('gb16-sign-in-in-another-case-matches-no-staff-row', async ({ attempt, call }) => {
      await call('getCurrentStaff', {})
      await attempt('getStaff', {})
    }, staffIs("UPDATE staff SET email = 'Jo@Example.com' WHERE id = $1")),
    // GB16: nothing records who gave or took a permission: the only change is the staff row itself.
    g('gb16-a-permission-change-leaves-no-record', async ({ call }) => {
      await call('setStaffPermission', { staffId: W48_ID.teamMember, field: 'can_issue_refunds', value: true })
      await call('setStaffCanManagePricing', { staffId: W48_ID.teamMember, canManagePricing: true })
    }, moreStaff),
  ]
}

// ---------------------------------------------------------------------------------------------------------------------
// 1.1 Catalog: service types

/** The public Sauna and the Private Hire as synced items: each has a Stripe product, and Sauna a price. */
const saunaSynced = synced('service_types', ID.serviceType, 'prod_sauna', { stripe_price_id: ['price_sauna', 2000] })
const privateSynced = synced('service_types', ID.privateType, 'prod_private')
/** The seed's one private tier (1 to 10, Core, £100) with its Stripe price, and the same size group in Peak with none. */
const tierPriced: Prepare = async (db, stripe) => {
  stripe.addPrice('price_tier_core', 10000, null)
  await db.query("UPDATE service_type_price_tiers SET stripe_price_id = 'price_tier_core' WHERE id = $1", [ID.privateTier])
}
const peakTier: Prepare = async (db) => {
  await insert(db, 'service_type_price_tiers', { id: W48_ID.tierPeak, service_type_id: ID.privateType, band_id: ID.peakBand, min_people: 1, max_people: 10, price: '140.00' })
}
const tuesdaySlot: Prepare = async (db) => {
  await insert(db, 'service_type_schedule_slots', { id: W48_ID.slot, service_type_id: ID.serviceType, day_of_week: 2, start_time: '07:00' })
}

function serviceTypeScenarios(): Scenario[] {
  const capacity = { serviceTypeId: ID.serviceType, duration: 60, capacity: 12, bookingType: 'public' }
  const newTier = { serviceTypeId: ID.privateType, minPeople: 11, maxPeople: 14 }
  const range = { tierId: ID.privateTier, minPeople: 1, maxPeople: 8 }
  const slot = { serviceTypeId: ID.serviceType, dayOfWeek: 2, startTime: '07:00' }
  return [
    // Each service type with its tiers (the band's code and name beside each) and its weekly slots.
    g('service-types-read', async ({ call }) => {
      await call('getServiceTypes', {})
    }, saunaSynced, privateSynced, tierPriced, peakTier, tuesdaySlot),
    g('service-type-active-who-may', whoMay('setServiceTypeActive', { serviceTypeId: ID.serviceType, active: false }, 'manage_pricing'), saunaSynced),
    g('service-type-active-refusals', each('setServiceTypeActive', { serviceTypeId: '', active: false }, { serviceTypeId: W48_ID.unknown, active: false }), saunaSynced),
    g('service-type-active-off-and-on', async ({ call }) => {
      await call('setServiceTypeActive', { serviceTypeId: ID.serviceType, active: false })
      await call('setServiceTypeActive', { serviceTypeId: ID.serviceType, active: true })
    }, saunaSynced),
    // No Stripe product (never synced): the row alone is switched.
    g('service-type-active-with-no-stripe-product', async ({ call }) => {
      await call('setServiceTypeActive', { serviceTypeId: ID.serviceType, active: false })
    }),
    g('service-type-active-refused-by-stripe', async ({ attempt, stripe }) => {
      stripe.failNext('products.update', { kind: 'error', error: refusedByStripe() })
      await attempt('setServiceTypeActive', { serviceTypeId: ID.serviceType, active: false })
    }, saunaSynced),
    // Stripe's product is switched first, then the row. The row's write failing leaves Stripe off and the row on.
    g('service-type-active-stripe-went-then-the-write-fails', async ({ attempt, db }) => {
      await whileFailing(db, { table: 'service_types', event: 'UPDATE', when: 'true' }, () => attempt('setServiceTypeActive', { serviceTypeId: ID.serviceType, active: false }))
    }, saunaSynced),
    g('service-type-details-who-may', whoMay('setServiceTypeCapacityInfo', capacity, 'manage_pricing')),
    g(
      'service-type-details-refusals',
      each('setServiceTypeCapacityInfo', { ...capacity, duration: 0 }, { ...capacity, duration: 45.5 }, { ...capacity, capacity: 0 }, { ...capacity, capacity: 2.5 }, { ...capacity, bookingType: 'members' }, { ...capacity, serviceTypeId: W48_ID.unknown })
    ),
    g('service-type-details-set', async ({ call }) => {
      await call('setServiceTypeCapacityInfo', { serviceTypeId: ID.serviceType, duration: 75, capacity: 12, bookingType: 'public' })
    }),
    // GB4: the seed's Sauna session keeps its capacity of 10 and its hour: only the service type's row changes.
    g('gb4-a-capacity-or-length-change-reaches-no-session-already-made', async ({ call }) => {
      await call('setServiceTypeCapacityInfo', { serviceTypeId: ID.serviceType, duration: 90, capacity: 8, bookingType: 'public' })
      await call('getSessionsForRange', { startDate: '2026-11-12', endDate: '2026-11-12' })
    }),
    g('tier-create-who-may', whoMay('createServiceTypePriceTier', newTier, 'manage_pricing')),
    g('tier-create-refusals', each('createServiceTypePriceTier', { ...newTier, serviceTypeId: '' }, { ...newTier, minPeople: 0 }, { ...newTier, minPeople: 1.5 }, { ...newTier, maxPeople: 0 }, { ...newTier, minPeople: 15 })),
    // One row for each active band (Core and Peak), with no price yet. The two rows share a moment: the comparer
    // settles their order by what they hold (their bands), so the recording repeats.
    g('tier-create', async ({ call }) => {
      await call('createServiceTypePriceTier', newTier)
    }),
    // A band switched off gets no row.
    g('tier-create-skips-a-band-that-is-off', async ({ call }) => {
      await call('createServiceTypePriceTier', newTier)
    }, sql('UPDATE session_bands SET active = false WHERE id = $1', [ID.peakBand])),
    // A group starting at the same size already exists in Core: that band is skipped without a word, Peak gets its row.
    // Pressed again, nothing is made and nothing is said.
    g('tier-create-where-one-band-already-has-the-group', async ({ call }) => {
      await call('createServiceTypePriceTier', { serviceTypeId: ID.privateType, minPeople: 1, maxPeople: 4 })
      await call('createServiceTypePriceTier', { serviceTypeId: ID.privateType, minPeople: 1, maxPeople: 4 })
    }),
    g('tier-range-who-may', whoMay('setServiceTypePriceTierRange', range, 'manage_pricing')),
    g('tier-range-refusals', each('setServiceTypePriceTierRange', { ...range, minPeople: 0 }, { ...range, maxPeople: 2.5 }, { ...range, maxPeople: 0 }, { ...range, minPeople: 9 }, { ...range, tierId: W48_ID.unknown })),
    g('tier-range-set', async ({ call }) => {
      await call('setServiceTypePriceTierRange', range)
    }),
    // GB21: the dialog saves a size group's range as one call per band. The second call failing leaves "1 to 8" in
    // Core and "1 to 10" in Peak for the same group: a party of 9 has a Peak price and no Core price. W65b: renamed from
    // gb21-a-size-group-range-saved-in-one-band-and-not-the-other: the second call's failure was the old side's own
    // statement (gone at W65a); on the Worker both calls go through, one band each.
    g('gb21-a-size-group-range-saved-band-by-band', async ({ call, attempt }) => {
      await call('setServiceTypePriceTierRange', { tierId: ID.privateTier, minPeople: 1, maxPeople: 8 })
      await attempt('setServiceTypePriceTierRange', { tierId: W48_ID.tierPeak, minPeople: 1, maxPeople: 8 })
      await call('getServiceTypes', {})
    }, peakTier),
    // GB21: nothing refuses a range that overlaps the next group's.
    g('gb21-a-range-may-overlap-the-next-size-group', async ({ call }) => {
      await call('createServiceTypePriceTier', { serviceTypeId: ID.privateType, minPeople: 11, maxPeople: 14 })
      await call('setServiceTypePriceTierRange', { tierId: ID.privateTier, minPeople: 1, maxPeople: 12 })
    }),
    g('tier-price-who-may', whoMay('updateTierPrice', { tierId: ID.privateTier, price: 120 }, 'manage_pricing'), privateSynced, tierPriced),
    g(
      'tier-price-refusals',
      each('updateTierPrice', { tierId: '', price: 120 }, { tierId: ID.privateTier, price: -1 }, { tierId: ID.privateTier, price: Number.NaN }, { tierId: W48_ID.unknown, price: 120 }),
      privateSynced,
      tierPriced
    ),
    g('tier-price-refused-service-type-has-no-stripe-product', each('updateTierPrice', { tierId: ID.privateTier, price: 120 })),
    // The old Stripe price is archived, a new one made, then the row written.
    g('tier-price-set', async ({ call }) => {
      await call('updateTierPrice', { tierId: ID.privateTier, price: 120 })
    }, privateSynced, tierPriced),
    // A tier with no Stripe price yet (a new size group): nothing to archive.
    g('tier-price-set-for-the-first-time', async ({ call }) => {
      await call('updateTierPrice', { tierId: W48_ID.tierPeak, price: 150.5 })
    }, privateSynced, sql('INSERT INTO service_type_price_tiers (id, service_type_id, band_id, min_people, max_people) VALUES ($1, $2, $3, 1, 10)', [W48_ID.tierPeak, ID.privateType, ID.peakBand])),
    // GB2: the old price is archived before the new one is made. Stripe refusing the new one leaves the row pointing
    // at an archived price, and the tier's price as it was.
    g('gb2-tier-price-old-stripe-price-archived-then-the-new-one-fails', async ({ attempt, stripe }) => {
      stripe.failNext('prices.create', { kind: 'error', error: refusedByStripe() })
      await attempt('updateTierPrice', { tierId: ID.privateTier, price: 120 })
    }, privateSynced, tierPriced),
    // GB2: the new price is made in Stripe, then the row's write fails: Stripe has a live price nothing points at.
    g('gb2-tier-price-made-in-stripe-then-the-write-fails', async ({ attempt, db }) => {
      await whileFailing(db, { table: 'service_type_price_tiers', event: 'UPDATE', when: 'true' }, () => attempt('updateTierPrice', { tierId: ID.privateTier, price: 120 }))
    }, privateSynced, tierPriced),
    // GB2: no key. The same press made again (an answer lost) makes a second Stripe price for the one change.
    g('gb2-tier-price-pressed-again-makes-a-second-stripe-price', async ({ call }) => {
      await call('updateTierPrice', { tierId: ID.privateTier, price: 120 })
      await call('updateTierPrice', { tierId: ID.privateTier, price: 120 })
    }, privateSynced, tierPriced),
    // Any active staff may; and a sign-in with no staff row is let through too (resolveStaffId answers null and nothing checks it).
    g('slot-add-who-may', whoMay('addServiceTypeScheduleSlot', slot, 'none')),
    g(
      'slot-add-refusals',
      each('addServiceTypeScheduleSlot', { ...slot, serviceTypeId: '' }, { ...slot, dayOfWeek: 7 }, { ...slot, dayOfWeek: 1.5 }, { ...slot, startTime: '7am' }, slot, { ...slot, serviceTypeId: W48_ID.unknown, dayOfWeek: 3 }),
      tuesdaySlot
    ),
    g('slot-add', async ({ call }) => {
      await call('addServiceTypeScheduleSlot', slot)
      await call('addServiceTypeScheduleSlot', { serviceTypeId: ID.serviceType, dayOfWeek: 6, startTime: '18:30:00' })
    }),
    // GB4: a new weekly slot makes no session on any date already made.
    g('gb4-a-new-weekly-slot-makes-no-session-on-dates-already-made', async ({ call }) => {
      await call('addServiceTypeScheduleSlot', { serviceTypeId: ID.serviceType, dayOfWeek: 4, startTime: '07:00' })
      await call('getSessionsForRange', { startDate: '2026-11-12', endDate: '2026-11-12' })
    }),
    g('slot-remove-who-may', whoMay('deleteServiceTypeScheduleSlot', { slotId: W48_ID.slot }, 'none'), tuesdaySlot),
    g('slot-remove-refusals', each('deleteServiceTypeScheduleSlot', { slotId: '' }, { slotId: W48_ID.unknown }), tuesdaySlot),
    // GB4: the slot goes; a session it made stays bookable (the seed's Thursday 10:00 Sauna, with a Thursday 10:00 slot).
    g('gb4-a-removed-weekly-slot-leaves-its-sessions', async ({ call }) => {
      await call('deleteServiceTypeScheduleSlot', { slotId: W48_ID.slot })
      await call('getSessionsForRange', { startDate: '2026-11-12', endDate: '2026-11-12' })
    }, sql("INSERT INTO service_type_schedule_slots (id, service_type_id, day_of_week, start_time) VALUES ($1, $2, 4, '10:00')", [W48_ID.slot, ID.serviceType])),
  ]
}

// ---------------------------------------------------------------------------------------------------------------------
// 1.2 Catalog: products, stock and add-ons

const soapSynced = synced('products', ID.product, 'prod_soap', { stripe_price_id_base: ['price_soap_base', 1200] })
const towelSynced = synced('addons', ID.addon, 'prod_towel', { stripe_price_id_base: ['price_towel_base', 500] })
const robeSynced = synced('addons', ID.robe, 'prod_robe', { stripe_price_id_base: ['price_robe_base', 1000], stripe_price_id_member: ['price_robe_member', 800] })
const passSynced = synced('session_pass_types', ID.passType, 'prod_pass', { stripe_price_id: ['price_pass', 5000] })
/** Soap's second size, and one earlier delivery on the first. */
const soapStock: Prepare = async (db) => {
  await insert(db, 'product_variants', { id: W48_ID.secondVariant, product_id: ID.product, sku: 'SOAP-2', size: 'Large', stock_quantity: 2 })
  await db.query("INSERT INTO stock_adjustments (id, variant_id, change_amount, reason, staff_id, created_at) VALUES ($1, $2, 5, 'Delivery', $3, '2026-11-01 09:00:00+00')", [W48_ID.stockRow, ID.variant, ID.staff])
}

function productScenarios(): Scenario[] {
  const newVariant = { productId: ID.product, size: ' Large ', sku: ' SOAP-L ' }
  const delivery = { variantId: ID.variant, changeAmount: 10, reasonCategory: 'delivery' }
  const soapPrice = { itemType: 'product', itemId: ID.product, basePrice: 14 }
  return [
    g('products-read', async ({ call }) => {
      await call('getProducts', {})
    }, soapSynced, soapStock),
    g('product-active-who-may', whoMay('setProductActive', { productId: ID.product, active: false }, 'manage_pricing'), soapSynced),
    g('product-active-off-and-on', async ({ call, attempt }) => {
      await call('setProductActive', { productId: ID.product, active: false })
      await call('setProductActive', { productId: ID.product, active: true })
      await attempt('setProductActive', { productId: W48_ID.unknown, active: false })
    }, soapSynced),
    // W65: GB15's scenario (the legacy catalogue route takes the shared key) went with the old side; its decided
    // behaviour is held in sweep/dropped.test.ts (sweep.ts, DROPPED).
    g('product-fulfilment-who-may', whoMay('setProductFulfillmentMethod', { productId: ID.product, fulfillmentMethod: 'both' }, 'manage_pricing')),
    g('product-fulfilment-set', async ({ call, attempt }) => {
      await attempt('setProductFulfillmentMethod', { productId: ID.product, fulfillmentMethod: 'courier' })
      await call('setProductFulfillmentMethod', { productId: W48_ID.unknown, fulfillmentMethod: 'both' })
      await call('setProductFulfillmentMethod', { productId: ID.product, fulfillmentMethod: 'shipping' })
    }),
    g('variant-details-who-may', whoMay('setProductVariantDetails', { variantId: ID.variant, size: 'Small', sku: 'SOAP-S' }, 'manage_pricing')),
    g('variant-details-set', async ({ call }) => {
      await call('setProductVariantDetails', { variantId: ID.variant, size: 'Small', sku: 'SOAP-S' })
      await call('setProductVariantDetails', { variantId: W48_ID.unknown, size: 'Small', sku: 'SOAP-X' })
    }),
    // GB23: no checks. An empty size is saved; a SKU another variant has, or none, shows the database's own error.
    g('gb23-variant-details-have-no-checks', async ({ call, attempt }) => {
      await call('setProductVariantDetails', { variantId: ID.variant, size: '', sku: 'SOAP-1' })
      await attempt('setProductVariantDetails', { variantId: ID.variant, size: 'Small', sku: 'CANDLE-1' })
      await attempt('setProductVariantDetails', { variantId: ID.variant, size: 'Small', sku: null })
    }),
    // Any active staff may (GB12): the inactive account is refused, a sign-in with no staff row is not.
    g('variant-create-who-may', whoMay('createProductVariant', newVariant, 'none'), soapSynced),
    g(
      'variant-create-refusals',
      each(
        'createProductVariant',
        { ...newVariant, productId: '' },
        { ...newVariant, size: '  ' },
        { ...newVariant, sku: '  ' },
        { ...newVariant, stockQuantity: -1 },
        { ...newVariant, stockQuantity: 1.5 },
        { ...newVariant, productId: W48_ID.unknown },
        { ...newVariant, sku: 'CANDLE-1' },
        // Candle was never synced: it has no Stripe product.
        { ...newVariant, productId: ID.candle }
      ),
      soapSynced
    ),
    g('variant-create-refused-by-stripe', async ({ attempt, stripe }) => {
      stripe.failNext('prices.create', { kind: 'error', error: refusedByStripe() })
      await attempt('createProductVariant', newVariant)
    }, soapSynced),
    // The Stripe price is made, the variant's insert fails, and the route archives the price again.
    g('variant-create-the-insert-fails', async ({ attempt, db }) => {
      await whileFailing(db, { table: 'product_variants', event: 'INSERT', when: 'true' }, () => attempt('createProductVariant', newVariant))
    }, soapSynced),
    g('variant-create-with-no-starting-stock', async ({ call }) => {
      await call('createProductVariant', newVariant)
    }, soapSynced),
    // With starting stock: the variant through the legacy route, then an "Initial stock" ledger row from Retool.
    g('variant-create-with-starting-stock', async ({ call }) => {
      await call('createProductVariant', { ...newVariant, stockQuantity: 10 })
    }, soapSynced),
    // GB12: Manage pricing is not asked for. A team member without it makes a variant (and its Stripe price).
    g('gb12-a-variant-made-without-manage-pricing', async ({ call }) => {
      await call('createProductVariant', { ...newVariant, stockQuantity: 3 })
    }, soapSynced, noManagePricing),
    // GB12: the ledger row is a second step. It fails on its own: the variant has 10 in stock and no ledger row. W65b:
    // renamed from gb12-the-initial-stock-ledger-row-fails-on-its-own: the failure was the old side's own statement
    // (gone at W65a); on the Worker the variant and its ledger row are written together.
    g('gb12-a-variant-made-with-its-initial-stock-and-ledger-row', async ({ attempt }) => {
      await attempt('createProductVariant', { ...newVariant, stockQuantity: 10 })
    }, soapSynced),
    // The checks of what was sent come before the staff check.
    g(
      'stock-adjust-refusals',
      each(
        'adjustVariantStock',
        { ...delivery, variantId: '' },
        { ...delivery, changeAmount: 0 },
        { ...delivery, changeAmount: 1.5 },
        { ...delivery, reasonCategory: 'theft' },
        { ...delivery, reasonCategory: 'other' },
        { ...delivery, reasonCategory: 'other', note: '   ' },
        { ...delivery, variantId: W48_ID.unknown },
        { variantId: ID.variant, changeAmount: -6, reasonCategory: 'damage' }
      )
    ),
    g('stock-adjust-who-may', whoMay('adjustVariantStock', delivery, 'none')),
    g('stock-adjust-each-reason', async ({ call }) => {
      await call('adjustVariantStock', delivery)
      await call('adjustVariantStock', { variantId: ID.variant, changeAmount: -2, reasonCategory: 'damage' })
      await call('adjustVariantStock', { variantId: ID.variant, changeAmount: -1, reasonCategory: 'recount' })
      await call('adjustVariantStock', { variantId: ID.variant, changeAmount: -1, reasonCategory: 'sale' })
      await call('adjustVariantStock', { variantId: ID.variant, changeAmount: 1, reasonCategory: 'refund_restock' })
      await call('adjustVariantStock', { variantId: ID.variant, changeAmount: -12, reasonCategory: 'other', note: '  Given to the raffle  ' })
      await call('getStockAdjustments', { variantId: ID.variant })
    }),
    // Stock taken by a sale between the check and the write: the guarded update changes nothing and the ledger row is taken back.
    // W65b: on the Worker the check and the write are one transaction; the sale lands at the nearest point, just before
    // that transaction opens. A real sale of four in cash (5 to 1), so its ledger row is written as live writes it (until
    // W65a a statement setting the stock to 1 stood for it).
    g('stock-adjust-stock-sold-between-the-check-and-the-write', async ({ attempt, call, db, stripe }) => {
      const fourSoaps = { productVariantId: ID.variant, quantity: 4, unitPrice: 12, systemUnitPrice: 12 }
      await atItsFirstTransaction(
        { db, stripe },
        VARIANT_STOCK_PATH,
        () => call('createOrder', { customerId: ID.customer, products: [fourSoaps], payment: { method: 'cash', confirmedCashAmount: 48 } }),
        () => attempt('adjustVariantStock', { variantId: ID.variant, changeAmount: -4, reasonCategory: 'damage' })
      )
    }),
    // The stock write itself fails: the ledger row written first is deleted again.
    g('stock-adjust-the-stock-write-fails', async ({ attempt, db }) => {
      await whileFailing(db, { table: 'product_variants', event: 'UPDATE', when: 'true' }, () => attempt('adjustVariantStock', delivery))
    }),
    // GB13: no press key. A delivery of 10 whose answer was lost, pressed again: stock reads 25 for 15 on the shelf.
    g('gb13-a-stock-press-made-twice-counts-twice', async ({ call }) => {
      await call('adjustVariantStock', delivery)
      await call('adjustVariantStock', delivery)
    }),
    // GB13: the ledger row and the stock change are two statements. Dying between them leaves a ledger row for stock that never moved.
    // W65b: renamed from gb13-the-ledger-row-is-written-and-the-stock-change-never-runs: the death was the old side's
    // (gone at W65a); on the Worker the ledger row and the stock change are one transaction, and the press goes through.
    g('gb13-a-delivery-writes-its-ledger-row-and-the-stock-change-together', async ({ attempt }) => {
      await attempt('adjustVariantStock', delivery)
    }),
    g('stock-history-read', async ({ call, attempt }) => {
      await attempt('getStockAdjustments', { variantId: '' })
      await call('getStockAdjustments', { variantId: ID.variant })
      await call('adjustVariantStock', delivery)
      await call('getStockAdjustments', { variantId: ID.variant, limit: 1 })
      await call('getStockAdjustments', { variantId: W48_ID.unknown })
    }, soapStock),
    g('price-who-may', whoMay('updateCatalogItemPrice', soapPrice, 'manage_pricing'), soapSynced),
    g(
      'price-refusals',
      each(
        'updateCatalogItemPrice',
        { ...soapPrice, itemId: '' },
        { itemType: 'product', itemId: ID.product },
        { ...soapPrice, basePrice: -1 },
        { itemType: 'product', itemId: ID.product, memberPrice: -0.01 },
        { itemType: 'product', itemId: ID.product, salePrice: Number.POSITIVE_INFINITY },
        { itemType: 'membership_plan', itemId: ID.plan, monthlyPrice: -5 },
        { itemType: 'membership_plan', itemId: ID.plan, yearlyPrice: Number.NaN },
        { ...soapPrice, itemId: W48_ID.unknown },
        // Candle has no Stripe product; a private service type's prices are its tiers.
        { ...soapPrice, itemId: ID.candle },
        { itemType: 'service_type', itemId: ID.privateType, basePrice: 90 }
      ),
      soapSynced,
      privateSynced
    ),
    // Base (its old Stripe price archived), then a member and a sale price for the first time, all in one press.
    g('price-product-base-member-and-sale', async ({ call }) => {
      await call('updateCatalogItemPrice', { itemType: 'product', itemId: ID.product, basePrice: 14, memberPrice: 11.5, salePrice: 9.99 })
    }, soapSynced),
    g('price-addon-base-and-member', async ({ call }) => {
      await call('updateCatalogItemPrice', { itemType: 'addon', itemId: ID.robe, basePrice: 12, memberPrice: 9 })
      // £0 is a price: a free add-on.
      await call('updateCatalogItemPrice', { itemType: 'addon', itemId: ID.addon, basePrice: 0 })
    }, robeSynced, towelSynced),
    g('price-session-pass', async ({ call }) => {
      await call('updateCatalogItemPrice', { itemType: 'session_pass_type', itemId: ID.passType, basePrice: 55 })
    }, passSynced),
    g('price-public-service-type', async ({ call }) => {
      await call('updateCatalogItemPrice', { itemType: 'service_type', itemId: ID.serviceType, basePrice: 22 })
    }, saunaSynced),
    // A price field the item's kind doesn't have (a monthly price on a product): the function lets it through, the
    // route prices nothing and its update is given no column to set, which fails: "Failed to update item".
    g('price-a-field-the-item-does-not-have', each('updateCatalogItemPrice', { itemType: 'product', itemId: ID.product, monthlyPrice: 30 }), soapSynced),
    // GB2, for a product: the old Stripe price archived, the new one refused, the row left on the archived price.
    g('gb2-product-price-old-stripe-price-archived-then-the-new-one-fails', async ({ attempt, stripe }) => {
      stripe.failNext('prices.create', { kind: 'error', error: refusedByStripe() })
      await attempt('updateCatalogItemPrice', soapPrice)
    }, soapSynced),
    g('addons-read', async ({ call }) => {
      await call('getAddons', {})
    }, robeSynced),
    g('addon-active-who-may', whoMay('setAddonActive', { addonId: ID.addon, active: false }, 'manage_pricing'), towelSynced),
    g('addon-active-off-and-on', async ({ call, attempt }) => {
      await call('setAddonActive', { addonId: ID.addon, active: false })
      await call('setAddonActive', { addonId: ID.addon, active: true })
      await attempt('setAddonActive', { addonId: W48_ID.unknown, active: true })
    }, towelSynced),
    g('addon-sku-who-may', whoMay('setAddonSku', { addonId: ID.addon, sku: 'TOWEL-2' }, 'manage_pricing')),
    g('addon-sku-set', async ({ call }) => {
      await call('setAddonSku', { addonId: ID.addon, sku: ' TOWEL-2 ' })
      // A blank SKU is saved as none.
      await call('setAddonSku', { addonId: ID.addon, sku: '   ' })
      await call('setAddonSku', { addonId: W48_ID.unknown, sku: 'X' })
    }),
    // GB23: a SKU another add-on has shows the database's own error.
    g('gb23-addon-sku-already-used-shows-the-database-error', each('setAddonSku', { addonId: ID.addon, sku: 'ROBE' })),
  ]
}

// ---------------------------------------------------------------------------------------------------------------------
// 1.3 Catalog: session passes and gift card types

const giftTypeSynced = synced('gift_card_types', ID.giftCardType, 'prod_gift')
/** The seed's £60 preset with its Stripe price, as one made through the legacy route has. */
const presetPriced: Prepare = async (db, stripe) => {
  stripe.addPrice('price_preset_60', 6000, null)
  await db.query("UPDATE gift_card_presets SET stripe_price_id = 'price_preset_60' WHERE id = $1", [ID.giftCardPreset])
}

function passAndGiftCardScenarios(): Scenario[] {
  const custom = { giftCardTypeId: ID.giftCardType, customAmountEnabled: true, customAmountMin: 5, customAmountMax: 250 }
  return [
    // Without a session, and with one: `covers_session` says whether each pass type's level covers that session's band.
    g('pass-types-read', async ({ call }) => {
      await call('getSessionPassTypes', {})
      await call('getSessionPassTypes', { sessionId: ID.session })
      await call('getSessionPassTypes', { sessionId: ID.peakSession })
    }, passSynced, sql("INSERT INTO session_pass_types (id, name, price, sessions_included, level) VALUES ($1, 'Core Five', '40.00', 5, 'core')", [ID.corePass])),
    g('pass-active-who-may', whoMay('setSessionPassActive', { passTypeId: ID.passType, active: false }, 'manage_pricing'), passSynced),
    g('pass-active-off-and-on', async ({ call, attempt }) => {
      await call('setSessionPassActive', { passTypeId: ID.passType, active: false })
      await call('setSessionPassActive', { passTypeId: ID.passType, active: true })
      await attempt('setSessionPassActive', { passTypeId: W48_ID.unknown, active: true })
    }, passSynced),
    g('pass-expiry-who-may', whoMay('setSessionPassExpiry', { passTypeId: ID.passType, expiryMonths: 6 }, 'manage_pricing')),
    g('pass-expiry-set', async ({ call }) => {
      await call('setSessionPassExpiry', { passTypeId: ID.passType, expiryMonths: 6 })
      await call('setSessionPassExpiry', { passTypeId: W48_ID.unknown, expiryMonths: 6 })
    }),
    g('pass-sessions-who-may', whoMay('setSessionPassSessionsIncluded', { passTypeId: ID.passType, sessionsIncluded: 10 }, 'manage_pricing')),
    g('pass-sessions-set', async ({ call }) => {
      await call('setSessionPassSessionsIncluded', { passTypeId: ID.passType, sessionsIncluded: 10 })
      await call('setSessionPassSessionsIncluded', { passTypeId: W48_ID.unknown, sessionsIncluded: 10 })
    }),
    // GB10: no check on either number, in the code or in the database. 0 sessions and an expiry of -1 month are saved;
    // only a value that isn't a whole number is stopped, by the column's type, in the database's own words.
    g('gb10-a-pass-type-saved-with-no-sessions-and-a-negative-expiry', async ({ call, attempt }) => {
      await call('setSessionPassSessionsIncluded', { passTypeId: ID.passType, sessionsIncluded: 0 })
      await call('setSessionPassSessionsIncluded', { passTypeId: ID.passType, sessionsIncluded: -3 })
      await call('setSessionPassExpiry', { passTypeId: ID.passType, expiryMonths: -1 })
      await call('setSessionPassExpiry', { passTypeId: ID.passType, expiryMonths: 0 })
      await attempt('setSessionPassExpiry', { passTypeId: ID.passType, expiryMonths: 1.5 })
      await attempt('setSessionPassSessionsIncluded', { passTypeId: ID.passType, sessionsIncluded: 2.5 })
    }),
    // This one answers a refusal as data, and reads the permission itself: no staff row and an inactive account differ.
    g('pass-level-who-may', whoMay('setSessionPassLevel', { passTypeId: ID.passType, level: 'core' }, 'manage_pricing')),
    g('pass-level-refusals', each('setSessionPassLevel', { passTypeId: ID.passType, level: 'gold' }, { passTypeId: W48_ID.unknown, level: 'core' })),
    g('pass-level-set', async ({ call }) => {
      await call('setSessionPassLevel', { passTypeId: ID.passType, level: 'core' })
      await call('setSessionPassLevel', { passTypeId: ID.passType, level: 'all_access' })
    }),
    // GB9: Sam holds an All-Access pass with 3 sessions left. The type is set to Core: the pass no longer covers Peak.
    g('gb9-a-level-change-reaches-passes-already-sold', async ({ call }) => {
      await call('getSessionPassTypes', { sessionId: ID.peakSession })
      await call('setSessionPassLevel', { passTypeId: ID.passType, level: 'core' })
      await call('getSessionPassTypes', { sessionId: ID.peakSession })
    }),
    g('gift-card-types-read', async ({ call }) => {
      await call('getGiftCardTypes', {})
    }, giftTypeSynced, presetPriced, sql("INSERT INTO gift_card_presets (id, gift_card_type_id, amount, active) VALUES ($1, $2, '25.00', false)", [W48_ID.secondPreset, ID.giftCardType])),
    g('gift-card-type-active-who-may', whoMay('setGiftCardTypeActive', { giftCardTypeId: ID.giftCardType, active: false }, 'manage_pricing'), giftTypeSynced),
    g('gift-card-type-active-off-and-on', async ({ call, attempt }) => {
      await call('setGiftCardTypeActive', { giftCardTypeId: ID.giftCardType, active: false })
      await call('setGiftCardTypeActive', { giftCardTypeId: ID.giftCardType, active: true })
      await attempt('setGiftCardTypeActive', { giftCardTypeId: W48_ID.unknown, active: true })
    }, giftTypeSynced),
    g('gift-card-preset-active-who-may', whoMay('setGiftCardPresetActive', { presetId: ID.giftCardPreset, active: false }, 'manage_pricing'), giftTypeSynced, presetPriced),
    // A preset is switched by its Stripe price, not a product.
    g('gift-card-preset-active-off-and-on', async ({ call, attempt }) => {
      await call('setGiftCardPresetActive', { presetId: ID.giftCardPreset, active: false })
      await call('setGiftCardPresetActive', { presetId: ID.giftCardPreset, active: true })
      await attempt('setGiftCardPresetActive', { presetId: W48_ID.unknown, active: true })
    }, giftTypeSynced, presetPriced),
    g('gift-card-preset-active-refused-by-stripe', async ({ attempt, stripe }) => {
      stripe.failNext('prices.update', { kind: 'error', error: refusedByStripe() })
      await attempt('setGiftCardPresetActive', { presetId: ID.giftCardPreset, active: false })
    }, giftTypeSynced, presetPriced),
    g('gift-card-preset-create-who-may', whoMay('createGiftCardPreset', { giftCardTypeId: ID.giftCardType, amount: 25 }, 'manage_pricing'), giftTypeSynced),
    g(
      'gift-card-preset-create-refusals',
      each('createGiftCardPreset', { giftCardTypeId: '', amount: 25 }, { giftCardTypeId: ID.giftCardType, amount: 0 }, { giftCardTypeId: ID.giftCardType, amount: -5 }, { giftCardTypeId: ID.giftCardType, amount: Number.NaN }, { giftCardTypeId: W48_ID.unknown, amount: 25 }),
      giftTypeSynced
    ),
    g('gift-card-preset-create-refused-type-has-no-stripe-product', each('createGiftCardPreset', { giftCardTypeId: ID.giftCardType, amount: 25 })),
    g('gift-card-preset-create', async ({ call }) => {
      await call('createGiftCardPreset', { giftCardTypeId: ID.giftCardType, amount: 25 })
      await call('createGiftCardPreset', { giftCardTypeId: ID.giftCardType, amount: 99.99 })
    }, giftTypeSynced),
    g('gift-card-preset-create-refused-by-stripe', async ({ attempt, stripe }) => {
      stripe.failNext('prices.create', { kind: 'error', error: refusedByStripe() })
      await attempt('createGiftCardPreset', { giftCardTypeId: ID.giftCardType, amount: 25 })
    }, giftTypeSynced),
    // The Stripe price is made, the row's insert fails, and the route archives the price again.
    g('gift-card-preset-create-the-insert-fails', async ({ attempt, db }) => {
      await whileFailing(db, { table: 'gift_card_presets', event: 'INSERT', when: 'true' }, () => attempt('createGiftCardPreset', { giftCardTypeId: ID.giftCardType, amount: 25 }))
    }, giftTypeSynced),
    g('gift-card-preset-price-who-may', whoMay('updateGiftCardPresetPrice', { presetId: ID.giftCardPreset, amount: 75 }, 'manage_pricing'), giftTypeSynced, presetPriced),
    g(
      'gift-card-preset-price-refusals',
      each('updateGiftCardPresetPrice', { presetId: '', amount: 75 }, { presetId: ID.giftCardPreset, amount: 0 }, { presetId: ID.giftCardPreset, amount: Number.NaN }, { presetId: W48_ID.unknown, amount: 75 }),
      giftTypeSynced,
      presetPriced
    ),
    g('gift-card-preset-price-refused-type-has-no-stripe-product', each('updateGiftCardPresetPrice', { presetId: ID.giftCardPreset, amount: 75 })),
    // The seed's gift card (£40, bought earlier) is untouched: only the preset and its Stripe price change.
    g('gift-card-preset-price-set', async ({ call }) => {
      await call('updateGiftCardPresetPrice', { presetId: ID.giftCardPreset, amount: 75 })
    }, giftTypeSynced, presetPriced),
    // GB2, for a preset: the new Stripe price is made, then the preset's write fails: the preset keeps its archived price.
    g('gb2-preset-price-made-in-stripe-then-the-write-fails', async ({ attempt, db }) => {
      await whileFailing(db, { table: 'gift_card_presets', event: 'UPDATE', when: 'true' }, () => attempt('updateGiftCardPresetPrice', { presetId: ID.giftCardPreset, amount: 75 }))
    }, giftTypeSynced, presetPriced),
    // GB2, for a preset: the old Stripe price archived, the new one refused: the preset is left on an archived price.
    g('gb2-preset-price-old-stripe-price-archived-then-the-new-one-fails', async ({ attempt, stripe }) => {
      stripe.failNext('prices.create', { kind: 'error', error: refusedByStripe() })
      await attempt('updateGiftCardPresetPrice', { presetId: ID.giftCardPreset, amount: 75 })
    }, giftTypeSynced, presetPriced),
    g('gift-card-type-custom-amounts-who-may', whoMay('setGiftCardTypeCustomAmountSettings', custom, 'manage_pricing')),
    g(
      'gift-card-type-custom-amounts-refusals',
      each(
        'setGiftCardTypeCustomAmountSettings',
        { ...custom, giftCardTypeId: '' },
        { giftCardTypeId: ID.giftCardType, customAmountEnabled: true },
        { ...custom, customAmountMin: -1 },
        { ...custom, customAmountMax: 0 },
        { giftCardTypeId: ID.giftCardType, customAmountEnabled: true, customAmountMin: 5 },
        { ...custom, customAmountMin: 300 },
        { ...custom, giftCardTypeId: W48_ID.unknown }
      )
    ),
    g('gift-card-type-custom-amounts-set-and-off', async ({ call }) => {
      await call('setGiftCardTypeCustomAmountSettings', custom)
      // Off: the two limits are cleared, whatever was sent.
      await call('setGiftCardTypeCustomAmountSettings', { giftCardTypeId: ID.giftCardType, customAmountEnabled: false, customAmountMin: 5, customAmountMax: 250 })
    }),
    g('gift-card-type-expiry-who-may', whoMay('setGiftCardTypeExpiry', { giftCardTypeId: ID.giftCardType, expiryMonths: 24 }, 'manage_pricing')),
    g('gift-card-type-expiry-set', async ({ call }) => {
      await call('setGiftCardTypeExpiry', { giftCardTypeId: ID.giftCardType, expiryMonths: 24 })
      await call('setGiftCardTypeExpiry', { giftCardTypeId: W48_ID.unknown, expiryMonths: 24 })
    }),
    // GB10: a gift card type's expiry has no check either.
    g('gb10-a-gift-card-type-saved-with-a-negative-expiry', async ({ call, attempt }) => {
      await call('setGiftCardTypeExpiry', { giftCardTypeId: ID.giftCardType, expiryMonths: -1 })
      await call('setGiftCardTypeExpiry', { giftCardTypeId: ID.giftCardType, expiryMonths: 0 })
      await attempt('setGiftCardTypeExpiry', { giftCardTypeId: ID.giftCardType, expiryMonths: 1.5 })
    }),
  ]
}

// ---------------------------------------------------------------------------------------------------------------------
// 1.4 Catalog: membership plans and settings

const MONTHLY_PRICE = 'price_seed_monthly'
const YEARLY_PRICE = 'price_seed_yearly'
/** The seed's Core plan's Stripe product, known to the fake (its two prices already are). */
const planSynced: Prepare = async (_db, stripe) => {
  stripe.addProduct('prod_seed')
}
/** Mo's membership as live ones are: a Stripe subscription on the plan's monthly price. */
const moSubscribed: Prepare = async (db, stripe) => {
  await db.query("UPDATE customer_memberships SET stripe_subscription_id = 'sub_mo', next_renewal_date = '2026-12-10' WHERE id = $1", [ID.membership])
  stripe.addSubscription('sub_mo', 'cus_member', MONTHLY_PRICE)
}
/** Two more members on Core: Pat pays monthly and her payment is overdue; Yan pays yearly. */
const moreMembers: Prepare = async (db, stripe) => {
  stripe.addCustomer('cus_pat')
  stripe.addCustomer('cus_yan')
  await insert(db, 'customers', { id: W48_ID.secondMember, first_name: 'Pat', last_name: 'Monthly', email: 'pat@example.com', date_of_birth: '1980-02-02', stripe_customer_id: 'cus_pat' })
  await insert(db, 'customers', { id: W48_ID.thirdMember, first_name: 'Yan', last_name: 'Yearly', email: 'yan@example.com', date_of_birth: '1975-03-03', stripe_customer_id: 'cus_yan' })
  await insert(db, 'customer_memberships', { id: W48_ID.secondMembership, customer_id: W48_ID.secondMember, plan_id: ID.plan, start_date: '2026-09-15', subscription_status: 'past_due', billing_frequency: 'monthly', stripe_subscription_id: 'sub_pat', next_renewal_date: '2026-11-15' })
  await insert(db, 'customer_memberships', { id: W48_ID.thirdMembership, customer_id: W48_ID.thirdMember, plan_id: ID.plan, start_date: '2026-06-01', subscription_status: 'active', billing_frequency: 'yearly', stripe_subscription_id: 'sub_yan', next_renewal_date: '2027-06-01', is_herd: true })
  stripe.addSubscription('sub_pat', 'cus_pat', MONTHLY_PRICE)
  stripe.addSubscription('sub_yan', 'cus_yan', YEARLY_PRICE)
}
const settingsRow = sql('INSERT INTO membership_settings (id, addon_credit_wait_months) VALUES (true, 6)')

function planScenarios(): Scenario[] {
  const newPlan = { name: ' Weekender ', level: 'core', sessionsIncluded: 2, addonsIncluded: 1, isUnlimited: false, priceMonthly: 25, priceYearly: 250 }
  const details = { planId: ID.plan, level: 'core', isUnlimited: false, sessionsIncluded: 4, addonsIncluded: 0, priceMonthly: 40, priceYearly: 400 }
  return [
    g('plans-read', async ({ call }) => {
      await call('getMembershipPlans', {})
    }),
    g('plan-create-who-may', whoMay('createMembershipPlan', newPlan, 'manage_pricing')),
    g(
      'plan-create-refusals',
      each(
        'createMembershipPlan',
        { ...newPlan, name: '   ' },
        { ...newPlan, level: 'gold' },
        { ...newPlan, sessionsIncluded: -1 },
        { ...newPlan, sessionsIncluded: 1.5 },
        { ...newPlan, sessionsIncluded: 0 },
        { ...newPlan, addonsIncluded: -1 },
        { ...newPlan, addonsIncluded: 0.5 },
        { ...newPlan, isUnlimited: 'yes' },
        { ...newPlan, priceMonthly: null, priceYearly: null },
        { ...newPlan, priceMonthly: -1 },
        { ...newPlan, priceYearly: Number.NaN }
      )
    ),
    // The row (off sale), then the legacy sync-stripe route (a product, a monthly and a yearly price), then toggle-active.
    g('plan-create', async ({ call }) => {
      await call('createMembershipPlan', newPlan)
    }),
    g('plan-create-monthly-only-and-unlimited', async ({ call }) => {
      // Unlimited: the sessions sent are ignored and saved as 0.
      await call('createMembershipPlan', { name: 'Unlimited', level: 'all_access', sessionsIncluded: 7, addonsIncluded: 2, isUnlimited: true, priceMonthly: 90, priceYearly: null })
    }),
    // GB20: three steps and no undo. Stripe refuses the product: an off-sale plan row is left, one for each press.
    g('gb20-plan-create-stripe-step-fails-and-leaves-a-row-each-press', async ({ attempt, stripe }) => {
      stripe.failNext('products.create', { kind: 'error', error: refusedByStripe() })
      await attempt('createMembershipPlan', newPlan)
      stripe.failNext('products.create', { kind: 'error', error: refusedByStripe() })
      await attempt('createMembershipPlan', newPlan)
    }),
    // GB20: the product and the monthly price are made, the yearly price is refused: Stripe has a product and a price no row names.
    g('gb20-plan-create-fails-part-way-through-stripe', async ({ attempt, stripe }) => {
      stripe.failNext('prices.create', { kind: 'none' })
      stripe.failNext('prices.create', { kind: 'error', error: refusedByStripe() })
      await attempt('createMembershipPlan', newPlan)
    }),
    // GB20: the product and both prices are made in Stripe, then writing their ids to the plan fails: Stripe has a
    // product and two prices no row names, and the plan row has none.
    g('gb20-plan-create-stripe-made-then-the-row-write-fails', async ({ attempt, db }) => {
      await whileFailing(db, { table: 'membership_plans', event: 'UPDATE', when: 'true' }, () => attempt('createMembershipPlan', newPlan))
    }),
    // GB20: synced, then the on-sale step is refused: the plan has its Stripe ids and stays off sale.
    g('gb20-plan-create-the-on-sale-step-fails', async ({ attempt, stripe }) => {
      stripe.failNext('products.update', { kind: 'error', error: refusedByStripe() })
      await attempt('createMembershipPlan', newPlan)
    }),
    g('plan-active-who-may', whoMay('setMembershipPlanActive', { planId: ID.plan, active: false }, 'manage_pricing'), planSynced),
    // Off sale and back: Stripe's product and the row. Mo's membership and her subscription are not touched.
    g('plan-active-off-and-on', async ({ call, attempt }) => {
      await call('setMembershipPlanActive', { planId: ID.plan, active: false })
      await call('setMembershipPlanActive', { planId: ID.plan, active: true })
      await attempt('setMembershipPlanActive', { planId: W48_ID.unknown, active: true })
    }, planSynced, moSubscribed),
    g('plan-details-who-may', whoMay('setMembershipPlanDetails', details, 'manage_pricing'), planSynced),
    g(
      'plan-details-refusals',
      each(
        'setMembershipPlanDetails',
        { ...details, name: '  ' },
        { ...details, level: 'gold' },
        { ...details, sessionsIncluded: -2 },
        { ...details, sessionsIncluded: 0 },
        { ...details, addonsIncluded: 1.5 },
        { ...details, priceMonthly: -1 },
        { ...details, priceYearly: Number.NaN },
        { ...details, planId: W48_ID.unknown }
      ),
      planSynced
    ),
    // Neither price changed: no Stripe call, one update of the details.
    g('plan-details-set-without-a-price-change', async ({ call }) => {
      await call('setMembershipPlanDetails', { ...details, name: ' Core Plus ', level: 'all_access', sessionsIncluded: 6, addonsIncluded: 2 })
      await call('setMembershipPlanDetails', { ...details, isUnlimited: true, sessionsIncluded: 9 })
    }, planSynced),
    // A plan never synced (no Stripe product): sync-stripe makes the product and prices from the row, then update-price
    // archives those and makes them again at the new price.
    g('plan-details-price-change-on-a-plan-never-synced', async ({ call }) => {
      await call('setMembershipPlanDetails', { planId: W48_ID.unsyncedPlan, level: 'core', isUnlimited: false, sessionsIncluded: 2, addonsIncluded: 0, priceMonthly: 30, priceYearly: 300 })
    }, sql("INSERT INTO membership_plans (id, name, level, sessions_included, price_monthly, price_yearly, active) VALUES ($1, 'Off Peak', 'core', 2, '28.00', '280.00', false)", [W48_ID.unsyncedPlan])),
    // GB1: Core's monthly price goes from £40 to £45 with three members on it. Mo and Pat (overdue) are moved to the
    // new price with no proration; Yan pays yearly, whose price didn't change. The function answers the plan's row
    // and nothing else: no count, no record, no audit row.
    g('gb1-plan-price-change-moves-every-live-member-and-says-nothing', async ({ call }) => {
      await call('setMembershipPlanDetails', { ...details, priceMonthly: 45 })
    }, planSynced, moSubscribed, moreMembers),
    // GB1: Stripe refuses Mo's move. Pat pays £45 from her next renewal and Mo £40 for ever; the answer is the same row.
    g('gb1-one-members-move-is-refused-and-nothing-says-which', async ({ call, stripe }) => {
      stripe.failNext('subscriptions.update', { kind: 'error', error: refusedByStripe() })
      await call('setMembershipPlanDetails', { ...details, priceMonthly: 45 })
    }, planSynced, moSubscribed, moreMembers),
    // GB1: the legacy route itself does answer the counts (moved, already current, skipped, failed): called directly,
    // as the price dialogs of the other catalogue pages call it. Both prices change here, so Yan moves too.
    g('gb1-the-legacy-route-answers-the-counts-the-plan-function-drops', async ({ call, stripe }) => {
      stripe.failNext('subscriptions.update', { kind: 'error', error: refusedByStripe() })
      await call('updateCatalogItemPrice', { itemType: 'membership_plan', itemId: ID.plan, monthlyPrice: 45, yearlyPrice: 450 })
    }, planSynced, moSubscribed, moreMembers),
    // GB1: a member whose subscription has ended in Stripe is skipped; one with no subscription isn't looked at.
    g('gb1-an-ended-subscription-is-skipped', async ({ call, stripe }) => {
      await stripe.subscriptions.cancel('sub_mo')
      stripe.calls.length = 0
      await call('updateCatalogItemPrice', { itemType: 'membership_plan', itemId: ID.plan, monthlyPrice: 45 })
    }, planSynced, moSubscribed),
    // GB2: the old monthly price is archived, the new one refused: the plan's row still names the archived price, and
    // the details the same press carried (the name, the sessions) are not saved either.
    g('gb2-plan-price-old-stripe-price-archived-then-the-new-one-fails', async ({ attempt, stripe }) => {
      stripe.failNext('prices.create', { kind: 'error', error: refusedByStripe() })
      await attempt('setMembershipPlanDetails', { ...details, name: 'Core Plus', sessionsIncluded: 6, priceMonthly: 45 })
    }, planSynced, moSubscribed),
    g('membership-settings-read', async ({ call, db }) => {
      await call('getMembershipSettings', {})
      // No row: the function answers the default, 6.
      await db.query('RESET ROLE')
      await db.query('DELETE FROM membership_settings')
      await db.query('SET ROLE paddock_worker')
      await call('getMembershipSettings', {})
    }, sql('INSERT INTO membership_settings (id, addon_credit_wait_months) VALUES (true, 3)')),
    g('membership-settings-who-may', whoMay('setMembershipSettings', { addonCreditWaitMonths: 3 }, 'manage_pricing'), settingsRow),
    g('membership-settings-refusals', each('setMembershipSettings', { addonCreditWaitMonths: -1 }, { addonCreditWaitMonths: 61 }, { addonCreditWaitMonths: 1.5 }, { addonCreditWaitMonths: '6' }), settingsRow),
    g('membership-settings-refused-no-settings-row', each('setMembershipSettings', { addonCreditWaitMonths: 3 })),
    // GB19: two statements and no record. Mo joined 10 months ago and is Herd at 6 months. At 12 months she isn't:
    // one save turns her Herd flag off (herdFlagsChanged 1), and setting it to 0 turns it on again.
    g('gb19-the-waiting-period-changes-members-herd-flags-with-no-record', async ({ call }) => {
      await call('setMembershipSettings', { addonCreditWaitMonths: 12 })
      await call('setMembershipSettings', { addonCreditWaitMonths: 0 })
    }, settingsRow),
    // GB19: the waiting period is saved, then the Herd refresh fails: the setting says 12 months and every flag is as it was.
    // W65b: renamed from gb19-the-waiting-period-is-saved-and-the-herd-refresh-fails: the failure was the old side's own
    // statement (gone at W65a); on the Worker the setting and the Herd refresh are saved together.
    g('gb19-the-waiting-period-is-saved-with-the-herd-refresh', async ({ attempt }) => {
      await attempt('setMembershipSettings', { addonCreditWaitMonths: 12 })
    }, settingsRow),
  ]
}

// ---------------------------------------------------------------------------------------------------------------------
// 1.5 Catalog: events, and the attendee list

const eventIs = (statement: string, params: SqlParam[] = []): Prepare => sql(statement, [...params, ID.event])
/** The seed's event moved to tonight, 19:00 to 21:00, so check-in is open from the start of today. */
const eventTonight = eventIs("UPDATE events SET starts_at = '2026-11-10 19:00:00+00', ends_at = '2026-11-10 21:00:00+00', refund_cutoff_at = '2026-11-09 19:00:00+00' WHERE id = $1")
const extraWaiver = eventIs("UPDATE events SET has_extra_waiver = true, extra_waiver_version = 'cold-plunge-v2' WHERE id = $1")
/** An event as Sanity's webhook first makes it: a name, and nothing set. */
const draftEvent = sql("INSERT INTO events (id, name) VALUES ($1, 'Winter Solstice')", [W48_ID.draftEvent])

/** Sam and a guest booked on the seed's event, paid in cash (£80), through the old order code as the older scenarios do. */
async function twoPlaces({ call, db }: Pick<ScenarioContext, 'call' | 'db'>): Promise<{ bookingId: string; samId: string; alexId: string }> {
  const placed = (await call('createOrder', {
    customerId: ID.customer,
    event: { eventId: ID.event, accountHolderAttending: true, guestsOver18Confirmed: true, attendees: [{ ...sam, isAccountHolder: true }, { name: 'Alex Guest', email: 'alex@example.com', isAccountHolder: false }] },
    payment: { method: 'cash', confirmedCashAmount: 80 },
  })) as { eventBookingId: string }
  const rows = await db.query<{ id: string; attendee_type: string }>('SELECT id, attendee_type FROM event_attendees WHERE event_booking_id = $1', [placed.eventBookingId])
  return { bookingId: placed.eventBookingId, samId: rows.find((row) => row.attendee_type === 'account_holder')?.id ?? '', alexId: rows.find((row) => row.attendee_type !== 'account_holder')?.id ?? '' }
}

function eventScenarios(): Scenario[] {
  const details = {
    eventId: ID.event,
    startsAt: '2026-12-01T19:00:00.000Z',
    endsAt: '2026-12-01T21:00:00.000Z',
    capacity: 10,
    access: 'public',
    publicReleaseAt: null,
    pricePublic: 40,
    pricePreHerd: 30,
    priceHerd: 20,
    refundCutoffAt: '2026-11-30T19:00:00.000Z',
  }
  const signed = { which: 'standard', accepted: true, method: 'in_person' }
  return [
    g('events-read', async ({ call }) => {
      await call('getEvents', {})
    }, draftEvent),
    g('event-active-who-may', whoMay('setEventActive', { eventId: ID.event, active: false }, 'manage_pricing')),
    g('event-active-off-and-on', async ({ call }) => {
      await call('setEventActive', { eventId: ID.event, active: false })
      await call('setEventActive', { eventId: ID.event, active: true })
      await call('setEventActive', { eventId: W48_ID.unknown, active: true })
    }),
    // The table's own rule refuses an unfinished event, and a cancelled one, in the same words.
    g('event-active-refused-unfinished-or-cancelled', async ({ call, db }) => {
      await call('setEventActive', { eventId: W48_ID.draftEvent, active: true })
      await db.query("UPDATE events SET active = false, cancelled_at = now(), cancel_reason = 'Storm' WHERE id = $1", [ID.event])
      await call('setEventActive', { eventId: ID.event, active: true })
    }, draftEvent),
    g('event-details-who-may', whoMay('setEventDetails', details, 'manage_pricing')),
    g(
      'event-details-refusals',
      each(
        'setEventDetails',
        { ...details, access: 'everyone' },
        { ...details, capacity: 0 },
        { ...details, capacity: 7.5 },
        { ...details, pricePublic: -1 },
        { ...details, priceHerd: Number.NaN },
        { ...details, startsAt: 'next Tuesday' },
        { ...details, refundCutoffAt: 'soon' },
        { ...details, eventId: W48_ID.unknown },
        // The table's constraints, each in plain words.
        { ...details, endsAt: '2026-12-01T18:00:00.000Z' },
        { ...details, refundCutoffAt: '2026-12-02T19:00:00.000Z' },
        { ...details, access: 'members_first', publicReleaseAt: '2026-12-01T20:00:00.000Z' },
        // On sale: a price, the cut-off or (Members first) the public release can't be cleared.
        { ...details, pricePreHerd: null },
        { ...details, refundCutoffAt: null },
        { ...details, access: 'members_first', publicReleaseAt: null }
      )
    ),
    g('event-details-refused-cancelled-event', each('setEventDetails', details), eventIs("UPDATE events SET active = false, cancelled_at = now(), cancel_reason = 'Storm' WHERE id = $1")),
    g('event-details-refused-capacity-below-places-booked', async ({ call, db }) => {
      await twoPlaces({ call, db })
      await call('setEventDetails', { ...details, capacity: 1 })
    }),
    g('event-details-set', async ({ call }) => {
      await call('setEventDetails', { ...details, startsAt: '2026-12-05T18:30:00.000Z', endsAt: '2026-12-05T20:30:00.000Z', capacity: 14, pricePublic: 45, pricePreHerd: 35.5, priceHerd: 0, refundCutoffAt: '2026-12-03T18:30:00.000Z' })
      // Members first keeps its public release time; Public (and Members only) clears it, whatever was sent.
      await call('setEventDetails', { ...details, access: 'members_first', publicReleaseAt: '2026-11-20T09:00:00.000Z' })
      await call('setEventDetails', { ...details, access: 'members_only', publicReleaseAt: '2026-11-20T09:00:00.000Z' })
    }),
    // Off sale, anything can be cleared.
    g('event-details-cleared-while-off-sale', async ({ call }) => {
      await call('setEventDetails', { eventId: ID.event, startsAt: null, endsAt: null, capacity: null, access: 'public', publicReleaseAt: null, pricePublic: null, pricePreHerd: null, priceHerd: null, refundCutoffAt: null })
    }, eventIs('UPDATE events SET active = false WHERE id = $1')),
    // GB11: two places are sold (£40 each, cut-off 30 Nov). The cut-off is then moved to today, the price to £60 and
    // the date by a day: every edit goes through with no warning and no record, and the places keep nothing of what
    // they were bought under.
    g('gb11-cut-off-date-and-prices-change-after-places-are-sold', async ({ call, db }) => {
      await twoPlaces({ call, db })
      await call('setEventDetails', { ...details, refundCutoffAt: '2026-11-10T08:00:00.000Z' })
      await call('setEventDetails', { ...details, refundCutoffAt: '2026-11-10T08:00:00.000Z', pricePublic: 60, startsAt: '2026-12-02T19:00:00.000Z', endsAt: '2026-12-02T21:00:00.000Z' })
      await call('getEventAttendees', { eventId: ID.event })
    }),
    g('event-attendees-read', async ({ call, db }) => {
      const { alexId } = await twoPlaces({ call, db })
      await db.query("UPDATE event_attendees SET waiver_accepted = true, waiver_method = 'email_link', waiver_version = 'v1', waiver_accepted_at = now() WHERE id = $1", [alexId])
      await call('getEventAttendees', { eventId: ID.event })
      await call('getEventAttendees', { eventId: W48_ID.unknown })
    }, eventTonight, extraWaiver),
    // Any active staff may; a sign-in with no staff row is let through too.
    g('event-check-in-who-may', async (context) => {
      const { samId } = await twoPlaces(context)
      await context.db.query("UPDATE event_attendees SET waiver_accepted = true, waiver_method = 'email_link', waiver_version = 'v1', waiver_accepted_at = now() WHERE id = $1", [samId])
      await whoMay('setEventAttendeeCheckIn', { attendeeId: samId, checkedIn: true }, 'none')(context)
    }, eventTonight),
    // Every reason, in the order the one statement checks them.
    g('event-check-in-refusals', async ({ call, db }) => {
      const { bookingId, samId, alexId } = await twoPlaces({ call, db })
      const checkIn = (attendeeId: string, more: Record<string, unknown> = {}) => call('setEventAttendeeCheckIn', { attendeeId, checkedIn: true, ...more })
      await checkIn('not-an-id')
      await checkIn(W48_ID.unknown)
      // Before the day: the event is on 1 December.
      await checkIn(samId)
      await db.query("UPDATE events SET starts_at = '2026-11-10 19:00:00+00', ends_at = '2026-11-10 21:00:00+00', refund_cutoff_at = '2026-11-09 19:00:00+00' WHERE id = $1", [ID.event])
      // On the day, with the standard waiver not signed.
      await checkIn(samId)
      // The extra waiver is wanted and its text hasn't synced: it can't be signed at the desk either.
      await db.query('UPDATE events SET has_extra_waiver = true, extra_waiver_version = NULL WHERE id = $1', [ID.event])
      await checkIn(samId, { markWaiversSignedInPerson: true })
      await db.query('UPDATE events SET has_extra_waiver = false WHERE id = $1', [ID.event])
      await db.query('UPDATE event_attendees SET cancelled_at = now() WHERE id = $1', [alexId])
      await checkIn(alexId, { markWaiversSignedInPerson: true })
      await db.query("UPDATE event_bookings SET status = 'cancelled' WHERE id = $1", [bookingId])
      await checkIn(samId, { markWaiversSignedInPerson: true })
      await db.query("UPDATE event_bookings SET status = 'confirmed' WHERE id = $1", [bookingId])
      await db.query("UPDATE events SET active = false, cancelled_at = now(), cancel_reason = 'Storm' WHERE id = $1", [ID.event])
      await checkIn(samId, { markWaiversSignedInPerson: true })
      await db.query('UPDATE events SET cancelled_at = NULL, cancel_reason = NULL WHERE id = $1', [ID.event])
      // The day after: closed.
      vi.setSystemTime(Date.now() + 48 * 60 * 60 * 1000)
      await checkIn(samId, { markWaiversSignedInPerson: true })
    }),
    // Checked in with the waivers signed in person at the desk (standard and extra, by one statement), then undone:
    // the waivers stay signed.
    g('event-check-in-signing-at-the-desk-then-undo', async ({ call, db }) => {
      const { samId } = await twoPlaces({ call, db })
      await call('setEventAttendeeCheckIn', { attendeeId: samId, checkedIn: true, markWaiversSignedInPerson: true })
      await call('setEventAttendeeCheckIn', { attendeeId: samId, checkedIn: false })
      await call('setEventAttendeeCheckIn', { attendeeId: W48_ID.unknown, checkedIn: false })
    }, eventTonight, extraWaiver),
    // Undo has no window and no status check: a place checked in is un-checked on a cancelled booking's attendee too,
    // only a cancelled place is refused ("no longer exists").
    g('event-check-in-undo-has-no-checks', async ({ call, db }) => {
      const { bookingId, samId, alexId } = await twoPlaces({ call, db })
      await db.query('UPDATE event_attendees SET checked_in_at = now() WHERE event_booking_id = $1', [bookingId])
      await db.query("UPDATE event_bookings SET status = 'cancelled' WHERE id = $1", [bookingId])
      await call('setEventAttendeeCheckIn', { attendeeId: samId, checkedIn: false })
      await db.query('UPDATE event_attendees SET cancelled_at = now() WHERE id = $1', [alexId])
      await call('setEventAttendeeCheckIn', { attendeeId: alexId, checkedIn: false })
    }),
    g('event-check-in-many', async ({ call, db }) => {
      const { samId, alexId } = await twoPlaces({ call, db })
      await db.query("UPDATE event_attendees SET waiver_accepted = true, waiver_method = 'email_link', waiver_version = 'v1', waiver_accepted_at = now() WHERE id = $1", [samId])
      await call('setEventAttendeesCheckIn', { attendeeIds: [] })
      await call('setEventAttendeesCheckIn', { attendeeIds: 'everyone' })
      // Sam's waiver is signed; Alex's isn't; one id is nobody's, one isn't an id, and Sam is named twice.
      await call('setEventAttendeesCheckIn', { attendeeIds: [samId, alexId, W48_ID.unknown, 'not-an-id', samId] })
      await call('setEventAttendeesCheckIn', { attendeeIds: [samId, alexId], markWaiversSignedInPerson: true })
    }, eventTonight),
    g('event-check-in-many-who-may', async (context) => {
      const { samId } = await twoPlaces(context)
      await whoMay('setEventAttendeesCheckIn', { attendeeIds: [samId], markWaiversSignedInPerson: true }, 'none')(context)
    }, eventTonight),
    g('event-waiver-who-may', async (context) => {
      const { samId } = await twoPlaces(context)
      await whoMay('setEventAttendeeWaiver', { attendeeId: samId, ...signed }, 'none')(context)
    }),
    g('event-waiver-refusals', async ({ call, db }) => {
      const { bookingId, samId, alexId } = await twoPlaces({ call, db })
      const waiver = (attendeeId: string, more: Record<string, unknown>) => call('setEventAttendeeWaiver', { attendeeId, ...more })
      await waiver(samId, { which: 'all', accepted: true, method: 'in_person' })
      await waiver(samId, { which: 'both', accepted: false })
      await waiver(samId, { which: 'standard', accepted: true })
      await waiver(samId, { which: 'standard', accepted: true, method: 'checkout' })
      await waiver(W48_ID.unknown, signed)
      // The event has no extra waiver.
      await waiver(samId, { which: 'extra', accepted: true, method: 'in_person' })
      await waiver(samId, { which: 'both', accepted: true, method: 'in_person' })
      await waiver(samId, { which: 'extra', accepted: false })
      // It has one, and its text hasn't synced.
      await db.query('UPDATE events SET has_extra_waiver = true, extra_waiver_version = NULL WHERE id = $1', [ID.event])
      await waiver(samId, { which: 'extra', accepted: true, method: 'email_link' })
      await db.query('UPDATE event_attendees SET cancelled_at = now() WHERE id = $1', [alexId])
      await waiver(alexId, signed)
      await db.query("UPDATE event_bookings SET status = 'cancelled' WHERE id = $1", [bookingId])
      await waiver(samId, signed)
    }),
    g('event-waiver-standard-signed-and-revoked', async ({ call, db }) => {
      const { samId, alexId } = await twoPlaces({ call, db })
      await call('setEventAttendeeWaiver', { attendeeId: samId, ...signed })
      await call('setEventAttendeeWaiver', { attendeeId: alexId, which: 'standard', accepted: true, method: 'email_link' })
      await call('setEventAttendeeWaiver', { attendeeId: samId, which: 'standard', accepted: false })
    }),
    g('event-waiver-extra-and-both', async ({ call, db }) => {
      const { samId, alexId } = await twoPlaces({ call, db })
      await call('setEventAttendeeWaiver', { attendeeId: samId, which: 'extra', accepted: true, method: 'in_person' })
      await call('setEventAttendeeWaiver', { attendeeId: samId, which: 'extra', accepted: false })
      await call('setEventAttendeeWaiver', { attendeeId: alexId, which: 'both', accepted: true, method: 'email_link' })
    }, extraWaiver),
    // The extra waiver's text changes after Alex signed it: his reads "older version", and counts as outstanding at check-in.
    g('event-waiver-an-older-extra-version-is-outstanding', async ({ call, db }) => {
      const { alexId } = await twoPlaces({ call, db })
      await call('setEventAttendeeWaiver', { attendeeId: alexId, which: 'both', accepted: true, method: 'email_link' })
      await db.query("UPDATE events SET extra_waiver_version = 'cold-plunge-v3' WHERE id = $1", [ID.event])
      await call('getEventAttendees', { eventId: ID.event })
      await call('setEventAttendeeCheckIn', { attendeeId: alexId, checkedIn: true })
      await call('setEventAttendeeCheckIn', { attendeeId: alexId, checkedIn: true, markWaiversSignedInPerson: true })
    }, eventTonight, extraWaiver),
    // Overview's events card: tonight's event with its counts, and the attendees whose waivers are outstanding.
    g('todays-events-read', async ({ call, db }) => {
      await call('getTodaysEvents', {})
      const { samId } = await twoPlaces({ call, db })
      await call('setEventAttendeeWaiver', { attendeeId: samId, which: 'both', accepted: true, method: 'in_person' })
      await call('setEventAttendeeCheckIn', { attendeeId: samId, checkedIn: true })
      await call('getTodaysEvents', {})
    }, eventTonight, extraWaiver, draftEvent),
    // An event on another day, or cancelled, isn't today's.
    g('todays-events-read-nothing-today', async ({ call, db }) => {
      await call('getTodaysEvents', {})
      await db.query("UPDATE events SET starts_at = '2026-11-10 19:00:00+00', ends_at = '2026-11-10 21:00:00+00', refund_cutoff_at = '2026-11-09 19:00:00+00', active = false, cancelled_at = now(), cancel_reason = 'Storm' WHERE id = $1", [ID.event])
      await call('getTodaysEvents', {})
    }),
  ]
}

// ---------------------------------------------------------------------------------------------------------------------
// 1.6 Promo codes

/** Sam's seat bought in cash with ALLTEN (10% off £20), through the old order code: one redemption of £2. */
const samUsesAllTen = ({ call }: Pick<ScenarioContext, 'call'>) => call('createOrder', { customerId: ID.customer, booking: paidSeat(), promoCode: 'ALLTEN', payment: { method: 'cash', confirmedCashAmount: 18 } })

function promoScenarios(): Scenario[] {
  const EVERY_KIND = ['booking', 'addon', 'product', 'session_pass', 'membership', 'event']
  const newCode = { code: ' winter25 ', description: '  Winter offer  ', discountType: 'percentage', discountValue: 25, appliesTo: ['booking', 'addon'], appliesOnMemberPrices: false, expiresOn: null, maxTotalUses: null, oneUsePerCustomer: false, minSpend: null, restrictedCustomerId: null }
  const allTen = { id: ID.promoPercent, code: 'ALLTEN', discountType: 'percentage', discountValue: 10, appliesTo: EVERY_KIND, appliesOnMemberPrices: false, expiresOn: null, maxTotalUses: null, oneUsePerCustomer: false, minSpend: null, restrictedCustomerId: null, active: true }
  return [
    // The list, newest first, with how often each was used and who a restricted one is for; then one code's uses.
    g('promo-codes-read', async ({ call }) => {
      await samUsesAllTen({ call })
      await call('getPromoCodes', {})
      await call('getPromoCodeRedemptions', { promoCodeId: ID.promoPercent })
      await call('getPromoCodeRedemptions', { promoCodeId: ID.promoFixed })
      await call('getPromoCodeRedemptions', { promoCodeId: W48_ID.unknown })
    }, sql("UPDATE promo_codes SET restricted_customer_id = $1, description = 'For Mo only', created_by = 'jo@example.com' WHERE id = $2", [ID.member, ID.promoFixed])),
    g('promo-create-who-may', whoMay('createPromoCode', newCode, 'manage_pricing')),
    g(
      'promo-create-refusals',
      each(
        'createPromoCode',
        { ...newCode, code: 'ab' },
        { ...newCode, code: 'TEN OFF' },
        { ...newCode, code: 'A-VERY-LONG-PROMO-CODE-INDEED' },
        { ...newCode, discountType: 'bogof' },
        { ...newCode, discountValue: 0 },
        { ...newCode, discountValue: Number.NaN },
        { ...newCode, discountValue: 101 },
        { ...newCode, appliesTo: [] },
        { ...newCode, appliesTo: ['booking', 'gift_card'] },
        { ...newCode, expiresOn: '01/12/2026' },
        { ...newCode, maxTotalUses: 0 },
        { ...newCode, maxTotalUses: 2.5 },
        { ...newCode, minSpend: -1 },
        { ...newCode, restrictedCustomerId: W48_ID.unknown },
        // The same code in another case: codes are unique whatever the case.
        { ...newCode, code: 'allten' }
      )
    ),
    g('promo-create', async ({ call }) => {
      await call('createPromoCode', newCode)
      await call('createPromoCode', { code: 'MO-FIVER', discountType: 'fixed', discountValue: 5, appliesTo: EVERY_KIND, appliesOnMemberPrices: true, expiresOn: '2026-12-31', maxTotalUses: 3, oneUsePerCustomer: true, minSpend: 20, restrictedCustomerId: ID.member })
    }),
    g('promo-update-who-may', whoMay('updatePromoCode', { ...allTen, discountValue: 15 }, 'manage_pricing')),
    g('promo-update-refusals', async ({ call, attempt }) => {
      await call('updatePromoCode', { ...allTen, id: W48_ID.unknown })
      await attempt('updatePromoCode', { ...allTen, code: 'no' })
      await attempt('updatePromoCode', { ...allTen, discountValue: 150 })
      await attempt('updatePromoCode', { ...allTen, appliesTo: ['seat'] })
      await attempt('updatePromoCode', { ...allTen, restrictedCustomerId: W48_ID.unknown })
      await attempt('updatePromoCode', { ...allTen, code: 'fiver' })
    }),
    // Every field in one press, then switched off by the page's switch (the same function, active false).
    g('promo-update', async ({ call }) => {
      await call('updatePromoCode', { ...allTen, code: 'all-fifteen', description: ' Now 15% ', discountValue: 15, appliesTo: ['booking'], appliesOnMemberPrices: true, expiresOn: '2027-01-31', maxTotalUses: 100, oneUsePerCustomer: true, minSpend: 10, restrictedCustomerId: ID.customer })
      await call('updatePromoCode', { ...allTen, code: 'ALL-FIFTEEN', discountValue: 15, active: false })
    }),
    // Once used, the code's text is locked; everything else can still change.
    g('promo-update-the-text-is-locked-once-used', async ({ call }) => {
      await samUsesAllTen({ call })
      await call('updatePromoCode', { ...allTen, code: 'ALLTWENTY', discountValue: 20 })
      await call('updatePromoCode', { ...allTen, discountValue: 20, description: 'Was 10%' })
    }),
    // GB18: a code edited from 10% to 100% and back. The row ends as it began and nothing records either edit.
    g('gb18-a-code-edited-to-100-percent-and-back-leaves-no-trace', async ({ call }) => {
      await call('updatePromoCode', { ...allTen, discountValue: 100 })
      await call('updatePromoCode', { ...allTen, discountValue: 10 })
    }),
    // GB18: "the text can't change once used" is a read, then a write. An order uses ALLTEN between the two: the
    // text changes anyway, and the order's redemption now belongs to a code called ALLTWENTY. W65b: on the Worker the
    // read and the write are one transaction; the order lands at the nearest point, just before it opens.
    g('gb18-the-text-lock-is-a-read-then-a-write', async ({ call, db, stripe }) => {
      await atItsFirstTransaction({ db, stripe }, PROMO_CODE_PATH, () => samUsesAllTen({ call }), () => call('updatePromoCode', { ...allTen, code: 'ALLTWENTY', discountValue: 20 }))
    }),
  ]
}

// ---------------------------------------------------------------------------------------------------------------------
// 1.7 Pricing

/** Every day's windows as live has them in shape: Core until 17:00, Peak after. Fixed ids and times, so a recording reads them back in one order. */
const weekOfBandRules: Prepare = async (db) => {
  for (let day = 0; day <= 6; day++) {
    await db.query("INSERT INTO band_rules (id, band_id, day_of_week, from_time, to_time, created_at) VALUES ($1, $2, $3, '00:00', '17:00', $4)", [`10000000-0000-4000-8000-000000000b${day}0`, ID.band, day, `2026-10-01 09:00:0${day}+00`])
    await db.query("INSERT INTO band_rules (id, band_id, day_of_week, from_time, to_time, created_at) VALUES ($1, $2, $3, '17:00', '24:00', $4)", [`10000000-0000-4000-8000-000000000b${day}1`, ID.peakBand, day, `2026-10-01 09:00:1${day}+00`])
  }
}
/** A public Sauna on Saturday 14 November at 14:00, in Core. */
const saturdayAfternoon = sql("INSERT INTO sessions (id, service_type_id, start_time, end_time, type, capacity, band_id) VALUES ($1, $2, '2026-11-14 14:00:00+00', '2026-11-14 15:00:00+00', 'public', 10, $3)", [W48_ID.sameDaySession, ID.serviceType, ID.band])

function pricingScenarios(): Scenario[] {
  const SATURDAY = 6
  const wholeDay = [{ bandId: ID.band, fromTime: '00:00', toTime: '24:00' }]
  const recut = { dayOfWeek: SATURDAY, rules: [{ bandId: ID.peakBand, fromTime: '12:00', toTime: '24:00' }, { bandId: ID.band, fromTime: '00:00', toTime: '12:00' }] }
  const term = { membershipLevel: 'core', bandId: ID.peakBand, creditEligible: false, discountPercent: 20 }
  const postage = { standardPrice: 5.5, expressPrice: 11, freeShippingThreshold: 60 }
  return [
    g('band-price-who-may', whoMay('setBandPrice', { bandId: ID.band, price: 22 }, 'manage_pricing')),
    g('band-price-set', async ({ call, attempt }) => {
      await attempt('setBandPrice', { bandId: ID.band, price: -1 })
      await attempt('setBandPrice', { bandId: ID.band, price: Number.NaN })
      await call('setBandPrice', { bandId: W48_ID.unknown, price: 22 })
      await call('setBandPrice', { bandId: ID.band, price: 22.5 })
      await call('setBandPrice', { bandId: ID.peakBand, price: 0 })
    }),
    g('band-rules-who-may', whoMay('setBandRules', recut, 'manage_pricing'), weekOfBandRules),
    g(
      'band-rules-refusals',
      each(
        'setBandRules',
        { dayOfWeek: 7, rules: wholeDay },
        { dayOfWeek: 2.5, rules: wholeDay },
        { dayOfWeek: SATURDAY, rules: [] },
        { dayOfWeek: SATURDAY, rules: 'all day' },
        { dayOfWeek: SATURDAY, rules: [{ bandId: ID.band, fromTime: 'noon', toTime: '24:00' }] },
        { dayOfWeek: SATURDAY, rules: [{ bandId: ID.band, fromTime: '12:00', toTime: '12:00' }] },
        { dayOfWeek: SATURDAY, rules: [{ bandId: ID.band, fromTime: '00:00', toTime: '25:00' }] },
        { dayOfWeek: SATURDAY, rules: [{ bandId: ID.band, fromTime: '06:00', toTime: '24:00' }] },
        { dayOfWeek: SATURDAY, rules: [{ bandId: ID.band, fromTime: '00:00', toTime: '12:00' }, { bandId: ID.peakBand, fromTime: '13:00', toTime: '24:00' }] },
        { dayOfWeek: SATURDAY, rules: [{ bandId: ID.band, fromTime: '00:00', toTime: '13:00' }, { bandId: ID.peakBand, fromTime: '12:00', toTime: '24:00' }] },
        { dayOfWeek: SATURDAY, rules: [{ bandId: ID.band, fromTime: '00:00', toTime: '22:00' }] },
        { dayOfWeek: SATURDAY, rules: [{ bandId: W48_ID.unknown, fromTime: '00:00', toTime: '24:00' }] }
      ),
      weekOfBandRules
    ),
    // Saturday re-cut at noon (sent out of order: they are sorted first). The 14:00 Sauna moves from Core to Peak:
    // one session re-banded. The 18:00 one is Peak already.
    g('band-rules-set', async ({ call }) => {
      await call('setBandRules', recut)
    }, weekOfBandRules, saturdayAfternoon),
    // A band set by hand on a session is left alone by the re-banding.
    g('band-rules-set-leaves-a-band-set-by-hand', async ({ call }) => {
      await call('setBandRules', recut)
    }, weekOfBandRules, saturdayAfternoon, sql('UPDATE sessions SET band_overridden = true WHERE id = $1', [W48_ID.sameDaySession])),
    // GB8: the day's windows are deleted, then inserted one by one. The first insert fails: the old windows are put
    // back (as new rows), and the save is refused in the database's words. W65b: on the Worker a day's windows are saved
    // in one transaction, so there is no put-back: the three GB8 scenarios run the failing insert there (the form the
    // sweep pressed them in since W64, press-forms.ts TOLD_AGAIN until W65b), and are renamed for what they do.
    // Renamed from gb8-band-windows-deleted-then-an-insert-fails-and-the-old-ones-are-put-back.
    g('gb8-band-windows-the-morning-window-fails-and-the-old-ones-stay', async ({ attempt, db }) => {
      await whileFailing(db, { table: 'band_rules', event: 'INSERT', when: "NEW.from_time = '00:00'" }, () => attempt('setBandRules', recut))
    }, weekOfBandRules, saturdayAfternoon),
    // GB8: the put-back fails too. Saturday is left with no band windows at all. W65b: renamed from
    // gb8-band-windows-deleted-and-the-put-back-fails-too.
    g('gb8-band-windows-every-insert-fails-and-the-old-ones-stay', async ({ attempt, db }) => {
      await whileFailing(db, { table: 'band_rules', event: 'INSERT', when: 'true' }, () => attempt('setBandRules', recut))
    }, weekOfBandRules, saturdayAfternoon),
    // GB8: the second window's insert fails after the first went in: the put-back then meets the first new window,
    // which overlaps the old ones, so it fails as well and Saturday is left half cut. W65b: renamed from
    // gb8-band-windows-half-saved-then-the-put-back-overlaps.
    g('gb8-band-windows-the-afternoon-window-fails-and-the-old-ones-stay', async ({ attempt, db }) => {
      await whileFailing(db, { table: 'band_rules', event: 'INSERT', when: "NEW.from_time = '12:00'" }, () => attempt('setBandRules', recut))
    }, weekOfBandRules, saturdayAfternoon),
    g('member-band-term-who-may', whoMay('setMembershipBandTerm', term, 'manage_pricing')),
    g(
      'member-band-term-refusals',
      each('setMembershipBandTerm', { ...term, membershipLevel: '   ' }, { ...term, discountPercent: -1 }, { ...term, discountPercent: 101 }, { ...term, discountPercent: Number.NaN }, { ...term, bandId: W48_ID.unknown })
    ),
    // Core in Peak goes from 15% off to 20% (an existing row), and All-Access in Peak is new: credit allowed, no discount.
    g('member-band-term-set', async ({ call }) => {
      await call('setMembershipBandTerm', term)
      await call('setMembershipBandTerm', { membershipLevel: ' all_access ', bandId: ID.peakBand, creditEligible: true, discountPercent: 0 })
    }),
    g('postage-who-may', whoMay('setPostageSettings', postage, 'manage_pricing')),
    g('postage-refusals', each('setPostageSettings', { ...postage, standardPrice: -1 }, { ...postage, expressPrice: Number.NaN }, { ...postage, freeShippingThreshold: -5 })),
    g('postage-set', async ({ call }) => {
      await call('setPostageSettings', postage)
      // 0 means no free shipping.
      await call('setPostageSettings', { standardPrice: 0, expressPrice: 9.95, freeShippingThreshold: 0 })
    }),
    g('postage-refused-not-set-up', each('setPostageSettings', postage), async (db) => {
      await db.query('RESET ROLE')
      await db.query('DELETE FROM postage_settings')
      await db.query('SET ROLE paddock_worker')
    }),
  ]
}

// ---------------------------------------------------------------------------------------------------------------------
// 1.9 Sessions and the timetable

/** Sauna as live service types are: an hour long, 10 places. (The seed leaves the length empty.) */
const saunaHour = sql('UPDATE service_types SET duration = 60, capacity = 10 WHERE id = $1', [ID.serviceType])
/** A weekly slot for the seed's Sauna session: Thursdays at 10:00. */
const thursdaySlot = sql("INSERT INTO service_type_schedule_slots (id, service_type_id, day_of_week, start_time) VALUES ($1, $2, 4, '10:00')", [W48_ID.slot, ID.serviceType])
/** A second Sauna on the seed session's day (Thursday 12 November), at 15:00. */
const thursdayAfternoon = sql("INSERT INTO sessions (id, service_type_id, start_time, end_time, type, capacity, band_id) VALUES ($1, $2, '2026-11-12 15:00:00+00', '2026-11-12 16:00:00+00', 'public', 10, $3)", [W48_ID.sameDaySession, ID.serviceType, ID.band])
/** That second session already blocked, by Jo, for a repair. */
const repairBlock = sql("UPDATE sessions SET status = 'blocked', blocked_reason = 'Boiler repair', blocked_by = $1 WHERE id = $2", [ID.staff, W48_ID.sameDaySession])

/** Sam's seat on the seed's Thursday 10:00 Sauna, paid in cash (£20), through the old order code. */
async function samBooked({ call }: Pick<ScenarioContext, 'call'>, more: Record<string, unknown> = {}): Promise<string> {
  const placed = (await call('createOrder', { customerId: ID.customer, booking: paidSeat(), payment: { method: 'cash', confirmedCashAmount: 20 }, ...more })) as { bookingId: string }
  return placed.bookingId
}

/**
 * The database's nightly job, as the side runs it (W51, migration 032: the Worker's side runs the job as the saved
 * schema has it, as the table owner). W65: the fallback for the old functions (the job as it was before 032) went with
 * them, so a side without a job of its own can't run these scenarios.
 */
async function runNightlyJob({ db, side }: Pick<ScenarioContext, 'db' | 'side'>): Promise<void> {
  if (!side.nightlyJob) throw new Error(`The ${side.name} side has no nightly job to run.`)
  return side.nightlyJob(db)
}

function sessionScenarios(): Scenario[] {
  const THURSDAY = '2026-11-12'
  const block = { sessionId: ID.session, reason: 'Staff training' }
  const moved = { sessionId: ID.session, startTime: '2026-11-12T18:00:00.000Z' }
  const oneOff = { serviceTypeId: ID.serviceType, startTime: '2026-11-20T07:00:00.000Z' }
  return [
    // The calendar's read: each session with its band, its bookings counted (confirmed only), blocked or not.
    g('sessions-read', async ({ call }) => {
      await samBooked({ call })
      await call('getSessionsForRange', { startDate: '2026-11-12', endDate: '2026-11-14' })
      await call('getSessionsForRange', { startDate: '2026-12-01', endDate: '2026-12-02' })
    }, thursdayAfternoon, repairBlock),
    // New Order's "Add Booking" on a card: the service types with a weekly slot at that time, and the session each has.
    g('sessions-for-slot-read', async ({ call }) => {
      await call('getServiceTypesForSlot', { startTime: '2026-11-12T10:00:00.000Z' })
      await call('getServiceTypesForSlot', { startTime: '2026-11-12T11:00:00.000Z' })
    }, saunaHour, thursdaySlot),
    g('block-session-who-may', whoMay('blockSession', block, 'none')),
    g('block-session', async ({ call }) => {
      await call('blockSession', block)
      // A session that doesn't exist is answered as blocked, with no session.
      await call('blockSession', { sessionId: W48_ID.unknown, reason: 'Staff training' })
    }),
    // A confirmed booking stops the block and is listed.
    g('block-session-refused-confirmed-booking-in-the-way', async ({ call }) => {
      await samBooked({ call })
      await call('blockSession', block)
    }),
    // GB5: only confirmed bookings stop a block. One at Payment needed, and one whose payment is being taken
    // (pending), don't: the session is blocked with the booking still on it.
    g('gb5-a-payment-needed-booking-does-not-stop-a-block', async ({ call, db }) => {
      const bookingId = await samBooked({ call })
      await db.query("UPDATE bookings SET status = 'payment_needed' WHERE id = $1", [bookingId])
      await call('blockSession', block)
    }),
    g('gb5-a-pending-booking-does-not-stop-a-block', async ({ call, db }) => {
      const bookingId = await samBooked({ call })
      await db.query("UPDATE bookings SET status = 'pending' WHERE id = $1", [bookingId])
      await call('blockSession', block)
      await call('blockDay', { date: THURSDAY, reason: 'Staff day' })
    }),
    // GB5: the check and the block are two statements. A booking placed between them lands on a blocked session.
    // W65b: on the Worker the check and the block are one transaction under the session's lock; the booking lands at
    // the nearest point, just before it opens.
    g('gb5-a-booking-placed-between-the-check-and-the-block', async ({ call, db, stripe }) => {
      await atItsFirstTransaction({ db, stripe }, SESSION_BLOCK_PATH, () => samBooked({ call }), () => call('blockSession', block))
    }),
    g('block-day-who-may', whoMay('blockDay', { date: THURSDAY, reason: 'Staff day' }, 'none')),
    g('block-day', async ({ call }) => {
      await call('blockDay', { date: THURSDAY, reason: 'Staff day' })
      // A day with no sessions.
      await call('blockDay', { date: '2026-11-11', reason: 'Staff day' })
    }, thursdayAfternoon),
    g('block-day-refused-confirmed-bookings-in-the-way', async ({ call }) => {
      await samBooked({ call })
      await call('blockDay', { date: THURSDAY, reason: 'Staff day' })
    }, thursdayAfternoon),
    g('unblock-session-who-may', whoMay('unblockSession', { sessionId: W48_ID.sameDaySession }, 'none'), thursdayAfternoon, repairBlock),
    g('unblock-session', async ({ call }) => {
      await call('unblockSession', { sessionId: W48_ID.sameDaySession })
      await call('unblockSession', { sessionId: W48_ID.unknown })
    }, thursdayAfternoon, repairBlock),
    // The count asks nobody who they are; the press needs a staff row.
    g('unblock-day-who-may', async (context) => {
      await whoMay('unblockDay', { date: THURSDAY }, 'none')(context)
      await context.attempt('unblockDay', { date: THURSDAY, confirmed: true })
      await context.db.query("UPDATE staff SET active = false, email = 'jo@example.com' WHERE id = $1", [ID.staff])
      await context.attempt('unblockDay', { date: THURSDAY, confirmed: true })
    }, thursdayAfternoon, repairBlock),
    g('unblock-day', async ({ call }) => {
      await call('unblockDay', { date: THURSDAY })
      await call('unblockDay', { date: THURSDAY, confirmed: true })
      await call('unblockDay', { date: THURSDAY, confirmed: true })
    }, thursdayAfternoon, repairBlock),
    // GB7: Unblock sets a session open whatever it was (here it was never blocked); Block Day overwrites the repair
    // block's reason and who; Unblock Day then reopens that session too, so the repair block is gone.
    g('gb7-a-day-block-and-unblock-loses-an-earlier-block', async ({ call }) => {
      await call('unblockSession', { sessionId: ID.session })
      await call('blockDay', { date: THURSDAY, reason: 'Staff day' })
      await call('getSessionsForRange', { startDate: THURSDAY, endDate: THURSDAY })
      await call('unblockDay', { date: THURSDAY, confirmed: true })
      await call('getSessionsForRange', { startDate: THURSDAY, endDate: THURSDAY })
    }, thursdayAfternoon, repairBlock, moreStaff, sql('UPDATE sessions SET blocked_by = $1 WHERE id = $2', [W48_ID.manager, W48_ID.sameDaySession])),
    g('session-band-who-may', whoMay('setSessionBand', { sessionId: ID.session, bandId: ID.peakBand, confirmed: true }, 'manage_pricing')),
    g(
      'session-band-refusals',
      each('setSessionBand', { bandId: ID.peakBand }, { sessionId: ID.session, date: THURSDAY, bandId: ID.peakBand }, { sessionId: ID.session, bandId: W48_ID.unknown }, { sessionId: ID.session, bandId: ID.peakBand })
    ),
    g('session-band-refused-band-switched-off', each('setSessionBand', { sessionId: ID.session, bandId: ID.peakBand, confirmed: true }), sql('UPDATE session_bands SET active = false WHERE id = $1', [ID.peakBand])),
    // One session: the count first (one session, Sam's booking on it), then the press.
    g('session-band-set-for-one-session', async ({ call }) => {
      await samBooked({ call })
      await call('setSessionBand', { sessionId: ID.session, bandId: ID.peakBand })
      await call('setSessionBand', { sessionId: ID.session, bandId: ID.peakBand, confirmed: true })
      await call('setSessionBand', { sessionId: W48_ID.unknown, bandId: ID.peakBand, confirmed: true })
    }),
    g('session-band-set-for-a-day', async ({ call }) => {
      await samBooked({ call })
      await call('setSessionBand', { date: THURSDAY, bandId: ID.peakBand })
      await call('setSessionBand', { date: THURSDAY, bandId: ID.peakBand, confirmed: true })
    }, thursdayAfternoon),
    g('session-band-reset-who-may', whoMay('resetSessionBand', { sessionId: ID.session }, 'manage_pricing'), weekOfBandRules),
    // Back to the rule for its time (Thursday 10:00 is Core); and a session nothing overrode, and one that isn't there.
    g('session-band-reset', async ({ call }) => {
      await call('resetSessionBand', { sessionId: W48_ID.unknown })
      await call('resetSessionBand', { sessionId: ID.session })
      await call('setSessionBand', { sessionId: ID.session, bandId: ID.peakBand, confirmed: true })
      await call('resetSessionBand', { sessionId: ID.session })
    }, weekOfBandRules),
    // No window covers the time (no band rules at all): the reset leaves the session with no band.
    g('session-band-reset-with-no-window-for-its-time', async ({ call }) => {
      await call('setSessionBand', { sessionId: ID.session, bandId: ID.peakBand, confirmed: true })
      await call('resetSessionBand', { sessionId: ID.session })
    }),
    g('session-start-time-who-may', whoMay('setSessionStartTime', moved, 'none'), saunaHour, weekOfBandRules),
    g(
      'session-start-time-refusals',
      each(
        'setSessionStartTime',
        { sessionId: ID.session, startTime: '2026-11-12 18:00' },
        { sessionId: ID.session, startTime: 'tomorrow' },
        { sessionId: ID.session, startTime: 1_800_000_000_000 },
        { sessionId: ID.session, startTime: '2026-02-30T10:00:00.000Z' },
        { sessionId: W48_ID.unknown, startTime: '2026-11-12T18:00:00.000Z' },
        // Another Sauna already starts at 15:00 that day.
        { sessionId: ID.session, startTime: '2026-11-12T15:00:00.000Z' }
      ),
      saunaHour,
      thursdayAfternoon,
      weekOfBandRules
    ),
    // 10:00 (Core) to 18:00 (Peak): the end follows the service type's length, the band follows the time.
    g('session-start-time-set', async ({ call }) => {
      await call('setSessionStartTime', moved)
    }, saunaHour, weekOfBandRules),
    // A band set by hand stays when the time moves.
    g('session-start-time-set-keeps-a-band-set-by-hand', async ({ call }) => {
      await call('setSessionBand', { sessionId: ID.session, bandId: ID.band, confirmed: true })
      await call('setSessionStartTime', moved)
    }, saunaHour, weekOfBandRules),
    g('session-start-time-refused-booking-on-it', async ({ call, db }) => {
      const bookingId = await samBooked({ call })
      await call('setSessionStartTime', moved)
      await db.query("UPDATE bookings SET status = 'pending' WHERE id = $1", [bookingId])
      await call('setSessionStartTime', moved)
      // Cancelled, the session can move.
      await db.query("UPDATE bookings SET status = 'cancelled' WHERE id = $1", [bookingId])
      await call('setSessionStartTime', moved)
    }, saunaHour, weekOfBandRules),
    // The count finds nothing; a booking lands before the write; the write's own guard refuses it. W65b: on the Worker
    // the count and the write are one transaction; the booking lands at the nearest point, just before it opens.
    g('session-start-time-refused-booking-placed-between-the-check-and-the-write', async ({ call, db, stripe }) => {
      await atItsFirstTransaction({ db, stripe }, SESSION_START_TIME_PATH, () => samBooked({ call }), () => call('setSessionStartTime', moved))
    }, saunaHour, weekOfBandRules),
    // GB6: a booking at Payment needed isn't counted. The 10:00 Core session moves to 18:00, Peak, and the booking
    // goes with it unseen.
    g('gb6-a-session-with-a-payment-needed-booking-is-moved-into-peak', async ({ call, db }) => {
      const bookingId = await samBooked({ call })
      await db.query("UPDATE bookings SET status = 'payment_needed' WHERE id = $1", [bookingId])
      await call('setSessionStartTime', moved)
      await call('getBookingById', { bookingId })
    }, saunaHour, weekOfBandRules),
    g('one-off-session-who-may', whoMay('createOneOffSession', oneOff, 'none'), saunaHour, weekOfBandRules),
    g('one-off-session-refusals', async ({ call, attempt, db }) => {
      await call('createOneOffSession', { ...oneOff, serviceTypeId: W48_ID.unknown })
      // Private Hire has no length set.
      await call('createOneOffSession', { ...oneOff, serviceTypeId: ID.privateType })
      await call('createOneOffSession', { serviceTypeId: ID.serviceType, startTime: '2026-11-12T10:00:00.000Z' })
      // The time isn't checked: the database's own words.
      await attempt('createOneOffSession', { ...oneOff, startTime: 'next Friday' })
      await db.query('UPDATE service_types SET active = false WHERE id = $1', [ID.serviceType])
      await call('createOneOffSession', oneOff)
    }, saunaHour, weekOfBandRules),
    // Friday 20 November at 07:00 (Core by the rules), and one in the past: nothing checks the date.
    g('one-off-session-create', async ({ call }) => {
      await call('createOneOffSession', oneOff)
      await call('createOneOffSession', { serviceTypeId: ID.serviceType, startTime: '2026-11-01T19:00:00.000Z' })
    }, saunaHour, weekOfBandRules),
    // The control for GB3: the nightly job with nothing far ahead makes the Thursday 10:00 sessions from the day
    // after the last session (14 Nov) up to 98 days from today (16 Feb 2027): 13 Thursdays.
    g('nightly-job-makes-sessions-98-days-ahead', async ({ call, db, side }) => {
      await runNightlyJob({ db, side })
      await call('getSessionsForRange', { startDate: '2026-11-15', endDate: '2026-12-10' })
    }, saunaHour, thursdaySlot, weekOfBandRules),
    // GB3: one one-off session on 1 June 2027. That night the job sees a session past its 98-day target and makes
    // nothing: there is no session to book between 15 November and June.
    g('gb3-one-far-future-session-stops-the-nightly-job', async ({ call, db, side }) => {
      await call('createOneOffSession', { serviceTypeId: ID.serviceType, startTime: '2027-06-01T10:00:00.000Z' })
      await runNightlyJob({ db, side })
      await call('getSessionsForRange', { startDate: '2026-11-15', endDate: '2026-12-10' })
    }, saunaHour, thursdaySlot, weekOfBandRules),
    // W65: GB24's two scenarios (generateUpcomingSessions run by hand, and its "who may") went with the old side; the
    // function was deleted, not moved. Held in sweep/dropped.test.ts (sweep.ts, DROPPED).
  ]
}

// ---------------------------------------------------------------------------------------------------------------------
// 1.10 Bookings, 1.11 Orders and fulfilment, 1.12 Overview

const alexGuest = { name: 'Alex Guest', email: 'alex@example.com' }
const towelOnIt = { addonId: ID.addon, quantity: 1, unitPrice: 5, redemptionSource: 'paid', systemUnitPrice: 5 }
/** Sam and a guest on the seed's Thursday 10:00 Sauna with a towel, in cash (£45), through the old order code. */
async function twoSeatsAndATowel({ call, db }: Pick<ScenarioContext, 'call' | 'db'>): Promise<{ bookingId: string; orderId: string; samGuestId: string; alexGuestId: string; towelLineId: string }> {
  const placed = (await call('createOrder', {
    customerId: ID.customer,
    booking: { sessionId: ID.session, guests: [sam, alexGuest], redemptionSource: 'paid', guestsOver18Confirmed: true, addons: [towelOnIt] },
    payment: { method: 'cash', confirmedCashAmount: 45 },
  })) as { bookingId: string; orderId: string }
  const guests = await db.query<{ id: string; guest_type: string }>('SELECT id, guest_type FROM booking_guests WHERE booking_id = $1', [placed.bookingId])
  const lines = await db.query<{ id: string }>('SELECT id FROM addon_order_lines WHERE booking_id = $1', [placed.bookingId])
  return {
    bookingId: placed.bookingId,
    orderId: placed.orderId,
    samGuestId: guests.find((guest) => guest.guest_type === 'account_holder')?.id ?? '',
    alexGuestId: guests.find((guest) => guest.guest_type !== 'account_holder')?.id ?? '',
    towelLineId: lines[0]?.id ?? '',
  }
}
/** Two bars of soap to pick up, in cash (£24): one product line. */
async function soapOrder({ call, db }: Pick<ScenarioContext, 'call' | 'db'>): Promise<{ orderId: string; lineId: string }> {
  const placed = (await call('createOrder', { customerId: ID.customer, products: [{ productVariantId: ID.variant, quantity: 2, unitPrice: 12, systemUnitPrice: 12 }], payment: { method: 'cash', confirmedCashAmount: 24 } })) as { orderId: string }
  const lines = await db.query<{ id: string }>("SELECT id FROM order_line_items WHERE order_id = $1 AND item_type = 'product'", [placed.orderId])
  return { orderId: placed.orderId, lineId: lines[0]?.id ?? '' }
}

function bookingAndOrderScenarios(): Scenario[] {
  const range = { startDate: '2026-11-12', endDate: '2026-11-14' }
  return [
    // The Bookings list (a date range, a status, both, neither), one booking by id, and its detail.
    g('bookings-read', async ({ call, db }) => {
      const { bookingId } = await twoSeatsAndATowel({ call, db })
      await call('setBookingSpecialRequests', { bookingId, specialRequests: 'Step-free access please' })
      await call('getBookings', range)
      await call('getBookings', { ...range, status: 'cancelled' })
      await call('getBookings', { status: 'confirmed' })
      await call('getBookings', {})
      await call('getBookings', { startDate: '2026-12-01', endDate: '2026-12-02' })
      await call('getBookingById', { bookingId })
      await call('getBookingById', { bookingId: W48_ID.unknown })
      await call('getBookingById', { bookingId: '' })
      await call('getBookingDetail', { bookingId })
      await call('getBookingDetail', { bookingId: W48_ID.unknown })
    }),
    // The booking's own order decides "how it was paid": a later guest paid another way doesn't.
    g('bookings-read-the-method-of-the-bookings-own-order', async ({ call }) => {
      const bookingId = await samBooked({ call })
      await call('addBookingGuest', { bookingId, guestName: 'Bea Guest', guestEmail: 'bea@example.com', guestsOver18Confirmed: true, payment: { method: 'store_credit' } })
      await call('getBookingById', { bookingId })
    }),
    // The detail's "a payment is still open" words: a reader order placed and not yet finished.
    g('booking-detail-read-with-a-reader-payment-open', async ({ call, db }) => {
      await call('createOrder', { customerId: ID.customer, booking: paidSeat(), payment: { method: 'reader' } })
      const made = await db.query<{ id: string }>('SELECT id FROM bookings')
      await call('getBookingDetail', { bookingId: made[0]?.id ?? '' })
    }),
    // The other words: a saved-card payment the Worker started and hasn't settled (its record carries a request id).
    // The booking and the payment's record are part of the seed, not written by the scenario (a scenario that
    // writes a card-flow row in its steps belongs with the flow scenarios).
    g('booking-detail-read-with-a-card-payment-being-checked', async ({ call }) => {
      await call('getBookingDetail', { bookingId: W48_ID.seededBooking })
    }, async (db) => {
      await insert(db, 'bookings', { id: W48_ID.seededBooking, session_id: ID.session, customer_id: ID.customer, party_size: 1, status: 'confirmed', price_paid: '20.00', redemption_source: 'paid' })
      await db.query(
        `INSERT INTO pending_reader_payments (flow, record_id, expected_amount, snapshot, status) VALUES ('add_guest', $1, 20, '{"method": "card", "request_id": "req_w48"}'::jsonb, 'pending')`,
        [W48_ID.seededBooking]
      )
    }),
    g('addon-prep-read', async ({ call, db }) => {
      const { bookingId, towelLineId } = await twoSeatsAndATowel({ call, db })
      await call('getAddonPrepChecklistForRange', range)
      await call('getAddonPrepChecklistForRange', { startDate: '2026-12-01', endDate: '2026-12-02' })
      // A removed add-on, and a cancelled booking's, are not on the list.
      await db.query('UPDATE addon_order_lines SET removed_at = now() WHERE id = $1', [towelLineId])
      await call('getAddonPrepChecklistForRange', range)
      await db.query("UPDATE addon_order_lines SET removed_at = NULL WHERE id = $1", [towelLineId])
      await db.query("UPDATE bookings SET status = 'cancelled' WHERE id = $1", [bookingId])
      await call('getAddonPrepChecklistForRange', range)
    }),
    g('waiver-gaps-read', async ({ call, db }) => {
      const { samGuestId } = await twoSeatsAndATowel({ call, db })
      await call('getWaiverGapsForRange', range)
      await call('setGuestWaiverStatus', { guestId: samGuestId, accepted: true, waiverMethod: 'in_person' })
      await call('getWaiverGapsForRange', range)
      await call('getWaiverGapsForRange', { startDate: '2026-12-01', endDate: '2026-12-02' })
    }),
    g('booking-check-in-who-may', async (context) => {
      const bookingId = await samBooked(context)
      await whoMay('setBookingCheckedIn', { bookingId, checkedIn: true }, 'none')(context)
    }),
    // In and out again; the time is Retool's clock, sent as text.
    g('booking-check-in-and-undo', async ({ call }) => {
      const bookingId = await samBooked({ call })
      await call('setBookingCheckedIn', { bookingId, checkedIn: true })
      await call('setBookingCheckedIn', { bookingId, checkedIn: false })
      await call('setBookingCheckedIn', { bookingId: W48_ID.unknown, checkedIn: true })
    }),
    // GB17: no check of the booking. A cancelled one is checked in (it reads as attended), and so is one at Payment
    // needed (Q49). Nothing says who checked it in.
    g('gb17-a-cancelled-booking-and-a-payment-needed-one-are-checked-in', async ({ call, db }) => {
      const bookingId = await samBooked({ call })
      await db.query("UPDATE bookings SET status = 'payment_needed', payment_due_by = now() + interval '1 day' WHERE id = $1", [bookingId])
      await call('setBookingCheckedIn', { bookingId, checkedIn: true })
      await db.query("UPDATE bookings SET status = 'cancelled', cancelled_at = now(), checked_in_at = NULL WHERE id = $1", [bookingId])
      await call('setBookingCheckedIn', { bookingId, checkedIn: true })
    }),
    g('guest-waiver-who-may', async (context) => {
      const { samGuestId } = await twoSeatsAndATowel(context)
      await whoMay('setGuestWaiverStatus', { guestId: samGuestId, accepted: true, waiverMethod: 'in_person' }, 'none')(context)
    }),
    g('guest-waiver-signed-and-revoked', async ({ call, attempt, db }) => {
      const { samGuestId, alexGuestId } = await twoSeatsAndATowel({ call, db })
      await attempt('setGuestWaiverStatus', { guestId: samGuestId, accepted: true })
      await attempt('setGuestWaiverStatus', { guestId: samGuestId, accepted: true, waiverMethod: 'checkout' })
      await call('setGuestWaiverStatus', { guestId: samGuestId, accepted: true, waiverMethod: 'in_person' })
      await call('setGuestWaiverStatus', { guestId: alexGuestId, accepted: true, waiverMethod: 'email_link', waiverVersion: ' v2 ' })
      await call('setGuestWaiverStatus', { guestId: samGuestId, accepted: false })
      await call('setGuestWaiverStatus', { guestId: W48_ID.unknown, accepted: true, waiverMethod: 'in_person' })
    }),
    // GB17: a cancelled booking's waiver is changed like any other, and nothing says who took it.
    g('gb17-a-cancelled-bookings-waiver-is-changed', async ({ call, db }) => {
      const { bookingId, samGuestId } = await twoSeatsAndATowel({ call, db })
      await db.query("UPDATE bookings SET status = 'cancelled', cancelled_at = now() WHERE id = $1", [bookingId])
      await call('setGuestWaiverStatus', { guestId: samGuestId, accepted: true, waiverMethod: 'in_person' })
    }),
    // Prepared needs a staff row (it is recorded on the line); un-prepared doesn't check that the caller has one.
    g('addon-prepared-who-may', async (context) => {
      const { towelLineId } = await twoSeatsAndATowel(context)
      await whoMay('setAddonLinePrepared', { lineId: towelLineId, prepared: true }, 'none')(context)
      await context.attempt('setAddonLinePrepared', { lineId: towelLineId, prepared: false })
    }),
    g('addon-prepared-and-undo', async ({ call, db }) => {
      const { towelLineId } = await twoSeatsAndATowel({ call, db })
      await call('setAddonLinePrepared', { lineId: towelLineId, prepared: true })
      await call('setAddonLinePrepared', { lineId: towelLineId, prepared: false })
      await call('setAddonLinePrepared', { lineId: W48_ID.unknown, prepared: true })
    }),
    // GB17: an add-on already removed from its booking is marked prepared.
    g('gb17-a-removed-addon-is-marked-prepared', async ({ call, db }) => {
      const { towelLineId } = await twoSeatsAndATowel({ call, db })
      await db.query('UPDATE addon_order_lines SET removed_at = now(), removed_by = $1 WHERE id = $2', [ID.staff, towelLineId])
      await call('setAddonLinePrepared', { lineId: towelLineId, prepared: true })
    }),
    // The Orders page: the four views, the search, and the worked-out status of each order. A seat on Thursday is
    // Upcoming; soap to pick up is Needs action; an order in December's range is nobody's.
    g('orders-read', async ({ call, db }) => {
      await twoSeatsAndATowel({ call, db })
      await soapOrder({ call, db })
      await call('getOrders', {})
      await call('getOrders', { view: 'needs_action' })
      await call('getOrders', { view: 'upcoming' })
      await call('getOrders', { view: 'complete' })
      await call('getOrders', { view: 'all' })
      await call('getOrders', { view: 'all', search: 'sam@' })
      await call('getOrders', { view: 'all', search: 'nobody' })
      await call('getOrders', { view: 'all', paymentStatus: 'paid', orderSource: 'staff_created', startDate: '2026-11-10', endDate: '2026-11-10' })
      await call('getOrders', { view: 'all', paymentStatus: 'refunded' })
      await call('getOrders', { view: 'all', startDate: '2026-12-01', endDate: '2026-12-02' })
    }),
    // Each kind of line with its worked-out name: a seat and its towel, soap, a pass, a gift card, postage, an event.
    g('order-lines-read', async ({ call, db }) => {
      const seat = await twoSeatsAndATowel({ call, db })
      await call('getOrderLineItems', { orderId: seat.orderId })
      const shop = (await call('createOrder', {
        customerId: ID.customer,
        products: [{ productVariantId: ID.candleVariant, quantity: 1, unitPrice: 20, systemUnitPrice: 20 }],
        standaloneAddons: [{ addonId: ID.robe, quantity: 1, unitPrice: 10, systemUnitPrice: 10 }],
        sessionPassTypeId: ID.passType,
        giftCard: { giftCardPresetId: ID.giftCardPreset, fulfillmentMethod: 'pickup' },
        shippingAddress: { name: 'Sam Test', line1: '1 Mill Lane', city: 'Hebden Bridge', postcode: 'HX7 1AA', country: 'United Kingdom' },
        postageMethod: 'standard',
        // £20 candle + £10 robe + £50 pass + £60 gift card + £4.95 postage.
        payment: { method: 'cash', confirmedCashAmount: 144.95 },
      })) as { orderId: string }
      await call('getOrderLineItems', { orderId: shop.orderId })
      const places = (await call('createOrder', {
        customerId: ID.customer,
        event: { eventId: ID.event, accountHolderAttending: true, guestsOver18Confirmed: true, attendees: [{ ...sam, isAccountHolder: true }, { ...alexGuest, isAccountHolder: false }] },
        payment: { method: 'cash', confirmedCashAmount: 80 },
      })) as { orderId: string }
      await call('getOrderLineItems', { orderId: places.orderId })
      await call('getOrderLineItems', { orderId: W48_ID.unknown })
    }),
    g('order-line-fulfilled-who-may', async (context) => {
      const { lineId } = await soapOrder(context)
      await whoMay('setOrderLineItemFulfilled', { lineItemId: lineId, fulfilled: true }, 'none')(context)
    }),
    // Fulfilled and back; a line that isn't a product, and one that isn't there. The order leaves Needs action once fulfilled.
    g('order-line-fulfilled-and-undo', async ({ call, db }) => {
      const { lineId } = await soapOrder({ call, db })
      const seat = await twoSeatsAndATowel({ call, db })
      const seatLine = await db.query<{ id: string }>("SELECT id FROM order_line_items WHERE order_id = $1 AND item_type = 'booking'", [seat.orderId])
      await call('setOrderLineItemFulfilled', { lineItemId: lineId, fulfilled: true })
      await call('getOrders', { view: 'needs_action' })
      await call('setOrderLineItemFulfilled', { lineItemId: lineId, fulfilled: false })
      await call('setOrderLineItemFulfilled', { lineItemId: seatLine[0]?.id ?? '', fulfilled: true })
      await call('setOrderLineItemFulfilled', { lineItemId: W48_ID.unknown, fulfilled: true })
    }),
    // GB22: an order whose booking is at Payment needed reads Complete (not Needs action, not Upcoming).
    g('gb22-an-order-whose-booking-needs-payment-reads-complete', async ({ call, db }) => {
      const bookingId = await samBooked({ call })
      await db.query("UPDATE bookings SET status = 'payment_needed', payment_due_by = now() + interval '1 day' WHERE id = $1", [bookingId])
      await call('getOrders', {})
      await call('getOrders', { view: 'complete' })
    }),
    // GB22's second half as it is today (since W47): an order with money owed counts as Needs action.
    g('gb22-an-order-with-money-owed-is-needs-action', async ({ call, db }) => {
      const { orderId } = await soapOrder({ call, db })
      await call('setOrderLineItemFulfilled', { lineItemId: (await db.query<{ id: string }>('SELECT id FROM order_line_items WHERE order_id = $1', [orderId]))[0]?.id ?? '', fulfilled: true })
      await db.query("UPDATE orders SET refund_owed_amount = '24.00' WHERE id = $1", [orderId])
      await call('getOrders', {})
    }),
    // Overview's "Needs attention: payments": bookings at Payment needed (soonest deadline first) and members whose payment is overdue.
    g('payment-attention-read', async ({ call, db }) => {
      await call('getPaymentAttentionItems', {})
      const bookingId = await samBooked({ call })
      await db.query("UPDATE bookings SET status = 'payment_needed', payment_due_by = now() + interval '1 day' WHERE id = $1", [bookingId])
      await db.query("UPDATE customer_memberships SET subscription_status = 'past_due' WHERE id = $1", [ID.membership])
      await call('getPaymentAttentionItems', {})
    }),
    // GB14: not one of the reads asks who is calling. An inactive account, and a sign-in with no staff row at all,
    // read bookings, guests' dates of birth, orders, promo codes and the catalogue. Only the staff list refuses.
    g('gb14-the-reads-check-nobody', async ({ call, attempt, db }) => {
      const { bookingId, orderId } = await twoSeatsAndATowel({ call, db })
      const reads = async () => {
        await call('getBookings', range)
        await call('getBookingById', { bookingId })
        await call('getBookingDetail', { bookingId })
        await call('getAddonPrepChecklistForRange', range)
        await call('getWaiverGapsForRange', range)
        await call('getOrders', { view: 'all' })
        await call('getOrderLineItems', { orderId })
        await call('getPaymentAttentionItems', {})
        await call('getSessionsForRange', range)
        await call('getServiceTypesForSlot', { startTime: '2026-11-12T10:00:00.000Z' })
        await call('getPromoCodes', {})
        await call('getPromoCodeRedemptions', { promoCodeId: ID.promoPercent })
        await call('getEvents', {})
        await call('getEventAttendees', { eventId: ID.event })
        await call('getTodaysEvents', {})
        await call('getServiceTypes', {})
        await call('getProducts', {})
        await call('getStockAdjustments', { variantId: ID.variant })
        await call('getAddons', {})
        await call('getSessionPassTypes', {})
        await call('getGiftCardTypes', {})
        await call('getMembershipPlans', {})
        await call('getMembershipSettings', {})
        await attempt('getStaff', {})
      }
      await db.query('UPDATE staff SET active = false WHERE id = $1', [ID.staff])
      await reads()
      await db.query("UPDATE staff SET email = 'someone.else@example.com' WHERE id = $1", [ID.staff])
      await reads()
    }),
  ]
}

/** Every step G scenario, by screen (G-plan section 1's order). */
export function w48Scenarios(): Scenario[] {
  return [
    ...staffScenarios(),
    ...serviceTypeScenarios(),
    ...productScenarios(),
    ...passAndGiftCardScenarios(),
    ...planScenarios(),
    ...eventScenarios(),
    ...promoScenarios(),
    ...pricingScenarios(),
    ...sessionScenarios(),
    ...bookingAndOrderScenarios(),
  ]
}

/** The screen each scenario group belongs to, for the report's counts. */
export const W48_GROUPS: ReadonlyArray<{ screen: string; scenarios: () => Scenario[] }> = [
  { screen: 'Staff', scenarios: staffScenarios },
  { screen: 'Catalog: service types', scenarios: serviceTypeScenarios },
  { screen: 'Catalog: products, stock and add-ons', scenarios: productScenarios },
  { screen: 'Catalog: session passes and gift card types', scenarios: passAndGiftCardScenarios },
  { screen: 'Catalog: membership plans and settings', scenarios: planScenarios },
  { screen: 'Catalog: events, and the attendee list', scenarios: eventScenarios },
  { screen: 'Promo codes', scenarios: promoScenarios },
  { screen: 'Pricing', scenarios: pricingScenarios },
  { screen: 'Sessions and the timetable', scenarios: sessionScenarios },
  { screen: 'Bookings, orders and Overview', scenarios: bookingAndOrderScenarios },
]
