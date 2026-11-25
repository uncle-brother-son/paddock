import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  backendWithoutMoney,
  changedWebhookFields,
  filesToLint,
  MONEY_WORDS,
  pickLevel,
  SHOP_AMOUNT_FILE,
  SHOP_AMOUNT_RULE,
  SHOP_READ_PATHS,
  SHOP_READER,
  storiesFor,
  unitTestsToRun,
  WEBHOOK_BLOCKS,
  WEBHOOK_FIELDS,
  webhookFieldsIn,
} from './check-fast-level.mjs'

// Brief W72, item 1 (WQ29): how `npm run check:fast` picks the test level. W73, item 8 (WQ30): Level 1b. WQ45: the
// shop's reads are Level 1b by name, and the one website file that imports them is Level 2.

const WEB = path.resolve(__dirname, '..')
const SCHEMAS = path.resolve(WEB, '../studio/schemaTypes')

const changed = (file: string, before: string | null = 'const a = 1\n', after: string | null = 'const a = 2\n') => ({ file, before, after })
const levelOf = (...changes: ReturnType<typeof changed>[]) => pickLevel(changes).level

describe('the level', () => {
  it('nothing changed: none', () => {
    expect(pickLevel([])).toEqual({ level: 0, reasons: [] })
  })

  it.each([
    'web/server/rules/pricing/seats.ts',
    'web/server/rules/pricing/seats.test.ts',
    'web/server/rules/README.md',
    'web/contracts/admin.ts',
    'supabase/migrations/033_money_columns_numeric_10_2.sql',
    'supabase/README.md',
    'web/app/api/v1/staff/orders/route.ts',
    'web/app/api/stripe/webhook/route.ts',
    'web/custom-worker.ts',
    'web/wrangler.jsonc',
    'web/package-lock.json',
  ])('%s is Level 1, alone or among website files', (file) => {
    expect(levelOf(changed(file))).toBe(1)
    const { level, reasons } = pickLevel([changed('web/components/Header.tsx'), changed(file), changed('studio/structure.ts')])
    expect(level).toBe(1)
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toContain(file)
  })

  // W73, item 8 (WQ30): backend that does not touch money has a level of its own, between the two.
  describe('Level 1b: backend that does not touch money (WQ30)', () => {
    const reads = "export const GET = defineRoute({ access: 'public' }, async () => listCategories())\n"
    const migration = 'create table product_categories (id text primary key, title text not null);\n'

    it.each([
      ['the Sanity webhook', changed('web/app/api/sanity/webhook/route.ts')],
      ["the webhook's test", changed('web/app/api/sanity/webhook/route.test.ts')],
      ['what the webhook writes', changed('web/server/rules/catalog/sanity-sync.ts')],
      ['a migration that names no money', changed('supabase/migrations/035_product_categories.sql', null, migration)],
      ['a route that only reads', changed('web/app/api/v1/public/categories/route.ts', null, reads)],
      ["a read-only route's test", changed('web/app/api/v1/public/categories/route.test.ts', null, "it('lists them', async () => { await GET(request()) })\n")],
    ])('%s is Level 1b, alone or among website files', (_what, change) => {
      expect(levelOf(change)).toBe('1b')
      const { level, reasons } = pickLevel([changed('web/components/Header.tsx'), change, changed('studio/structure.ts')])
      expect(level).toBe('1b')
      expect(reasons).toHaveLength(1)
      expect(reasons[0]).toContain(change.file)
    })

    it('money beside it makes the whole change Level 1, and only the money files are the reasons', () => {
      const { level, reasons } = pickLevel([changed('web/app/api/sanity/webhook/route.ts'), changed('web/server/rules/refunds/claims.ts'), changed('web/components/Header.tsx')])
      expect(level).toBe(1)
      expect(reasons).toEqual(['web/server/rules/refunds/claims.ts (web/server/ is backend or money code)'])
    })

    it.each([
      ['a price column', 'alter table products add column sale_price numeric(10,2);'],
      ['an order', 'create index on orders (customer_id);'],
      ['a booking', 'alter table bookings add column note text;'],
      ['a membership', "update memberships set status = 'ended' where id = $1;"],
      ['store credit', 'select store_credit_balance from customers;'],
      ['a gift card', 'alter table gift_cards add column sent_at timestamptz;'],
      ['a session pass', 'alter table session_pass_types add column level text;'],
      ['Stripe', '-- the stripe_customer_id column'],
    ])('a migration that names %s is Level 1', (_what, sql) => {
      expect(levelOf(changed('supabase/migrations/036_x.sql', null, `${migration}${sql}\n`))).toBe(1)
    })

    it('a migration cannot leave Level 1 by losing the word, and one that cannot be read is Level 1', () => {
      expect(levelOf(changed('supabase/migrations/036_x.sql', 'alter table orders add column note text;', migration))).toBe(1)
      expect(levelOf(changed('supabase/migrations/036_x.sql', migration, null))).toBe('1b')
      expect(levelOf(changed('supabase/migrations/036_x.sql', null, null))).toBe(1)
      // Money in its name counts too.
      expect(levelOf(changed('supabase/migrations/036_refund_owed.sql', null, migration))).toBe(1)
    })

    it.each([
      ['it writes', 'web/app/api/v1/staff/categories/route.ts', `${reads}export const POST = defineRoute({ access: 'staff' }, async () => addCategory())\n`],
      ['it names a price', 'web/app/api/v1/public/products/route.ts', "export const GET = defineRoute({ access: 'public' }, async () => productsWithPrices())\n"],
      ['its address is about orders', 'web/app/api/v1/staff/orders/stuck/route.ts', reads],
      ['its address is about bookings', 'web/app/api/v1/customer/bookings/route.ts', reads],
    ])('a route is Level 1 when %s', (_what, file, source) => {
      expect(levelOf(changed(file, null, source))).toBe(1)
      expect(levelOf(changed(file, source, reads))).toBe(1)
    })

    it("only those three kinds of file (and the shop's reads, by name: below): any other backend file is Level 1 whatever it says", () => {
      for (const file of ['web/server/rules/catalog/items.ts', 'web/server/scheduled.ts', 'web/contracts/categories.ts', 'web/app/api/v1/define-route.ts', 'supabase/config.toml', 'web/custom-worker.ts']) {
        expect(backendWithoutMoney(changed(file, null, 'export const a = 1\n')), file).toBeNull()
        expect(levelOf(changed(file, null, 'export const a = 1\n')), file).toBe(1)
      }
    })

    it('the money words catch the money tables and leave content alone', () => {
      for (const word of ['orders', 'order_items', 'bookings', 'event_bookings', 'memberships', 'refund_owed_amount', 'store_credit_balance', 'gift_cards', 'session_pass_types', 'base_price', 'stripe_payment_intent_id', 'promo_codes']) {
        expect(MONEY_WORDS.test(word), word).toBe(true)
      }
      for (const word of ['product_categories', 'title', 'sanity_id', 'images', 'password', 'compass', 'slug']) expect(MONEY_WORDS.test(word), word).toBe(false)
    })
  })

  // W74a, WQ45 (Wayne, 24 Nov): the shop's reads are Level 1b by name, and the one website file that imports them is
  // Level 2. Money paths stay Level 1.
  describe("the shop's reads (WQ45)", () => {
    const REPO = path.resolve(WEB, '..')
    const asItIs = (file: string) => changed(file, null, readFileSync(path.join(REPO, file), 'utf8'))
    /** W74a; W75a; W77a, the booking panel's three. */
    const SHOP_ROUTES = ['availability', 'booking-days', 'booking-quote', 'event-availability', 'sessions']
    const rule = 'export const sizePrices = (variant) => ({ price: variantPriceFor(variant, false) })\n'

    it('the list is the rules, their contract, the public routes and the test that lists the public routes', () => {
      expect(SHOP_READ_PATHS).toEqual(['web/server/rules/shop/', 'web/contracts/shop.ts', ...SHOP_ROUTES.map((route) => `web/app/api/v1/shop/${route}/`), 'web/server/api-allowlist.test.ts'])
      expect(SHOP_READER).toBe('web/lib/shop/read.ts')
    })

    it.each([
      ['a rule that reads the shop, though it names prices', changed('web/server/rules/shop/display-prices.ts', null, rule)],
      ["the shop's read", changed('web/server/rules/shop/reads.ts', 'export const a = 1\n', "const SQL = 'SELECT c.title FROM product_categories c'\n")],
      ["a rule's test, which sets its own rows up", changed('web/server/rules/shop/shop.test.ts', null, "await db.query('UPDATE product_variants SET stock_quantity = 0 WHERE product_id = $1::uuid', [id])\n")],
      ['its words', changed('web/server/rules/shop/failure-messages.ts')],
      ['its contract', changed('web/contracts/shop.ts', null, 'export const shopSizeSchema = z.strictObject({ price: money })\n')],
      ['the availability route', changed('web/app/api/v1/shop/availability/route.ts', null, "export const GET = defineRoute({ auth: 'public' }, async ({ input }) => shopAvailability(db, input.product))\n")],
      ["the events' read (W75a)", changed('web/server/rules/shop/events.ts', null, "const SQL = 'SELECT q.unit_price FROM quote_event(e.id, NULL, 1, false, NULL) q'\n")],
      ["the events' route (W75a)", changed('web/app/api/v1/shop/event-availability/route.ts', null, "export const GET = defineRoute({ auth: 'public' }, async ({ input }) => shopEventAvailability(db, input.event))\n")],
      ["the booking panel's rule and reads (W77a)", changed('web/server/rules/shop/booking.ts', null, "const SQL = 'SELECT s.id FROM sessions s WHERE NOT EXISTS (SELECT 1 FROM bookings b WHERE b.session_id <> s.id)'\n")],
      ["its days' route (W77a)", changed('web/app/api/v1/shop/booking-days/route.ts', null, "export const GET = defineRoute({ auth: 'public' }, async ({ input }) => shopBookingDays(db, input.month))\n")],
      ["its sessions' route (W77a)", changed('web/app/api/v1/shop/sessions/route.ts', null, "export const GET = defineRoute({ auth: 'public' }, async ({ input }) => shopSessions(db, input.date))\n")],
      ["its quote's route (W77a)", changed('web/app/api/v1/shop/booking-quote/route.ts', null, "export const GET = defineRoute({ auth: 'public' }, async ({ input }) => shopBookingQuote(db, input.session, 1))\n")],
      ["the route's test", changed('web/app/api/v1/shop/availability/route.test.ts', null, "it('refuses a POST', async () => {})\n")],
      ['the test that lists the public routes', changed('web/server/api-allowlist.test.ts')],
    ])('%s is Level 1b, alone or among website files', (_what, change) => {
      expect(levelOf(change)).toBe('1b')
      const { level, reasons } = pickLevel([changed('web/components/shop/ProductCard.tsx'), change, changed('studio/structure.ts')])
      expect(level).toBe('1b')
      expect(reasons).toEqual([`${change.file} (the shop's reads: they show prices, sizes and spaces, and never write or move money)`])
    })

    it("every file of the shop's reads in the repo today is Level 1b as it is", () => {
      const files = [
        ...readdirSync(path.join(WEB, 'server/rules/shop')).map((name) => `web/server/rules/shop/${name}`),
        ...SHOP_ROUTES.flatMap((route) => readdirSync(path.join(WEB, 'app/api/v1/shop', route)).map((name) => `web/app/api/v1/shop/${route}/${name}`)),
        'web/contracts/shop.ts',
        'web/server/api-allowlist.test.ts',
      ]
      expect(files.length).toBeGreaterThanOrEqual(12)
      for (const file of files) expect(levelOf(asItIs(file)), file).toBe('1b')
    })

    it('one of them that starts to write is no longer a read: Level 1, and it cannot leave by losing the statement', () => {
      const insert = "await db.query('INSERT INTO shop_views (product) VALUES ($1)', [id])\n"
      for (const sql of [insert, "await db.query('UPDATE products SET active = false WHERE id = $1', [id])\n", "await db.query('DELETE FROM product_variants WHERE id = $1', [id])\n"]) {
        expect(levelOf(changed('web/server/rules/shop/reads.ts', rule, sql)), sql).toBe(1)
      }
      expect(levelOf(changed('web/server/rules/shop/reads.ts', insert, rule))).toBe(1)
      // Each route takes GET alone.
      const post = "export const POST = defineRoute({ auth: 'public' }, async () => addToBag())\n"
      for (const route of SHOP_ROUTES.map((name) => `web/app/api/v1/shop/${name}/route.ts`)) {
        expect(levelOf(changed(route, null, post)), route).toBe(1)
        expect(levelOf(changed(route, post, 'export const GET = 1\n')), route).toBe(1)
      }
    })

    it('money stays Level 1: the rules beside them, the other contracts, any other shop route, and money beside a read', () => {
      for (const file of [
        'web/server/rules/orders/catalog-price.ts',
        'web/server/rules/catalog/items.ts',
        'web/server/rules/shopfront/reads.ts',
        'web/server/rules/shop.ts',
        'web/contracts/index.ts',
        'web/contracts/shop-orders.ts',
        'web/server/api-allowlist.ts',
        'web/server/rules/README.md',
      ]) {
        expect(levelOf(changed(file, null, 'export const a = 1\n')), file).toBe(1)
      }
      expect(levelOf(changed('web/app/api/v1/shop/checkout/route.ts', null, "export const POST = defineRoute({ auth: 'public' }, async () => pay())\n"))).toBe(1)
      expect(levelOf(changed('web/app/api/v1/shop/basket/route.ts', null, "export const GET = defineRoute({ auth: 'public' }, async () => basketPrices())\n"))).toBe(1)
      const { level, reasons } = pickLevel([changed('web/server/rules/shop/reads.ts'), changed('web/server/rules/orders/catalog-price.ts'), changed('web/lib/shop/read.ts')])
      expect(level).toBe(1)
      expect(reasons).toEqual(['web/server/rules/orders/catalog-price.ts (web/server/ is backend or money code)'])
    })

    const reads = "import { readShop, type Shop } from '@/server/rules/shop/reads'\n"

    it('the one website file that reads the shop is Level 2, as it is today and whichever of the shop\'s reads it imports', () => {
      expect(levelOf(asItIs(SHOP_READER))).toBe(2)
      expect(readFileSync(path.join(REPO, SHOP_READER), 'utf8')).toContain("from '@/server/rules/shop/reads'")
      expect(levelOf(changed(SHOP_READER, null, reads))).toBe(2)
      expect(levelOf(changed(SHOP_READER, reads, `${reads}export type { ShopSize } from '@/server/rules/shop/display-prices'\n`))).toBe(2)
      // With the pages built on it, the whole change is Level 2.
      expect(pickLevel([changed(SHOP_READER, null, reads), changed('web/app/shop/page.tsx'), changed('web/components/shop/ProductCard.tsx')])).toEqual({ level: 2, reasons: [] })
    })

    it('anything else it imports from server code, or Stripe, is Level 1, whether it gains it or loses it', () => {
      for (const line of ["import { variantPriceFor } from '@/server/rules/orders/catalog-price'", "import { openRequestDb } from '@/server/db/connection'", "import { shop } from '@/server/rules/shop'", "import Stripe from 'stripe'", "import { readShop } from '../../server/rules/shop/reads'"]) {
        expect(levelOf(changed(SHOP_READER, reads, `${reads}${line}\n`)), line).toBe(1)
        expect(levelOf(changed(SHOP_READER, `${reads}${line}\n`, reads)), line).toBe(1)
      }
    })

    // W76a (Wayne, 25 Nov): the Other rule runs in the browser, so one more file may import it, and only it.
    it('the file that brings the Other rule to the page is Level 2, as it is today', () => {
      expect([SHOP_AMOUNT_FILE, SHOP_AMOUNT_RULE]).toEqual(['web/lib/shop/gift-card-amount.ts', '@/server/rules/shop/gift-card-amount'])
      const own = readFileSync(path.join(REPO, SHOP_AMOUNT_FILE), 'utf8')
      expect([...own.matchAll(/from '([^']+)'/g)].map(([, name]) => name)).toEqual([SHOP_AMOUNT_RULE])
      expect(levelOf(asItIs(SHOP_AMOUNT_FILE))).toBe(2)
      expect(pickLevel([asItIs(SHOP_AMOUNT_FILE), changed('web/components/shop/GiftCardBuy.tsx', null, "import { checkOtherAmount } from '@/lib/shop/gift-card-amount'\n")])).toEqual({ level: 2, reasons: [] })
      // The rule itself stays Level 1b.
      expect(levelOf(changed('web/server/rules/shop/gift-card-amount.ts'))).toBe('1b')
    })

    it('anything else that file imports from server code, or Stripe, is Level 1, gained or lost; and no other file may import the rule', () => {
      const own = `export { checkOtherAmount } from '${SHOP_AMOUNT_RULE}'\n`
      for (const name of ['@/server/rules/shop/reads', '@/server/rules/shop/gift-card-amounts', '@/server/rules/shop/gift-card-amount/x', '@/server/rules/shop/failure-messages', '@/server/rules/orders/price-basket', '@/server/db', '../../server/rules/shop/gift-card-amount', 'stripe']) {
        expect(levelOf(changed(SHOP_AMOUNT_FILE, own, `${own}import { x } from '${name}'\n`)), name).toBe(1)
        expect(levelOf(changed(SHOP_AMOUNT_FILE, `${own}import { x } from '${name}'\n`, own)), name).toBe(1)
      }
      for (const file of ['web/components/shop/GiftCardBuy.tsx', 'web/app/shop/gift-card/page.tsx', 'web/lib/shop/gift-card-amount.tsx', 'web/lib/shop/pages.ts']) {
        expect(pickLevel([changed(file, null, own)]), file).toEqual({ level: 1, reasons: [`${file} (it uses Stripe or server code)`] })
      }
    })

    it("no other website file may import the shop's reads: a page, a component or another file of lib/shop is Level 1", () => {
      for (const file of ['web/app/shop/page.tsx', 'web/components/shop/ProductCard.tsx', 'web/lib/shop/pages.ts', 'web/lib/shop/read.tsx', 'web/lib/shop/read/index.ts']) {
        const { level, reasons } = pickLevel([changed(file, null, reads)])
        expect(level, file).toBe(1)
        expect(reasons).toEqual([`${file} (it uses Stripe or server code)`])
      }
    })
  })

  it('a removed or a new backend file is Level 1 too', () => {
    expect(levelOf(changed('web/server/x.ts', 'const a = 1', null))).toBe(1)
    expect(levelOf(changed('web/server/x.ts', null, 'const a = 1'))).toBe(1)
  })

  it.each([
    'web/components/layout/Grid.tsx',
    'web/app/globals.css',
    'web/app/page.tsx',
    'web/app/fonts/GT-Sectra-Fine-Regular.woff2',
    'web/middleware.ts',
    'web/lib/supabase/middleware.test.ts',
    'web/lib/sanity/queries.ts',
    'web/scripts/check-fast.mjs',
    'web/CLAUDE.md',
    'studio/structure.ts',
    'studio/lib/checks.ts',
    'WEBHOOK-SETUP.md',
  ])('%s is Level 2', (file) => {
    expect(levelOf(changed(file))).toBe(2)
  })

  it.each(["import Stripe from 'stripe'", "import { loadStripe } from '@stripe/stripe-js'", "import { quote } from '@/server/rules/quote'", "import { quote } from '../../server/rules/quote'", "const s = await import('stripe')"])(
    'a website file with %s is Level 1, whether it gains it or loses it',
    (line) => {
      expect(levelOf(changed('web/components/Pay.tsx', 'x', `${line}\n`))).toBe(1)
      expect(levelOf(changed('web/components/Pay.tsx', `${line}\n`, 'x'))).toBe(1)
      expect(levelOf(changed('web/lib/pay.test.ts', 'x', `${line}\n`))).toBe(2)
    },
  )

  it('package.json: a script is Level 2, a package is Level 1', () => {
    const before = JSON.stringify({ scripts: { a: '1' }, dependencies: { next: '16.4.5' } })
    expect(levelOf(changed('web/package.json', before, JSON.stringify({ scripts: { a: '2', b: '1' }, dependencies: { next: '16.4.5' } })))).toBe(2)
    expect(levelOf(changed('web/package.json', before, JSON.stringify({ scripts: { a: '1' }, dependencies: { next: '16.4.6' } })))).toBe(1)
    expect(levelOf(changed('web/package.json', before, JSON.stringify({ scripts: { a: '1' }, dependencies: { next: '16.4.5' }, devDependencies: { x: '1' } })))).toBe(1)
  })
})

describe("the Studio fields the Worker's Sanity webhook reads", () => {
  const schema = (fields: string, type = 'product') => `import { defineType, defineField } from 'sanity'\nexport const x = defineType({ name: '${type}', type: 'document', fields: [${fields}] })\n`
  const name = "defineField({ name: 'name', type: 'string' })"
  // W72a: a product's pictures are its gallery (of the media block), and its category a reference.
  const images = "defineField({ name: 'gallery', type: 'array', of: [{ type: 'media' }] })"
  const category = "defineField({ name: 'category', type: 'reference', to: [{ type: 'productCategory' }] })"
  const product = schema(`${name}, ${category}, ${images}`)

  it('another field added, changed or moved about is Level 2', () => {
    const after = schema(`defineField({ name: 'slug', type: 'slug' }), // a note\n ${name},\n\n ${category}, /* why */ ${images}, previousSlugs, defineField({ name: 'images', type: 'array' }), defineField({ name: 'seo', type: 'seo' })`)
    expect(changedWebhookFields(product, after)).toEqual([])
    expect(levelOf(changed('studio/schemaTypes/product.ts', product, after))).toBe(2)
  })

  it.each([
    ['its type', schema(`${name}, ${category}, defineField({ name: 'gallery', type: 'array', of: [{ type: 'image' }] })`), ['product.gallery']],
    ['its name', schema(`${name}, defineField({ name: 'categories', type: 'string' }), ${images}`), ['product.category']],
    ['a reference made a word', schema(`${name}, defineField({ name: 'category', type: 'string' }), ${images}`), ['product.category']],
    ['taken out', schema(`${category}, ${images}`), ['product.name']],
    ['made elsewhere', schema(`${name}, category, ${images}`), ['product.category']],
    ["the document's own name", schema(`${name}, ${category}, ${images}`, 'shopProduct'), ['product', 'product.category', 'product.gallery', 'product.name']],
    ['the document made another kind of thing', schema(`${name}, ${category}, ${images}`).replace("type: 'document'", "type: 'object'"), ['product']],
  ])('a webhook field changed (%s) is Level 1', (_what, after, fields) => {
    expect(changedWebhookFields(product, after)).toEqual(fields)
    expect(levelOf(changed('studio/schemaTypes/product.ts', product, after))).toBe(1)
  })

  it('its file removed or new is Level 1; a type the webhook never reads is Level 2', () => {
    expect(levelOf(changed('studio/schemaTypes/product.ts', product, null))).toBe(1)
    expect(levelOf(changed('studio/schemaTypes/product.ts', null, product))).toBe(1)
    expect(levelOf(changed('studio/schemaTypes/contentPage.ts', null, schema(name, 'contentPage')))).toBe(2)
    expect(levelOf(changed('studio/schemaTypes/page.ts', schema(name, 'page'), null))).toBe(2)
  })

  // W72a (W72's report, "For the lead" 1): the check compares a field's own code, so the blocks a gallery is made of
  // are held too: a gallery's item (its kind and its picture) and the picture (an image, with its file).
  describe('the blocks a gallery is made of', () => {
    const block = (name: string, own: string, fields: string) => `import { defineType, defineField } from 'sanity'\nexport const x = defineType({ name: '${name}', ${own}, fields: [${fields}] })\n`
    const kind = "defineField({ name: 'kind', type: 'string', options: { list: ['image', 'video'] } })"
    const image = "defineField({ name: 'image', type: 'picture' })"
    const poster = "defineField({ name: 'poster', type: 'picture' })"
    const media = block('media', "type: 'object'", `${kind}, ${image}, ${poster}`)
    const alt = "defineField({ name: 'alt', type: 'string' })"
    const picture = block('picture', "type: 'image', options: { hotspot: true }", alt)

    it("a gallery's item: its kind or its picture changed is Level 1; its poster, or a new field, is Level 2", () => {
      const file = 'studio/schemaTypes/objects/media.ts'
      expect(levelOf(changed(file, media, block('media', "type: 'object'", `${kind}, ${image}, defineField({ name: 'poster', type: 'image' }), defineField({ name: 'captions', type: 'file' })`)))).toBe(2)
      expect(changedWebhookFields(media, block('media', "type: 'object'", `${kind.replace("'video'", "'film'")}, ${image}, ${poster}`))).toEqual(['media.kind'])
      expect(levelOf(changed(file, media, block('media', "type: 'object'", `${kind.replace("'video'", "'film'")}, ${image}, ${poster}`)))).toBe(1)
      expect(changedWebhookFields(media, block('media', "type: 'object'", `${kind}, defineField({ name: 'image', type: 'image' }), ${poster}`))).toEqual(['media.image'])
      expect(changedWebhookFields(media, block('media', "type: 'object'", `${kind}, ${poster}`))).toEqual(['media.image'])
      expect(levelOf(changed(file, media, null))).toBe(1)
    })

    it('a picture: its alt text rules are Level 2; no longer an image, or its hotspot gone, is Level 1', () => {
      const file = 'studio/schemaTypes/objects/picture.ts'
      expect(levelOf(changed(file, picture, block('picture', "type: 'image', options: { hotspot: true }", `${alt.replace("'string'", "'text'")}, defineField({ name: 'decorative', type: 'boolean' })`)))).toBe(2)
      expect(changedWebhookFields(picture, block('picture', "type: 'file', options: { hotspot: true }", alt))).toEqual(['picture'])
      expect(levelOf(changed(file, picture, block('picture', "type: 'file', options: { hotspot: true }", alt)))).toBe(1)
      expect(changedWebhookFields(picture, block('picture', "type: 'image'", alt))).toEqual(['picture'])
      expect(levelOf(changed(file, picture, null))).toBe(1)
    })

    it('another block is Level 2', () => {
      expect(levelOf(changed('studio/schemaTypes/objects/seo.ts', block('seo', "type: 'object'", alt), block('seo', "type: 'object'", `${alt}, ${poster}`)))).toBe(2)
    })
  })

  it('the list is what the webhook reads: its types, and no field it does not name', () => {
    const route = readFileSync(path.join(WEB, 'app/api/sanity/webhook/route.ts'), 'utf8')
    // W72a: the seven item types, the category's own type, and the two blocks a gallery is read through.
    const items = /CATALOG_TYPES[^[]*\[([^\]]+)\]/.exec(route)?.[1]?.match(/\w+/g) ?? []
    const category = /const CATEGORY_TYPE = '(\w+)'/.exec(route)?.[1]
    expect(items).toHaveLength(7)
    expect([...items, category, ...Object.keys(WEBHOOK_BLOCKS)].sort()).toEqual(Object.keys(WEBHOOK_FIELDS).sort())
    const fieldsOf = (name: string) => [...(new RegExp(`interface ${name} \\{([^}]+)\\}`).exec(route)?.[1] ?? '').matchAll(/^\s+(\w+)\??:/gm)].map(([, field]) => field!).filter((field) => !field.startsWith('_'))
    const documents = Object.entries(WEBHOOK_FIELDS).filter(([type]) => !Object.hasOwn(WEBHOOK_BLOCKS, type)).flatMap(([, fields]) => fields)
    expect(fieldsOf('SanityDocument').sort()).toEqual([...new Set(documents)].sort())
    expect(fieldsOf('SanityMedia').sort()).toEqual([...WEBHOOK_BLOCKS.media].sort())
    // A picture is read for its file alone, which is what makes it an image.
    expect(fieldsOf('SanityImage')).toEqual(['asset'])
    expect(WEBHOOK_BLOCKS.picture).toEqual([])
  })

  it("every one of them is found in the Studio's own files", () => {
    const files = [...readdirSync(SCHEMAS).map((file) => path.join(SCHEMAS, file)), ...readdirSync(path.join(SCHEMAS, 'objects')).map((file) => path.join(SCHEMAS, 'objects', file))].filter((file) => file.endsWith('.ts'))
    const found = new Set(files.flatMap((file) => [...webhookFieldsIn(readFileSync(file, 'utf8')).keys()]))
    const wanted = Object.entries(WEBHOOK_FIELDS).flatMap(([type, fields]) => [type, ...fields.map((field) => `${type}.${field}`)])
    expect([...found].sort()).toEqual(wanted.sort())
  })
})

describe('what Level 2 checks', () => {
  const stories = [
    { file: 'components/layout/Grid.stories.tsx', source: "import { Grid } from './Grid'" },
    { file: 'components/foundations/Type.stories.tsx', source: "import tokens from '@/lib/design/figma-tokens.json'\nimport { measured } from './measured'" },
    { file: 'components/shop/Card.stories.tsx', source: "import { Card } from './Card'\nimport { Grid } from '@/components/layout/Grid'" },
  ]

  it.each([
    [['web/components/layout/Grid.tsx'], ['components/layout/Grid.stories.tsx', 'components/shop/Card.stories.tsx']],
    [['web/components/shop/Card.tsx'], ['components/shop/Card.stories.tsx']],
    [['web/components/shop/Card.stories.tsx'], ['components/shop/Card.stories.tsx']],
    [['web/components/foundations/measured.tsx', 'web/lib/design/figma-tokens.json'], ['components/foundations/Type.stories.tsx']],
    [['web/lib/sanity/queries.ts', 'studio/structure.ts', 'web/CLAUDE.md'], []],
  ])('the stories for %j', (files, expected) => {
    expect(storiesFor(files, stories)).toEqual(expected)
  })

  it.each(['web/app/globals.css', 'web/app/fonts.ts', 'web/app/fonts/GT-Sectra-Fine-Regular.woff2', 'web/.storybook/preview.tsx'])('%s is loaded by every story, so all of them', (file) => {
    expect(storiesFor([file], stories)).toHaveLength(3)
  })

  it('unit tests: the changed test files that are still there, and only those the unit config runs', () => {
    const files = ['web/lib/seo/noindex.test.ts', 'web/app/layout.test.ts', 'web/scripts/check-fast-level.test.ts', 'web/lib/site.ts', 'web/components/layout/Grid.stories.tsx', 'studio/lib/checks.test.ts']
    expect(unitTestsToRun([...files.map((file) => changed(file)), changed('web/lib/gone.test.ts', 'x', null)])).toEqual(['lib/seo/noindex.test.ts', 'app/layout.test.ts', 'scripts/check-fast-level.test.ts'])
    const config = readFileSync(path.join(WEB, 'vitest.unit.config.ts'), 'utf8')
    expect(config).toContain("include: ['app/**/*.test.ts', 'lib/**/*.test.ts', 'server/**/*.test.ts', 'contracts/**/*.test.ts', 'scripts/**/*.test.ts']")
  })

  it('lint: the scripts that are still there, each from its own folder', () => {
    expect(
      filesToLint([changed('web/app/fonts.ts'), changed('web/app/globals.css', null, ''), changed('web/lib/gone.ts', 'x', null), changed('studio/structure.ts'), changed('supabase/README.md')]),
    ).toEqual({ web: ['app/fonts.ts'], studio: ['structure.ts'] })
  })
})
