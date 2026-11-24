import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// Brief W71, item 5 (WQ21, WQ23): every animation and transition uses the one smooth curve and one of the two
// durations, from the tokens (lib/motion/tokens.ts for Motion; --ease-smooth, --duration-short and --duration-long
// in app/globals.css for CSS). This reads every source file under app/, components/ and features/ and fails on a
// curve or a duration typed in by hand: a cubic-bezier, an ease keyword, a spring, a time in ms or seconds.

const WEB = path.resolve(__dirname, '../..')
const FOLDERS = ['app', 'components', 'features']
const SOURCE_FILE = /\.(ts|tsx|js|jsx|mjs|css|mdx)$/

/**
 * The tokens themselves, which have to be typed in somewhere: in app/globals.css, the three motion variables and
 * the two lines that switch animations off for a visitor with reduced motion on. Nothing else in that file, and
 * no other file, is let through.
 */
const TOKEN_LINES: Readonly<Record<string, readonly RegExp[]>> = {
  'app/globals.css': [
    /^--ease-smooth: cubic-bezier\([^)]*\);$/,
    /^--duration-(short|long): \d+ms;$/,
    /^(animation|transition)-duration: 0\.01ms !important;$/,
  ],
}

type Check = { name: string; pattern: RegExp; motionLinesOnly?: boolean }

// "Not part of a longer word": Tailwind writes a space inside brackets as `_`, so `_` counts as a break here.
const BEFORE = '(?<![A-Za-z0-9.-])'
const AFTER = '(?![A-Za-z0-9-])'

const CHECKS: readonly Check[] = [
  { name: 'a typed-in curve (cubic-bezier)', pattern: /cubic-bezier\s*\(/ },
  // ease-in, ease-out, ease-in-out, ease-linear, ease-[...]: everything but ease-smooth.
  { name: 'an ease keyword', pattern: new RegExp(`${BEFORE}ease-(?!smooth${AFTER})[A-Za-z[(]`) },
  { name: "one of Motion's named curves", pattern: /\b(easeIn|easeOut|easeInOut|circIn|circOut|circInOut|backIn|backOut|backInOut|anticipate)\b/ },
  { name: 'an ease written out for Motion', pattern: /\bease\s*:\s*[["'`]/ },
  { name: 'a spring', pattern: /\btype\s*:\s*["'`](spring|inertia)["'`]/ },
  { name: 'a duration in milliseconds', pattern: new RegExp(`${BEFORE}\\d*\\.?\\d+ms${AFTER}`) },
  // duration-300, duration-[250ms]: everything but duration-short and duration-long.
  { name: 'a duration utility', pattern: new RegExp(`${BEFORE}duration-(?!(short|long)${AFTER})[A-Za-z0-9[(]`) },
  { name: 'a duration written out for Motion', pattern: /\bduration\s*:\s*["'`\d.-]/ },
  { name: 'a duration in seconds', pattern: new RegExp(`${BEFORE}\\d*\\.?\\d+s${AFTER}`), motionLinesOnly: true },
  { name: 'an ease keyword', pattern: new RegExp(`${BEFORE}(ease|linear)(?![A-Za-z0-9-]|\\s*:)`), motionLinesOnly: true },
]

const MOTION_LINE = /transition|animat|duration/i

type Finding = { file: string; line: number; found: string; text: string }

/** Every typed-in curve or duration in one file's text. `file` is its path from web/, with forward slashes. */
function typedInMotion(file: string, text: string): Finding[] {
  const tokenLines = TOKEN_LINES[file] ?? []
  const everyLineIsMotion = file.endsWith('.css')
  return text.split('\n').flatMap((raw, index) => {
    const line = raw.trim()
    if (tokenLines.some((allowed) => allowed.test(line))) return []
    const aboutMotion = everyLineIsMotion || MOTION_LINE.test(line)
    return CHECKS.filter((check) => (aboutMotion || !check.motionLinesOnly) && check.pattern.test(line)).map((check) => ({
      file,
      line: index + 1,
      found: check.name,
      text: line,
    }))
  })
}

function sourceFilesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) return sourceFilesUnder(full)
    return SOURCE_FILE.test(name) ? [path.relative(WEB, full).split(path.sep).join('/')] : []
  })
}

const found = (file: string, text: string): string[] => typedInMotion(file, text).map((finding) => finding.found)

describe('no animation has a curve or a duration of its own (W71, WQ21 and WQ23)', () => {
  const files = FOLDERS.flatMap((folder) => sourceFilesUnder(path.join(WEB, folder)))

  it('nothing under app/, components/ or features/ types one in', () => {
    const findings = files.flatMap((file) => typedInMotion(file, readFileSync(path.join(WEB, file), 'utf8')))
    expect(findings).toEqual([])
  })

  it('the files it reads include the stylesheet, the layout, the providers and the staff routes', () => {
    for (const file of ['app/globals.css', 'app/layout.tsx', 'components/providers/MotionProviders.tsx', 'app/api/v1/staff/whoami/route.ts']) {
      expect(files).toContain(file)
    }
  })

  it('the stylesheet does hold the token lines, and they are the only lines let through', () => {
    const css = readFileSync(path.join(WEB, 'app/globals.css'), 'utf8')
    // Read as any other file, the stylesheet's own token lines are findings: the three tokens, and the two
    // reduced-motion lines.
    expect([...new Set(typedInMotion('components/Somewhere.css', css).map((finding) => finding.text))]).toEqual([
      '--ease-smooth: cubic-bezier(0, 0, 0.2, 1);',
      '--duration-short: 320ms;',
      '--duration-long: 640ms;',
      'animation-duration: 0.01ms !important;',
      'transition-duration: 0.01ms !important;',
    ])
    // A token line is let through only as written: a fourth duration, or a curve under another name, is not.
    expect(found('app/globals.css', '  --duration-medium: 480ms;')).toEqual(['a duration in milliseconds'])
    expect(found('app/globals.css', '  --ease-snappy: cubic-bezier(0.4, 0, 0.2, 1);')).toEqual(['a typed-in curve (cubic-bezier)'])
    expect(found('app/globals.css', '  transition: opacity 320ms;')).toEqual(['a duration in milliseconds'])
  })

  it.each([
    ['a Motion duration', 'components/ui/Button.tsx', '<motion.div transition={{ duration: 0.3 }} />', ['a duration written out for Motion']],
    ['a Motion duration with no leading zero', 'components/ui/Button.tsx', 'const fade = { duration: .5 }', ['a duration written out for Motion']],
    ['a Motion curve as numbers', 'components/ui/Menu.tsx', 'transition={{ ease: [0.4, 0, 0.2, 1] }}', ['an ease written out for Motion']],
    ['a Motion curve by name', 'components/ui/Menu.tsx', "transition={{ ease: 'easeOut' }}", ["one of Motion's named curves", 'an ease written out for Motion']],
    ['a Motion linear ease', 'components/ui/Menu.tsx', 'transition={{ ease: "linear" }}', ['an ease written out for Motion', 'an ease keyword']],
    ['a spring', 'features/bag/Bag.tsx', "animate={{ x: 0 }} transition={{ type: 'spring', stiffness: 200 }}", ['a spring']],
    ['a Tailwind duration', 'components/ui/Button.tsx', '<a className="transition-opacity duration-300">', ['a duration utility']],
    ['a Tailwind duration in brackets', 'components/ui/Button.tsx', '<a className="transition duration-[250ms]">', ['a duration in milliseconds', 'a duration utility']],
    ['a Tailwind curve', 'components/ui/Button.tsx', '<a className="transition ease-in-out">', ['an ease keyword']],
    ['a Tailwind linear curve', 'components/ui/Button.tsx', '<a className="transition ease-linear">', ['an ease keyword']],
    ['a Tailwind curve in brackets', 'components/ui/Button.tsx', '<a className="ease-[cubic-bezier(0.4,0,0.2,1)]">', ['a typed-in curve (cubic-bezier)', 'an ease keyword']],
    ['a Tailwind animation in brackets', 'components/ui/Spinner.tsx', '<i className="animate-[spin_1s_linear_infinite]" />', ['a duration in seconds', 'an ease keyword']],
    ['an inline style', 'components/ui/Card.tsx', "style={{ transition: 'opacity 200ms ease-out' }}", ['an ease keyword', 'a duration in milliseconds']],
    ['an inline style in seconds', 'components/ui/Card.tsx', "style={{ transition: 'opacity 0.2s' }}", ['a duration in seconds']],
    ['CSS in seconds, with a keyword', 'app/shop/shop.css', '  transition: opacity .3s ease;', ['a duration in seconds', 'an ease keyword']],
    ['CSS over two lines', 'app/shop/shop.css', '    opacity 0.3s linear;', ['a duration in seconds', 'an ease keyword']],
    ['a curve in CSS', 'app/shop/shop.css', '  animation-timing-function: cubic-bezier(0.2, 0, 0, 1);', ['a typed-in curve (cubic-bezier)']],
    ['a curve put together by hand', 'components/ui/Menu.tsx', "const curve = `cubic-bezier(${EASE_SMOOTH.join(', ')})`", ['a typed-in curve (cubic-bezier)']],
  ])('it finds %s', (_what, file, text, expected) => {
    expect(found(file, text)).toEqual(expected)
  })

  it.each([
    ['Motion on the tokens', 'components/ui/Menu.tsx', '<motion.div transition={{ duration: DURATION_LONG, ease: EASE_SMOOTH }} />'],
    ['the curve by its CSS name from the tokens', 'components/ui/Menu.tsx', 'style={{ transitionTimingFunction: EASE_SMOOTH_CSS }}'],
    ['a duration passed on', 'components/ui/Menu.tsx', 'function Panel({ duration }: { duration: number }) { return <motion.div transition={{ duration }} /> }'],
    ['Tailwind on the tokens', 'components/ui/Button.tsx', '<a className="transition-opacity duration-short ease-smooth md:duration-long">'],
    ['CSS on the tokens', 'app/shop/shop.css', '  transition: opacity var(--duration-short) var(--ease-smooth);'],
    ['a CSS duration from a token', 'app/shop/shop.css', '  transition-duration: var(--duration-long);'],
    ['the tokens as utilities', 'app/globals.css', '  --tw-duration: var(--duration-short);'],
    ['a gradient', 'components/ui/Hero.tsx', '<div className="transition-opacity bg-linear-to-b" style={{ background: "linear-gradient(red, blue)" }} />'],
    ['sizes and counts', 'components/ui/Card.tsx', '<div className="col-span-12 p-16 text-12">3 sessions, 24 columns</div>'],
    ['words that hold "ms" or "ease"', 'components/ui/Form.tsx', '// Forms: please release the items; 2 rooms'],
  ])('it leaves %s alone', (_what, file, text) => {
    expect(found(file, text)).toEqual([])
  })
})
