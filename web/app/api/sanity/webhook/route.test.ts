import nodeCrypto, { createHash, createHmac } from 'node:crypto'
import path from 'node:path'
import { NextRequest } from 'next/server'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { GET as productCategoriesRoute } from '@/app/api/v1/staff/catalog/product-categories/route'
import { GET as productsRoute } from '@/app/api/v1/staff/catalog/products/route'
import { POST as closeRoute } from '@/app/api/v1/staff/orders/stuck/close/route'
import { catalogProductCategoriesRouteOutputSchema, stuckCloseKindSchema, stuckListOutputSchema } from '@/contracts'
import type { Db } from '@/server/db'
import { PLAN_STUCK_WORDS } from '@/server/rules/catalog/plan-failure-messages'
import { sanityDeletesListed, SANITY_DELETE_REFUSED_ACTION, sortSanityDelete } from '@/server/rules/catalog/sanity-sync'
import { LEFT_STEP_WORDS } from '@/server/rules/memberships/failure-messages'
import { stuckList } from '@/server/rules/orders/stuck-list'
import { ADMIN_TEST_KEY, pressRoute } from '@/server/rules/testing/admin-routes'
import { insert, startTestDatabase, type TestDatabase } from '@/server/rules/testing/database'
import { staffAppDir } from '@/server/rules/testing/staff-app-dir'
import { bindStaffRoutes } from '@/server/rules/testing/sweep/staff-routes'
import { FakeStripe } from '@/server/stripe/fake'
import { POST } from './route'

// Brief W66 item 2 (H-plan 4.3, H7; Q57): Sanity's webhook through its route, on PGlite with the live schema, as the
// role `paddock_worker` through the Worker's driver, and the fake Stripe. Before W66 it wrote through Supabase's client
// with the service-role key, and had no tests. What must hold:
// - each catalogue type made (OFF sale, Q57), brought up to date, and taken off sale on a delete with an audit row
//   by the system as `sanity`; nothing else written by a draft, a bad signature or a type with no row;
// - one transaction per document: a write failing leaves nothing half written;
// - no Stripe call for anything but a membership plan; a plan's product made under a key from the plan's id, so the
//   same delivery twice makes one product; a plan taken off sale only through the plan rule's guard.
// W66a (the W66 review's S1, F2, F6, F7): a republish changes nothing on the row but Sanity's own fields, on every
// statement's path; a plan renamed after a lost create still has one product; a delete of an item already off sale
// writes nothing; a signature older than 5 minutes is refused.
// W70a (the W70 audit's L1, L2): a delete acts on the signed body's document alone; a plan a price change kept on sale
// is a line on the Orders page's list, until it is off sale or marked sorted.
// W72a (WQ7, WQ15, WQ19; the lead's design): a product's, an event's and the gift card's picture is the first PICTURE of
// its gallery (videos skipped; none is no picture, never an error); a product category has a row of its own, a
// product's row holds its id, a rename is that one row's, and a category a product row still names is never deleted.

vi.setConfig({ testTimeout: 60_000 })

// The route reads Sanity's project and dataset when it is loaded (its picture builder), so they are set first.
const holder = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SANITY_PROJECT_ID = 'w66test'
  process.env.NEXT_PUBLIC_SANITY_DATASET = 'production'
  return { db: null as unknown, stripe: null as unknown }
})
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))
vi.mock('@/server/stripe/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/stripe/client')>()),
  createStripeClient: () => holder.stripe,
}))

const SECRET = 'w66-sanity-secret'
const JO = 'jo.sanity@example.com'
const FRAN = 'fran.sanity@example.com'
let jo: string
let database: TestDatabase
let stripe: FakeStripe

beforeAll(async () => {
  vi.stubEnv('SANITY_WEBHOOK_SECRET', SECRET)
  vi.stubEnv('STAFF_API_KEY', ADMIN_TEST_KEY)
  database = await startTestDatabase({ schema: 'live' })
  holder.db = database.db
  jo = await insert(database.db, 'staff', { role: 'staff', first_name: 'Jo', last_name: 'Staff', email: JO, can_issue_refunds: true })
  await insert(database.db, 'staff', { role: 'staff', first_name: 'Fran', last_name: 'Desk', email: FRAN, can_issue_refunds: false, can_manage_pricing: true })
})
afterAll(async () => {
  vi.unstubAllEnvs()
  await database.stop()
})
beforeEach(() => {
  stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
  holder.stripe = stripe
})

/** Sanity's signature: `t=<time>,v1=<base64url HMAC-SHA256 of "<time>.<body>">`, as the route checks it. The time is Sanity's, in milliseconds. */
function signed(body: string, secret = SECRET, t = String(Date.now())): string {
  const hash = createHmac('sha256', secret).update(`${t}.${body}`).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `t=${t},v1=${hash}`
}

async function deliver(document: Record<string, unknown> | null, headers: Record<string, string> = {}, signature?: string): Promise<{ status: number; body: unknown }> {
  const body = document === null ? '' : JSON.stringify(document)
  const response = await POST(new NextRequest('http://localhost/api/sanity/webhook', { method: 'POST', body, headers: { 'sanity-webhook-signature': signature ?? signed(body), ...headers } }))
  return { status: response.status, body: await response.json() }
}
const published = (document: Record<string, unknown>) => deliver(document, { 'sanity-operation': 'update' })
/** W70a (L1): a delete as Sanity sends it: the document's id in the signed body, and in the header that isn't signed. */
const deleted = (documentId: string) => deliver({ _id: documentId }, { 'sanity-operation': 'delete', 'sanity-document-id': documentId })

const IMAGE = { asset: { _ref: 'image-abc123-800x600-jpg' } }
/** W72a: a gallery's items, as the Studio's `media` block saves them: a picture, and a video with its poster. */
const pictureItem = (name = 'abc123') => ({ _type: 'media', _key: `k-${name}`, kind: 'image', image: { _type: 'picture', asset: { _type: 'reference', _ref: `image-${name}-800x600-jpg` }, alt: 'A sauna' } })
const videoItem = (name = 'film1', extra: Record<string, unknown> = {}) => ({
  _type: 'media',
  _key: `k-${name}`,
  kind: 'video',
  video: { _type: 'file', asset: { _type: 'reference', _ref: `file-${name}-mp4` } },
  poster: { _type: 'picture', asset: { _type: 'reference', _ref: `image-poster${name}-800x600-jpg` }, alt: 'Steam' },
  videoDescription: 'Steam rising',
  ...extra,
})
/** The staff app's picture of a Sanity image, as the route makes it. */
const thumbnailOf = (name = 'abc123') => `https://cdn.sanity.io/images/w66test/production/${name}-800x600.jpg?w=80`
/**
 * W72a: a document's picture, in the field its type keeps it in: a gallery on a product and an event, the physical
 * gallery on the gift card, `images` on the other four.
 */
const pictured = (type: string): Record<string, unknown> => {
  if (type === 'product' || type === 'event') return { gallery: [pictureItem()] }
  if (type === 'giftCardType') return { physicalGallery: [pictureItem()] }
  return { images: [IMAGE] }
}
/** W72a: a product's category as its document holds it: a reference to the category's document. */
const categoryRef = (id: string) => ({ _type: 'reference', _ref: id })
/** The route's fingerprint of an extra waiver: the first 12 hex characters of its trimmed text's SHA-256. */
const createHashOf = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 12)

/** Each Sanity type, its table and the column holding the document's id. */
const TYPES = [
  { type: 'serviceType', table: 'service_types', column: 'sanity_service_type_id', entity: 'service_type', action: 'catalog.active_set' },
  { type: 'product', table: 'products', column: 'sanity_product_id', entity: 'product', action: 'catalog.active_set' },
  { type: 'addon', table: 'addons', column: 'sanity_addon_id', entity: 'addon', action: 'catalog.active_set' },
  { type: 'sessionPassType', table: 'session_pass_types', column: 'sanity_pass_type_id', entity: 'session_pass_type', action: 'catalog.active_set' },
  { type: 'giftCardType', table: 'gift_card_types', column: 'sanity_gift_card_type_id', entity: 'gift_card_type', action: 'catalog.active_set' },
  { type: 'event', table: 'events', column: 'sanity_event_id', entity: 'event', action: 'event.active_set' },
  { type: 'membershipPlan', table: 'membership_plans', column: 'sanity_plan_id', entity: 'membership_plan', action: 'plan.active_set' },
] as const
type TypeInfo = (typeof TYPES)[number]
const NON_PLAN = TYPES.filter((t) => t.type !== 'membershipPlan')
/**
 * Every statement that can bring a row up to date: one per type, and for a product and an add-on (whose category the
 * Studio requires, so every live document has it) the one with the category and the one without.
 */
const PUBLISHED_AGAIN = TYPES.flatMap((info): Array<{ path: string; info: TypeInfo; extra: Record<string, unknown>; sanitysOwn: Record<string, unknown> }> => {
  const plain = { path: info.type, info, extra: {}, sanitysOwn: {} }
  if (info.type === 'product' || info.type === 'addon') {
    // W72a: a product's category is a reference, and its row holds the category's id; an add-on's is a word, as before.
    const category = info.type === 'product' ? categoryRef('w72a-cat-wellbeing') : 'Wellbeing'
    const stored = info.type === 'product' ? 'w72a-cat-wellbeing' : 'Wellbeing'
    return [
      { path: `${info.type} with its category, as every live one is sent`, info, extra: { category }, sanitysOwn: { category: stored } },
      { ...plain, path: `${info.type} without a category` },
    ]
  }
  if (info.type === 'event') return [{ ...plain, extra: { extraWaiver: 'Cold water.' }, sanitysOwn: { has_extra_waiver: true, extra_waiver_version: createHashOf('Cold water.') } }]
  return [plain]
})

/** What staff set on each type before a republish: every price the type has, and what else the catalogue pages edit. */
const STAFF_SET: Readonly<Record<TypeInfo['type'], string>> = {
  serviceType: "duration = 75, capacity = 9, booking_type = 'public', stripe_price_id = 'price_old_' || id",
  product: "base_price = 12.00, member_price = 10.00, sale_price = 11.00, fulfillment_method = 'pickup', stripe_price_id_base = 'price_base_' || id, stripe_price_id_member = 'price_member_' || id, stripe_price_id_sale = 'price_sale_' || id",
  addon: "sku = 'W66A-' || id, base_price = 4.00, member_price = 3.00, sale_price = 3.50, stripe_price_id_base = 'price_base_' || id, stripe_price_id_member = 'price_member_' || id, stripe_price_id_sale = 'price_sale_' || id",
  membershipPlan: "sessions_included = 4, addons_included = 2, price_monthly = 40.00, price_yearly = 400.00, level = 'core', is_unlimited = false, stripe_price_id = 'price_month_' || id, stripe_price_id_yearly = 'price_year_' || id",
  sessionPassType: "price = 90.00, sessions_included = 5, expiry_months = 9, level = 'core', stripe_price_id = 'price_pass_' || id",
  giftCardType: 'custom_amount_enabled = true, custom_amount_min = 10.00, custom_amount_max = 200.00, expiry_months = 24',
  event: "access = 'members_first', public_release_at = now() + interval '10 days', price_public = 21.00, price_pre_herd = 19.00, price_herd = 16.00, capacity = 12",
}

// The table and column are literals from TYPES, never from a request.
const rowOf = async (info: TypeInfo, documentId: string) =>
  (await database.db.query<{ id: string; name: string; thumbnail_url: string | null; active: boolean; stripe_product_id?: string | null; category?: string | null }>(`SELECT * FROM ${info.table} WHERE ${info.column} = $1`, [documentId]))
const auditRows = (entityId: string) =>
  database.db.query<{ actor_type: string; actor_id: string | null; action: string; details: Record<string, unknown> }>('SELECT actor_type, actor_id, action, details FROM audit_log WHERE entity_id = $1 ORDER BY at, ctid', [entityId])

/**
 * An item already made and put on sale by staff, with an old Stripe product id from before W55 (a plan keeps the
 * product its publish made).
 */
async function onSale(info: TypeInfo, documentId: string): Promise<string> {
  expect((await published({ _type: info.type, _id: documentId, name: 'Before' })).status).toBe(200)
  const [row] = await rowOf(info, documentId)
  const id = row?.id as string
  // Staff put it on sale (an event needs its date, capacity, cut-off and prices first).
  const extra = info.type === 'event' ? ", starts_at = now() + interval '30 days', capacity = 10, refund_cutoff_at = now() + interval '29 days', price_public = 20, price_pre_herd = 18, price_herd = 15" : ''
  const product = info.type === 'event' || info.type === 'membershipPlan' ? '' : `, stripe_product_id = 'prod_old_${id}'`
  await database.pg.exec(`RESET ROLE; UPDATE ${info.table} SET active = true${product}${extra} WHERE id = '${id}'; SET ROLE paddock_worker;`)
  return id
}

describe("Sanity's webhook on the Worker's connection (W66)", () => {
  it.each(TYPES)('$type: a new document makes its row OFF sale (Q57), with its name and picture', async (info) => {
    const documentId = `w66-new-${info.type}-${crypto.randomUUID()}`
    expect(await published({ _type: info.type, _id: documentId, name: 'New thing', ...pictured(info.type) })).toEqual({ status: 200, body: { success: true } })
    const rows = await rowOf(info, documentId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ name: 'New thing', active: false })
    expect(rows[0]?.thumbnail_url).toMatch(/^https:\/\/cdn\.sanity\.io\/images\/w66test\/production\/abc123-800x600\.jpg\?w=80$/)
    if (info.type === 'membershipPlan') {
      // As before: a new plan gets its Stripe product, under a key from the plan's id. W66a (F2), a named difference: the
      // create sends the name and the metadata alone, then the name and picture are sent as an update.
      expect(stripe.calls.map((call) => [call.method, call.idempotencyKey, call.params])).toEqual([
        ['products.create', `${rows[0]?.id}:sanity-plan-product`, { name: 'New thing', active: true, metadata: { sanity_id: documentId, type: 'membership_plan' } }],
        ['products.update', null, { id: rows[0]?.stripe_product_id, name: 'New thing', images: [rows[0]?.thumbnail_url] }],
      ])
      expect(rows[0]?.stripe_product_id).toMatch(/^prod_/)
    } else {
      // L2: no Stripe product made for anything else.
      expect(stripe.calls).toEqual([])
      if (info.type !== 'event') expect(rows[0]?.stripe_product_id ?? null).toBeNull()
    }
  })

  it.each(TYPES)('$type: a document published again brings the row up to date, leaving on sale as staff set it', async (info) => {
    const documentId = `w66-upd-${info.type}-${crypto.randomUUID()}`
    const id = await onSale(info, documentId)
    const productBefore = (await rowOf(info, documentId))[0]?.stripe_product_id
    stripe.calls.length = 0
    expect(await published({ _type: info.type, _id: documentId, name: 'After', ...pictured(info.type) })).toEqual({ status: 200, body: { success: true } })
    const [row] = await rowOf(info, documentId)
    expect(row).toMatchObject({ id, name: 'After', active: true })
    if (info.type === 'membershipPlan') {
      // As before: the plan's product renamed, with its picture.
      expect(stripe.calls.map((call) => [call.method, call.params])).toEqual([['products.update', { id: productBefore, name: 'After', images: [row?.thumbnail_url] }]])
      expect(row?.stripe_product_id).toBe(productBefore)
      expect((await stripe.products.retrieve(productBefore as string)).name).toBe('After')
    } else {
      expect(stripe.calls).toEqual([])
      if (info.type !== 'event') expect(row?.stripe_product_id).toBe(`prod_old_${id}`)
    }
  })

  // S1 (the W66 review): the whole row, so a republish that moved `active`, a price or any staff setting is caught on
  // every statement's path, a live product's and add-on's (with their category) included.
  it.each(PUBLISHED_AGAIN)('$path: published again, on sale and off sale, changes nothing on the row but Sanity\'s own fields (S1)', async ({ info, extra, sanitysOwn }) => {
    for (const active of [true, false]) {
      const documentId = `w66a-again-${info.type}-${crypto.randomUUID()}`
      const id = await onSale(info, documentId)
      await database.pg.exec(`RESET ROLE; UPDATE ${info.table} SET ${STAFF_SET[info.type]}, active = ${String(active)} WHERE id = '${id}'; SET ROLE paddock_worker;`)
      const [before] = await rowOf(info, documentId)
      expect(await published({ _type: info.type, _id: documentId, name: 'After', ...pictured(info.type), ...extra })).toEqual({ status: 200, body: { success: true } })
      const [after] = await rowOf(info, documentId)
      const { updated_at: changedAt, ...rest } = after as unknown as Record<string, unknown>
      const { updated_at: wasAt, ...was } = before as unknown as Record<string, unknown>
      expect(new Date(changedAt as string).getTime()).toBeGreaterThanOrEqual(new Date(wasAt as string).getTime())
      expect(rest).toEqual({ ...was, name: 'After', thumbnail_url: 'https://cdn.sanity.io/images/w66test/production/abc123-800x600.jpg?w=80', ...sanitysOwn })
      expect(rest['active']).toBe(active)
      // The staff settings were really there to lose: no price on the row is empty. W68 (H10): a service type has no price of
      // its own (migration 034 drops the column).
      for (const [name, value] of Object.entries(was)) if (/price|amount_m/.test(name) && !(info.table === 'service_types' && name === 'price')) expect(value, name).not.toBeNull()
    }
  })

  it.each(NON_PLAN)('$type: a delete takes the row off sale with an audit row by the system as sanity; nothing sent to Stripe', async (info) => {
    const documentId = `w66-del-${info.type}-${crypto.randomUUID()}`
    const id = await onSale(info, documentId)
    stripe.calls.length = 0
    expect(await deleted(documentId)).toEqual({ status: 200, body: { success: true } })
    const [row] = await rowOf(info, documentId)
    expect(row).toMatchObject({ id, active: false })
    expect(await auditRows(id)).toEqual([
      { actor_type: 'system', actor_id: 'sanity', action: info.action, details: { before: { id, active: true }, after: { id, active: false }, key: null, sanityDocumentId: documentId, why: 'sanity_delete' } },
    ])
    expect(stripe.calls).toEqual([])
  })

  it('membershipPlan: a delete goes through the plan rule: off sale, plan.active_set by sanity, and its product step sent', async () => {
    const info = TYPES.find((t) => t.type === 'membershipPlan') as TypeInfo
    const documentId = `w66-del-plan-${crypto.randomUUID()}`
    expect((await published({ _type: 'membershipPlan', _id: documentId, name: 'Core' })).status).toBe(200)
    const [made] = await rowOf(info, documentId)
    const id = made?.id as string
    await database.pg.exec(`RESET ROLE; UPDATE membership_plans SET active = true WHERE id = '${id}'; SET ROLE paddock_worker;`)
    stripe.calls.length = 0
    expect(await deleted(documentId)).toEqual({ status: 200, body: { success: true } })
    expect((await rowOf(info, documentId))[0]).toMatchObject({ active: false })
    const rows = await auditRows(id)
    expect(rows.find((row) => row.action === 'plan.active_set')).toMatchObject({ actor_type: 'system', actor_id: 'sanity', details: { before: { id, active: true }, after: { id, active: false }, key: null } })
    expect(rows.every((row) => row.actor_type === 'system' && row.actor_id === 'sanity')).toBe(true)
    // The plan rule's step: read, then sent (left.ts's way: only if Stripe doesn't already show it).
    expect(stripe.calls.map((call) => [call.method, call.params])).toEqual([
      ['products.retrieve', { id: made?.stripe_product_id }],
      ['products.update', { id: made?.stripe_product_id, active: false }],
    ])
  })

  it('membershipPlan: a delete while a price change on the plan is open is refused by the plan rule: answered 200, the plan stays on sale, recorded for the lead', async () => {
    const info = TYPES.find((t) => t.type === 'membershipPlan') as TypeInfo
    const documentId = `w66-del-plan-open-${crypto.randomUUID()}`
    expect((await published({ _type: 'membershipPlan', _id: documentId, name: 'Core' })).status).toBe(200)
    const id = (await rowOf(info, documentId))[0]?.id as string
    await database.pg.exec(`RESET ROLE; UPDATE membership_plans SET active = true WHERE id = '${id}'; SET ROLE paddock_worker;`)
    await database.db.query(
      "INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, request_id, details) VALUES ('staff', 'jo', 'plan.price_change', 'membership_plan', $1, 'req-open', $2::jsonb)",
      [id, JSON.stringify({ changeId: 'change-open', planId: id, state: 'started', prices: { monthly: 45 }, membersToMove: 0, productName: 'Core' })]
    )
    stripe.calls.length = 0
    expect(await deleted(documentId)).toEqual({ status: 200, body: { success: true, kept: 'price_change_open' } })
    expect((await rowOf(info, documentId))[0]).toMatchObject({ active: true })
    const refused = (await auditRows(id)).filter((row) => row.action === SANITY_DELETE_REFUSED_ACTION)
    expect(refused).toEqual([{ actor_type: 'system', actor_id: 'sanity', action: SANITY_DELETE_REFUSED_ACTION, details: expect.objectContaining({ sanityDocumentId: documentId, reason: 'price_change_open' }) }])
    expect((await auditRows(id)).some((row) => row.action === 'plan.active_set')).toBe(false)
    expect(stripe.calls).toEqual([])
  })

  it('membershipPlan: its product under the same key twice: Stripe made it but the answer was lost; the next publish gets that product back, never a second one', async () => {
    const info = TYPES.find((t) => t.type === 'membershipPlan') as TypeInfo
    const documentId = `w66-plan-key-${crypto.randomUUID()}`
    stripe.failNext('products.create', { kind: 'lost_response' })
    // Stripe's failure is logged and the document still answered 200, as before; the row has no product yet.
    expect(await published({ _type: 'membershipPlan', _id: documentId, name: 'Core' })).toEqual({ status: 200, body: { success: true } })
    const [first] = await rowOf(info, documentId)
    expect(first?.stripe_product_id ?? null).toBeNull()
    expect(await published({ _type: 'membershipPlan', _id: documentId, name: 'Core' })).toEqual({ status: 200, body: { success: true } })
    const [second] = await rowOf(info, documentId)
    const creates = stripe.calls.filter((call) => call.method === 'products.create')
    expect(creates.map((call) => call.idempotencyKey)).toEqual([`${first?.id}:sanity-plan-product`, `${first?.id}:sanity-plan-product`])
    expect(second?.stripe_product_id).toMatch(/^prod_/)
    expect((await stripe.products.list({ limit: 100 })).data.filter((product) => product.metadata['sanity_id'] === documentId)).toHaveLength(1)
  })

  it('membershipPlan: a lost create, then published again with a new name within 24 hours (Stripe refuses the key): its one product is found, given to the plan and renamed (F2)', async () => {
    const info = TYPES.find((t) => t.type === 'membershipPlan') as TypeInfo
    const documentId = `w66a-plan-renamed-${crypto.randomUUID()}`
    stripe.failNext('products.create', { kind: 'lost_response' })
    expect(await published({ _type: 'membershipPlan', _id: documentId, name: 'Cor', images: [IMAGE] })).toEqual({ status: 200, body: { success: true } })
    expect((await rowOf(info, documentId))[0]?.stripe_product_id ?? null).toBeNull()
    // Another plan's product, newer than the lost one: the look-up is by this document's id.
    expect((await published({ _type: 'membershipPlan', _id: `${documentId}-other`, name: 'Other' })).status).toBe(200)
    stripe.calls.length = 0
    expect(await published({ _type: 'membershipPlan', _id: documentId, name: 'Core', images: [IMAGE] })).toEqual({ status: 200, body: { success: true } })
    const [row] = await rowOf(info, documentId)
    const made = (await stripe.products.list({ limit: 100 })).data.filter((product) => product.metadata['sanity_id'] === documentId)
    expect(made).toEqual([expect.objectContaining({ name: 'Core', images: [row?.thumbnail_url] })])
    expect(row).toMatchObject({ name: 'Core', stripe_product_id: made[0]?.id })
    // The refused create made nothing; then the product's own update.
    expect(stripe.calls.map((call) => call.method)).toEqual(['products.create', 'products.list', 'products.update', 'products.list'])
    // And the next publish is an ordinary rename of that product.
    expect(await published({ _type: 'membershipPlan', _id: documentId, name: 'Core plan' })).toEqual({ status: 200, body: { success: true } })
    expect((await stripe.products.retrieve(made[0]?.id as string)).name).toBe('Core plan')
  })

  it('membershipPlan: a lost create, then published again with a new picture only: the same product, with the new picture (the create carries no picture)', async () => {
    const info = TYPES.find((t) => t.type === 'membershipPlan') as TypeInfo
    const documentId = `w66a-plan-picture-${crypto.randomUUID()}`
    stripe.failNext('products.create', { kind: 'lost_response' })
    await published({ _type: 'membershipPlan', _id: documentId, name: 'Core' })
    expect(await published({ _type: 'membershipPlan', _id: documentId, name: 'Core', images: [IMAGE] })).toEqual({ status: 200, body: { success: true } })
    const [row] = await rowOf(info, documentId)
    const made = (await stripe.products.list({ limit: 100 })).data.filter((product) => product.metadata['sanity_id'] === documentId)
    expect(made).toEqual([expect.objectContaining({ id: row?.stripe_product_id, name: 'Core', images: [row?.thumbnail_url] })])
  })

  it('product and add-on: the category is set when the document has the field, and left as it is when it has none; a new one with a category arrives off sale too (W72a: a product\'s is its category document\'s id, an add-on\'s its word as before)', async () => {
    for (const info of TYPES.filter((t) => t.type === 'product' || t.type === 'addon')) {
      const documentId = `w66-cat-${info.type}-${crypto.randomUUID()}`
      const category = info.type === 'product' ? categoryRef('w72a-cat-wellbeing') : 'Wellbeing'
      const stored = info.type === 'product' ? 'w72a-cat-wellbeing' : 'Wellbeing'
      await published({ _type: info.type, _id: documentId, name: 'Soap', category })
      // The row made by the statement that carries the category (the per-type test above makes it without one): off sale (Q57).
      expect((await rowOf(info, documentId))[0]).toMatchObject({ category: stored, active: false })
      await published({ _type: info.type, _id: documentId, name: 'Soap bar' })
      expect((await rowOf(info, documentId))[0]).toMatchObject({ name: 'Soap bar', category: stored })
      await published({ _type: info.type, _id: documentId, name: 'Soap bar', category: null })
      expect((await rowOf(info, documentId))[0]).toMatchObject({ category: null })
    }
  })

  it("event: the extra waiver's flag and fingerprint, changed with its text", async () => {
    const info = TYPES.find((t) => t.type === 'event') as TypeInfo
    const documentId = `w66-event-${crypto.randomUUID()}`
    await published({ _type: 'event', _id: documentId, name: 'Full moon', extraWaiver: '  Cold water at your own risk.  ' })
    const [first] = await database.db.query<{ has_extra_waiver: boolean; extra_waiver_version: string | null }>('SELECT has_extra_waiver, extra_waiver_version FROM events WHERE sanity_event_id = $1', [documentId])
    expect(first).toEqual({ has_extra_waiver: true, extra_waiver_version: createHashOf('Cold water at your own risk.') })
    await published({ _type: 'event', _id: documentId, name: 'Full moon' })
    const [second] = await database.db.query<{ has_extra_waiver: boolean; extra_waiver_version: string | null }>('SELECT has_extra_waiver, extra_waiver_version FROM events WHERE sanity_event_id = $1', [documentId])
    expect(second).toEqual({ has_extra_waiver: false, extra_waiver_version: null })
    expect(await rowOf(info, documentId)).toHaveLength(1)
  })

  // One after the other (PGlite is one session). Two at once can't make two either: the row is made by one statement
  // that takes the existing row on the item's unique Sanity id (ON CONFLICT).
  it('the same new document delivered twice makes one row', async () => {
    const info = TYPES.find((t) => t.type === 'addon') as TypeInfo
    const documentId = `w66-twice-${crypto.randomUUID()}`
    expect(await published({ _type: 'addon', _id: documentId, name: 'Towel' })).toEqual({ status: 200, body: { success: true } })
    expect(await published({ _type: 'addon', _id: documentId, name: 'Towel' })).toEqual({ status: 200, body: { success: true } })
    expect(await rowOf(info, documentId)).toHaveLength(1)
  })

  it('a draft (published or deleted) writes nothing', async () => {
    const info = TYPES.find((t) => t.type === 'product') as TypeInfo
    const documentId = `w66-draft-${crypto.randomUUID()}`
    expect(await published({ _type: 'product', _id: `drafts.${documentId}`, name: 'Draft soap' })).toEqual({ status: 200, body: { message: 'Draft ignored' } })
    expect(await rowOf(info, `drafts.${documentId}`)).toEqual([])
    const id = await onSale(info, documentId)
    expect(await deleted(`drafts.${documentId}`)).toEqual({ status: 200, body: { message: 'Draft delete ignored' } })
    expect((await rowOf(info, documentId))[0]).toMatchObject({ active: true })
    expect(await auditRows(id)).toEqual([])
  })

  it('a bad or missing signature is refused (401) and writes nothing', async () => {
    const info = TYPES.find((t) => t.type === 'product') as TypeInfo
    const documentId = `w66-badsig-${crypto.randomUUID()}`
    const body = JSON.stringify({ _type: 'product', _id: documentId, name: 'Forged' })
    expect(await deliver({ _type: 'product', _id: documentId, name: 'Forged' }, {}, signed(body, 'not-the-secret'))).toEqual({ status: 401, body: { error: 'Invalid signature' } })
    const response = await POST(new NextRequest('http://localhost/api/sanity/webhook', { method: 'POST', body }))
    expect(response.status).toBe(401)
    expect(await rowOf(info, documentId)).toEqual([])
    const id = await onSale(info, documentId)
    expect(await deliver({ _id: documentId }, { 'sanity-operation': 'delete', 'sanity-document-id': documentId }, `t=${Date.now()},v1=forged`)).toEqual({ status: 401, body: { error: 'Invalid signature' } })
    expect((await rowOf(info, documentId))[0]).toMatchObject({ active: true })
    expect(await auditRows(id)).toEqual([])
  })

  it('a signature older than 5 minutes is refused (401) and writes nothing: a captured delete can\'t be sent again later (F7)', async () => {
    const info = TYPES.find((t) => t.type === 'product') as TypeInfo
    const documentId = `w66a-old-${crypto.randomUUID()}`
    const id = await onSale(info, documentId)
    const headers = { 'sanity-operation': 'delete', 'sanity-document-id': documentId }
    const document = { _id: documentId }
    const body = JSON.stringify(document)
    const refused = { status: 401, body: { error: 'Invalid signature' } }
    const minutesAgo = (minutes: number): number => Date.now() - minutes * 60_000
    // Signed with the right secret, 5 minutes and a second ago: in milliseconds (Sanity's) and in seconds.
    expect(await deliver(document, headers, signed(body, SECRET, String(minutesAgo(5) - 1000)))).toEqual(refused)
    expect(await deliver(document, headers, signed(body, SECRET, String(Math.floor(minutesAgo(5) / 1000) - 1)))).toEqual(refused)
    // A time that isn't one, though signed.
    for (const t of ['', 'now', '-1', '1e15', '99999999999999999999']) expect(await deliver(document, headers, signed(body, SECRET, t)), t).toEqual(refused)
    // A fresh time put on an old signature: not what was signed.
    const old = signed(body, SECRET, String(minutesAgo(60)))
    expect(await deliver(document, headers, `t=${Date.now()},${old.slice(old.indexOf('v1='))}`)).toEqual(refused)
    expect((await rowOf(info, documentId))[0]).toMatchObject({ active: true })
    expect(await auditRows(id)).toEqual([])
    // Sanity's own second and third tries come within about two minutes: signed 4 minutes ago is taken.
    expect(await deliver(document, headers, signed(body, SECRET, String(minutesAgo(4))))).toEqual({ status: 200, body: { success: true } })
    expect((await rowOf(info, documentId))[0]).toMatchObject({ active: false })
    // In seconds too.
    expect(await deliver(document, headers, signed(body, SECRET, String(Math.floor(minutesAgo(1) / 1000))))).toEqual({ status: 200, body: { success: true } })
  })

  it('the signature is compared in constant time (crypto.timingSafeEqual), whatever its length (F7)', async () => {
    const info = TYPES.find((t) => t.type === 'product') as TypeInfo
    const documentId = `w66a-constant-${crypto.randomUUID()}`
    const body = JSON.stringify({ _type: 'product', _id: documentId, name: 'Soap' })
    const right = signed(body)
    const compare = vi.spyOn(nodeCrypto, 'timingSafeEqual')
    try {
      const wrong = `${right.slice(0, -1)}${right.endsWith('A') ? 'B' : 'A'}`
      const post = async (signature: string) => (await POST(new NextRequest('http://localhost/api/sanity/webhook', { method: 'POST', body, headers: { 'sanity-webhook-signature': signature } }))).status
      expect(await post(wrong)).toBe(401)
      expect(compare).toHaveBeenCalledTimes(1)
      // Shorter, longer, empty: refused, never thrown (timingSafeEqual itself throws on two lengths).
      for (const signature of [right.slice(0, -1), `${right}A`, right.replace(/v1=.*/, 'v1='), right.replace(/v1=.*/, 'v1=\u00e9')]) expect(await post(signature), signature).toBe(401)
      expect(await rowOf(info, documentId)).toEqual([])
      expect(await post(right)).toBe(200)
      expect(compare).toHaveBeenCalledTimes(2)
    } finally {
      compare.mockRestore()
    }
    expect(await rowOf(info, documentId)).toHaveLength(1)
  })

  it.each(TYPES)('$type: a delete of an item already off sale writes no update and no audit row, however often it comes (F6)', async (info) => {
    const documentId = `w66a-off-${info.type}-${crypto.randomUUID()}`
    const id = await onSale(info, documentId)
    expect(await deleted(documentId)).toEqual({ status: 200, body: { success: true } })
    const [off] = await rowOf(info, documentId)
    const rows = await auditRows(id)
    expect(rows.filter((row) => row.action === info.action)).toHaveLength(1)
    stripe.calls.length = 0
    // Delivered again, then again: the row (its updated_at too) and the audit trail as they were, nothing to Stripe.
    expect(await deleted(documentId)).toEqual({ status: 200, body: { success: true } })
    expect(await deleted(documentId)).toEqual({ status: 200, body: { success: true } })
    expect((await rowOf(info, documentId))[0]).toEqual(off)
    expect(await auditRows(id)).toEqual(rows)
    expect(stripe.calls).toEqual([])
  })

  it("a delete acts on the signed body's document alone: a header naming another is refused (400), and so is a body naming none; nothing is written, whichever of the two has the row (W70a, L1)", async () => {
    const info = TYPES.find((t) => t.type === 'product') as TypeInfo
    const signedId = `w70a-signed-${crypto.randomUUID()}`
    const headerId = `w70a-header-${crypto.randomUUID()}`
    const [signedRow, headerRow] = [await onSale(info, signedId), await onSale(info, headerId)]
    const untouched = async () => {
      expect((await rowOf(info, signedId))[0]).toMatchObject({ active: true })
      expect((await rowOf(info, headerId))[0]).toMatchObject({ active: true })
      expect([...(await auditRows(signedRow)), ...(await auditRows(headerRow))]).toEqual([])
    }
    const asDelete = (id?: string) => ({ 'sanity-operation': 'delete', ...(id === undefined ? {} : { 'sanity-document-id': id }) })
    // A request really signed for one document, with its unsigned header (or its operation) changed to take another off sale.
    expect(await deliver({ _id: signedId, _type: 'product', name: 'Soap' }, asDelete(headerId))).toEqual({ status: 400, body: { error: 'Document id mismatch' } })
    expect(await deliver({ _id: signedId }, asDelete(`drafts.${signedId}`))).toEqual({ status: 400, body: { error: 'Document id mismatch' } })
    await untouched()
    // No id in what was signed: never the header's.
    for (const document of [null, {}, { _id: '' }, { _id: 7 }, { _id: null }, { name: headerId }]) {
      expect(await deliver(document, asDelete(headerId)), JSON.stringify(document)).toEqual({ status: 400, body: { error: 'No document id in the signed body' } })
    }
    for (const body of ['null', '[]', '"text"', 'not json']) {
      const response = await POST(new NextRequest('http://localhost/api/sanity/webhook', { method: 'POST', body, headers: { 'sanity-webhook-signature': signed(body), ...asDelete(headerId) } }))
      expect([response.status, await response.json()], body).toEqual([400, { error: 'No document id in the signed body' }])
    }
    await untouched()
    // The two agree, or the header isn't there: the signed document goes off sale, the other stays.
    expect(await deliver({ _id: signedId }, asDelete())).toEqual({ status: 200, body: { success: true } })
    expect((await rowOf(info, signedId))[0]).toMatchObject({ active: false })
    expect((await rowOf(info, headerId))[0]).toMatchObject({ active: true })
    expect(await deliver({ _id: headerId }, asDelete(headerId))).toEqual({ status: 200, body: { success: true } })
    expect((await rowOf(info, headerId))[0]).toMatchObject({ active: false })
  })

  it('a type with no row here is ignored, and a delete of a document with no row writes nothing', async () => {
    expect(await published({ _type: 'blogPost', _id: `w66-blog-${crypto.randomUUID()}`, name: 'News' })).toEqual({ status: 200, body: { message: 'Non-catalog type ignored' } })
    const before = (await database.db.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_log'))[0]?.n
    expect(await deleted(`w66-nobody-${crypto.randomUUID()}`)).toEqual({ status: 200, body: { success: true } })
    expect((await database.db.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_log'))[0]?.n).toBe(before)
  })

  it('a write failing leaves nothing half written: the delete\'s audit row refused, the item stays on sale and the delivery is answered 500 (Sanity sends it again)', async () => {
    const info = TYPES.find((t) => t.type === 'giftCardType') as TypeInfo
    const documentId = `w66-fail-${crypto.randomUUID()}`
    const id = await onSale(info, documentId)
    await database.pg.exec(`
      RESET ROLE;
      CREATE FUNCTION public.w66_refuse_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit refused for the test'; END $$;
      CREATE TRIGGER w66_refuse_audit BEFORE INSERT ON public.audit_log FOR EACH ROW WHEN (NEW.actor_id = 'sanity') EXECUTE FUNCTION public.w66_refuse_audit();
      SET ROLE paddock_worker;`)
    try {
      expect(await deleted(documentId)).toEqual({ status: 500, body: { error: 'Internal server error' } })
    } finally {
      await database.pg.exec('RESET ROLE; DROP TRIGGER w66_refuse_audit ON public.audit_log; DROP FUNCTION public.w66_refuse_audit(); SET ROLE paddock_worker;')
    }
    expect((await rowOf(info, documentId))[0]).toMatchObject({ active: true })
    expect(await auditRows(id)).toEqual([])
    // Sent again: taken off sale, once.
    expect(await deleted(documentId)).toEqual({ status: 200, body: { success: true } })
    expect((await rowOf(info, documentId))[0]).toMatchObject({ active: false })
    expect(await auditRows(id)).toHaveLength(1)
  })

  it('a new document whose row is refused by the database makes nothing and is answered 500', async () => {
    const info = TYPES.find((t) => t.type === 'serviceType') as TypeInfo
    const documentId = `w66-noname-${crypto.randomUUID()}`
    // No name: the column is NOT NULL.
    expect(await deliver({ _type: 'serviceType', _id: documentId }, { 'sanity-operation': 'create' })).toEqual({ status: 500, body: { error: 'Internal server error' } })
    expect(await rowOf(info, documentId)).toEqual([])
  })
})

describe("W70a (the W70 audit's L2; H-plan 4.3): a plan deleted in Sanity that a price change kept on sale is a line on the Orders page's list", () => {
  const PLAN = TYPES.find((t) => t.type === 'membershipPlan') as TypeInfo
  const asOwner = (sql: string) => database.pg.exec(`RESET ROLE; ${sql}; SET ROLE paddock_worker;`)
  const priceChange = (id: string, state: 'started' | 'done', changeId = `change-${id}`) =>
    database.db.query(
      "INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, request_id, details) VALUES ('staff', 'jo', 'plan.price_change', 'membership_plan', $1, 'req-open', $2::jsonb)",
      [id, JSON.stringify({ changeId, planId: id, state, prices: { monthly: 45 }, membersToMove: 0, productName: 'Core' })]
    )
  /** A plan on sale, deleted in Sanity while a price change on it is open: kept on sale. */
  async function kept(name = 'Core'): Promise<{ id: string; documentId: string }> {
    const documentId = `w70a-kept-${crypto.randomUUID()}`
    expect((await published({ _type: 'membershipPlan', _id: documentId, name })).status).toBe(200)
    const id = (await rowOf(PLAN, documentId))[0]?.id as string
    await asOwner(`UPDATE membership_plans SET active = true WHERE id = '${id}'`)
    await priceChange(id, 'started')
    expect(await deleted(documentId)).toEqual({ status: 200, body: { success: true, kept: 'price_change_open' } })
    return { id, documentId }
  }
  const linesOf = async (id: string) => ((await stuckList(database.db)).plans ?? []).filter((line) => line.planId === id && line.what === 'sanity_delete')
  const refusals = async (id: string) =>
    database.db.query<{ id: string; details: Record<string, unknown>; actor_type: string; actor_id: string | null }>('SELECT id, details, actor_type, actor_id FROM audit_log WHERE entity_id = $1 AND action = $2 ORDER BY at, ctid', [id, SANITY_DELETE_REFUSED_ACTION])
  const close = (lineId: string, { email = JO, reason = 'Deleted by mistake, published again', key = crypto.randomUUID() } = {}) =>
    pressRoute<Record<string, unknown>>(closeRoute, 'POST', { email, params: {}, body: { kind: 'sanity_delete', orderId: lineId, reason }, key })
  const closeRows = (lineId: string) =>
    database.db.query<{ actor_id: string | null; entity_type: string; details: Record<string, unknown> }>("SELECT actor_id, entity_type, details FROM audit_log WHERE action = 'order.close' AND entity_id = $1", [lineId])

  it('the line names the plan and says what to do, with Mark sorted; the contract carries it; the kind is the last of the close kinds and of what a plan line is', async () => {
    const { id } = await kept('All Access')
    const [refusal] = await refusals(id)
    const lines = await linesOf(id)
    expect(lines).toEqual([
      { lineId: refusal?.id, planId: id, planName: 'All Access', what: 'sanity_delete', state: 'refused', at: expect.any(String), words: PLAN_STUCK_WORDS.sanityDeleteKept('All Access'), close: { kind: 'sanity_delete', orderId: refusal?.id } },
    ])
    expect(lines[0]?.words).toBe(
      'The plan "All Access" was deleted or unpublished in Sanity while a price change on it was still moving its members to the new price, so it stays on sale here. Nothing was changed. Once its members have moved (about 20 minutes), take it off sale on the Membership Plans page (needs the Manage pricing permission): this line then goes. If it should stay on sale, or it has been published again in Sanity, press Mark sorted (needs the Issue refunds permission).'
    )
    const parsed = stuckListOutputSchema.parse(JSON.parse(JSON.stringify(await stuckList(database.db))))
    expect(parsed.plans?.find((line) => line.planId === id)?.what).toBe('sanity_delete')
    expect(stuckCloseKindSchema.options.at(-1)).toBe('sanity_delete')
    // Still listed once the members have moved: only taking it off sale, or a person, ends it.
    await priceChange(id, 'done')
    expect(await linesOf(id)).toHaveLength(1)
  })

  it('it goes once the plan is taken off sale (a second delete from Sanity, once the change is done), and stays gone when staff put the plan back on sale', async () => {
    const { id, documentId } = await kept()
    const other = await kept('Other')
    await priceChange(id, 'done')
    expect(await deleted(documentId)).toEqual({ status: 200, body: { success: true } })
    expect((await rowOf(PLAN, documentId))[0]).toMatchObject({ active: false })
    expect(await linesOf(id)).toEqual([])
    await asOwner(`UPDATE membership_plans SET active = true WHERE id = '${id}'`)
    expect(await linesOf(id)).toEqual([])
    // A later price change, and deleted again while it is open: listed, whatever was dealt with before.
    await priceChange(id, 'started', `change-2-${id}`)
    expect(await deleted(documentId)).toEqual({ status: 200, body: { success: true, kept: 'price_change_open' } })
    expect(await linesOf(id)).toHaveLength(1)
    // A plan off sale without a row for it is not listed either, and comes back with the plan (nothing dealt with it).
    await asOwner(`UPDATE membership_plans SET active = false WHERE id = '${other.id}'`)
    expect(await linesOf(other.id)).toEqual([])
    await asOwner(`UPDATE membership_plans SET active = true WHERE id = '${other.id}'`)
    expect(await linesOf(other.id)).toHaveLength(1)
  })

  it('deleted twice while the change is open: one line, the newest refusal; the older one can\'t be closed, and closing the newest ends both', async () => {
    const { id, documentId } = await kept()
    expect(await deleted(documentId)).toEqual({ status: 200, body: { success: true, kept: 'price_change_open' } })
    const rows = await refusals(id)
    expect(rows).toHaveLength(2)
    const lines = await linesOf(id)
    expect(lines).toHaveLength(1)
    const newest = lines[0]?.lineId as string
    const older = rows.map((row) => row.id).find((one) => one !== newest) as string
    expect((await close(older)).data).toEqual({ closed: false, reason: 'not_listed', kind: 'sanity_delete', orderId: older, message: LEFT_STEP_WORDS.notListed })
    expect(await linesOf(id)).toHaveLength(1)
    expect((await close(newest)).data).toEqual({ closed: true, kind: 'sanity_delete', orderId: newest, message: 'Marked as sorted. It is no longer listed.' })
    expect(await linesOf(id)).toEqual([])
  })

  it("Mark sorted: Issue refunds and a reason; one `sorted` row and the close's own, by the person; the plan and Stripe left alone; pressed again it says so; a later delete refused is listed again", async () => {
    const { id, documentId } = await kept()
    const [line] = await linesOf(id)
    const lineId = line?.lineId as string
    const row = (await rowOf(PLAN, documentId))[0]
    stripe.calls.length = 0
    expect((await close(lineId, { email: FRAN })).error?.code).toBe('FORBIDDEN')
    expect((await close(lineId, { reason: 'no' })).error?.code).toBe('VALIDATION')
    expect(await linesOf(id)).toHaveLength(1)
    expect(await closeRows(lineId)).toEqual([])

    expect((await close(lineId)).data).toEqual({ closed: true, kind: 'sanity_delete', orderId: lineId, message: LEFT_STEP_WORDS.sorted })
    expect(await linesOf(id)).toEqual([])
    const why = 'Deleted by mistake, published again'
    expect((await refusals(id)).filter((one) => one.details['state'] === 'sorted')).toEqual([
      { id: expect.any(String), actor_type: 'staff', actor_id: jo, details: { state: 'sorted', refusalId: lineId, sanityDocumentId: documentId, byHand: { why } } },
    ])
    expect(await closeRows(lineId)).toEqual([{ actor_id: jo, entity_type: 'sanity_delete', details: { kind: 'sanity_delete', why, planId: id, sanityDocumentId: documentId } }])
    expect((await rowOf(PLAN, documentId))[0]).toEqual(row)
    expect(stripe.calls).toEqual([])

    expect((await close(lineId)).data).toEqual({ closed: true, alreadyClosed: true, kind: 'sanity_delete', orderId: lineId, message: 'Marked as sorted. It is no longer listed.' })
    expect(await closeRows(lineId)).toHaveLength(1)
    expect((await refusals(id)).filter((one) => one.details['state'] === 'sorted')).toHaveLength(1)

    // Deleted again with the change still open: a new line of its own.
    expect(await deleted(documentId)).toEqual({ status: 200, body: { success: true, kept: 'price_change_open' } })
    const again = await linesOf(id)
    expect(again).toHaveLength(1)
    expect(again[0]?.lineId).not.toBe(lineId)
  })

  it('not on the list: an id nothing has, a plan taken off sale meanwhile and a `sorted` row itself are refused with nothing written', async () => {
    const { id } = await kept()
    const [line] = await linesOf(id)
    const lineId = line?.lineId as string
    const refusedAs = (orderId: string) => ({ closed: false, reason: 'not_listed', kind: 'sanity_delete', orderId, message: LEFT_STEP_WORDS.notListed })
    const nobody = crypto.randomUUID()
    expect((await close(nobody)).data).toEqual(refusedAs(nobody))
    await asOwner(`UPDATE membership_plans SET active = false WHERE id = '${id}'`)
    expect((await close(lineId)).data).toEqual(refusedAs(lineId))
    expect(await closeRows(lineId)).toEqual([])
    await asOwner(`UPDATE membership_plans SET active = true WHERE id = '${id}'`)
    expect((await close(lineId)).data).toMatchObject({ closed: true })
    const sorted = (await refusals(id)).find((one) => one.details['state'] === 'sorted')?.id as string
    expect((await close(sorted)).data).toEqual(refusedAs(sorted))
  })

  it('a fault at the second row keeps neither (one transaction), and the line stays', async () => {
    const { id } = await kept()
    const [line] = await linesOf(id)
    const lineId = line?.lineId as string
    const by = { actor: { type: 'staff' as const, id: jo }, requestId: 'w70a-fault' }
    await expect(
      sortSanityDelete(database.db, lineId, 'why it was closed', by, () => {
        throw new Error('the close row failed')
      })
    ).rejects.toThrow('the close row failed')
    expect((await refusals(id)).filter((one) => one.details['state'] === 'sorted')).toEqual([])
    expect((await sanityDeletesListed(database.db)).map((one) => one.refusalId)).toContain(lineId)
  })
})

describe('W72a (WQ15, WQ19): the staff app\'s picture is the first PICTURE of a gallery of pictures and videos', () => {
  const OK = { status: 200, body: { success: true } }
  const PRODUCT = TYPES.find((t) => t.type === 'product') as TypeInfo
  const EVENT = TYPES.find((t) => t.type === 'event') as TypeInfo
  const GIFT_CARD = TYPES.find((t) => t.type === 'giftCardType') as TypeInfo
  const picture = async (info: TypeInfo, documentId: string) => (await rowOf(info, documentId))[0]?.thumbnail_url ?? null

  it.each([PRODUCT, EVENT])('$type: a gallery that starts with a video: the picture is the first picture after it, never the video\'s poster, nor a picture the video item still carries', async (info) => {
    const documentId = `w72a-video-first-${info.type}-${crypto.randomUUID()}`
    expect(await published({ _type: info.type, _id: documentId, name: 'Film first', gallery: [videoItem('film1'), pictureItem('second2'), pictureItem('third3')] })).toEqual(OK)
    expect(await picture(info, documentId)).toBe(thumbnailOf('second2'))
    // The Studio keeps the picture of an item someone switched from Image to Video: it is still a video.
    expect(await published({ _type: info.type, _id: documentId, name: 'Film first', gallery: [videoItem('film1', { image: pictureItem('stale9').image }), videoItem('film2'), pictureItem('third3')] })).toEqual(OK)
    expect(await picture(info, documentId)).toBe(thumbnailOf('third3'))
    // A picture first is the picture, as before.
    expect(await published({ _type: info.type, _id: documentId, name: 'Film first', gallery: [pictureItem('first1'), videoItem('film1')] })).toEqual(OK)
    expect(await picture(info, documentId)).toBe(thumbnailOf('first1'))
  })

  it.each([PRODUCT, EVENT])('$type: a gallery of videos only has no picture: answered 200, the row brought up to date with none', async (info) => {
    const documentId = `w72a-videos-only-${info.type}-${crypto.randomUUID()}`
    expect(await published({ _type: info.type, _id: documentId, name: 'Before', gallery: [pictureItem()] })).toEqual(OK)
    expect(await picture(info, documentId)).toBe(thumbnailOf())
    expect(await published({ _type: info.type, _id: documentId, name: 'Films', gallery: [videoItem('film1'), videoItem('film2', { image: pictureItem('stale9').image })] })).toEqual(OK)
    expect((await rowOf(info, documentId))[0]).toMatchObject({ name: 'Films', thumbnail_url: null })
  })

  it.each([PRODUCT, EVENT])('$type: an empty gallery, none at all, or one that is not a list of items has no picture and is never an error; the old `images` field is not read', async (info) => {
    const documentId = `w72a-empty-${info.type}-${crypto.randomUUID()}`
    const odd: unknown[] = [[], undefined, null, 'gallery', 7, {}, [null], ['x', 3], [{}], [{ kind: 'image' }], [{ kind: 'image', image: {} }], [{ kind: 'image', image: { asset: {} } }], [{ kind: 'image', image: { asset: { _ref: '' } } }]]
    for (const gallery of odd) {
      // A picture first each time, so "none" is this delivery's doing.
      expect(await published({ _type: info.type, _id: documentId, name: 'Pictured', gallery: [pictureItem()] })).toEqual(OK)
      expect(await picture(info, documentId)).toBe(thumbnailOf())
      expect(await published({ _type: info.type, _id: documentId, name: 'Bare', ...(gallery === undefined ? {} : { gallery }) }), JSON.stringify(gallery)).toEqual(OK)
      expect((await rowOf(info, documentId))[0], JSON.stringify(gallery)).toMatchObject({ name: 'Bare', thumbnail_url: null })
    }
    // Odd items are passed over on the way to a real picture; an item with no kind is a picture (the Studio's first choice).
    expect(await published({ _type: info.type, _id: documentId, name: 'Mixed', gallery: [null, { kind: 'image' }, { image: pictureItem('nokind4').image }, pictureItem('later5')] })).toEqual(OK)
    expect(await picture(info, documentId)).toBe(thumbnailOf('nokind4'))
    // `images`, as these three types had it before W72a, gives no picture.
    expect(await published({ _type: info.type, _id: documentId, name: 'Old field', images: [IMAGE] })).toEqual(OK)
    expect(await picture(info, documentId)).toBeNull()
  })

  it("the gift card's two galleries: the physical gallery's first picture; else the digital one's; none in either is no picture", async () => {
    const documentId = `w72a-gift-${crypto.randomUUID()}`
    const publish = (galleries: Record<string, unknown>) => published({ _type: 'giftCardType', _id: documentId, name: 'The Paddock Gift Card', ...galleries })
    expect(await publish({ physicalGallery: [pictureItem('card1')], digitalGallery: [pictureItem('email2')] })).toEqual(OK)
    expect(await picture(GIFT_CARD, documentId)).toBe(thumbnailOf('card1'))
    // The physical gallery's first picture, wherever it is in that gallery, before any of the digital one's.
    expect(await publish({ physicalGallery: [videoItem('film1'), pictureItem('card3')], digitalGallery: [pictureItem('email2')] })).toEqual(OK)
    expect(await picture(GIFT_CARD, documentId)).toBe(thumbnailOf('card3'))
    // No picture in the physical gallery (videos only, empty, or no such gallery): the digital one's first picture.
    for (const physical of [{ physicalGallery: [videoItem('film1', { image: pictureItem('stale9').image })] }, { physicalGallery: [] }, {}]) {
      expect(await publish({ ...physical, digitalGallery: [videoItem('film2'), pictureItem('email2'), pictureItem('email6')] })).toEqual(OK)
      expect(await picture(GIFT_CARD, documentId), JSON.stringify(Object.keys(physical))).toBe(thumbnailOf('email2'))
    }
    // The digital gallery alone is not passed over for being second.
    expect(await publish({ digitalGallery: [pictureItem('email7')] })).toEqual(OK)
    expect(await picture(GIFT_CARD, documentId)).toBe(thumbnailOf('email7'))
    // None in either, or neither there: no picture, never an error. A product's `gallery` is not a gift card's field.
    for (const galleries of [{ physicalGallery: [videoItem('film1')], digitalGallery: [videoItem('film2')] }, { physicalGallery: [], digitalGallery: [] }, {}, { gallery: [pictureItem()] }, { images: [IMAGE] }]) {
      expect(await publish({ physicalGallery: [pictureItem('card1')] })).toEqual(OK)
      expect(await publish(galleries), JSON.stringify(Object.keys(galleries))).toEqual(OK)
      expect(await picture(GIFT_CARD, documentId), JSON.stringify(Object.keys(galleries))).toBeNull()
    }
    expect(stripe.calls).toEqual([])
  })

  it.each(TYPES.filter((t) => ['serviceType', 'addon', 'membershipPlan', 'sessionPassType'].includes(t.type)))('$type keeps `images`: its first image, as before; a gallery on it is not read', async (info) => {
    const documentId = `w72a-images-${info.type}-${crypto.randomUUID()}`
    expect(await published({ _type: info.type, _id: documentId, name: 'Kept', images: [IMAGE], gallery: [pictureItem('other8')] })).toEqual(OK)
    expect(await picture(info, documentId)).toBe(thumbnailOf())
    expect(await published({ _type: info.type, _id: documentId, name: 'Kept', gallery: [pictureItem('other8')] })).toEqual(OK)
    expect(await picture(info, documentId)).toBeNull()
  })
})

describe('W72a (WQ7): a product category is a document with a row of its own; a product\'s row holds its id', () => {
  const OK = { status: 200, body: { success: true } }
  const PRODUCT = TYPES.find((t) => t.type === 'product') as TypeInfo
  const INA = 'ina.sanity@example.com'
  type CategoryRow = { sanity_category_id: string; title: string; sort_order: number | null; updated_at: string }
  const category = (id: string, fields: Record<string, unknown>) => published({ _type: 'productCategory', _id: id, ...fields })
  const categoryRow = async (id: string): Promise<CategoryRow | undefined> =>
    (await database.db.query<CategoryRow>('SELECT sanity_category_id, title, sort_order, updated_at FROM product_categories WHERE sanity_category_id = $1', [id]))[0]
  const product = (id: string, fields: Record<string, unknown>) => published({ _type: 'product', _id: id, name: 'Paddock T-Shirt', ...fields })
  const auditCount = async () => (await database.db.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_log'))[0]?.n
  /** The staff app's two reads, as an active staff member, cut down to this test's own rows (the file shares one database). */
  const listed = async (ids: readonly string[]) => {
    const answer = await pressRoute<Array<{ sanity_category_id: string; title: string; sort_order: number | null }>>(productCategoriesRoute, 'GET', { email: JO })
    expect(answer.status).toBe(200)
    expect(catalogProductCategoriesRouteOutputSchema.parse(answer.data)).toEqual(answer.data)
    return (answer.data ?? []).filter((row) => ids.includes(row.sanity_category_id))
  }
  const productsListed = async (ids: readonly string[]) => {
    // The products read's contract wants a base price, and a product new from Sanity has none until staff set it
    // (noticed in W72a's report; the check is off in production). Each is given one first, as staff would.
    await database.db.query('UPDATE products SET base_price = 10.00 WHERE base_price IS NULL')
    const answer = await pressRoute<Array<{ sanity_product_id: string | null; name: string; category: string | null }>>(productsRoute, 'GET', { email: JO })
    expect(answer.status).toBe(200)
    return (answer.data ?? []).filter((row) => ids.includes(row.sanity_product_id ?? '')).map((row) => [row.name, row.category])
  }

  beforeAll(async () => {
    await insert(database.db, 'staff', { role: 'staff', first_name: 'Ina', last_name: 'Gone', email: INA, active: false })
  })

  it("a renamed category: its one row changes, no product row is written, and the staff app's read gives the new title for the id each product holds", async () => {
    const id = `w72a-cat-${crypto.randomUUID()}`
    const productId = `w72a-tee-${crypto.randomUUID()}`
    const audited = await auditCount()
    expect(await category(id, { title: 'Apparel', slug: { _type: 'slug', current: 'apparel' }, order: 2 })).toEqual(OK)
    expect(await categoryRow(id)).toMatchObject({ sanity_category_id: id, title: 'Apparel', sort_order: 2 })
    expect(await product(productId, { category: categoryRef(id), gallery: [pictureItem()] })).toEqual(OK)
    const [before] = await rowOf(PRODUCT, productId)
    expect(before).toMatchObject({ category: id, active: false })
    expect(await listed([id])).toEqual([{ sanity_category_id: id, title: 'Apparel', sort_order: 2 }])

    expect(await category(id, { title: 'Clothing', slug: { _type: 'slug', current: 'apparel' }, order: 2 })).toEqual(OK)
    expect(await categoryRow(id)).toMatchObject({ sanity_category_id: id, title: 'Clothing', sort_order: 2 })
    // The product's row, whole: its category is still the id, and nothing on it was written (its updated_at too).
    expect((await rowOf(PRODUCT, productId))[0]).toEqual(before)
    expect(await listed([id])).toEqual([{ sanity_category_id: id, title: 'Clothing', sort_order: 2 }])
    expect(await productsListed([productId])).toEqual([['Paddock T-Shirt', id]])
    // A copy of Sanity's content: nothing sent to Stripe, no audit row.
    expect(stripe.calls).toEqual([])
    expect(await auditCount()).toBe(audited)
  })

  it("a product's category is its category document's id: a word (as before W72a) or a title is never stored where an id belongs, and leaves the row's as it is", async () => {
    const [first, second] = [`w72a-cat-${crypto.randomUUID()}`, `w72a-cat-${crypto.randomUUID()}`]
    const productId = `w72a-id-${crypto.randomUUID()}`
    const held = async () => (await rowOf(PRODUCT, productId))[0]?.category ?? null
    // A document from before W72a, published before its content move: its word is not written.
    expect(await product(productId, { category: 'apparel' })).toEqual(OK)
    expect(await held()).toBeNull()
    expect(await product(productId, { category: categoryRef(first) })).toEqual(OK)
    expect(await held()).toBe(first)
    for (const notAnId of ['Apparel', 'apparel', '', 7, true, [], {}, { _ref: '' }, { _ref: 7 }, { title: 'Apparel' }, [categoryRef(second)]]) {
      expect(await product(productId, { category: notAnId }), JSON.stringify(notAnId)).toEqual(OK)
      expect(await held(), JSON.stringify(notAnId)).toBe(first)
    }
    // Whatever else comes with a reference, only its id is kept.
    expect(await product(productId, { category: { ...categoryRef(second), title: 'Apparel', slug: { current: 'apparel' } } })).toEqual(OK)
    expect(await held()).toBe(second)
    // The field there and empty: none. The field not there: left as it is (as before).
    expect(await product(productId, {})).toEqual(OK)
    expect(await held()).toBe(second)
    expect(await product(productId, { category: null })).toEqual(OK)
    expect(await held()).toBeNull()
  })

  it('a category deleted in Sanity while a product row still names it keeps its row: nothing is written and the answer says why; once no product names it the delete goes through, and again does nothing', async () => {
    const [id, other] = [`w72a-cat-${crypto.randomUUID()}`, `w72a-cat-${crypto.randomUUID()}`]
    const [tee, cap] = [`w72a-tee-${crypto.randomUUID()}`, `w72a-cap-${crypto.randomUUID()}`]
    expect(await category(id, { title: 'Apparel', order: 1 })).toEqual(OK)
    expect(await category(other, { title: 'Accessories', order: 2 })).toEqual(OK)
    expect(await product(tee, { category: categoryRef(id) })).toEqual(OK)
    expect(await product(cap, { category: categoryRef(id) })).toEqual(OK)
    const audited = await auditCount()
    const [row, teeRow] = [await categoryRow(id), (await rowOf(PRODUCT, tee))[0]]

    // Two product rows name it (both off sale: a row names its category whether or not it is on sale).
    expect(await deleted(id)).toEqual({ status: 200, body: { success: true, kept: 'category_in_use', products: 2 } })
    expect(await categoryRow(id)).toEqual(row)
    expect((await rowOf(PRODUCT, tee))[0]).toEqual(teeRow)
    expect(await listed([id, other])).toEqual([
      { sanity_category_id: id, title: 'Apparel', sort_order: 1 },
      { sanity_category_id: other, title: 'Accessories', sort_order: 2 },
    ])
    // One moved to another category: the other still names it.
    expect(await product(tee, { category: categoryRef(other) })).toEqual(OK)
    expect(await deleted(id)).toEqual({ status: 200, body: { success: true, kept: 'category_in_use', products: 1 } })
    expect(await categoryRow(id)).toEqual(row)
    // None names it: the row goes, and only that row.
    expect(await product(cap, { category: null })).toEqual(OK)
    expect(await deleted(id)).toEqual(OK)
    expect(await categoryRow(id)).toBeUndefined()
    expect(await categoryRow(other)).toMatchObject({ title: 'Accessories' })
    expect((await rowOf(PRODUCT, tee))[0]).toMatchObject({ category: other, active: false })
    expect(await listed([id, other])).toEqual([{ sanity_category_id: other, title: 'Accessories', sort_order: 2 }])
    // Delivered again: nothing to do.
    expect(await deleted(id)).toEqual(OK)
    expect(await auditCount()).toBe(audited)
    expect(stripe.calls).toEqual([])
  })

  it('the same new category delivered twice makes one row; a draft writes nothing; one with no title is refused by the database (500, nothing written)', async () => {
    const id = `w72a-cat-${crypto.randomUUID()}`
    expect(await category(id, { title: 'Books', order: 3 })).toEqual(OK)
    expect(await category(id, { title: 'Books', order: 3 })).toEqual(OK)
    expect(await database.db.query('SELECT title FROM product_categories WHERE sanity_category_id = $1', [id])).toEqual([{ title: 'Books' }])
    const draft = `w72a-cat-${crypto.randomUUID()}`
    expect(await category(`drafts.${draft}`, { title: 'Draft', order: 1 })).toEqual({ status: 200, body: { message: 'Draft ignored' } })
    expect(await categoryRow(draft)).toBeUndefined()
    expect(await categoryRow(`drafts.${draft}`)).toBeUndefined()
    expect(await deleted(`drafts.${id}`)).toEqual({ status: 200, body: { message: 'Draft delete ignored' } })
    expect(await categoryRow(id)).toMatchObject({ title: 'Books' })
    const untitled = `w72a-cat-${crypto.randomUUID()}`
    expect(await category(untitled, { order: 1 })).toEqual({ status: 500, body: { error: 'Internal server error' } })
    expect(await categoryRow(untitled)).toBeUndefined()
    // A bad signature writes no category either.
    const body = JSON.stringify({ _type: 'productCategory', _id: untitled, title: 'Forged' })
    expect(await deliver({ _type: 'productCategory', _id: untitled, title: 'Forged' }, { 'sanity-operation': 'create' }, signed(body, 'not-the-secret'))).toEqual({ status: 401, body: { error: 'Invalid signature' } })
    expect(await categoryRow(untitled)).toBeUndefined()
  })

  it("a category's order is a whole number, or none; the staff app's list is in that order then by title, those with none last, and the products read follows it (a product with no category's row comes last)", async () => {
    const id = `w72a-cat-${crypto.randomUUID()}`
    for (const order of [undefined, null, 1.5, '4', Number.NaN, 3_000_000_000, -3_000_000_000, {}]) {
      expect(await category(id, { title: 'Order', order: 5 })).toEqual(OK)
      expect(await category(id, { title: 'Order', ...(order === undefined ? {} : { order }) }), String(order)).toEqual(OK)
      expect((await categoryRow(id))?.sort_order, String(order)).toBeNull()
    }
    for (const order of [0, -2, 12]) {
      expect(await category(id, { title: 'Order', order })).toEqual(OK)
      expect((await categoryRow(id))?.sort_order).toBe(order)
    }

    const tag = crypto.randomUUID()
    const [beta, alpha, second, last, lastToo] = ['beta', 'alpha', 'second', 'last', 'last-too'].map((name) => `w72a-order-${name}-${tag}`) as [string, string, string, string, string]
    expect(await category(beta, { title: 'Beta', order: 1 })).toEqual(OK)
    expect(await category(second, { title: 'Aardvark', order: 2 })).toEqual(OK)
    expect(await category(last, { title: 'Aaa no order' })).toEqual(OK)
    expect(await category(lastToo, { title: 'Aab no order', order: null })).toEqual(OK)
    expect(await category(alpha, { title: 'Alpha', order: 1 })).toEqual(OK)
    expect((await listed([beta, alpha, second, last, lastToo])).map((row) => row.title)).toEqual(['Alpha', 'Beta', 'Aardvark', 'Aaa no order', 'Aab no order'])

    const names = ['in-second-a', 'in-alpha-z', 'in-alpha-b', 'none', 'word', 'not-arrived', 'in-last'] as const
    const ids = Object.fromEntries(names.map((name) => [name, `w72a-product-${name}-${tag}`])) as Record<(typeof names)[number], string>
    const notArrived = `w72a-order-not-arrived-${tag}`
    await published({ _type: 'product', _id: ids['in-second-a'], name: 'A in the second category', category: categoryRef(second) })
    await published({ _type: 'product', _id: ids['in-alpha-z'], name: 'Z in Alpha', category: categoryRef(alpha) })
    await published({ _type: 'product', _id: ids['in-alpha-b'], name: 'B in Alpha', category: categoryRef(alpha) })
    await published({ _type: 'product', _id: ids['none'], name: 'AA with no category' })
    await published({ _type: 'product', _id: ids['word'], name: 'AB with a word from before' })
    await database.db.query("UPDATE products SET category = 'apparel' WHERE sanity_product_id = $1", [ids['word']])
    await published({ _type: 'product', _id: ids['not-arrived'], name: 'AC whose category has not arrived', category: categoryRef(notArrived) })
    await published({ _type: 'product', _id: ids['in-last'], name: 'AD in a category with no order', category: categoryRef(last) })
    expect(await productsListed(Object.values(ids))).toEqual([
      ['B in Alpha', alpha],
      ['Z in Alpha', alpha],
      ['A in the second category', second],
      ['AD in a category with no order', last],
      ['AB with a word from before', 'apparel'],
      ['AC whose category has not arrived', notArrived],
      ['AA with no category', null],
    ])
  })

  it("the staff app's own getProductCategories, through the real route: after a rename it answers the new title, for the id the product's row still holds", async () => {
    const id = `w72a-cat-${crypto.randomUUID()}`
    const productId = `w72a-tee-${crypto.randomUUID()}`
    expect(await category(id, { title: 'Apparel', order: 1 })).toEqual(OK)
    expect(await product(productId, { category: categoryRef(id) })).toEqual(OK)
    expect(await category(id, { title: 'Clothing', order: 1 })).toEqual(OK)
    vi.stubGlobal('paddockWorkerV1', { rawRequest: bindStaffRoutes(database.db) })
    try {
      const getProductCategories = (await import(/* @vite-ignore */ path.join(staffAppDir(), 'backend/paddock/getProductCategories.ts'))).default as (req: { user: { email: string } }) => Promise<Array<{ sanity_category_id: string; title: string; sort_order: number | null }>>
      const rows = await getProductCategories({ user: { email: JO } })
      expect(rows.filter((row) => row.sanity_category_id === id)).toEqual([{ sanity_category_id: id, title: 'Clothing', sort_order: 1 }])
      expect((await rowOf(PRODUCT, productId))[0]?.category).toBe(id)
      // An inactive account is refused in the Worker's words, as every catalogue read refuses it.
      await expect(getProductCategories({ user: { email: INA } })).rejects.toThrow('This staff account is inactive. Ask an admin to reactivate it.')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('the categories read: any active staff member; an inactive account and a sign-in with no staff row are refused', async () => {
    expect((await pressRoute(productCategoriesRoute, 'GET', { email: FRAN })).ok).toBe(true)
    const inactive = await pressRoute(productCategoriesRoute, 'GET', { email: INA })
    expect([inactive.ok, inactive.data, inactive.error?.code]).toEqual([false, undefined, 'FORBIDDEN'])
    const nobody = await pressRoute(productCategoriesRoute, 'GET', { email: 'nobody.sanity@example.com' })
    expect([nobody.ok, nobody.data, nobody.error?.code]).toEqual([false, undefined, 'UNAUTHORISED'])
    expect((await pressRoute(productCategoriesRoute, 'GET', { email: JO, bearer: 'not-the-key' })).ok).toBe(false)
  })
})
