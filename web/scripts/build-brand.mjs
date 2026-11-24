// npm run brand:build (W73): turns the SVG files in components/brand/svg/ (exported from Figma's 01 Logo and 02 Icons
// pages, cleaned by the lead) into the data files components/brand/art/*.ts that Icon, Logo, Fence, HouseIllustration
// and PaymentMark draw from. `-- --check` writes nothing and fails when a data file is behind its SVG files
// (scripts/build-brand.test.ts runs the same comparison). No package: the files are read as text.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Put in front of every id inside a drawing; BrandSvg swaps it for an id of the element's own, so two logos on a page never share one. */
export const ID_TOKEN = '__BRAND_ID__'

/**
 * The three folders. `ownColours`: the payment marks keep their brands' colours; an icon or a logo may only use
 * `currentColor`, so it follows the text colour in every theme.
 */
export const GROUPS = [
  { folder: 'icons', ownColours: false },
  { folder: 'logos', ownColours: false },
  { folder: 'payment', ownColours: true },
]

const attribute = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1]

/** One SVG file's text as { width, height, body, ids }. Throws on anything a drawing has no business holding. */
export function readArt(name, svg, { ownColours }) {
  const refuse = (why) => {
    throw new Error(`${name}: ${why}`)
  }
  const root = /<svg\b[^>]*>/.exec(svg)?.[0]
  const end = svg.lastIndexOf('</svg>')
  if (!root || end < 0) refuse('not an SVG file')
  const width = Number(attribute(root, 'width'))
  const height = Number(attribute(root, 'height'))
  if (!(width > 0) || !(height > 0)) refuse('no width and height of its own')
  if (attribute(root, 'viewBox') !== `0 0 ${width} ${height}`) refuse(`its viewBox is not its own box (0 0 ${width} ${height})`)

  let body = svg
    .slice(svg.indexOf(root) + root.length, end)
    // Figma's export note about where the file came from: not part of the drawing.
    .replace(/<metadata>[\s\S]*?<\/metadata>/g, '')
    .replace(/xlink:href=/g, 'href=')
    .replace(/>\s+</g, '><')
    .trim()

  for (const [what, pattern] of [
    ['a script', /<script\b/i],
    ['a style sheet', /<style\b/i],
    ['a picture or outside content', /<(image|foreignObject|iframe)\b/i],
    ['an event handler', /\son[a-z]+=/i],
    ['an outside address', /href="(?!#)/],
  ]) {
    if (pattern.test(body)) refuse(`holds ${what}`)
  }

  if (!ownColours) {
    // A mask is drawn in black and white by its nature; everything else takes the text colour.
    const drawn = body.replace(/<mask\b[\s\S]*?<\/mask>/g, '')
    const colours = [...drawn.matchAll(/\s(?:fill|stroke)="([^"]*)"/g)].map(([, colour]) => colour)
    const typedIn = [...new Set(colours.filter((colour) => colour !== 'currentColor' && colour !== 'none'))]
    if (typedIn.length > 0) refuse(`has a colour of its own (${typedIn.join(', ')}): only currentColor`)
  }

  const ids = [...new Set([...body.matchAll(/\sid="([^"]+)"/g)].map(([, id]) => id))]
  for (const id of ids) {
    body = body.replaceAll(` id="${id}"`, ` id="${ID_TOKEN}${id}"`).replaceAll(`"#${id}"`, `"#${ID_TOKEN}${id}"`).replaceAll(`url(#${id})`, `url(#${ID_TOKEN}${id})`)
  }
  return { width, height, body, ids: ids.length > 0 }
}

/** Each data file's path from web/ with its text. */
export function buildBrand(web = WEB) {
  const files = {}
  for (const group of GROUPS) {
    const folder = path.join(web, 'components/brand/svg', group.folder)
    const names = readdirSync(folder)
      .filter((file) => file.endsWith('.svg'))
      .sort()
    const entries = names.map((file) => {
      const name = file.slice(0, -'.svg'.length)
      const art = readArt(`${group.folder}/${file}`, readFileSync(path.join(folder, file), 'utf8'), group)
      return `  ${JSON.stringify(name)}: { width: ${art.width}, height: ${art.height}, ids: ${art.ids}, body: ${JSON.stringify(art.body)} },`
    })
    files[`components/brand/art/${group.folder}.ts`] = [
      `// Made by scripts/build-brand.mjs from components/brand/svg/${group.folder}/. Never edit by hand: change the SVG file and run`,
      '// `npm run brand:build`.',
      `export const ${group.folder} = {`,
      ...entries,
      '} as const',
      '',
    ].join('\n')
  }
  return files
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check')
  const behind = []
  for (const [file, text] of Object.entries(buildBrand())) {
    const full = path.join(WEB, file)
    let now = null
    try {
      now = readFileSync(full, 'utf8')
    } catch {
      now = null
    }
    if (now === text) continue
    if (check) behind.push(file)
    else {
      writeFileSync(full, text)
      console.log(`wrote ${file}`)
    }
  }
  if (behind.length > 0) {
    console.error(`Behind their SVG files (run npm run brand:build): ${behind.join(', ')}`)
    process.exit(1)
  }
  if (check) console.log('The brand data files are up to date.')
}
