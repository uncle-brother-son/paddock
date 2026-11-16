import { loadPaymentDateQuote, type PaymentDateQuote } from './shared/membershipPaymentDate'

export interface GetMembershipPaymentDateQuoteParams {
  membershipId: string
  /** The date staff picked (YYYY-MM-DD); omit to get only the allowed window. */
  newRenewalDate?: string
}

/**
 * Read-only quote for "Change payment date" (brief 13): whether the change is allowed, the
 * earliest and latest new dates, and for a picked date the extra days and the part-month charge
 * (plan monthly price × extra days ÷ days from the current renewal date to the same day a month
 * later, to the penny). changeMembershipPaymentDate works out the same figures again live.
 */
export default async function getMembershipPaymentDateQuote(
  req: { params: GetMembershipPaymentDateQuoteParams }
): Promise<PaymentDateQuote | null> {
  const { membershipId, newRenewalDate } = req.params
  if (!membershipId) return null
  return loadPaymentDateQuote(membershipId, newRenewalDate)
}
