import catalog from '../live-catalog.json'

/**
 * Turns what a run left behind into something two runs can be compared on, and compares them.
 *
 * Generated ids become labels (`orders#1`), timestamps become `<set>` (so set against unset still
 * shows), money is compared to the penny, and random values such as gift card codes become labels.
 * Everything else must match exactly. Row order is part of the comparison: rows are read the way
 * the app reads them, `ORDER BY created_at, id`, and `tied` counts rows sharing a created_at.
 * Inside a real transaction now() doesn't move, so rows that used to have an order have none: that
 * shows in `tied` every time, not just when the random ids happen to sort the wrong way.
 */

export type Row = Record<string, unknown>

export interface TableChange {
  /** New rows, in the app's reading order. */
  added: Row[]
  /** Rows from the seed that changed: the primary key, then each changed column as [before, after]. */
  changed: Row[]
  /** The primary keys of seed rows that went. */
  removed: unknown[]
  /** New rows that share a created_at with another new row. */
  tied: number
}

export interface StripeCallRecord {
  method: string
  params: unknown
  idempotencyKey: string | null
}

export interface Recording {
  scenario: string
  /** What each call returned: what staff see. */
  results: unknown[]
  stripeCalls: StripeCallRecord[]
  /** Only the tables that changed. */
  tables: Record<string, TableChange>
}

/** Raw rows by table, in the app's reading order. */
export type TableDump = Record<string, Row[]>

interface TableInfo {
  columns: Map<string, string>
  primaryKey: string[]
  orderedBy: string | null
}

export const TABLES: ReadonlyMap<string, TableInfo> = new Map(
  catalog.tables.map((table) => {
    const pk = catalog.constraints.find((k) => k.table === table.name && k.type === 'p')
    const primaryKey = /\(([^)]+)\)/.exec(pk?.definition ?? '')?.[1]?.split(', ') ?? []
    const columns = new Map(table.columns.map((c) => [c.name, c.type]))
    const orderedBy = columns.has('created_at') ? 'created_at' : columns.has('at') ? 'at' : null
    return [table.name, { columns, primaryKey, orderedBy }]
  })
)

/** Values that differ by chance on every run, and how to name them. */
const RANDOM_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  gift_cards: ['code'],
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const ISO_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:\d{2})?)?$/
/** A booking's updated_at inside a Stripe key, wherever the key is. The clock moves per statement, and
 *  the shadow adds some. */
const TIME_IN_KEY = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}(:\d{2})?/g
const EVENT_KEY_IDS = /^(event-refund:[^:]+:\d+:\d+:)[0-9a-f]{8}(:)/
const ORDER_KEY_IDS = /^(order-refund:[^:]+:)[0-9a-f]{8}(:)/

function collectUuids(value: unknown, into: Set<string>): void {
  if (typeof value === 'string') {
    for (const match of value.matchAll(UUID)) into.add(match[0].toLowerCase())
  } else if (Array.isArray(value)) {
    value.forEach((item) => collectUuids(item, into))
  } else if (value !== null && typeof value === 'object') {
    Object.values(value).forEach((item) => collectUuids(item, into))
  }
}

/** Replaces generated ids and random values, and tidies times and money, anywhere in a value. */
class Labeller {
  private readonly labels = new Map<string, string>()
  private unknown = 0

  constructor(private readonly seedIds: ReadonlySet<string>) {}

  set(raw: string, label: string): void {
    if (!this.labels.has(raw)) this.labels.set(raw, label)
  }

  private uuid(raw: string): string {
    const id = raw.toLowerCase()
    if (this.seedIds.has(id)) return id
    const known = this.labels.get(id)
    if (known) return known
    // An id with no row left, such as an order that was rolled back.
    this.unknown += 1
    const label = `gone#${this.unknown}`
    this.labels.set(id, label)
    return label
  }

  text(value: string): string {
    if (ISO_TIME.test(value)) return '<time>'
    let result = value.replace(UUID, (raw) => this.uuid(raw))
    // A charge's key is also written to audit_log before the charge (W05j), so its time is hidden
    // there too, as in the Stripe calls below.
    if (result.startsWith('booking-charge:')) result = result.replace(TIME_IN_KEY, '<time>')
    // An event or order refund's key names its places or lines by a hash of their ids, which are new
    // on every run (W05j); W05k's scenarios are the first to record one.
    result = result.replace(EVENT_KEY_IDS, '$1<ids>$2').replace(ORDER_KEY_IDS, '$1<ids>$2')
    for (const [raw, label] of this.labels) {
      if (!raw.match(UUID) && result.includes(raw)) result = result.split(raw).join(label)
    }
    return result
  }

  value(value: unknown): unknown {
    if (typeof value === 'string') return this.text(value)
    if (typeof value === 'number') return Number.isInteger(value) ? value : Math.round(value * 100) / 100
    if (Array.isArray(value)) return value.map((item) => this.value(item))
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value)
          .filter(([, item]) => item !== undefined)
          .map(([key, item]) => [key, this.value(item)])
      )
    }
    return value
  }

  column(type: string, value: unknown): unknown {
    if (value === null || value === undefined) return null
    if (type.startsWith('timestamp')) return '<set>'
    if (type.startsWith('numeric')) return Number(value).toFixed(2)
    return this.value(value)
  }
}

function keyOf(row: Row, primaryKey: readonly string[]): string {
  return primaryKey.map((column) => String(row[column])).join('|')
}

function normaliseRow(table: string, row: Row, labeller: Labeller): Row {
  const info = TABLES.get(table)
  if (!info) throw new Error(`The catalog has no table ${table}.`)
  return Object.fromEntries(Object.entries(row).map(([column, value]) => [column, labeller.column(info.columns.get(column) ?? 'text', value)]))
}

/** Rows with the same created_at have no real order, so they are put in a fixed one. */
function settleTies(rows: Row[], orderedBy: string | null, seedIds: ReadonlySet<string>): Row[] {
  if (orderedBy === null) return rows
  const fingerprint = (row: Row) => JSON.stringify(row, (_, value: unknown) => (typeof value === 'string' ? value.replace(UUID, (raw) => (seedIds.has(raw.toLowerCase()) ? raw : '')) : value))
  const groups = new Map<unknown, Row[]>()
  for (const row of rows) groups.set(row[orderedBy], [...(groups.get(row[orderedBy]) ?? []), row])
  return [...groups.values()].flatMap((group) => [...group].sort((a, b) => fingerprint(a).localeCompare(fingerprint(b))))
}

function countTied(rows: readonly Row[], orderedBy: string | null): number {
  if (orderedBy === null) return 0
  const counts = new Map<unknown, number>()
  for (const row of rows) counts.set(row[orderedBy], (counts.get(row[orderedBy]) ?? 0) + 1)
  return [...counts.values()].filter((n) => n > 1).reduce((sum, n) => sum + n, 0)
}

export interface RawRun {
  scenario: string
  before: TableDump
  after: TableDump
  results: unknown[]
  stripeCalls: StripeCallRecord[]
}

export function buildRecording(run: RawRun): Recording {
  const seedIds = new Set<string>()
  collectUuids(run.before, seedIds)

  const newRows = new Map<string, Row[]>()
  for (const [table, rows] of Object.entries(run.after)) {
    const info = TABLES.get(table)
    if (!info) throw new Error(`The catalog has no table ${table}.`)
    const seeded = new Set((run.before[table] ?? []).map((row) => keyOf(row, info.primaryKey)))
    const added = rows.filter((row) => !seeded.has(keyOf(row, info.primaryKey)))
    newRows.set(table, settleTies(added, info.orderedBy, seedIds))
  }

  // Label every new row before normalising any, so a foreign key finds its label whichever table
  // comes first.
  const labeller = new Labeller(seedIds)
  for (const [table, rows] of newRows) {
    const info = TABLES.get(table)
    rows.forEach((row, index) => {
      const id = row['id']
      if (typeof id === 'string' && info?.primaryKey.includes('id')) labeller.set(id.toLowerCase(), `${table}#${index + 1}`)
      for (const column of RANDOM_COLUMNS[table] ?? []) {
        if (typeof row[column] === 'string') labeller.set(row[column], `<${column}#${index + 1}>`)
      }
    })
  }

  const tables: Record<string, TableChange> = {}
  for (const [table, rows] of newRows) {
    const info = TABLES.get(table)
    if (!info) continue
    const before = run.before[table] ?? []
    const after = run.after[table] ?? []
    const afterByKey = new Map(after.map((row) => [keyOf(row, info.primaryKey), row]))

    const changed: Row[] = []
    const removed: unknown[] = []
    for (const old of before) {
      const key = keyOf(old, info.primaryKey)
      const now = afterByKey.get(key)
      if (!now) {
        removed.push(labeller.value(key))
        continue
      }
      const was = normaliseRow(table, old, labeller)
      const is = normaliseRow(table, now, labeller)
      // Timestamps show only as set or unset, so a row written and put back counts as unchanged.
      const columns = Object.keys(is).filter((c) => JSON.stringify(was[c]) !== JSON.stringify(is[c]))
      if (columns.length > 0) {
        changed.push({
          [info.primaryKey.join('|')]: labeller.value(key),
          ...Object.fromEntries(columns.map((c) => [c, [was[c], is[c]]])),
        })
      }
    }

    if (rows.length > 0 || changed.length > 0 || removed.length > 0) {
      tables[table] = {
        added: rows.map((row) => normaliseRow(table, row, labeller)),
        changed,
        removed,
        tied: countTied(rows, info.orderedBy),
      }
    }
  }

  return {
    scenario: run.scenario,
    results: run.results.map((result) => labeller.value(result)),
    stripeCalls: run.stripeCalls.map((call) => ({
      method: call.method,
      params: labeller.value(call.params),
      idempotencyKey: call.idempotencyKey === null ? null : labeller.text(call.idempotencyKey).replace(TIME_IN_KEY, '<time>'),
    })),
    tables,
  }
}

/**
 * W11: the same recording with each `gone#N` label renumbered by where it is first met: the answers,
 * then the Stripe calls, then the tables. An id with no row left is numbered as it is met while the
 * tables are labelled, so a side that keeps rows naming it (the Worker's audit and idempotency rows)
 * numbers it differently. Renumbering both sides the same way keeps which label is which within a
 * recording, so two different gone ids still can't pass as one.
 */
export function withCanonicalGoneNumbers(recording: Recording): Recording {
  const numbers = new Map<string, string>()
  const renumber = (text: string): string =>
    text.replace(/gone#\d+/g, (label) => {
      const known = numbers.get(label)
      if (known) return known
      const next = `gone#${numbers.size + 1}`
      numbers.set(label, next)
      return next
    })
  const walkValue = (value: unknown): unknown => {
    if (typeof value === 'string') return renumber(value)
    if (Array.isArray(value)) return value.map(walkValue)
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, walkValue(inner)]))
    return value
  }
  const results = walkValue(recording.results) as unknown[]
  const stripeCalls = walkValue(recording.stripeCalls) as StripeCallRecord[]
  const tables = walkValue(recording.tables) as Record<string, TableChange>
  return { ...recording, results, stripeCalls, tables }
}

/**
 * W13: the same recording with each fake Stripe id (`pi_fake_0003`, `sub_fake_0007`, ...) renumbered by
 * where it is first met, per kind, as withCanonicalGoneNumbers does for gone ids. The fake numbers its ids
 * from one sequence, so a side that makes one call more or fewer (the Worker's coupon has a fixed id, so it
 * takes no number) shifts every later id. Renumbering keeps which id is which within a recording, so two
 * different ids still can't pass as one, and the order they are met in is still compared.
 */
export function withCanonicalStripeIds(recording: Recording): Recording {
  const numbers = new Map<string, string>()
  const counts = new Map<string, number>()
  const renumber = (text: string): string =>
    text.replace(/\b([a-z]+)_fake_(?:[a-z0-9]+_)?\d{4}\b/g, (id, kind: string) => {
      const known = numbers.get(id)
      if (known) return known
      const next = (counts.get(kind) ?? 0) + 1
      counts.set(kind, next)
      const label = `${kind}_fake#${next}`
      numbers.set(id, label)
      return label
    })
  const walkValue = (value: unknown): unknown => {
    if (typeof value === 'string') return renumber(value)
    if (Array.isArray(value)) return value.map(walkValue)
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, walkValue(inner)]))
    return value
  }
  return {
    ...recording,
    results: walkValue(recording.results) as unknown[],
    stripeCalls: walkValue(recording.stripeCalls) as StripeCallRecord[],
    tables: walkValue(recording.tables) as Record<string, TableChange>,
  }
}

export interface Difference {
  path: string
  expected: unknown
  actual: unknown
}

/** A difference we mean to have. Every one names who decided it: anything else fails. */
export interface AllowedDifference {
  name: string
  /** Where it was decided, e.g. 'W03-decisions Q9'. */
  decision: string
  path: RegExp
}

function walk(path: string, expected: unknown, actual: unknown, out: Difference[]): void {
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const length = Math.max(expected.length, actual.length)
    for (let i = 0; i < length; i++) {
      if (i >= expected.length) out.push({ path: `${path}[${i}]`, expected: undefined, actual: actual[i] })
      else if (i >= actual.length) out.push({ path: `${path}[${i}]`, expected: expected[i], actual: undefined })
      else walk(`${path}[${i}]`, expected[i], actual[i], out)
    }
    return
  }
  const bothObjects =
    expected !== null && actual !== null && typeof expected === 'object' && typeof actual === 'object' && !Array.isArray(expected) && !Array.isArray(actual)
  if (bothObjects) {
    const a = expected as Row
    const b = actual as Row
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(key in a)) out.push({ path: `${path}.${key}`, expected: undefined, actual: b[key] })
      else if (!(key in b)) out.push({ path: `${path}.${key}`, expected: a[key], actual: undefined })
      else walk(`${path}.${key}`, a[key], b[key], out)
    }
    return
  }
  if (expected !== actual) out.push({ path, expected, actual })
}

/** Every difference between two recordings that nobody decided on, plus any allowance not used. */
export function compareRecordings(expected: Recording, actual: Recording, allowed: readonly AllowedDifference[] = []): Difference[] {
  const found: Difference[] = []
  walk('', { results: expected.results, stripeCalls: expected.stripeCalls, tables: expected.tables }, { results: actual.results, stripeCalls: actual.stripeCalls, tables: actual.tables }, found)

  const used = new Set<AllowedDifference>()
  const left = found.filter((difference) => {
    const allowance = allowed.find((a) => a.path.test(difference.path))
    if (allowance) used.add(allowance)
    return !allowance
  })
  for (const allowance of allowed) {
    if (!used.has(allowance)) {
      left.push({ path: `(allowed difference not seen: ${allowance.name})`, expected: allowance.decision, actual: undefined })
    }
  }
  return left
}
