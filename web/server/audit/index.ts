import 'server-only'
import type { Tx } from '@/server/db'

export interface AuditEntry {
  actorType: 'staff' | 'customer' | 'system'
  /** The staff or customer id; null for the system. */
  actorId: string | null
  /** What happened, as noun.verb, e.g. 'booking.cancel'. */
  action: string
  entityType: string
  entityId: string
  requestId: string
  details?: { readonly [key: string]: unknown }
}

export const audit = {
  /** Takes a tx, not a db, so the record and the change commit or roll back together. */
  async record(tx: Tx, entry: AuditEntry): Promise<void> {
    await tx.query(
      `INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, request_id, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [entry.actorType, entry.actorId, entry.action, entry.entityType, entry.entityId, entry.requestId, entry.details ?? {}]
    )
  },

  /**
   * Several records in one statement, a round trip saved. Inside a transaction now() doesn't move,
   * so `at` is set from the clock, a millisecond apart (the drivers read times to the millisecond),
   * to keep them in the order given.
   */
  async recordAll(tx: Tx, entries: readonly AuditEntry[]): Promise<void> {
    if (entries.length === 0) return
    const rows = entries.map((entry, i) => ({
      position: i + 1,
      actor_type: entry.actorType,
      actor_id: entry.actorId,
      action: entry.action,
      entity_type: entry.entityType,
      entity_id: entry.entityId,
      request_id: entry.requestId,
      details: entry.details ?? {},
    }))
    await tx.query(
      `WITH clock AS (SELECT clock_timestamp() AS at)
       INSERT INTO audit_log (at, actor_type, actor_id, action, entity_type, entity_id, request_id, details)
       SELECT clock.at + r.position * interval '1 millisecond', r.actor_type, r.actor_id, r.action, r.entity_type, r.entity_id, r.request_id, r.details
       FROM clock
       CROSS JOIN jsonb_to_recordset($1::jsonb) AS r(position int, actor_type text, actor_id text, action text, entity_type text, entity_id text, request_id text, details jsonb)`,
      [rows]
    )
  },
}
