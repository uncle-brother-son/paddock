// New in W66 (H-plan 4.3, H7; Wayne's Q57, 22 Nov; lead calls L2, L-H6): Sanity's webhook writes on the Worker's own
// database connection, in place of Supabase's client and the service-role key.
//
// Sanity owns an item's content (name, picture, a product's category, an event's extra waiver); Postgres owns its
// prices, stock and whether it is on sale. Until W66 the route (app/api/sanity/webhook/route.ts) wrote each document
// through supabase-js, inserted a new item ON SALE with no price, made or renamed a Stripe product for every kind, and
// took a deleted item off sale with no record of who did it. Now:
// - One transaction per document: the row made or brought up to date in one statement (`ON CONFLICT` on the item's
//   Sanity id, which is unique on each table, so two deliveries of one new document can't make two rows).
// - Q57: a new row arrives OFF sale, whatever its kind. Staff set its prices in the staff app and put it on sale there
//   (an event always arrived off sale, as before). Nothing here ever puts an item on sale.
// - L2: no Stripe product is made or renamed for a service type, product, add-on, pass type or gift card type (nothing
//   has read one since W55; the Worker charges its own quote). Their old `stripe_product_id` columns are left as they
//   are. Membership plans as before (L-H6): a product made for a plan that has none, its name and picture sent again
//   on every publish, now on the Worker's Stripe client, after the row's transaction (never inside it), and the new
//   product made under a key from the plan's id, so a second delivery (or a retry) can't make a second product.
//   A Stripe failure is logged and the document still answered 200, as before: the next publish makes or renames it.
// - A delete takes the item off sale (never a row delete, as before), in one transaction with an audit row by the
//   system as `sanity`: `catalog.active_set` for the five item kinds (as the staff app's switch writes), and
//   `event.active_set` for an event. A plan goes off sale only through the plan rule's own switch (plans.ts,
//   takePlanOffSale): refused while a price change on the plan is open, and then logged, answered 200 and recorded
//   (`catalog.sanity_delete_refused`) for the lead.
import 'server-only'
import { audit } from '@/server/audit'
import type { Db, Tx } from '@/server/db'
import { ApiError } from '@/server/http/errors'
import { stripeIdempotencyKey } from '@/server/http/idempotency'
import type { StepBy } from '@/server/rules/memberships/left'
import type { StripeClient } from '@/server/stripe/client'
import { PLAN_ENTITY } from './plan-stripe'
import { takePlanOffSale } from './plans'

/** Who a Sanity write is by: the system, named `sanity` (audit_log's actor types are staff, customer and system). */
export const SANITY_ACTOR = { type: 'system', id: 'sanity' } as const

/** A Sanity document type this webhook keeps a row for. */
export type SanityKind = 'serviceType' | 'product' | 'addon' | 'membershipPlan' | 'sessionPassType' | 'giftCardType' | 'event'

/** The fields of a document as Sanity sends them, already turned into the row's (the route does that). */
export interface SanityMirror {
  name: string
  thumbnailUrl: string | null
  /** Products and add-ons only. Absent: the row's category is left as it is (as the client's update left it). */
  category?: string | null
  /** Events only. */
  hasExtraWaiver?: boolean
  extraWaiverVersion?: string | null
}

// Each statement is a literal per kind: no table or column name is ever built from what Sanity sends.
/** Make or bring up to date, by the document's id. `created`: this call made the row. */
const UPSERT_SQL: Readonly<Record<Exclude<SanityKind, 'product' | 'addon' | 'event'>, string>> = {
  serviceType: `INSERT INTO service_types (sanity_service_type_id, name, thumbnail_url, active) VALUES ($1, $2, $3, false)
    ON CONFLICT (sanity_service_type_id) DO UPDATE SET name = EXCLUDED.name, thumbnail_url = EXCLUDED.thumbnail_url, updated_at = now()
    RETURNING id, (xmax = 0) AS created, stripe_product_id`,
  membershipPlan: `INSERT INTO membership_plans (sanity_plan_id, name, thumbnail_url, active) VALUES ($1, $2, $3, false)
    ON CONFLICT (sanity_plan_id) DO UPDATE SET name = EXCLUDED.name, thumbnail_url = EXCLUDED.thumbnail_url, updated_at = now()
    RETURNING id, (xmax = 0) AS created, stripe_product_id`,
  sessionPassType: `INSERT INTO session_pass_types (sanity_pass_type_id, name, thumbnail_url, active) VALUES ($1, $2, $3, false)
    ON CONFLICT (sanity_pass_type_id) DO UPDATE SET name = EXCLUDED.name, thumbnail_url = EXCLUDED.thumbnail_url, updated_at = now()
    RETURNING id, (xmax = 0) AS created, stripe_product_id`,
  giftCardType: `INSERT INTO gift_card_types (sanity_gift_card_type_id, name, thumbnail_url, active) VALUES ($1, $2, $3, false)
    ON CONFLICT (sanity_gift_card_type_id) DO UPDATE SET name = EXCLUDED.name, thumbnail_url = EXCLUDED.thumbnail_url, updated_at = now()
    RETURNING id, (xmax = 0) AS created, stripe_product_id`,
}
const UPSERT_WITH_CATEGORY_SQL: Readonly<Record<'product' | 'addon', string>> = {
  product: `INSERT INTO products (sanity_product_id, name, category, thumbnail_url, active) VALUES ($1, $2, $3, $4, false)
    ON CONFLICT (sanity_product_id) DO UPDATE SET name = EXCLUDED.name, category = EXCLUDED.category, thumbnail_url = EXCLUDED.thumbnail_url, updated_at = now()
    RETURNING id, (xmax = 0) AS created, stripe_product_id`,
  addon: `INSERT INTO addons (sanity_addon_id, name, category, thumbnail_url, active) VALUES ($1, $2, $3, $4, false)
    ON CONFLICT (sanity_addon_id) DO UPDATE SET name = EXCLUDED.name, category = EXCLUDED.category, thumbnail_url = EXCLUDED.thumbnail_url, updated_at = now()
    RETURNING id, (xmax = 0) AS created, stripe_product_id`,
}
const UPSERT_KEEPING_CATEGORY_SQL: Readonly<Record<'product' | 'addon', string>> = {
  product: `INSERT INTO products (sanity_product_id, name, thumbnail_url, active) VALUES ($1, $2, $3, false)
    ON CONFLICT (sanity_product_id) DO UPDATE SET name = EXCLUDED.name, thumbnail_url = EXCLUDED.thumbnail_url, updated_at = now()
    RETURNING id, (xmax = 0) AS created, stripe_product_id`,
  addon: `INSERT INTO addons (sanity_addon_id, name, thumbnail_url, active) VALUES ($1, $2, $3, false)
    ON CONFLICT (sanity_addon_id) DO UPDATE SET name = EXCLUDED.name, thumbnail_url = EXCLUDED.thumbnail_url, updated_at = now()
    RETURNING id, (xmax = 0) AS created, stripe_product_id`,
}
const UPSERT_EVENT_SQL = `INSERT INTO events (sanity_event_id, name, thumbnail_url, has_extra_waiver, extra_waiver_version, active) VALUES ($1, $2, $3, $4::boolean, $5, false)
    ON CONFLICT (sanity_event_id) DO UPDATE SET name = EXCLUDED.name, thumbnail_url = EXCLUDED.thumbnail_url, has_extra_waiver = EXCLUDED.has_extra_waiver,
      extra_waiver_version = EXCLUDED.extra_waiver_version, updated_at = now()
    RETURNING id, (xmax = 0) AS created, NULL::text AS stripe_product_id`

/** The plan's product, written only while the row still has none (a staff press may have set one meanwhile). */
const SET_PLAN_PRODUCT_SQL = 'UPDATE membership_plans SET stripe_product_id = $1 WHERE id = $2::uuid AND stripe_product_id IS NULL'

/** Where a deleted document's row may be, in the order the route always looked (a delete carries no type). */
const DELETE_TABLES: ReadonlyArray<{ table: string; findSql: string; offSql: string; entity: string; action: string }> = [
  { table: 'service_types', findSql: 'SELECT id, active FROM service_types WHERE sanity_service_type_id = $1 FOR UPDATE', offSql: 'UPDATE service_types SET active = false, updated_at = now() WHERE id = $1::uuid', entity: 'service_type', action: 'catalog.active_set' },
  { table: 'products', findSql: 'SELECT id, active FROM products WHERE sanity_product_id = $1 FOR UPDATE', offSql: 'UPDATE products SET active = false, updated_at = now() WHERE id = $1::uuid', entity: 'product', action: 'catalog.active_set' },
  { table: 'addons', findSql: 'SELECT id, active FROM addons WHERE sanity_addon_id = $1 FOR UPDATE', offSql: 'UPDATE addons SET active = false, updated_at = now() WHERE id = $1::uuid', entity: 'addon', action: 'catalog.active_set' },
  { table: 'membership_plans', findSql: 'SELECT id, active FROM membership_plans WHERE sanity_plan_id = $1', offSql: '', entity: PLAN_ENTITY, action: 'plan.active_set' },
  { table: 'session_pass_types', findSql: 'SELECT id, active FROM session_pass_types WHERE sanity_pass_type_id = $1 FOR UPDATE', offSql: 'UPDATE session_pass_types SET active = false, updated_at = now() WHERE id = $1::uuid', entity: 'session_pass_type', action: 'catalog.active_set' },
  { table: 'gift_card_types', findSql: 'SELECT id, active FROM gift_card_types WHERE sanity_gift_card_type_id = $1 FOR UPDATE', offSql: 'UPDATE gift_card_types SET active = false, updated_at = now() WHERE id = $1::uuid', entity: 'gift_card_type', action: 'catalog.active_set' },
  { table: 'events', findSql: 'SELECT id, active FROM events WHERE sanity_event_id = $1 FOR UPDATE', offSql: 'UPDATE events SET active = false, updated_at = now() WHERE id = $1::uuid', entity: 'event', action: 'event.active_set' },
]

/** The audit action a Sanity delete of a plan records when the plan rule keeps the plan on sale. */
export const SANITY_DELETE_REFUSED_ACTION = 'catalog.sanity_delete_refused'

export interface SanityOptions {
  /** This delivery's own id (the route makes one): every audit row it writes carries it. */
  requestId: string
  /** The Worker's Stripe client, asked for only for a membership plan. */
  stripe: () => StripeClient
}

export interface SyncedDocument {
  kind: SanityKind
  id: string
  created: boolean
  /** Membership plans only: what was done with the plan's Stripe product. */
  planProduct?: 'made' | 'renamed' | 'failed'
}

type Upserted = { id: string; created: boolean; stripe_product_id: string | null }

async function upsert(tx: Tx, kind: SanityKind, documentId: string, mirror: SanityMirror): Promise<Upserted> {
  let rows: Upserted[]
  if (kind === 'product' || kind === 'addon') {
    rows = 'category' in mirror
      ? await tx.query<Upserted>(UPSERT_WITH_CATEGORY_SQL[kind], [documentId, mirror.name, mirror.category ?? null, mirror.thumbnailUrl])
      : await tx.query<Upserted>(UPSERT_KEEPING_CATEGORY_SQL[kind], [documentId, mirror.name, mirror.thumbnailUrl])
  } else if (kind === 'event') {
    rows = await tx.query<Upserted>(UPSERT_EVENT_SQL, [documentId, mirror.name, mirror.thumbnailUrl, mirror.hasExtraWaiver === true, mirror.extraWaiverVersion ?? null])
  } else {
    rows = await tx.query<Upserted>(UPSERT_SQL[kind], [documentId, mirror.name, mirror.thumbnailUrl])
  }
  const [row] = rows
  if (!row) throw new Error(`The ${kind} row for Sanity document ${documentId} was neither made nor updated.`)
  return row
}

/**
 * A published document: its row made (off sale, Q57) or brought up to date, in one transaction. For a membership plan,
 * then its Stripe product (after the transaction): made under a key from the plan's id when the row has none,
 * otherwise renamed. Throws when the database fails, so the route answers 500 and Sanity sends it again.
 */
export async function syncSanityDocument(db: Db, kind: SanityKind, documentId: string, mirror: SanityMirror, options: SanityOptions): Promise<SyncedDocument> {
  const row = await db.transaction((tx) => upsert(tx, kind, documentId, mirror))
  const synced: SyncedDocument = { kind, id: row.id, created: row.created === true }
  if (kind !== 'membershipPlan') return synced
  try {
    const stripe = options.stripe()
    if (row.stripe_product_id) {
      await stripe.products.update(row.stripe_product_id, { name: mirror.name, images: mirror.thumbnailUrl ? [mirror.thumbnailUrl] : [] })
      return { ...synced, planProduct: 'renamed' }
    }
    // Self-heals a plan whose product was never made (Stripe away at the time), as before. The key comes from the
    // plan's id, so Stripe answers a second send (a delivery sent again, a retry) with the product it made the first time.
    const product = await stripe.products.create(
      { name: mirror.name, ...(mirror.thumbnailUrl ? { images: [mirror.thumbnailUrl] } : {}), active: true, metadata: { sanity_id: documentId, type: 'membership_plan' } },
      { idempotencyKey: stripeIdempotencyKey(row.id, 'sanity-plan-product') }
    )
    await db.query(SET_PLAN_PRODUCT_SQL, [product.id, row.id])
    return { ...synced, planProduct: 'made' }
  } catch (err) {
    // As before: the row stands, and the next publish makes or renames the product.
    console.error(`Error syncing the Stripe product of membership plan ${row.id} (Sanity ${documentId}):`, err instanceof Error ? err.message : err)
    return { ...synced, planProduct: 'failed' }
  }
}

export type SanityDeleted =
  | { found: false }
  | { found: true; entity: string; id: string; wasActive: boolean }
  | { found: true; entity: typeof PLAN_ENTITY; id: string; refused: 'price_change_open'; message: string }

/**
 * A deleted (or unpublished) document: its row taken off sale, whichever table holds it, with an audit row by the
 * system as `sanity`; one transaction. A plan through the plan rule's switch (takePlanOffSale), which keeps it on sale
 * while a price change is open: that refusal is recorded for the lead and answered, never thrown. Any other failure
 * throws, so the route answers 500 and Sanity sends it again.
 */
export async function takeSanityDocumentOffSale(db: Db, documentId: string, options: SanityOptions): Promise<SanityDeleted> {
  const by: StepBy = { actor: { ...SANITY_ACTOR }, requestId: options.requestId }
  const found = await db.transaction(async (tx): Promise<SanityDeleted | { plan: string; wasActive: boolean }> => {
    for (const where of DELETE_TABLES) {
      const [row] = await tx.query<{ id: string; active: boolean | null }>(where.findSql, [documentId])
      if (!row) continue
      if (where.entity === PLAN_ENTITY) return { plan: row.id, wasActive: row.active === true }
      await tx.query(where.offSql, [row.id])
      await audit.record(tx, {
        actorType: SANITY_ACTOR.type,
        actorId: SANITY_ACTOR.id,
        action: where.action,
        entityType: where.entity,
        entityId: row.id,
        requestId: options.requestId,
        details: { before: { id: row.id, active: row.active === true }, after: { id: row.id, active: false }, key: null, sanityDocumentId: documentId, why: 'sanity_delete' },
      })
      return { found: true, entity: where.entity, id: row.id, wasActive: row.active === true }
    }
    return { found: false }
  })
  if (!('plan' in found)) return found
  const planId = found.plan
  try {
    await takePlanOffSale(db, planId, { by, key: null, stripe: options.stripe, timing: undefined })
    return { found: true, entity: PLAN_ENTITY, id: planId, wasActive: found.wasActive }
  } catch (err) {
    const reason = err instanceof ApiError ? (err.details as { reason?: unknown } | undefined)?.reason : undefined
    if (reason !== 'price_change_open') throw err
    const message = err instanceof Error ? err.message : String(err)
    await db.transaction((tx) =>
      audit.record(tx, { actorType: SANITY_ACTOR.type, actorId: SANITY_ACTOR.id, action: SANITY_DELETE_REFUSED_ACTION, entityType: PLAN_ENTITY, entityId: planId, requestId: options.requestId, details: { sanityDocumentId: documentId, reason, message } })
    )
    console.error(`Sanity deleted membership plan ${planId} (${documentId}), but it stays on sale: ${message}`)
    return { found: true, entity: PLAN_ENTITY, id: planId, refused: 'price_change_open', message }
  }
}
