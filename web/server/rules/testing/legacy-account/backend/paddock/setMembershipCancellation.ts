import { isHtmlErrorPage } from './shared/isHtmlErrorPage'
import { extractStructuredApiError } from './shared/extractStructuredApiError'
import { extractApiErrorMessage } from './shared/extractApiErrorMessage'
import { getStaffAccessRow } from './shared/staffAccess'

export interface SetMembershipCancellationParams {
  membershipId: string
  /** true = schedule the membership to stop renewing; false = undo a previously-scheduled
   *  cancellation (only meaningful before it has taken effect). */
  cancel: boolean
}

export interface SetMembershipCancellationResult {
  updated: boolean
  reason?: 'membership_not_found' | 'not_active' | 'already_cancelling' | 'not_cancelling' | 'permission_denied'
  /** The Worker's error text, surfaced verbatim to staff when the call fails. */
  message?: string
  /** On success — the row as the Worker left it in the database (read back after the call). */
  membership?: { id: string; cancel_effective_date: string | null; billing_frequency: string | null }
  /** On cancel success — the real end date the Worker returned (Stripe period end). */
  endDate?: string
  /** On cancel success — whether the Worker updated the Stripe subscription itself. */
  stripeUpdated?: boolean
}

interface WorkerCancelResponse {
  success?: boolean
  endDate?: string
  cancelEffectiveDate?: string
  stripeUpdated?: boolean
  error?: string
  details?: string
}

interface WorkerUndoResponse {
  success?: boolean
  error?: string
  details?: string
}

/** Maps a Worker error text to the caller-facing failure reason when it matches one of the
 *  known cases; anything else stays undefined so the raw Worker text is surfaced instead. */
function mapWorkerError(error: string): SetMembershipCancellationResult['reason'] {
  const lower = error.toLowerCase()
  if (lower.includes('not found')) return 'membership_not_found'
  if (lower.includes('already')) return 'already_cancelling'
  if (lower.includes('not active') || lower.includes('no active')) return 'not_active'
  if (lower.includes('not cancelling') || lower.includes('no pending') || lower.includes('nothing to undo')) {
    return 'not_cancelling'
  }
  return undefined
}

async function readBackMembership(membershipId: string) {
  const lookup = await paddockData.query<{ id: string; cancel_effective_date: string | null; billing_frequency: string | null }>(
    'SELECT id, cancel_effective_date, billing_frequency FROM customer_memberships WHERE id = $1',
    [membershipId]
  )
  return lookup.data[0] ?? null
}

/**
 * Schedules (or undoes) a membership's cancellation through the payments backend ("Paddock
 * Backend API" Worker) — Retool no longer writes cancel_effective_date itself. The Worker
 * applies the same minimum-term rules (monthly: at least 2 total payments, so the end date is
 * GREATEST(start_date + 2 months, next_renewal_date); yearly: stop at next_renewal_date with no
 * floor), updates the Stripe subscription, and writes the resulting cancel_effective_date back
 * to customer_memberships. The row is read back afterwards so the UI always shows what the
 * Worker actually stored.
 *
 * subscription_status stays 'active' throughout the countdown, and usability is governed
 * everywhere by comparing cancel_effective_date against London's date inclusively —
 * cancel_effective_date is the LAST DAY OF ACCESS, so the check is
 * `>= (now() AT TIME ZONE 'Europe/London')::date` (see shared/creditRedemption.ts and its
 * callers) — evaluated live, never by a background job.
 */
export default async function setMembershipCancellation(
  req: { params: SetMembershipCancellationParams; user: User }
): Promise<SetMembershipCancellationResult> {
  const { membershipId, cancel } = req.params
  if (!membershipId) {
    return { updated: false, message: 'membershipId is required' }
  }

  // Cancelling (or re-activating) a membership moves real value — restricted to staff with
  // can_issue_refunds, like the other money-back-to-customer actions.
  const staffAccess = await getStaffAccessRow(req.user.email)
  if (!staffAccess?.can_issue_refunds) {
    return {
      updated: false,
      reason: 'permission_denied',
      message: 'Needs the Issue refunds permission to cancel or re-activate a membership.',
    }
  }

  try {
    if (cancel) {
      const response = await paddockBackendApi2.rawRequest<WorkerCancelResponse>({
        path: '/api/memberships/cancel',
        method: 'POST',
        body: { membershipId },
      })
      if (isHtmlErrorPage(response.data)) {
        throw new Error(
          'The membership cancel endpoint returned an HTML page instead of a JSON response — the "Paddock ' +
            'Backend API" resource is very likely misconfigured.'
        )
      }
      const structuredError = extractStructuredApiError(response.data)
      if (structuredError) {
        const workerReason = mapWorkerError(structuredError)
        return { updated: false, ...(workerReason ? { reason: workerReason } : {}), message: structuredError }
      }
      if (!response.data.success) {
        return { updated: false, message: 'The cancel endpoint did not report success.' }
      }
      // The Worker wrote the database — read the row back so the UI shows the real stored date.
      const membership = await readBackMembership(membershipId)
      if (!membership) {
        return { updated: false, reason: 'membership_not_found' }
      }
      return {
        updated: true,
        membership,
        ...(response.data.endDate ? { endDate: response.data.endDate } : {}),
        ...(typeof response.data.stripeUpdated === 'boolean' ? { stripeUpdated: response.data.stripeUpdated } : {}),
      }
    }

    // Undo a pending cancellation.
    const response = await paddockBackendApi2.rawRequest<WorkerUndoResponse>({
      path: '/api/memberships/undo-cancel',
      method: 'POST',
      body: { membershipId },
    })
    if (isHtmlErrorPage(response.data)) {
      throw new Error(
        'The membership undo-cancel endpoint returned an HTML page instead of a JSON response — the "Paddock ' +
          'Backend API" resource is very likely misconfigured.'
      )
    }
    const structuredError = extractStructuredApiError(response.data)
    if (structuredError) {
      const workerReason = mapWorkerError(structuredError)
      return { updated: false, ...(workerReason ? { reason: workerReason } : {}), message: structuredError }
    }
    if (!response.data.success) {
      return { updated: false, message: 'The undo-cancel endpoint did not report success.' }
    }
    const membership = await readBackMembership(membershipId)
    if (!membership) {
      return { updated: false, reason: 'membership_not_found' }
    }
    return { updated: true, membership }
  } catch (err) {
    // The REST client throws for some non-2xx statuses and may attach the parsed body — recover
    // the structured { error } shape from it before falling back to the message text.
    if (err instanceof Error) {
      const anyErr = err as unknown as Record<string, unknown>
      const nestedData = (anyErr['response'] as Record<string, unknown> | undefined)?.['data'] ?? anyErr['data']
      if (nestedData && typeof nestedData === 'object') {
        const structuredError = extractStructuredApiError(nestedData as Record<string, unknown>)
        if (structuredError) {
          const workerReason = mapWorkerError(structuredError)
          return { updated: false, ...(workerReason ? { reason: workerReason } : {}), message: structuredError }
        }
      }
      return { updated: false, message: extractApiErrorMessage(err, 'Failed to update the membership cancellation') }
    }
    throw err
  }
}
