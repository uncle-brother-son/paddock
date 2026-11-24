import { readFileSync } from 'node:fs'
import path from 'node:path'

// For tests only: reads app/globals.css as a tree of rules, so a test can ask for "the declarations in
// [data-theme="dark"]" or "the @utility text-h1 block" and compare them with the Figma tokens.

export type Rule = {
  /** What comes before the `{`: a selector or an at-rule (`@theme static`, `@media (width >= 48rem)`). */
  header: string
  /** The rule's own declarations, in order of writing; a later one of the same name wins. */
  declarations: Record<string, string>
  rules: Rule[]
}

export const GLOBALS_CSS = path.resolve(__dirname, '../../app/globals.css')

const withoutComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '')

export function parseStylesheet(css: string): Rule {
  const text = withoutComments(css)
  let at = 0

  const readRule = (header: string): Rule => {
    const rule: Rule = { header, declarations: {}, rules: [] }
    let pending = ''
    while (at < text.length) {
      const char = text[at++]
      if (char === '{') {
        rule.rules.push(readRule(pending.trim().replace(/\s+/g, ' ')))
        pending = ''
      } else if (char === '}') {
        return rule
      } else if (char === ';') {
        const colon = pending.indexOf(':')
        if (colon > 0) rule.declarations[pending.slice(0, colon).trim()] = pending.slice(colon + 1).trim().replace(/\s+/g, ' ')
        pending = ''
      } else {
        pending += char
      }
    }
    return rule
  }

  return readRule('')
}

export const readGlobalsCss = (): Rule => parseStylesheet(readFileSync(GLOBALS_CSS, 'utf8'))

/** Every rule with this header, at any depth, in order of writing. */
export function rulesNamed(root: Rule, header: string): Rule[] {
  return root.rules.flatMap((rule) => [...(rule.header === header ? [rule] : []), ...rulesNamed(rule, header)])
}

/** The one rule with this header; fails when there is none, or more than one. */
export function ruleNamed(root: Rule, header: string): Rule {
  const found = rulesNamed(root, header)
  if (found.length !== 1) throw new Error(`Expected one "${header}" rule in globals.css, found ${found.length}`)
  return found[0]!
}

/** The one rule with this header written directly inside `parent` (not deeper). */
export function childNamed(parent: Rule, header: string): Rule {
  const found = parent.rules.filter((rule) => rule.header === header)
  if (found.length !== 1) throw new Error(`Expected one "${header}" rule inside "${parent.header}", found ${found.length}`)
  return found[0]!
}

/** Follows `var(--name)` through a set of declarations until a plain value is left. */
export function resolveValue(value: string, declarations: Record<string, string>): string {
  let resolved = value
  for (let depth = 0; depth < 10; depth += 1) {
    const match = /^var\((--[\w-]+)\)$/.exec(resolved)
    if (!match) return resolved
    const next = declarations[match[1]!]
    if (next === undefined) throw new Error(`${match[1]} is not declared`)
    resolved = next
  }
  throw new Error(`${value} never resolves`)
}

/** `1.5rem` as pixels at the browser's default 16px. */
export function remToPx(value: string): number {
  const match = /^(\d*\.?\d+)rem$/.exec(value)
  if (!match) throw new Error(`Not a rem value: ${value}`)
  return Number(match[1]) * 16
}
