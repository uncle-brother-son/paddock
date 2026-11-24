// Which test level a set of changed files needs (WQ29), and what that level checks. No side effects: check-fast.mjs
// reads git and runs the commands; check-fast-level.test.ts holds the rules.
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

/** Stripe, or server code, used by a file outside the Level 1 folders. A type-only import counts too. */
const usesMoneyCode = (source) => source !== null && /(?:from|import|require)\s*\(?\s*['"](?:stripe|@stripe\/[^'"]+|@\/server(?:\/[^'"]*)?|(?:\.\.\/)+server(?:\/[^'"]*)?)['"]/.test(source)

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
 * when it isn't there). Level 2 covers Level 3 (a small visual fix has the same checks; WQ29).
 */
export function pickLevel(changes) {
  const reasons = []
  for (const { file, before, after } of changes) {
    const level1 = LEVEL_1_PATHS.find((place) => (place.endsWith('/') ? file.startsWith(place) : file === place))
    if (level1) {
      reasons.push(`${file} (${level1} is backend or money code)`)
    } else if (file === 'web/package.json' && dependenciesChanged(before, after)) {
      reasons.push(`${file} (the packages changed)`)
    } else if (file.startsWith(SCHEMA_FOLDER) && isScript(file)) {
      const fields = changedWebhookFields(before, after)
      if (fields.length > 0) reasons.push(`${file} (the Worker's Sanity webhook reads ${fields.join(', ')})`)
    } else if (file.startsWith('web/') && isScript(file) && !/\.test\.[a-z]+$/.test(file) && (usesMoneyCode(before) || usesMoneyCode(after))) {
      reasons.push(`${file} (it uses Stripe or server code)`)
    }
  }
  if (changes.length === 0) return { level: 0, reasons }
  return { level: reasons.length > 0 ? 1 : 2, reasons }
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

/** The changed unit tests that are still there, from web/ (the folders vitest.unit.config.ts runs). */
export function unitTestsToRun(changes) {
  return changes
    .filter(({ file, after }) => after !== null && /^web\/(app|lib|server|contracts|scripts)\/.+\.test\.ts$/.test(file))
    .map(({ file }) => file.slice('web/'.length))
}

/** The changed files to lint, in web/ and in studio/ (each with its own rules), from that folder. Gone files are left out. */
export function filesToLint(changes) {
  const inFolder = (folder) =>
    changes.filter(({ file, after }) => after !== null && file.startsWith(folder) && isScript(file)).map(({ file }) => file.slice(folder.length))
  return { web: inFolder('web/'), studio: inFolder('studio/') }
}
