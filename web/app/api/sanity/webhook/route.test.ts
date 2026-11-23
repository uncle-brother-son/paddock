import { createHash, createHmac } from 'node:crypto'
import { NextRequest } from 'next/server'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Db } from '@/server/db'
import { SANITY_DELETE_REFUSED_ACTION } from '@/server/rules/catalog/sanity-sync'
import { startTestDatabase, type TestDatabase } from '@/server/rules/testing/database'
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
let database: TestDatabase
let stripe: FakeStripe

beforeAll(async () => {
  vi.stubEnv('SANITY_WEBHOOK_SECRET', SECRET)
  database = await startTestDatabase({ schema: 'live' })
  holder.db = database.db
})
afterAll(async () => {
  vi.unstubAllEnvs()
  await database.stop()
})
beforeEach(() => {
  stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
  holder.stripe = stripe
})

/** Sanity's signature: `t=<time>,v1=<base64url HMAC-SHA256 of "<time>.<body>">`, as the route checks it. */
function signed(body: string, secret = SECRET): string {
  const t = String(Math.floor(Date.now() / 1000))
  const hash = createHmac('sha256', secret).update(`${t}.${body}`).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `t=${t},v1=${hash}`
}

async function deliver(document: Record<string, unknown> | null, headers: Record<string, string> = {}, signature?: string): Promise<{ status: number; body: unknown }> {
  const body = document === null ? '' : JSON.stringify(document)
  const response = await POST(new NextRequest('http://localhost/api/sanity/webhook', { method: 'POST', body, headers: { 'sanity-webhook-signature': signature ?? signed(body), ...headers } }))
  return { status: response.status, body: await response.json() }
}
const published = (document: Record<string, unknown>) => deliver(document, { 'sanity-operation': 'update' })
const deleted = (documentId: string) => deliver(null, { 'sanity-operation': 'delete', 'sanity-document-id': documentId })

const IMAGE = { asset: { _ref: 'image-abc123-800x600-jpg' } }

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

// The table and column are literals from TYPES, never from a request.
const rowOf = async (info: TypeInfo, documentId: string) =>
  (await database.db.query<{ id: string; name: string; thumbnail_url: string | null; active: boolean; stripe_product_id?: string | null; category?: string | null }>(`SELECT * FROM ${info.table} WHERE ${info.column} = $1`, [documentId]))
const auditRows = (entityId: string) =>
  database.db.query<{ actor_type: string; actor_id: string | null; action: string; details: Record<string, unknown> }>('SELECT actor_type, actor_id, action, details FROM audit_log WHERE entity_id = $1 ORDER BY at, id', [entityId])

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
    expect(await published({ _type: info.type, _id: documentId, name: 'New thing', images: [IMAGE] })).toEqual({ status: 200, body: { success: true } })
    const rows = await rowOf(info, documentId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ name: 'New thing', active: false })
    expect(rows[0]?.thumbnail_url).toMatch(/^https:\/\/cdn\.sanity\.io\/images\/w66test\/production\/abc123-800x600\.jpg\?w=80$/)
    if (info.type === 'membershipPlan') {
      // As before: a new plan gets its Stripe product, under a key from the plan's id.
      expect(stripe.calls.map((call) => [call.method, call.idempotencyKey])).toEqual([['products.create', `${rows[0]?.id}:sanity-plan-product`]])
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
    expect(await published({ _type: info.type, _id: documentId, name: 'After', images: [IMAGE] })).toEqual({ status: 200, body: { success: true } })
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

  it('product and add-on: the category is set when the document has the field, and left as it is when it has none; a new one with a category arrives off sale too', async () => {
    for (const info of TYPES.filter((t) => t.type === 'product' || t.type === 'addon')) {
      const documentId = `w66-cat-${info.type}-${crypto.randomUUID()}`
      await published({ _type: info.type, _id: documentId, name: 'Soap', category: 'Wellbeing' })
      // The row made by the statement that carries the category (the per-type test above makes it without one): off sale (Q57).
      expect((await rowOf(info, documentId))[0]).toMatchObject({ category: 'Wellbeing', active: false })
      await published({ _type: info.type, _id: documentId, name: 'Soap bar' })
      expect((await rowOf(info, documentId))[0]).toMatchObject({ name: 'Soap bar', category: 'Wellbeing' })
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
    expect(await deliver(null, { 'sanity-operation': 'delete', 'sanity-document-id': documentId }, 't=1,v1=forged')).toEqual({ status: 401, body: { error: 'Invalid signature' } })
    expect((await rowOf(info, documentId))[0]).toMatchObject({ active: true })
    expect(await auditRows(id)).toEqual([])
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

/** The route's fingerprint of an extra waiver: the first 12 hex characters of its trimmed text's SHA-256. */
const createHashOf = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 12)
