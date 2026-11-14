import { isHtmlErrorPage } from './isHtmlErrorPage'
import { extractStructuredApiError } from './extractStructuredApiError'
import { extractApiErrorMessage } from './extractApiErrorMessage'
// The runtime globals (paddockBackendApi2) are typed by the generated declarations in
// backend/resources/; ../globals.ts is now an empty module, kept so this import stays valid.
import '../globals'

export interface CancelMembershipSubscriptionResult {
  /** False when there was no real Stripe subscription to cancel (nothing was attempted). */
  attempted: boolean
  success: boolean
  message?: string
}

/**
 * Cancels the real Stripe subscription behind a membership, if one exists. Extracted from
 * refundOrder.ts (originally built and verified there) so createOrder.ts's "customer has an
 * exhausted membership — cancel it and buy a new one in this basket" flow can reuse the exact
 * same, already-proven external call and error handling instead of duplicating it.
 *
 * Returns `{ attempted: false, success: true }` when `stripeSubscriptionId` is null — memberships
 * created before real Stripe subscription creation was wired into createOrder.ts (and old test
 * data) have no subscription to cancel; local deactivation of the customer_memberships row is the
 * caller's responsibility either way.
 */
export async function cancelMembershipSubscription(
  stripeSubscriptionId: string | null
): Promise<CancelMembershipSubscriptionResult> {
  if (!stripeSubscriptionId) {
    return { attempted: false, success: true }
  }
  try {
    const response = await paddockBackendApi2.rawRequest<{ error?: string; details?: string }>({
      path: '/api/memberships/cancel-subscription',
      method: 'POST',
      body: { stripeSubscriptionId },
    })
    const failureMessage = isHtmlErrorPage(response.data)
      ? 'The subscription-cancellation endpoint returned an HTML page instead of a JSON response.'
      : extractStructuredApiError(response.data)
    if (failureMessage) {
      return { attempted: true, success: false, message: failureMessage }
    }
    return { attempted: true, success: true }
  } catch (err) {
    return { attempted: true, success: false, message: extractApiErrorMessage(err, 'Failed to cancel subscription') }
  }
}
