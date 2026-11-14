import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

// Test helper (W27): reads the words of a frozen copy of old staff app code with the TypeScript parser, so a
// failure-messages test can hold the Worker's words to the old functions', word for word, after the staff app has
// deleted them. As server/rules/bookings/failure-messages.test.ts does for step D (which keeps its own copy of this).

export const readSource = (file: string): ts.SourceFile => ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)

/** Every string literal under `dir`, and the static text of every template literal (its parts joined by NUL). */
export function frozenWords(dir: string): { strings: Set<string>; templates: string[] } {
  const strings = new Set<string>()
  const templates: string[] = []
  const walk = (folder: string) => {
    for (const name of readdirSync(folder)) {
      const full = path.join(folder, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (name.endsWith('.ts')) {
        readSource(full).forEachChild(function visit(node) {
          if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) strings.add(node.text)
          if (ts.isTemplateExpression(node)) templates.push([node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join('\u0000'))
          node.forEachChild(visit)
        })
      }
    }
  }
  walk(dir)
  return { strings, templates }
}

/** The frozen templates `text` fills in: their static parts, in order, with anything between. */
export function templatesFilledBy(templates: readonly string[], text: string): string[] {
  return templates.filter((template) => {
    const parts = template.split('\u0000')
    const pattern = new RegExp(`^${parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\S]*?')}$`)
    // At least a few words of fixed text: a template that is all placeholders would fit anything.
    return parts.length > 1 && parts.join('').trim().length >= 12 && pattern.test(text)
  })
}

/** The string members of a union type alias (`type X = 'a' | 'b'`), in source order. Comments between them are skipped. */
export function unionMembers(file: string, typeName: string): string[] {
  const members: string[] = []
  readSource(file).forEachChild(function visit(node) {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === typeName) {
      const collect = (type: ts.TypeNode): void => {
        if (ts.isUnionTypeNode(type)) type.types.forEach(collect)
        else if (ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal)) members.push(type.literal.text)
        else throw new Error(`${typeName} has a member that isn't a string literal`)
      }
      collect(node.type)
    }
    node.forEachChild(visit)
  })
  if (members.length === 0) throw new Error(`${typeName} isn't a union of strings in ${file}`)
  return members
}

/** Every string a file's source holds between quotes of any kind, for "the dialog still says this" checks. */
export function sourceHolds(file: string, words: string): boolean {
  const source = readFileSync(file, 'utf8')
  return [`'${words}'`, `"${words}"`, `\`${words}\``].some((quoted) => source.includes(quoted)) || source.includes(`>${words}<`)
}
