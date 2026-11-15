// Brief W32 (a named difference against W21's, W28's and W30's recordings): every finished claim keeps its card
// refunds' ids and statuses (`refunds` on its `…refund_finished` row), which the refund watch follows. The old code
// kept none, so no golden file has them: this is the one rule the three sides' row checks hold the new field to.

const round2 = (n: number): number => Math.round(n * 100) / 100
const FIELDS = ['amount', 'orderId', 'paymentIntentId', 'refundId', 'status']
const STATUSES: ReadonlySet<string> = new Set(['succeeded', 'pending', 'requires_action'])

type Part = { orderId?: string; paymentIntentId?: string; amount?: number }

/**
 * What is wrong with a finished row's `refunds`, or null. Present exactly when card money is recorded as gone; one
 * entry per card part that went, naming a part the claim planned (its order, its PaymentIntent, its amount) and
 * Stripe's refund for it; the entries add up to the card money recorded.
 */
export function refundsKeptProblem(finished: Record<string, unknown>, claim: Record<string, unknown>): string | null {
  const card = Number(finished['cardRefunded'] ?? 0)
  const kept = finished['refunds']
  if (!(card > 0)) return kept === undefined ? null : 'refunds kept with no card money gone'
  if (!Array.isArray(kept) || kept.length === 0) return 'card money gone with no refund kept'
  const planned = (((claim['plan'] ?? {}) as { card?: Part[] }).card ?? []) as Part[]
  const orders = new Set<string>()
  let total = 0
  for (const entry of kept as Array<Record<string, unknown>>) {
    if (Object.keys(entry).sort().join() !== FIELDS.join()) return "a kept refund's fields"
    if (typeof entry['refundId'] !== 'string' || entry['refundId'] === '') return 'a kept refund with no id'
    if (!STATUSES.has(String(entry['status']))) return `a kept refund that never went (${String(entry['status'])})`
    const part = planned.find((one) => one.orderId === entry['orderId'])
    if (!part || part.paymentIntentId !== entry['paymentIntentId'] || part.amount !== entry['amount']) return 'a kept refund is not a planned part'
    if (orders.has(String(entry['orderId']))) return 'two kept refunds for one part'
    orders.add(String(entry['orderId']))
    total = round2(total + Number(entry['amount']))
  }
  return total === round2(card) ? null : 'the kept refunds are not the card money recorded'
}

// Brief W32a (lead call 1; a named difference against the same recordings): every card refund a finished claim keeps
// is watched, whatever its status, so each of those rows now has a `refund.watch` row (`watching`) beside it, where
// W32 wrote one only for a refund not yet `succeeded` (none in any recording). The golden files have none. This is the
// one rule the three sides hold those rows to.

export const REFUND_WATCH_ROW = 'refund.watch'

type WatchRow = { id?: unknown; action?: unknown; entity_type?: unknown; entity_id?: unknown; details?: Record<string, unknown> | null }
const WATCHING_FIELDS = ['amount', 'claimId', 'lines', 'livemode', 'on', 'orderId', 'paymentIntentId', 'refundId', 'state', 'status', 'subjectId']
const CHECKED_FIELDS = ['reason', 'refundId', 'state', 'status']

/**
 * What is wrong with a recording's refund watch rows, empty when nothing is. `on`: the subject the side's claims are on;
 * `finishedAction`: its finished rows. Each refund a finished row keeps has exactly one `watching` row, on the refund's
 * id, saying exactly what the claim and the kept refund say (the subject, the claim, the part's PaymentIntent, amount
 * and lines, the refund's status, the claim's key mode; the order the money would be owed on, none for a booking). No
 * other watch row exists, but the `checked` row of a later read of a watched refund (a scenario that runs for days).
 */
export function refundWatchProblems(all: readonly WatchRow[], on: 'booking' | 'order' | 'event_booking', finishedAction: string): string[] {
  const problems: string[] = []
  const watchRows = all.filter((row) => row.action === REFUND_WATCH_ROW)
  const expected = new Set<WatchRow>()
  for (const finished of all.filter((row) => row.action === finishedAction && Array.isArray(row.details?.['refunds']))) {
    const claim = all.find((other) => other.id === finished.details?.['claimId'])
    const planned = (((claim?.details?.['plan'] ?? {}) as { card?: Array<{ orderId?: string; lines?: unknown }> }).card ?? []) as Array<{ orderId?: string; lines?: unknown }>
    for (const kept of finished.details?.['refunds'] as Array<Record<string, unknown>>) {
      const rows = watchRows.filter((row) => row.entity_id === kept['refundId'] && row.details?.['state'] === 'watching')
      const row = rows[0]
      if (rows.length !== 1 || !row) {
        problems.push(`${REFUND_WATCH_ROW}: ${rows.length} watching rows for the kept refund ${String(kept['refundId'])}`)
        continue
      }
      expected.add(row)
      const details = row.details ?? {}
      const should = {
        state: 'watching',
        refundId: kept['refundId'],
        paymentIntentId: kept['paymentIntentId'],
        amount: kept['amount'],
        status: kept['status'],
        livemode: claim?.details?.['livemode'],
        on,
        subjectId: finished.entity_id,
        orderId: on === 'booking' ? null : kept['orderId'],
        claimId: finished.details?.['claimId'],
        lines: planned.find((part) => part.orderId === kept['orderId'])?.lines,
      }
      if (Object.keys(details).sort().join() !== WATCHING_FIELDS.join() || JSON.stringify(Object.entries(details).sort()) !== JSON.stringify(Object.entries(should).sort())) {
        problems.push(`${REFUND_WATCH_ROW}: the watching row is not what the claim and its kept refund say (${JSON.stringify(details)})`)
      }
      if (row.entity_type !== 'refund_watch') problems.push(`${REFUND_WATCH_ROW}: entity ${String(row.entity_type)}`)
    }
  }
  const watched = new Set([...expected].map((row) => row.entity_id))
  for (const row of watchRows) {
    if (expected.has(row)) continue
    const details = row.details ?? {}
    const laterRead = details['state'] === 'checked' && watched.has(row.entity_id) && details['refundId'] === row.entity_id && Object.keys(details).sort().join() === CHECKED_FIELDS.join()
    if (!laterRead) problems.push(`${REFUND_WATCH_ROW}: a row no kept refund accounts for (${JSON.stringify(details)})`)
  }
  return problems
}
