// Which test level a set of changed files needs (WQ29, WQ30), and what that level checks. No side effects:
// check-fast.mjs reads git and runs the commands; check-fast-level.test.ts holds the rules.
import path from 'node:path'
import ts from 'typescript'

/** Level 1: the backend and the money code. A folder ends in "/"; anything else is one file. */
export const LEVEL_1_PATHS = [
  'web/server/',
  'web/contracts/',
  'supabase/',
  'web/app/api/',
  'web/custom-worker.ts',
  'web/wrangler.jsonc',
  'web/package-lock.json',
]

/**
 * W73 (WQ30), Level 1b: the backend that does not touch money. The Sanity webhook and what it writes (names, pictures,
 * categories: content only, never a price, stock or what is on sale).
 */
export const LEVEL_1B_PATHS = ['web/app/api/sanity/', 'web/server/rules/catalog/sanity-sync.ts']

/**
 * W74a, WQ45 (Wayne, 24 Nov): the shop's reads are Level 1b too, by name: the rules that read the shop for the
 * website's pages, their contract, the public routes (GET /api/v1/shop/availability; W75a, the events'
 * /api/v1/shop/event-availability; W77a, the booking panel's booking-days, sessions and booking-quote) and the test that lists the public routes. They show prices and never set, charge
 * or move one, so the money words can't be asked of them. What can: one of them that starts to write (a statement that
 * changes a row, or a route that takes more than GET) is no longer a read, and is Level 1. A test sets its own rows up,
 * so a test is not asked.
 */
export const SHOP_READ_PATHS = [
  'web/server/rules/shop/',
  'web/contracts/shop.ts',
  'web/app/api/v1/shop/availability/',
  'web/app/api/v1/shop/booking-days/',
  'web/app/api/v1/shop/booking-quote/',
  'web/app/api/v1/shop/event-availability/',
  'web/app/api/v1/shop/sessions/',
  'web/server/api-allowlist.test.ts',
]

/**
 * WQ45: the one website file that reads the shop from the Worker's rules (W74: `readShop()`, kept for a minute). Its
 * import of the shop's reads does not make it money code, so a page built on it is Level 2. Anything else it imports
 * from server code, or Stripe, does; and so does any other website file that imports the shop's reads itself.
 */
export const SHOP_READER = 'web/lib/shop/read.ts'
const SHOP_READS_IMPORT = '@/server/rules/shop/'

/**
 * W76a (Wayne, 25 Nov): the gift card's Other rule runs in the browser too (the page asks it as the customer types), and
 * SHOP_READER is server-only. So this one website file may import that one rule, and nothing else from server code.
 * The rule itself stays where it is, Level 1b.
 */
export const SHOP_AMOUNT_FILE = 'web/lib/shop/gift-card-amount.ts'
export const SHOP_AMOUNT_RULE = '@/server/rules/shop/gift-card-amount'

const inPlaces = (places, file) => places.some((place) => (place.endsWith('/') ? file.startsWith(place) : file === place))
const isTest = (file) => /\.test\.[a-z]+$/.test(file)

/** A statement that changes a row. */
const SQL_WRITES = /\b(insert\s+into|update\s+\w+\s+set|delete\s+from)\b/i

/**
 * Words that mean money, a booking or a membership. A migration or a read-only route that names one (in its path or
 * its text) stays Level 1. It errs towards Level 1 on purpose: "pass" and "order" catch more than they need to.
 */
export const MONEY_WORDS =
  /stripe|refund|payment|\bpay\b|paid|charge|invoice|pric(e|ing)|credit|order|booking|membership|subscription|gift.?card|\bpass(es)?\b|session.?pass|balance|promo|discount|checkout|money|amount/i

const WRITES = /\b(POST|PUT|PATCH|DELETE)\b/

/**
 * Why a changed backend file is Level 1b and not Level 1 (WQ30), or null when it is Level 1: the Sanity webhook and
 * its sync; a migration that names no money; a route under /api/v1 that only reads and names no money. Both the text
 * before and the text after count, so a file can't leave Level 1 by losing the word. With no text to read, Level 1.
 */
export function backendWithoutMoney({ file, before, after }) {
  if (inPlaces(LEVEL_1B_PATHS, file)) return 'the Sanity webhook and its sync: content only'
  const texts = [before, after].filter((text) => text !== null)
  if (inPlaces(SHOP_READ_PATHS, file)) {
    const route = /\/route\.ts$/.test(file)
    const writes = !isTest(file) && texts.some((text) => SQL_WRITES.test(text) || (route && WRITES.test(text)))
    return writes ? null : "the shop's reads: they show prices, sizes and spaces, and never write or move money"
  }
  if (texts.length === 0) return null
  const namesMoney = MONEY_WORDS.test(file) || texts.some((text) => MONEY_WORDS.test(text))
  if (/^supabase\/migrations\/[^/]+\.sql$/.test(file)) return namesMoney ? null : 'a migration that names no money, booking or membership'
  if (/^web\/app\/api\/v1\/.+\/route(\.test)?\.ts$/.test(file)) {
    return namesMoney || texts.some((text) => WRITES.test(text)) ? null : 'a route that only reads, and names no money, booking or membership'
  }
  return null
}

/**
 * W72a: the blocks a gallery is made of (studio/schemaTypes/objects/). The check compares a field's own code, not the
 * block it uses, so the blocks the webhook reads through are listed too: of a gallery's item its kind and its picture,
 * and of a picture only what kind of thing it is (an image, with its file), which `webhookFieldsIn` holds for every
 * type here.
 */
export const WEBHOOK_BLOCKS = {
  media: ['kind', 'image'],
  picture: [],
}

/**
 * The fields the Worker's Sanity webhook reads (web/app/api/sanity/webhook/route.ts), by Studio type. A change to one is
 * Level 1. The test beside this file fails when the webhook reads a field, or a type, that isn't here.
 */
export const WEBHOOK_FIELDS = {
  serviceType: ['name', 'images'],
  product: ['name', 'category', 'gallery'],
  addon: ['name', 'category', 'images'],
  membershipPlan: ['name', 'images'],
  sessionPassType: ['name', 'images'],
  giftCardType: ['name', 'physicalGallery', 'digitalGallery'],
  event: ['name', 'gallery', 'extraWaiver'],
  // W72a: a product category has a row of its own.
  productCategory: ['title', 'order'],
  ...WEBHOOK_BLOCKS,
}

const SCHEMA_FOLDER = 'studio/schemaTypes/'

const isScript = (file) => /\.(ts|tsx|mts|mjs|js|jsx)$/.test(file)

const parse = (source) => ts.createSourceFile('schema.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

/** A property of an object literal, by name. */
const propertyOf = (object, name) => object.properties.find((property) => ts.isPropertyAssignment(property) && property.name.getText() === name)?.initializer

/** The object literal an array member is, with or without defineField() round it. */
const objectOf = (node) => {
  if (ts.isObjectLiteralExpression(node)) return node
  if (ts.isCallExpression(node) && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) return node.arguments[0]
  return undefined
}

/**
 * Each webhook field in a schema file, as "type.field" to its code (comments and layout don't count). "type" alone says
 * the type is there, and what kind of thing it is (its own `type` and `options`: a document, an object, an image with a
 * hotspot), so a block turned into another kind reads as changed. A field the file doesn't spell out is missing, which
 * reads as changed.
 */
export function webhookFieldsIn(source) {
  const found = new Map()
  if (source === null) return found
  const file = parse(source)
  const printer = ts.createPrinter({ removeComments: true })
  const visit = (node) => {
    const object = ts.isCallExpression(node) && node.expression.getText() === 'defineType' ? objectOf(node) : undefined
    const nameNode = object && propertyOf(object, 'name')
    const type = nameNode && ts.isStringLiteralLike(nameNode) ? nameNode.text : undefined
    if (object && type && Object.hasOwn(WEBHOOK_FIELDS, type)) {
      const kind = ['type', 'options'].map((part) => `${part}: ${propertyOf(object, part)?.getText().replace(/\s+/g, ' ') ?? 'none'}`).join('; ')
      found.set(type, kind)
      const fields = propertyOf(object, 'fields')
      for (const element of fields && ts.isArrayLiteralExpression(fields) ? fields.elements : []) {
        const field = objectOf(element)
        const fieldName = field && propertyOf(field, 'name')
        if (!fieldName || !ts.isStringLiteralLike(fieldName) || !WEBHOOK_FIELDS[type].includes(fieldName.text)) continue
        // Parsed again on its own, so that where it sits in the file makes no difference.
        const own = parse(`(${element.getText()})`)
        found.set(`${type}.${fieldName.text}`, printer.printFile(own).replace(/\s+/g, ' '))
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

/** The webhook fields (and types) that differ between two versions of a schema file. */
export function changedWebhookFields(before, after) {
  const was = webhookFieldsIn(before)
  const is = webhookFieldsIn(after)
  return [...new Set([...was.keys(), ...is.keys()])].filter((key) => was.get(key) !== is.get(key)).sort()
}

const MONEY_IMPORT = /(?:from|import|require)\s*\(?\s*['"](stripe|@stripe\/[^'"]+|@\/server(?:\/[^'"]*)?|(?:\.\.\/)+server(?:\/[^'"]*)?)['"]/g

/**
 * Stripe, or server code, used by a file outside the Level 1 folders. A type-only import counts too. WQ45: the shop's
 * reads, imported by the one file that reads the shop (SHOP_READER), do not count; there and nowhere else. Nor does the
 * Other rule, imported by SHOP_AMOUNT_FILE (W76a).
 */
const usesMoneyCode = (file, source) =>
  source !== null &&
  [...source.matchAll(MONEY_IMPORT)].some(([, name]) => !(file === SHOP_READER && name.startsWith(SHOP_READS_IMPORT)) && !(file === SHOP_AMOUNT_FILE && name === SHOP_AMOUNT_RULE))

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'overrides']

function dependenciesChanged(before, after) {
  const of = (source) => {
    const json = source === null ? {} : JSON.parse(source)
    return JSON.stringify(DEPENDENCY_FIELDS.map((field) => json[field] ?? null))
  }
  return of(before) !== of(after)
}

/**
 * The level, and why. `changes`: each changed file's path from the repo's root, with its text before and after (null
 * when it isn't there). Level 1 (money) wins over Level '1b' (backend with no money; WQ30), which wins over Level 2;
 * the reasons are those of the level picked. Level 2 covers Level 3 (a small visual fix has the same checks; WQ29).
 */
export function pickLevel(changes) {
  const reasons = []
  const reasons1b = []
  for (const { file, before, after } of changes) {
    const level1 = LEVEL_1_PATHS.find((place) => inPlaces([place], file))
    if (level1) {
      const noMoney = backendWithoutMoney({ file, before, after })
      if (noMoney) reasons1b.push(`${file} (${noMoney})`)
      else reasons.push(`${file} (${level1} is backend or money code)`)
    } else if (file === 'web/package.json' && dependenciesChanged(before, after)) {
      reasons.push(`${file} (the packages changed)`)
    } else if (file.startsWith(SCHEMA_FOLDER) && isScript(file)) {
      const fields = changedWebhookFields(before, after)
      if (fields.length > 0) reasons.push(`${file} (the Worker's Sanity webhook reads ${fields.join(', ')})`)
    } else if (file.startsWith('web/') && isScript(file) && !isTest(file) && (usesMoneyCode(file, before) || usesMoneyCode(file, after))) {
      reasons.push(`${file} (it uses Stripe or server code)`)
    }
  }
  if (changes.length === 0) return { level: 0, reasons }
  if (reasons.length > 0) return { level: 1, reasons }
  if (reasons1b.length > 0) return { level: '1b', reasons: reasons1b }
  return { level: 2, reasons }
}

/** Files every story loads (.storybook/preview.tsx): a change to one is a change to them all. */
const EVERY_STORY = [/^web\/\.storybook\//, /^web\/app\/globals\.css$/, /^web\/app\/fonts\.ts$/, /^web\/app\/fonts\//]

/**
 * The story files to test, from web/: the changed ones, those named after a changed file beside them, and those that
 * import a changed file. `stories`: every story file's path from web/ with its text.
 */
export function storiesFor(changedFiles, stories) {
  if (changedFiles.some((file) => EVERY_STORY.some((pattern) => pattern.test(file)))) return stories.map(({ file }) => file)
  const changed = new Set(changedFiles.filter((file) => file.startsWith('web/')).map((file) => file.slice('web/'.length)))
  const withoutEnding = (file) => file.replace(/(\.stories)?\.(tsx|ts|mdx|json|css)$/, '')
  const changedNames = new Set([...changed].map(withoutEnding))
  return stories
    .filter(({ file, source }) => {
      if (changed.has(file) || changedNames.has(withoutEnding(file))) return true
      const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(([, name]) => name)
      return imports.some((name) => {
        const target = name.startsWith('@/') ? name.slice(2) : name.startsWith('.') ? path.posix.join(path.posix.dirname(file), name) : null
        return target !== null && (changed.has(target) || changedNames.has(withoutEnding(target)))
      })
    })
    .map(({ file }) => file)
}

/**
 * The unit tests to run, from web/ (the folders vitest.unit.config.ts runs): the changed ones that are still there.
 * At Level 2 (Wayne, 27 Nov, on W84) every test under lib/ is run as well, changed or not: check-fast.mjs hands them
 * in as `libTests`, and they come first. They hold the components' and the stylesheet's own lines, so a change to a
 * component can fail one that did not change (W84: two in lib/modules/content.test.ts went unseen), and all of them
 * take a second or two.
 */
export function unitTestsToRun(changes, libTests = []) {
  const changed = changes
    .filter(({ file, after }) => after !== null && /^web\/(app|lib|server|contracts|scripts)\/.+\.test\.ts$/.test(file))
    .map(({ file }) => file.slice('web/'.length))
  return [...new Set([...libTests, ...changed])]
}

/** The changed files to lint, in web/ and in studio/ (each with its own rules), from that folder. Gone files are left out. */
export function filesToLint(changes) {
  const inFolder = (folder) =>
    changes.filter(({ file, after }) => after !== null && file.startsWith(folder) && isScript(file)).map(({ file }) => file.slice(folder.length))
  return { web: inFolder('web/'), studio: inFolder('studio/') }
}
