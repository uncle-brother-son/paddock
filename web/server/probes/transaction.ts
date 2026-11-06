import 'server-only'
import { z } from 'zod'
import { audit } from '@/server/audit'
import type { Db } from '@/server/db'
import { claimIdempotencyKey, completeIdempotencyKey, hashRequest, type IdempotencyScope } from '@/server/http/idempotency'

/**
 * One real transaction through Hyperdrive, rolled back so nothing is kept (brief W04). It does what
 * an order's T1 will: claims an idempotency key, writes an audit row, locks a row, runs about as
 * many short statements as T1, then undoes it all and checks from outside that nothing stayed.
 *
 * The schemas live here, not in contracts/: only the lead calls this, never the staff app. Remove
 * this file and its route at W16.
 */

export const probeTransactionInputSchema = z.object({
  /** Short statements to run inside the transaction. T1 is expected to be 30 to 60. */
  statements: z.number().int().min(1).max(60).default(40),
})

export const probeTransactionOutputSchema = z.object({
  /** The answer: true only if the rows were there inside the transaction and gone after it. */
  passed: z.boolean(),
  inside: z.object({
    idempotencyRows: z.number(),
    auditRows: z.number(),
    /** Every statement ran on one backend, so the transaction held its connection. */
    oneConnection: z.boolean(),
    /** now() stayed put while clock_timestamp() moved: why W03 plan 2.4 item 7 matters. */
    nowFixed: z.boolean(),
    clockMoved: z.boolean(),
    statementTimeout: z.string(),
    lockTimeout: z.string(),
    idleTimeout: z.string(),
  }),
  after: z.object({ idempotencyRows: z.number(), auditRows: z.number() }),
  timingsMs: z.object({
    /** Taking a connection, BEGIN and setting the timeouts. */
    open: z.number(),
    idempotencyClaim: z.number(),
    auditWrite: z.number(),
    rowLock: z.number(),
    statements: z.number(),
    statementAverage: z.number(),
    statementSlowest: z.number(),
    rollback: z.number(),
    /** From before the transaction to after the rollback. */
    total: z.number(),
  }),
})

export type ProbeTransactionOutput = z.output<typeof probeTransactionOutputSchema>

class RollBackTheProbe extends Error {}

interface Facts {
  pid: number
  now_at: string
  clock_at: string
}

const FACTS = `SELECT pg_backend_pid() AS pid, now()::text AS now_at, clock_timestamp()::text AS clock_at`

interface ProbeInput {
  db: Db
  staffId: string
  requestId: string
  statements: number
  now?: () => number
}

export async function probeTransaction({ db, staffId, requestId, statements, now = Date.now }: ProbeInput): Promise<ProbeTransactionOutput> {
  const scope: IdempotencyScope = { actorType: 'staff', actorId: staffId, endpoint: 'POST probe/transaction', key: `probe-${requestId}` }
  const countIdempotency = async (from: Pick<Db, 'query'>) =>
    Number(
      (
        await from.query<{ n: string }>(
          'SELECT count(*) AS n FROM api_idempotency WHERE actor_type = $1 AND actor_id = $2 AND endpoint = $3 AND key = $4',
          [scope.actorType, scope.actorId, scope.endpoint, scope.key]
        )
      )[0]?.n
    )
  const countAudit = async (from: Pick<Db, 'query'>) =>
    Number((await from.query<{ n: string }>('SELECT count(*) AS n FROM audit_log WHERE request_id = $1', [requestId]))[0]?.n)

  const started = now()
  let opened = started
  let inside: ProbeTransactionOutput['inside'] | undefined
  const timings = { idempotencyClaim: 0, auditWrite: 0, rowLock: 0, statements: 0, statementSlowest: 0 }
  let finishedWork = started

  try {
    await db.transaction(async (tx) => {
      opened = now()
      const first = (await tx.query<Facts>(FACTS))[0] as Facts
      const settings = (
        await tx.query<{ statement_timeout: string; lock_timeout: string; idle_timeout: string }>(
          `SELECT current_setting('statement_timeout') AS statement_timeout,
                  current_setting('lock_timeout') AS lock_timeout,
                  current_setting('idle_in_transaction_session_timeout') AS idle_timeout`
        )
      )[0]

      let mark = now()
      const stored = await claimIdempotencyKey(tx, scope, await hashRequest({ probe: requestId }))
      if (stored !== null) throw new Error('The probe found its own key already claimed.')
      timings.idempotencyClaim = now() - mark

      mark = now()
      await audit.record(tx, {
        actorType: 'staff',
        actorId: staffId,
        action: 'probe.transaction',
        entityType: 'probe',
        entityId: requestId,
        requestId,
        details: { rolledBack: true },
      })
      timings.auditWrite = now() - mark

      mark = now()
      await tx.selectForUpdate('SELECT id FROM staff WHERE id = $1', [staffId])
      timings.rowLock = now() - mark

      const pids = new Set([first.pid])
      const running = now()
      for (let i = 0; i < statements; i++) {
        mark = now()
        const row = (await tx.query<Facts>(FACTS))[0] as Facts
        pids.add(row.pid)
        timings.statementSlowest = Math.max(timings.statementSlowest, now() - mark)
      }
      timings.statements = now() - running

      await completeIdempotencyKey(tx, scope, { status: 200, body: { probe: true } })

      const last = (await tx.query<Facts>(FACTS))[0] as Facts
      inside = {
        idempotencyRows: await countIdempotency(tx),
        auditRows: await countAudit(tx),
        oneConnection: pids.size === 1 && pids.has(last.pid),
        nowFixed: first.now_at === last.now_at,
        clockMoved: first.clock_at !== last.clock_at,
        statementTimeout: settings?.statement_timeout ?? '',
        lockTimeout: settings?.lock_timeout ?? '',
        idleTimeout: settings?.idle_timeout ?? '',
      }
      finishedWork = now()
      throw new RollBackTheProbe()
    })
  } catch (err) {
    if (!(err instanceof RollBackTheProbe)) throw err
  }

  const rolledBack = now()
  const after = { idempotencyRows: await countIdempotency(db), auditRows: await countAudit(db) }
  if (!inside) throw new Error('The probe transaction finished without rolling back.')
  const seen: ProbeTransactionOutput['inside'] = inside

  return {
    passed: seen.idempotencyRows === 1 && seen.auditRows === 1 && seen.oneConnection && after.idempotencyRows === 0 && after.auditRows === 0,
    inside: seen,
    after,
    timingsMs: {
      open: opened - started,
      idempotencyClaim: timings.idempotencyClaim,
      auditWrite: timings.auditWrite,
      rowLock: timings.rowLock,
      statements: timings.statements,
      statementAverage: Math.round((timings.statements / statements) * 10) / 10,
      statementSlowest: timings.statementSlowest,
      rollback: rolledBack - finishedWork,
      total: rolledBack - started,
    },
  }
}
