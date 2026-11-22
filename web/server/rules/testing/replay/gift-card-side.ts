import { vi } from 'vitest'
import type { Db } from '@/server/db'
import type { FakeStripe } from '@/server/stripe/fake'
import { withCanonicalGoneNumbers, type Recording, type Row } from './compare'
import { oldSide, type ReplaySide } from './harness'
import { type GiftCardPressOptions, W38_ACTIONS, giftCardsAsTheScreensPress } from '../sweep/gift-card-presses'

/*
 * W38 (F-plan 4.12 item 3; brief W38 item 5): the gift card actions' side of the replay, beside account-side.ts
 * (W37's). The five old gift card actions go to the staff app's thin wrappers, which call the Worker's routes, and
 * their answers come back in the old functions' shapes. Every other call (an order placed or refunded to set a
 * scenario up, the actions later slices move) still runs through the frozen copies of the old functions, so the seed
 * state is exactly what each golden file recorded.
 * A test file using this mocks @/server/db/connection to the replay database and sets STAFF_API_KEY, as
 * account-side.ts's users do. None of the five touches Stripe or the switch.
 */

// W64: the presses moved to the sweep folder (H-plan 3.3 step 3); re-exported for the old replay's files.
export * from '../sweep/gift-card-presses'

export interface GiftCardSideOptions extends GiftCardPressOptions {
  /** Changes an answer after the Worker gives it: how a test plants a deliberate difference. */
  adjust?: (action: string, answer: unknown) => unknown
  /** Every call, as it was made, for tests that check which side answered. */
  calls?: Array<{ action: string; side: 'new' | 'old' }>
}

/**
 * The new side: the five gift card actions through the staff app's wrappers and the Worker's routes, everything else
 * through the old functions (the frozen copies), on the same database.
 */
export function newGiftCardSide({ adjust, calls, repeatedPress }: GiftCardSideOptions = {}): (db: Db, stripe: FakeStripe) => ReplaySide {
  return (db, stripe) => {
    const old = oldSide(db, stripe)
    const press = giftCardsAsTheScreensPress({ ...(repeatedPress !== undefined ? { repeatedPress } : {}) })
    return {
      name: 'new',
      async call(action, params) {
        if (!W38_ACTIONS.has(action)) {
          calls?.push({ action, side: 'old' })
          return old.call(action, params)
        }
        calls?.push({ action, side: 'new' })
        // The clock moves between presses, as the old side's moves with each statement (harness.ts, tick).
        vi.setSystemTime(Date.now() + 1)
        const answer = await press(db, action, params)
        return adjust ? adjust(action, answer) : answer
      },
    }
  }
}

// --- What is set aside before the two recordings are compared, and checked on its own

type AuditRow = Row & { action?: unknown; entity_type?: unknown; entity_id?: unknown; details?: Record<string, unknown> | null }

/** The Worker's audit rows for W38's three writes (F-plan 4.11). The old functions wrote none. */
export const W38_AUDIT_ROWS: ReadonlySet<string> = new Set(['gift_card.extended', 'gift_card.picked_up', 'gift_card.shipped'])

const auditRows = (recording: Recording): AuditRow[] => (recording.tables['audit_log']?.added ?? []) as AuditRow[]
const giftCardAuditRows = (recording: Recording): AuditRow[] => auditRows(recording).filter((row) => W38_AUDIT_ROWS.has(String(row.action)))

/**
 * A recording as the gift card replay compares it: the Worker's own audit rows set aside (the old functions wrote
 * none), the remaining audit rows' own labels left out (they shift when rows are set aside), and the stored answers
 * set aside (api_idempotency: only the new side has them). Everything else is compared exactly, and what was set
 * aside is checked on its own (giftCardRowProblems, giftCardStoredAnswerProblems).
 */
export function comparableGiftCards(recording: Recording): Recording {
  const aside = new Set(giftCardAuditRows(recording))
  const tables = { ...recording.tables }
  delete tables['api_idempotency']
  const audit = tables['audit_log']
  if (audit) {
    const added = (audit.added as AuditRow[])
      .filter((row) => !aside.has(row))
      .map((row) => {
        const rest: AuditRow = { ...row }
        delete rest['id']
        return rest
      })
    if (added.length === 0 && audit.changed.length === 0 && audit.removed.length === 0) delete tables['audit_log']
    else tables['audit_log'] = { added, changed: audit.changed, removed: audit.removed, tied: 0 }
  }
  return withCanonicalGoneNumbers(JSON.parse(JSON.stringify({ ...recording, tables })) as Recording)
}

const sameKeys = (details: Record<string, unknown> | null | undefined, keys: readonly string[]): boolean => JSON.stringify(Object.keys(details ?? {}).sort()) === JSON.stringify([...keys].sort())
const isDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)

const ROUTES = {
  'gift_card.extended': /^POST \/api\/v1\/staff\/gift-cards\/[^/]+\/extend$/,
  'gift_card.picked_up': /^POST \/api\/v1\/staff\/gift-cards\/[^/]+\/picked-up$/,
  'gift_card.shipped': /^POST \/api\/v1\/staff\/gift-cards\/[^/]+\/shipped$/,
} as const

/**
 * What each of the Worker's own audit rows must say, exactly, and that each change has exactly one: one row for each
 * press of a write route that was answered with a success (a stored answer of 200), and none for a refusal. An
 * extension's row carries the dates the card's own row moved between. Answers the problems found, empty when all is
 * right.
 */
export function giftCardRowProblems(recording: Recording): string[] {
  const problems: string[] = []
  const rows = giftCardAuditRows(recording)
  const stored = (recording.tables['api_idempotency']?.added ?? []) as Row[]
  const cards = (recording.tables['gift_cards']?.changed ?? []) as Row[]
  for (const row of rows) {
    const d = row.details ?? {}
    const wrong = (why: string) => problems.push(`${String(row.action)}: ${why} (${JSON.stringify(d)})`)
    const byStaff = row['actor_type'] === 'staff' && typeof row['actor_id'] === 'string' && row['actor_id'] !== '' && typeof row['request_id'] === 'string' && row['request_id'] !== ''
    if (!byStaff) wrong('actor or request id')
    if (row['entity_type'] !== 'gift_card' || typeof row['entity_id'] !== 'string' || row['entity_id'] === '') wrong('entity')
    if (row.action === 'gift_card.extended') {
      if (!sameKeys(d, ['months', 'expiryBefore', 'expiryAfter', 'countedFrom', 'voidedBefore'])) wrong('fields')
      if (!Number.isInteger(d['months']) || Number(d['months']) <= 0) wrong('the months')
      if (!isDate(d['expiryBefore']) || !isDate(d['expiryAfter']) || !(d['expiryAfter'] > d['expiryBefore'])) wrong('the dates')
      if (d['countedFrom'] !== 'today' && d['countedFrom'] !== 'expiry') wrong('what the months were counted from')
      if (typeof d['voidedBefore'] !== 'boolean') wrong('whether it was voided')
    } else {
      const flag = row.action === 'gift_card.picked_up' ? 'pickedUp' : 'shipped'
      const before = (d['before'] ?? {}) as Record<string, unknown>
      if (!sameKeys(d, [flag, 'before']) || !sameKeys(before, [flag, 'at', 'by'])) wrong('fields')
      if (typeof d[flag] !== 'boolean' || typeof before[flag] !== 'boolean') wrong('the flag')
      // Set before: when and who are there. Not set before: neither is.
      if (before[flag] === true ? typeof before['at'] !== 'string' : before['at'] !== null || before['by'] !== null) wrong('when and who before')
    }
  }
  const of = (action: string) => rows.filter((row) => row.action === action)
  for (const [action, route] of Object.entries(ROUTES)) {
    const presses = stored.filter((row) => route.test(String(row['endpoint'])) && row['http_status'] === 200).length
    if (of(action).length !== presses) problems.push(`${action}: ${of(action).length} rows for ${presses} presses answered with a success`)
  }
  // The dates a card's own row moved between are the first extension's "before" and the last one's "after".
  for (const card of cards) {
    const moved = card['expiry_date']
    if (!Array.isArray(moved)) continue
    const own = of('gift_card.extended').filter((row) => row['entity_id'] === card['id'])
    if (own.length === 0) problems.push(`gift card ${String(card['id'])}: its expiry moved with no audit row`)
    else if (own[0]?.details?.['expiryBefore'] !== moved[0] || own.at(-1)?.details?.['expiryAfter'] !== moved[1]) problems.push(`gift card ${String(card['id'])}: its audit rows don't carry the dates it moved between`)
  }
  for (const row of of('gift_card.extended')) {
    if (!cards.some((card) => card['id'] === row['entity_id'] && Array.isArray(card['expiry_date']))) problems.push(`gift_card.extended: no card's expiry moved with it (${String(row['entity_id'])})`)
  }
  return problems
}

/** The stored answers the new side wrote: each a finished press of one of W38's three write routes on the Worker. */
export function giftCardStoredAnswerProblems(recording: Recording): string[] {
  const rows = (recording.tables['api_idempotency']?.added ?? []) as Row[]
  const route = /^POST \/api\/v1\/staff\/gift-cards\/[^/]+\/(extend|picked-up|shipped)$/
  return rows.filter((row) => row['status'] !== 'done' || !route.test(String(row['endpoint']))).map((row) => `${String(row['endpoint'])}: ${String(row['status'])}`)
}
