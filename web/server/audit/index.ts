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
}
