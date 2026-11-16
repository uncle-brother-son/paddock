// New in W37 (F-plan 4.2 item 5): how every step F action refuses. An ApiError whose `details` carry the old reason
// (or a new one, where the old function gave only words), the words staff see and the action, as
// accountRefusalDetailsSchema, so the staff app's thin wrappers put the old result shapes back.
import 'server-only'
import type { AccountAction, AccountRefusalDetails, ApiErrorCode } from '@/contracts'
import { ApiError } from '@/server/http/errors'

/** Who is acting on a step F route. `canIssueRefunds` is the signed-in staff member's own switch, read by the route. */
export interface AccountActor {
  type: 'staff'
  id: string
  canIssueRefunds: boolean
}

export interface AccountOptions {
  actor: AccountActor
  requestId: string
}

export function accountRefusal(code: ApiErrorCode, action: AccountAction, reason: string, message: string, extras: { field?: string } = {}): ApiError {
  const details: AccountRefusalDetails = { reason, message, action }
  return new ApiError(code, message, { ...extras, details })
}
