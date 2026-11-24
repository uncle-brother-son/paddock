import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { changedWebhookFields, filesToLint, pickLevel, storiesFor, unitTestsToRun, WEBHOOK_BLOCKS, WEBHOOK_FIELDS, webhookFieldsIn } from './check-fast-level.mjs'

// Brief W72, item 1 (WQ29): how `npm run check:fast` picks the test level.

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
    'supabase/migrations/035_x.sql',
    'web/app/api/sanity/webhook/route.ts',
    'web/app/api/v1/staff/orders/route.ts',
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
