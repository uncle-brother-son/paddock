import type { AccountSection, CustomerMeOutput, CustomerSignInCreateInput } from '@/contracts/sign-in'
import { ACCOUNT_SECTIONS } from '@/contracts/sign-in'

// W85: the browser's three calls to W85a's routes, each with the signed-in login's access token (Bearer), as every
// customer route takes it: who am I (the name, the email and which account sections show), link (the login to its
// customer) and create (Create your account). Nothing here decides who the customer is: the Worker reads the email
// from the token. Never cached.

export const ME_ADDRESS = '/api/v1/customer/me'
export const LINK_ADDRESS = '/api/v1/customer/sign-in/link'
export const CREATE_ADDRESS = '/api/v1/customer/sign-in/create'

export type Me = CustomerMeOutput

/** A Worker refusal as the popup shows it: its code, its reason and field when it gives them, and its words. */
export type Refusal = { code: string; reason: string | null; field: string | null; message: string }

/**
 * What a call came to:
 *  - `ok`: the answer;
 *  - `signed_out`: no sign-in, or one the Worker no longer takes (401): the site is signed out;
 *  - `not_linked`: the login has no customer yet (me: CUSTOMER_NOT_LINKED), so the site asks link;
 *  - `refused`: a refusal in the Worker's words (a name missing, the email linked elsewhere, a login not by email code);
 *  - `fault`: no answer, or one the site can't read: nothing is known.
 */
export type Outcome<Answer> = { kind: 'ok'; answer: Answer } | { kind: 'signed_out' } | { kind: 'not_linked' } | { kind: 'refused'; refusal: Refusal } | { kind: 'fault' }

type Fields = Record<string, unknown>
const isFields = (value: unknown): value is Fields => typeof value === 'object' && value !== null && !Array.isArray(value)
const isText = (value: unknown): value is string => typeof value === 'string'
const isSection = (value: unknown): value is AccountSection => (ACCOUNT_SECTIONS as readonly unknown[]).includes(value)

export function meFrom(data: unknown): Me | null {
  if (!isFields(data) || !isText(data.firstName) || !isText(data.email) || !Array.isArray(data.sections) || !data.sections.every(isSection)) return null
  return { firstName: data.firstName, email: data.email, sections: data.sections }
}

export type Linked = { status: 'linked'; firstName: string } | { status: 'needs_details' }

export function linkedFrom(data: unknown): Linked | null {
  if (!isFields(data)) return null
  if (data.status === 'needs_details') return { status: 'needs_details' }
  if (data.status === 'linked' && isFields(data.customer) && isText(data.customer.firstName)) return { status: 'linked', firstName: data.customer.firstName }
  return null
}

/** A route's answer, read as one of the outcomes above. */
export function outcomeOf<Answer>(status: number, body: unknown, read: (data: unknown) => Answer | null): Outcome<Answer> {
  if (isFields(body) && body.ok === true) {
    const answer = read(body.data)
    return answer === null ? { kind: 'fault' } : { kind: 'ok', answer }
  }
  const error = isFields(body) && isFields(body.error) ? body.error : null
  if (status === 401 || error?.code === 'UNAUTHORISED') return { kind: 'signed_out' }
  if (error?.code === 'CUSTOMER_NOT_LINKED') return { kind: 'not_linked' }
  // A refusal with words of its own for the customer (W85a: `details.reason` and `message`), below a fault.
  if (error && status < 500 && isText(error.code) && isText(error.message)) {
    const details = isFields(error.details) ? error.details : null
    return {
      kind: 'refused',
      refusal: {
        code: error.code,
        reason: details && isText(details.reason) ? details.reason : null,
        field: isText(error.field) ? error.field : null,
        message: isText(details?.message) ? details.message : error.message,
      },
    }
  }
  return { kind: 'fault' }
}

async function call<Answer>(address: string, token: string, read: (data: unknown) => Answer | null, body?: unknown): Promise<Outcome<Answer>> {
  try {
    const response = await fetch(address, {
      method: body === undefined ? 'GET' : 'POST',
      cache: 'no-store',
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    let parsed: unknown = null
    try {
      parsed = await response.json()
    } catch {
      parsed = null
    }
    return outcomeOf(response.status, parsed, read)
  } catch {
    return { kind: 'fault' }
  }
}

/** GET /api/v1/customer/me. */
export const askMe = (token: string): Promise<Outcome<Me>> => call(ME_ADDRESS, token, meFrom)

/** POST /api/v1/customer/sign-in/link (no body: the email is the token's). */
export const askLink = (token: string): Promise<Outcome<Linked>> => call(LINK_ADDRESS, token, linkedFrom, {})

/** POST /api/v1/customer/sign-in/create, with the names, the phone if given, and the news and offers tick. */
export const askCreate = (token: string, details: CustomerSignInCreateInput): Promise<Outcome<Linked>> => call(CREATE_ADDRESS, token, linkedFrom, details)
