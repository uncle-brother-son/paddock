// Ported from backend/paddock/shared/creditRedemption.ts (getCustomerCreditOptions only: the
// reserve and release functions move with step C).
import 'server-only'
import type { CustomerCreditOptionsOutput, MembershipCreditCandidate, SessionPassCreditCandidate } from '@/contracts'
import type { Queryable } from '@/server/db'

/**
 * Loads every membership/session-pass credit source available to a customer, each list already
 * sorted soonest-expiring-first so the caller can treat index 0 as the auto-selected default.
 * With `sessionId`, session passes are limited to those that cover that session.
 *
 * A membership is usable only while subscription_status = 'active' and it is not past a scheduled
 * cancellation (cancel_effective_date is the last day of access, so the comparison is inclusive).
 * Add-on credits are only spendable while the membership is Herd. The pass level rule lives in
 * the SQL function pass_covers_session, never in TypeScript.
 */
export async function getCustomerCreditOptions(db: Queryable, customerId: string, sessionId?: string): Promise<CustomerCreditOptionsOutput> {
  const [memberships, passes] = await Promise.all([
    db.query<
      MembershipCreditCandidate & {
        start_date: string
        stripe_subscription_id: string | null
      }
    >(
      `SELECT cm.id, cm.plan_id, mp.name AS plan_name,
              mcc.is_unlimited, mcc.credits_remaining, mcc.period_end,
              cm.addon_credits_remaining, cm.next_renewal_date, cm.start_date, cm.stripe_subscription_id,
              cm.is_herd, cm.herd_override
       FROM customer_memberships cm
       JOIN membership_plans mp ON mp.id = cm.plan_id
       LEFT JOIN membership_current_credits mcc ON mcc.membership_id = cm.id
       WHERE cm.customer_id = $1
         AND cm.subscription_status = 'active'
         AND (cm.cancel_effective_date IS NULL OR cm.cancel_effective_date >= (now() AT TIME ZONE 'Europe/London')::date)
       ORDER BY mcc.period_end ASC NULLS LAST`,
      [customerId]
    ),
    // Two forms so the $N placeholders stay in ascending order in the SQL text.
    sessionId
      ? db.query<SessionPassCreditCandidate>(
          `SELECT csp.id, csp.pass_type_id, spt.name AS pass_type_name, spt.level, csp.sessions_remaining, csp.expiry_date,
                  pass_covers_session(csp.pass_type_id, $1) AS covers_session
           FROM customer_session_passes csp
           JOIN session_pass_types spt ON spt.id = csp.pass_type_id
           WHERE csp.customer_id = $2 AND csp.expiry_date >= (now() AT TIME ZONE 'Europe/London')::date
           ORDER BY csp.expiry_date ASC`,
          [sessionId, customerId]
        )
      : db.query<SessionPassCreditCandidate>(
          `SELECT csp.id, csp.pass_type_id, spt.name AS pass_type_name, spt.level, csp.sessions_remaining, csp.expiry_date,
                  NULL::boolean AS covers_session
           FROM customer_session_passes csp
           JOIN session_pass_types spt ON spt.id = csp.pass_type_id
           WHERE csp.customer_id = $1 AND csp.expiry_date >= (now() AT TIME ZONE 'Europe/London')::date
           ORDER BY csp.expiry_date ASC`,
          [customerId]
        ),
  ])

  // Session-credit candidates: usable memberships that are unlimited or still have credit left
  // in their current period, soonest-expiring period first. A membership with no current period
  // has nothing to draw from and is excluded.
  const membershipsWithSessionCredit = memberships
    .filter((m) => m.is_unlimited || (m.credits_remaining ?? 0) > 0)
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    .map(({ stripe_subscription_id: _unused1, start_date: _unused2, ...rest }) => rest)
  const membershipsWithAddonCredit = memberships
    .filter((m) => m.addon_credits_remaining > 0 && m.is_herd === true)
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    .map(({ stripe_subscription_id: _unused1, start_date: _unused2, ...rest }) => rest)
  const usablePasses = passes.filter((p) => p.sessions_remaining > 0)
  const sessionPasses = sessionId ? usablePasses.filter((p) => p.covers_session === true) : usablePasses
  const sessionPassesNotCoveringSession = usablePasses.length - sessionPasses.length

  // A usable, non-unlimited membership with nothing left in its current period (or no current
  // period at all): the "cancel and buy a new one" flow.
  const exhausted = memberships.find((m) => !m.is_unlimited && (m.credits_remaining ?? 0) <= 0)
  const exhaustedMembership = exhausted
    ? {
        id: exhausted.id,
        plan_id: exhausted.plan_id,
        plan_name: exhausted.plan_name,
        stripe_subscription_id: exhausted.stripe_subscription_id,
      }
    : null

  return {
    membershipsWithSessionCredit,
    membershipsWithAddonCredit,
    sessionPasses,
    sessionPassesNotCoveringSession,
    exhaustedMembership,
  }
}
