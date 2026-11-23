import type { Db } from '@/server/db'
import type { FakeStripe } from '@/server/stripe/fake'

/*
 * W64 (H-plan 3.3 step 3): G-plan 4.9 item 5's invariants, checked on every scenario of the all-Worker sweep beside the
 * W05 invariants (replay/invariants.ts):
 *   1. a plan never points at an archived price;
 *   2. a subscription is moved to a price at most once (per change: no two moves of one subscription to one price);
 *   3. stock never changes twice for one press (no more staff stock rows than stock presses answered with a success),
 *      never without its ledger row (each variant moved by exactly what its new ledger rows say) and never below zero;
 *   4. no booking that isn't cancelled on a blocked session;
 *   5. a day's band windows always cover the whole day (every day that has windows);
 *   6. always one active admin and one active Manage pricing holder;
 *   7. (W66) a membership's payment date moved, and charged for, once: no two change rows moving it from the same
 *      renewal date both charged and not failed.
 * One to five are read after the seed and after the run, and only a breach the run made counts: a seed may set up an
 * unusual state on purpose, and that is the scenario's, not the code's. Six is read around each staff press
 * (staffHoldersProblems), because the "who may" recordings make their only admin inactive by hand during the run.
 */

/** The staff presses that can take a role or a permission away. */
export const STAFF_WRITES: ReadonlySet<string> = new Set(['setStaffRole', 'setStaffPermission', 'setStaffCanManagePricing', 'createStaff'])

export interface GState {
  archivedPlanPrices: string[]
  blockedWithLiveBookings: string[]
  daysNotCovered: string[]
  activeAdmins: number
  activePricingHolders: number
  belowZero: string[]
  stock: Map<string, number>
  /** The stock ledger's rows, by id: what the run adds is every row not here. */
  ledgerIds: string[]
}

const MINUTES_IN_A_DAY = 24 * 60
const minutes = (time: string): number => {
  const [h, m] = time.split(':').map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}

export async function readGState(db: Db, stripe: FakeStripe): Promise<GState> {
  const plans = await db.query<{ id: string; monthly: string | null; yearly: string | null }>('SELECT id, stripe_price_id AS monthly, stripe_price_id_yearly AS yearly FROM membership_plans')
  const archivedPlanPrices = plans.flatMap((plan) => [plan.monthly, plan.yearly].filter((price): price is string => !!price && stripe.price(price)?.['active'] === false).map((price) => `${plan.id} on ${price}`))
  const blocked = await db.query<{ id: string }>("SELECT b.id FROM bookings b JOIN sessions s ON s.id = b.session_id WHERE s.status = 'blocked' AND b.status <> 'cancelled' ORDER BY b.id")
  const windows = await db.query<{ day: number; from_time: string; to_time: string }>('SELECT day_of_week AS day, from_time::text, to_time::text FROM band_rules ORDER BY day_of_week, from_time')
  const daysNotCovered: string[] = []
  for (const day of new Set(windows.map((row) => row.day))) {
    const spans = windows.filter((row) => row.day === day).map((row) => [minutes(row.from_time), row.to_time.startsWith('24') || row.to_time === '00:00:00' ? MINUTES_IN_A_DAY : minutes(row.to_time)] as const)
    let reached = 0
    for (const [from, to] of [...spans].sort((a, b) => a[0] - b[0])) {
      if (from > reached) break
      reached = Math.max(reached, to)
    }
    if (reached < MINUTES_IN_A_DAY) daysNotCovered.push(`day ${day} covered to ${Math.floor(reached / 60)}:${String(reached % 60).padStart(2, '0')}`)
  }
  const [staff] = await db.query<{ admins: string; pricing: string }>(
    "SELECT count(*) FILTER (WHERE active AND role = 'admin')::text AS admins, count(*) FILTER (WHERE active AND can_manage_pricing)::text AS pricing FROM staff"
  )
  const variants = await db.query<{ id: string; stock: number }>('SELECT id, stock_quantity AS stock FROM product_variants ORDER BY id')
  const ledger = await db.query<{ id: string }>('SELECT id FROM stock_adjustments')
  return {
    archivedPlanPrices,
    blockedWithLiveBookings: blocked.map((row) => row.id),
    daysNotCovered,
    activeAdmins: Number(staff?.admins ?? 0),
    activePricingHolders: Number(staff?.pricing ?? 0),
    belowZero: variants.filter((variant) => Number(variant.stock) < 0).map((variant) => variant.id),
    stock: new Map(variants.map((variant) => [variant.id, Number(variant.stock)])),
    ledgerIds: ledger.map((row) => row.id),
  }
}

/** Six, around one staff press: it took away the last active admin, or the last active Manage pricing holder. */
export async function staffHoldersProblems(db: Db, stripe: FakeStripe, before: GState, action: string): Promise<string[]> {
  const after = await readGState(db, stripe)
  const wrong: string[] = []
  if (before.activeAdmins > 0 && after.activeAdmins === 0) wrong.push(`${action} left no active admin`)
  if (before.activePricingHolders > 0 && after.activePricingHolders === 0) wrong.push(`${action} left no active Manage pricing holder`)
  return wrong
}

/** The breaches the run made: present after it and not after the seed. */
export async function gBreaches(db: Db, stripe: FakeStripe, before: GState): Promise<string[]> {
  const after = await readGState(db, stripe)
  const isNew = (was: readonly string[], now: readonly string[]) => now.filter((one) => !was.includes(one))
  const wrong: string[] = []
  for (const one of isNew(before.archivedPlanPrices, after.archivedPlanPrices)) wrong.push(`a plan on an archived price: ${one}`)
  for (const one of isNew(before.blockedWithLiveBookings, after.blockedWithLiveBookings)) wrong.push(`a live booking on a blocked session: ${one}`)
  for (const one of isNew(before.daysNotCovered, after.daysNotCovered)) wrong.push(`band windows don't cover the day: ${one}`)
  for (const one of isNew(before.belowZero, after.belowZero)) wrong.push(`stock below zero: ${one}`)

  // 2: a subscription moved to one price twice.
  const moves = new Map<string, number>()
  for (const call of stripe.calls.filter((one) => one.method === 'subscriptions.update')) {
    const params = call.params as { id?: string; items?: Array<{ price?: string }> }
    for (const item of params.items ?? []) {
      if (!item.price) continue
      const key = `${params.id ?? '?'} to ${item.price}`
      moves.set(key, (moves.get(key) ?? 0) + 1)
    }
  }
  for (const [key, count] of moves) if (count > 1) wrong.push(`a subscription moved ${count} times: ${key}`)

  // 3: each variant moved by what its new ledger rows say; no more staff stock rows than stock presses that succeeded.
  const added = await db.query<{ variant_id: string; change: string }>(
    'SELECT variant_id, sum(change_amount)::text AS change FROM stock_adjustments WHERE NOT (id = ANY($1::uuid[])) GROUP BY variant_id',
    [before.ledgerIds]
  )
  const ledgerChange = new Map(added.map((row) => [row.variant_id, Number(row.change)]))
  for (const [variant, now] of after.stock) {
    // A variant the run made starts at nothing: its starting stock is a ledger row too ('Initial stock').
    const moved = now - (before.stock.get(variant) ?? 0)
    if (moved !== (ledgerChange.get(variant) ?? 0)) wrong.push(`stock of ${variant} moved ${moved}, its ledger says ${ledgerChange.get(variant) ?? 0}`)
  }
  const [presses] = await db.query<{ rows: string; presses: string }>(
    `SELECT (SELECT count(*) FROM stock_adjustments WHERE NOT (id = ANY($1::uuid[])) AND staff_id IS NOT NULL AND reason <> 'Initial stock')::text AS rows,
            (SELECT count(*) FROM api_idempotency WHERE endpoint LIKE 'POST /api/v1/staff/catalog/variants/%/stock' AND http_status = 200)::text AS presses`,
    [before.ledgerIds]
  )
  if (Number(presses?.rows ?? 0) > Number(presses?.presses ?? 0)) wrong.push(`${presses?.rows} staff stock changes for ${presses?.presses} stock presses`)

  // 7 (W66 item 0; W65b "Noticed" 3): a membership's payment date is moved, and charged for, once. Each change row is
  // charged under its own key (`<changeId>:charge`), so a second charge for one move is a second row: two rows moving
  // the same membership from the same renewal date, both charged (a `paymentIntents.create` under the row's key) and
  // neither failed. A first try that failed (declined, or refused and refunded) leaves its row `failed`, so trying
  // again is not counted; a later move starts from the date the first set, so it is not counted either.
  const chargedRows = new Set(
    stripe.calls
      .filter((call) => call.method === 'paymentIntents.create' && typeof call.idempotencyKey === 'string' && call.idempotencyKey.endsWith(':charge'))
      .map((call) => (call.idempotencyKey as string).slice(0, -':charge'.length))
  )
  const changes = await db.query<{ id: string; membership_id: string; old_renewal_date: string; status: string }>(
    'SELECT id::text AS id, membership_id::text AS membership_id, old_renewal_date::text AS old_renewal_date, status FROM membership_payment_date_changes ORDER BY created_at, id'
  )
  const movesCharged = new Map<string, string[]>()
  for (const change of changes) {
    if (!chargedRows.has(change.id) || change.status === 'failed') continue
    const move = `membership ${change.membership_id} from ${change.old_renewal_date}`
    movesCharged.set(move, [...(movesCharged.get(move) ?? []), change.id])
  }
  for (const [move, rows] of movesCharged) if (rows.length > 1) wrong.push(`a payment date change charged ${rows.length} times: ${move} (${rows.join(', ')})`)
  return wrong
}
