import { readFileSync } from 'node:fs'
import path from 'node:path'

/*
 * W64a item 7 (W64 plan, agreed by the W64 review): the words of the old staff app code, pinned. The failure-messages
 * tests hold each Worker sentence to the old function's, word for word; until W64a they read the old code itself with the
 * TypeScript parser. That code went at W65, so what each test read from it was recorded once in `old-words.json`, and
 * the tests read it here. Nothing here reads the old code.
 *
 * The folders, by short name: `account` (step F's functions), `accountRoutes` (step F's three legacy routes), `refund`
 * (step E's), `booking` (step D's), `admin` (step G's). A file is named from its folder's `backend/paddock` (or the
 * routes folder), e.g. `shared/eventCancellationQuote.ts`.
 */

export const OLD_WORDS_FILE = path.join(__dirname, 'old-words.json')

export type OldFolder = 'account' | 'accountRoutes' | 'refund' | 'booking'

/** An old file's sentence that staff could see, as step G's words test reads it (admin/words.test.ts). */
export interface OldAdminWord {
  kind: 'thrown' | 'message' | 'route' | 'record' | 'const' | 'fallback' | 'returned'
  text: string
  /** The file, from step G's copy's root. */
  file: string
}

export interface OldWords {
  about: string
  /** Every string literal under the folder, and the static text of every template literal (its parts joined by NUL). */
  folders: Record<OldFolder, { strings: string[]; templates: string[] }>
  /** `<folder>:<type>`: the string members of a union type alias, in source order. */
  unions: Record<string, string[]>
  /** `<folder>:<interface>.<property>`: the string members of a property's type, in source order. */
  propertyUnions: Record<string, string[]>
  /** The few things a test read from one old file's text, each as the test read it. */
  facts: {
    /** account `adjustCustomerStoreCredit.ts`: its `const MIN_REASON_LENGTH = …` line. */
    minReasonLength: string
    /** refund `shared/eventCancellationQuote.ts`: QUOTE_REFUSALS, `{ key: { reason, message } }`. */
    quoteRefusals: Record<string, { reason: string; message: string }>
    /** refund `cancelEvent.ts`: its result's reasons (`reason: 'a' | 'b'; message: string`), and every string literal in it. */
    cancelEventReasons: string[]
    cancelEventStrings: string[]
    /** account `shared/membershipPaymentDate.ts`: its string literals in source order (each where it first appears), and its two SQL constants. */
    paymentDateStrings: string[]
    paymentDateSql: { columns: string; join: string }
    /** account `shared/formatIsoDate.ts`: its `const MONTHS = …` line. */
    formatIsoDateMonths: string
    /** admin `shared/eventAttendeeList.ts`: the two parts of the loader a test held the Worker's to, and whether it wrote anything. */
    attendeeListLoader: { read: string | null; from: string | null; writes: boolean }
    /** admin `shared/staffAccess.ts`: INACTIVE_STAFF_MESSAGE. */
    inactiveStaffMessage: string
  }
  /** Step G's copy as admin/words.test.ts reads it: its file count, every sentence staff could see, and each function's reasons. */
  admin: { files: number; words: OldAdminWord[]; reasons: Record<string, string[]> }
}

export const OLD_WORDS: OldWords = JSON.parse(readFileSync(OLD_WORDS_FILE, 'utf8')) as OldWords

/** A folder's strings and templates, as the old code's parser answered them before W65. */
export function oldWords(folder: OldFolder): { strings: Set<string>; templates: string[] } {
  const recorded = OLD_WORDS.folders[folder]
  return { strings: new Set(recorded.strings), templates: [...recorded.templates] }
}

/**
 * The string members of a union type alias of the old code, by its name (each is declared once). Named by type, not by
 * file: the removal guard refuses a gone module's path.
 */
export function oldUnionMembers(folder: OldFolder, typeName: string): string[] {
  const members = OLD_WORDS.unions[`${folder}:${typeName}`]
  if (!members) throw new Error(`${typeName} isn't a union of strings in the ${folder} copy`)
  return [...members]
}

/** The string members of a property's type inside an interface of the old code, by the interface's name. */
export function oldPropertyUnionMembers(folder: OldFolder, interfaceName: string, property: string): string[] {
  const members = OLD_WORDS.propertyUnions[`${folder}:${interfaceName}.${property}`]
  if (!members) throw new Error(`${interfaceName}.${property} isn't a union of strings in the ${folder} copy`)
  return [...members]
}

/** The templates `text` fills in: their static parts, in order, with anything between (as the old code's parser had it, unchanged). */
export function templatesFilledBy(templates: readonly string[], text: string): string[] {
  return templates.filter((template) => {
    const parts = template.split('\u0000')
    const pattern = new RegExp(`^${parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\S]*?')}$`)
    // At least a few words of fixed text: a template that is all placeholders would fit anything.
    return parts.length > 1 && parts.join('').trim().length >= 12 && pattern.test(text)
  })
}

/** Every string a file's source holds between quotes of any kind, for "the dialog still says this" checks (as the old code's parser had it, unchanged). */
export function sourceHolds(file: string, words: string): boolean {
  const source = readFileSync(file, 'utf8')
  return [`'${words}'`, `"${words}"`, `\`${words}\``].some((quoted) => source.includes(quoted)) || source.includes(`>${words}<`)
}
