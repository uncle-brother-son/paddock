// Ported in W37 from the staff app's adjustMembershipCredits.ts, getMembershipCreditAdjustments.ts and
// setMembershipHerd.ts (F-plan 1.4, 4.5; brief W37 items 2 and 3; bugs FB7 to FB11). None touches Stripe, so each
// write is one transaction with nothing to hold: the rows locked, the old checks and words, the change, its record
// and its audit row together. A refusal is a throw, so nothing of it is kept.
import 'server-only'
import type { AdjustMembershipCreditsInput, AdjustMembershipCreditsOutput, MembershipCreditAdjustmentRow, SetMembershipHerdOutput } from '@/contracts'
import { audit } from '@/server/audit'
import type { Db, Queryable, Tx } from '@/server/db'
import { accountRefusal, type AccountOptions } from '@/server/rules/account/refusal'
import { HERD_NOT_FOUND_MESSAGE, ISSUE_REFUNDS_NEEDED_MESSAGE, MEMBERSHIP_CREDIT_NEW_WORDS, MEMBERSHIP_CREDIT_WORDS } from './failure-messages'

export const CREDIT_TYPES = ['session', 'addon'] as const
export type CreditType = (typeof CREDIT_TYPES)[number]

/**
 * The locks, in LOCK_ORDER (server/rules/orders/locks.ts): the membership's current credit period, then the
 * membership. A booking paid with a session credit locks that credit period (lockForOrder, lockForBooking), and one
 * that draws or returns an add-on credit locks the membership, so an adjustment queues behind either and they behind
 * it (FB7). The period is taken only for a session adjustment: `$2`. The second lateral names the first, so Postgres
 * takes them in this order. No row when the membership doesn't exist.
 */
export const CREDIT_ADJUSTMENT_LOCK_SQL = `
SELECT m.id AS membership_id, p.id AS period_id
FROM (SELECT $1::uuid AS id) wanted
LEFT JOIN LATERAL (
  SELECT id FROM membership_credit_periods
  WHERE membership_id = wanted.id
    AND $2::boolean
    AND (now() AT TIME ZONE 'Europe/London')::date BETWEEN period_start AND period_end
  FOR NO KEY UPDATE
) p ON true
JOIN LATERAL (
  SELECT id FROM customer_memberships WHERE id = wanted.id AND (p.id IS NULL OR p.id IS NOT NULL) FOR NO KEY UPDATE
) m ON true`

interface CreditFacts {
  is_unlimited: boolean
  addon_credits_remaining: number
  period_id: string | null
  credits_allocated: number | null
  credits_used: number | null
  period_start: string | null
  period_end: string | null
}

/**
 * Read in its own statement, after the locks: a statement that waited for a lock still counts the bookings it saw
 * before waiting (server/rules/README.md, "Locks before reads").
 */
async function readCreditFacts(tx: Tx, membershipId: string): Promise<CreditFacts | null> {
  const rows = await tx.query<CreditFacts>(
    `SELECT mp.is_unlimited, cm.addon_credits_remaining, mcc.period_id, mcc.credits_allocated, mcc.credits_used,
            mcc.period_start::text AS period_start, mcc.period_end::text AS period_end
     FROM customer_memberships cm
     JOIN membership_plans mp ON mp.id = cm.plan_id
     LEFT JOIN membership_current_credits mcc ON mcc.membership_id = cm.id
     WHERE cm.id = $1::uuid`,
    [membershipId]
  )
  return rows[0] ?? null
}

/**
 * adjustMembershipCredits. Issue refunds, then a whole number that isn't 0, one of the two credit types and a reason
 * (FB10: the old function took an empty one). Then one transaction (FB8) under the locks above:
 *  - session: the current period's allocation moved by the amount from what is there now (FB7: the old function wrote
 *    a figure worked out before the write), refused if that would leave it below what is used;
 *  - add-on: the membership's balance moved by the amount, refused below zero (FB10);
 *  - the adjustment row (membership_credit_adjustments) and a `membership.credits_adjusted` audit row.
 * The route's press key stops a repeated press adding twice (FB9). No upper limit (lead call L14).
 */
export async function adjustMembershipCredits(db: Db, membershipId: string, input: AdjustMembershipCreditsInput, options: AccountOptions): Promise<AdjustMembershipCreditsOutput> {
  if (!options.actor.canIssueRefunds) throw accountRefusal('FORBIDDEN', 'credits', 'permission_denied', MEMBERSHIP_CREDIT_WORDS.permissionDenied)
  const { amount } = input
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount === 0) {
    throw accountRefusal('VALIDATION', 'credits', 'amount_invalid', MEMBERSHIP_CREDIT_WORDS.amountInvalid, { field: 'amount' })
  }
  if (!(CREDIT_TYPES as readonly string[]).includes(input.creditType)) {
    throw accountRefusal('VALIDATION', 'credits', 'credit_type_invalid', MEMBERSHIP_CREDIT_NEW_WORDS.creditTypeInvalid, { field: 'creditType' })
  }
  const creditType = input.creditType as CreditType
  const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
  if (!reason) throw accountRefusal('VALIDATION', 'credits', 'reason_required', MEMBERSHIP_CREDIT_NEW_WORDS.reasonRequired, { field: 'reason' })

  return db.transaction(async (tx) => {
    const [locked] = await tx.query<{ membership_id: string; period_id: string | null }>(CREDIT_ADJUSTMENT_LOCK_SQL, [membershipId, creditType === 'session'])
    const facts = locked ? await readCreditFacts(tx, membershipId) : null
    if (!locked || !facts) throw accountRefusal('NOT_FOUND', 'credits', 'membership_not_found', MEMBERSHIP_CREDIT_WORDS.notFound)

    let output: AdjustMembershipCreditsOutput
    let before: number
    let after: number
    let periodId: string | null = null
    if (creditType === 'addon') {
      before = facts.addon_credits_remaining
      after = before + amount
      if (after < 0) throw accountRefusal('CONFLICT', 'credits', 'addon_below_zero', MEMBERSHIP_CREDIT_NEW_WORDS.addonBelowZero(after))
      const [row] = await tx.query<{ addon_credits_remaining: number }>(
        'UPDATE customer_memberships SET addon_credits_remaining = addon_credits_remaining + $1, updated_at = now() WHERE id = $2::uuid RETURNING addon_credits_remaining',
        [amount, membershipId]
      )
      if (!row || row.addon_credits_remaining !== after) throw new Error(`Membership ${membershipId} was locked but its add-on credits didn't move as read.`)
      output = { addon_credits_remaining: row.addon_credits_remaining }
    } else {
      if (facts.is_unlimited) throw accountRefusal('CONFLICT', 'credits', 'unlimited', MEMBERSHIP_CREDIT_WORDS.unlimited)
      if (!facts.period_id || !facts.period_start || !facts.period_end) throw accountRefusal('CONFLICT', 'credits', 'no_current_period', MEMBERSHIP_CREDIT_WORDS.noCurrentPeriod)
      // The period read is the one locked: both are "the period covering today's London date" at this transaction's start.
      if (facts.period_id !== locked.period_id) throw new Error(`Membership ${membershipId}'s current credit period was read as ${facts.period_id} but locked as ${locked.period_id}.`)
      periodId = facts.period_id
      before = facts.credits_allocated ?? 0
      const used = facts.credits_used ?? 0
      after = before + amount
      if (after < used) throw accountRefusal('CONFLICT', 'credits', 'below_used', MEMBERSHIP_CREDIT_WORDS.belowUsed(after, used))
      const [row] = await tx.query<{ credits_allocated: number }>(
        'UPDATE membership_credit_periods SET credits_allocated = credits_allocated + $1 WHERE id = $2::uuid RETURNING credits_allocated',
        [amount, periodId]
      )
      if (!row || row.credits_allocated !== after) throw new Error(`Credit period ${periodId} was locked but its allocation didn't move as read.`)
      output = {
        period: { period_id: periodId, credits_allocated: row.credits_allocated, credits_used: used, period_start: facts.period_start, period_end: facts.period_end },
      }
    }

    const [adjustment] = await tx.query<{ id: string }>(
      `INSERT INTO membership_credit_adjustments (membership_id, staff_id, amount, credit_type, reason)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5)
       RETURNING id`,
      [membershipId, options.actor.id, amount, creditType, reason]
    )
    if (!adjustment) throw new Error(`The adjustment of membership ${membershipId} wasn't recorded.`)
    await audit.record(tx, {
      actorType: options.actor.type,
      actorId: options.actor.id,
      action: 'membership.credits_adjusted',
      entityType: 'membership',
      entityId: membershipId,
      requestId: options.requestId,
      details: {
        creditType,
        amount,
        reason,
        before,
        after,
        adjustmentId: adjustment.id,
        ...(periodId ? { periodId, used: facts.credits_used ?? 0 } : {}),
      },
    })
    return output
  })
}

const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value ?? ''))

/** getMembershipCreditAdjustments: every adjustment of the membership, newest first, with who made it. */
export async function listCreditAdjustments(db: Queryable, membershipId: string): Promise<MembershipCreditAdjustmentRow[]> {
  const rows = await db.query<Omit<MembershipCreditAdjustmentRow, 'created_at'> & { created_at: unknown }>(
    `SELECT mca.id, mca.membership_id, mca.staff_id,
            s.first_name AS staff_first_name, s.last_name AS staff_last_name, s.email AS staff_email, s.role AS staff_role,
            mca.amount, mca.credit_type, mca.reason, mca.created_at
     FROM membership_credit_adjustments mca
     LEFT JOIN staff s ON s.id = mca.staff_id
     WHERE mca.membership_id = $1::uuid
     ORDER BY mca.created_at DESC, mca.id DESC`,
    [membershipId]
  )
  return rows.map((row) => ({ ...row, created_at: iso(row.created_at) }))
}

/**
 * The automatic Herd rule for one membership: the expression of the database's refresh_herd_flags() (which the hourly
 * job runs for every membership with no override), word for word, so a clear settles this membership inside the
 * transaction rather than by a second statement over the whole table (FB11). COALESCE because is_herd can't be null:
 * a membership with no billing frequency that hasn't waited long enough is not Herd. credits.test.ts holds the
 * expression to the saved function and to what the function itself decides.
 */
export const HERD_RULE_SQL = `(cm.billing_frequency = 'yearly'
                    or cm.start_date <= (now() at time zone 'Europe/London')::date - (wait_months || ' months')::interval)`

const CLEAR_HERD_SQL = `
UPDATE customer_memberships cm
SET herd_override = NULL,
    is_herd = COALESCE(${HERD_RULE_SQL}, false),
    updated_at = now()
FROM (SELECT COALESCE((SELECT addon_credit_wait_months FROM membership_settings WHERE id), 6) AS wait_months) settings
WHERE cm.id = $1::uuid
RETURNING cm.id`

interface HerdState {
  is_herd: boolean
  herd_override: boolean | null
}

/**
 * setMembershipHerd. Issue refunds (turning Herd on releases the member's add-on credits at once). One transaction
 * under the membership's lock: true or false sets the override and the flag; null clears the override and applies the
 * automatic rule to this membership. A `membership.herd_set` audit row records who, and the flag and override before
 * and after (FB11; lead call L13: no reason is asked for).
 */
export async function setMembershipHerd(db: Db, membershipId: string, herd: boolean | null, options: AccountOptions): Promise<SetMembershipHerdOutput> {
  if (!options.actor.canIssueRefunds) throw accountRefusal('FORBIDDEN', 'herd', 'permission_denied', ISSUE_REFUNDS_NEEDED_MESSAGE)
  return db.transaction(async (tx) => {
    const [before] = await tx.query<HerdState>('SELECT is_herd, herd_override FROM customer_memberships WHERE id = $1::uuid FOR NO KEY UPDATE', [membershipId])
    if (!before) throw accountRefusal('NOT_FOUND', 'herd', 'not_found', HERD_NOT_FOUND_MESSAGE)
    const written =
      herd === null
        ? await tx.query<{ id: string }>(CLEAR_HERD_SQL, [membershipId])
        : await tx.query<{ id: string }>('UPDATE customer_memberships SET herd_override = $1, is_herd = $2, updated_at = now() WHERE id = $3::uuid RETURNING id', [herd, herd, membershipId])
    const [membership] = await tx.query<SetMembershipHerdOutput['membership']>(
      `SELECT cm.id, mp.name AS plan_name, cm.subscription_status, cm.is_herd, cm.herd_override, cm.addon_credits_remaining
       FROM customer_memberships cm
       JOIN membership_plans mp ON mp.id = cm.plan_id
       WHERE cm.id = $1::uuid`,
      [membershipId]
    )
    if (written.length !== 1 || !membership) throw new Error(`Membership ${membershipId} was locked but not updated.`)
    await audit.record(tx, {
      actorType: options.actor.type,
      actorId: options.actor.id,
      action: 'membership.herd_set',
      entityType: 'membership',
      entityId: membershipId,
      requestId: options.requestId,
      details: {
        herd,
        before: { isHerd: before.is_herd, override: before.herd_override },
        after: { isHerd: membership.is_herd, override: membership.herd_override },
      },
    })
    return { membership }
  })
}
