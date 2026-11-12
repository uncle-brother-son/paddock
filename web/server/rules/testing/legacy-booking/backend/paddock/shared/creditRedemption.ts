/**
 * Shared credit-redemption engine for memberships and session passes, used by createBooking.ts,
 * createOrder.ts and the other write functions. The basket UI's pre-flight credit lookup now lives
 * in the Worker (server/rules/credits/credit-options.ts), and must agree with the rules here.
 *
 * Auto-selection rule (confirmed): when more than one membership/pass qualifies, prefer whichever
 * expires soonest — for a membership that's the current credit period's `period_end` ascending
 * (the period whose credits run out soonest), for a session pass that's `expiry_date` ascending.
 *
 * Session credits are period-based: a membership's spendable session credit is defined by the
 * `membership_current_credits` view (one row per membership whose credit period covers today's
 * London date), never by the legacy `customer_memberships.session_credits_remaining` counter.
 * Usage in a period is counted from non-cancelled bookings carrying that period's
 * `bookings.credit_period_id`, so claiming a credit happens atomically in the booking INSERT
 * itself (see createBooking.ts) — there is no counter UPDATE to reserve or release anymore.
 *
 * Membership usability gate: a membership is usable (for either credit type) only while
 * `subscription_status = 'active'` AND it is not past a scheduled cancellation — i.e.
 * `cancel_effective_date` is null or is TODAY OR LATER: cancel_effective_date is the LAST DAY OF
 * ACCESS (Stripe's end date minus one day, matching allocate_membership_credit_periods capping
 * the final credit period at that date inclusive), so the comparison is inclusive
 * (`cancel_effective_date >= (now() AT TIME ZONE 'Europe/London')::date`) and the membership stays usable on that final day.
 * `cancel_effective_date` is set by setMembershipCancellation.ts (via the Worker) and never by a
 * background job; this comparison against (now() AT TIME ZONE 'Europe/London')::date is what actually enforces it everywhere a
 * membership's usability is checked (mirrors how gift card / session pass expiry is enforced
 * elsewhere in this codebase — no cron).
 *
 * A membership whose plan is unlimited (`is_unlimited`) always has credit available while its
 * period covers today — the view leaves `credits_remaining` NULL for those.
 *
 * Add-on credit Herd gate: independent of the above, `addon_credits_remaining` is only spendable
 * while the membership is a Herd member (`customer_memberships.is_herd = true`). Yearly
 * memberships are Herd from sign-up; monthly memberships become Herd automatically once they
 * have been members for the configured waiting period (membership_settings.addon_credit_wait_months,
 * enforced by public.refresh_herd_flags()), and staff can toggle Herd manually via
 * herd_override (setMembershipHerd.ts). Session credits are never subject to this gate. Enforced
 * both in the Worker's candidate list (so a non-Herd membership is never offered/auto-selected) and
 * atomically in reserveMembershipAddonCredit (defense in depth).
 *
 * Session pass levels: an 'all_access' pass covers any public session; a 'core' pass covers
 * Off-Peak and Core sessions only (never Peak). The rule lives in ONE place, the SQL function
 * pass_covers_session(pass_type_id, session_id) — it is false for private or unbanded sessions —
 * and is only ever called from SQL here, never re-implemented in TypeScript.
 */

export interface UsableMembershipCreditPeriod {
  periodId: string
  isUnlimited: boolean
}

/**
 * Resolves the membership's current credit period when it is actually usable: active, not past a
 * scheduled cancellation, and either unlimited or holding at least one unspent credit. Returns
 * null when no such period exists — the caller treats that as "no credit available". The
 * reservation itself is atomic in createBooking.ts's guarded booking INSERT, which re-checks the
 * same conditions against the period row.
 */
export async function findUsableMembershipCreditPeriod(
  membershipId: string
): Promise<UsableMembershipCreditPeriod | null> {
  const result = await paddockData.query<{ period_id: string; is_unlimited: boolean }>(
    `SELECT mcc.period_id, mcc.is_unlimited
     FROM membership_current_credits mcc
     JOIN customer_memberships cm ON cm.id = mcc.membership_id
     WHERE mcc.membership_id = $1
       AND cm.subscription_status = 'active'
       AND (cm.cancel_effective_date IS NULL OR cm.cancel_effective_date >= (now() AT TIME ZONE 'Europe/London')::date)
       AND (mcc.is_unlimited OR mcc.credits_remaining > 0)`,
    [membershipId]
  )
  const row = result.data[0]
  return row ? { periodId: row.period_id, isUnlimited: row.is_unlimited } : null
}

export interface ReserveMembershipAddonCreditResult {
  reserved: boolean
  /** 'membership_too_new' now means "not a Herd member" — see the file header. */
  reason?: 'membership_not_found' | 'membership_too_new' | 'insufficient_credit'
}

/** Atomically claims `quantity` add-on credits from a specific membership — gated on both having
 *  enough credit AND the membership being a Herd member (see file header). The single UPDATE is
 *  the same race-safe pattern as before: the WHERE clause re-checks eligibility inside the claim
 *  itself. */
export async function reserveMembershipAddonCredit(
  membershipId: string,
  quantity: number
): Promise<ReserveMembershipAddonCreditResult> {
  const result = await paddockData.query<{ id: string }>(
    `UPDATE customer_memberships SET addon_credits_remaining = addon_credits_remaining - $1, updated_at = now()
     WHERE id = $2 AND addon_credits_remaining >= $3 AND is_herd = true
     RETURNING id`,
    [quantity, membershipId, quantity]
  )
  if (result.data.length > 0) return { reserved: true }

  // Distinguish why, so the caller can surface a clearer reason than a flat "insufficient credit".
  const lookup = await paddockData.query<{ eligible: boolean; addon_credits_remaining: number }>(
    `SELECT is_herd AS eligible, addon_credits_remaining
     FROM customer_memberships WHERE id = $1`,
    [membershipId]
  )
  const row = lookup.data[0]
  if (!row) return { reserved: false, reason: 'membership_not_found' }
  if (!row.eligible) return { reserved: false, reason: 'membership_too_new' }
  return { reserved: false, reason: 'insufficient_credit' }
}

export async function releaseMembershipAddonCredit(membershipId: string, quantity: number): Promise<void> {
  await paddockData.query(
    `UPDATE customer_memberships SET addon_credits_remaining = addon_credits_remaining + $1, updated_at = now() WHERE id = $2`,
    [quantity, membershipId]
  )
}

export interface ReserveSessionPassCreditResult {
  reserved: boolean
  /** 'not_valid_for_band': the pass is otherwise usable but its level doesn't cover the session
   *  (a Core pass on a Peak session). 'unavailable': gone, expired or used up. */
  reason?: 'not_valid_for_band' | 'unavailable'
}

/** Atomically claims one session from a specific (non-expired) session pass for `sessionId`. The
 *  WHERE clause re-checks pass_covers_session inside the claim itself, so a Core credit can never
 *  be taken for a Peak session even under a race. */
export async function reserveSessionPassCredit(
  sessionPassId: string,
  sessionId: string
): Promise<ReserveSessionPassCreditResult> {
  const result = await paddockData.query<{ id: string }>(
    `UPDATE customer_session_passes SET sessions_remaining = sessions_remaining - 1, updated_at = now()
     WHERE id = $1 AND sessions_remaining >= 1 AND expiry_date >= (now() AT TIME ZONE 'Europe/London')::date
       AND pass_covers_session(pass_type_id, $2)
     RETURNING id`,
    [sessionPassId, sessionId]
  )
  if (result.data.length > 0) return { reserved: true }

  // Distinguish why, so the caller can surface the band reason instead of a flat "unavailable".
  const lookup = await paddockData.query<{ usable: boolean; covers: boolean }>(
    `SELECT pass_covers_session(pass_type_id, $1) AS covers,
            (sessions_remaining >= 1 AND expiry_date >= (now() AT TIME ZONE 'Europe/London')::date) AS usable
     FROM customer_session_passes WHERE id = $2`,
    [sessionId, sessionPassId]
  )
  const row = lookup.data[0]
  if (row && row.usable && !row.covers) return { reserved: false, reason: 'not_valid_for_band' }
  return { reserved: false, reason: 'unavailable' }
}

/** Returns one session to a specific session pass — only while the pass is still unexpired;
 *  an expired pass keeps its counter untouched (the returned session is gone). */
export async function releaseSessionPassCredit(sessionPassId: string): Promise<void> {
  await paddockData.query(
    `UPDATE customer_session_passes SET sessions_remaining = sessions_remaining + 1, updated_at = now()
     WHERE id = $1 AND expiry_date >= (now() AT TIME ZONE 'Europe/London')::date`,
    [sessionPassId]
  )
}
