import { z } from 'zod'

// --- W85a (backend log 9, 25): the website's sign-in. A Supabase login (passwordless: an emailed code or link) is
// matched to its customer by email the first time it signs in (link), or makes one (create); then "who am I" (me)
// gives the site the name, the email and which account sections show. The login's email always comes from its
// verified token, never from a request body: a body's `email` is not read.
//
// In a file of its own, exported last from index.ts, so the types printed for the staff app (workerContracts.ts) only
// gain these: declared earlier, its literal unions change the order the older types' unions are printed in.

/**
 * Why a sign-in route refused, in `error.details.reason`, with the customer's words in `message`
 * (server/rules/customer/sign-in-words.ts; the test beside the rule holds the two lists together).
 *  - `email_linked_elsewhere` (CONFLICT): a customer has this email and another login; logged for staff.
 *  - `email_not_confirmed`, `no_email` (FORBIDDEN): the login can't be matched by email.
 *  - `email_login_only` (FORBIDDEN; WQ101): the login isn't an email-code login (Google, Apple, none): refused until
 *    another provider is reviewed.
 *  - `first_name_required`, `last_name_required`, `too_long` (VALIDATION, with `field`): create's own checks.
 */
export const CUSTOMER_SIGN_IN_REASONS = ['email_linked_elsewhere', 'email_not_confirmed', 'no_email', 'email_login_only', 'first_name_required', 'last_name_required', 'too_long'] as const
export const customerSignInRefusalDetailsSchema = z.object({ reason: z.enum(CUSTOMER_SIGN_IN_REASONS), message: z.string() })
export type CustomerSignInRefusalDetails = z.infer<typeof customerSignInRefusalDetailsSchema>

/** The signed-in customer, as the site greets them. */
export const customerSignInCustomerSchema = z.object({ firstName: z.string(), email: z.string() })

/**
 * Linked: the login has its customer. `change` says what this call did: `none` (it was linked already: a second call
 * answers so), `linked` (an existing customer with this email, with no login yet, is now this login's: their credits,
 * passes and store credit with it), `created` (create made the customer).
 */
export const customerSignInLinkedSchema = z.object({
  status: z.literal('linked'),
  customer: customerSignInCustomerSchema,
  change: z.enum(['none', 'linked', 'created']),
})
export type CustomerSignInLinked = z.infer<typeof customerSignInLinkedSchema>

// POST /api/v1/customer/sign-in/link (no body; the email is the token's)

export const customerSignInLinkInputSchema = z.object({})

/** `needs_details`: no customer has this email, so the site shows Create your account (then create). */
export const customerSignInLinkOutputSchema = z.discriminatedUnion('status', [customerSignInLinkedSchema, z.object({ status: z.literal('needs_details') })])
export type CustomerSignInLinkOutput = z.infer<typeof customerSignInLinkOutputSchema>

// POST /api/v1/customer/sign-in/create

/**
 * Backend log 9: first name, last name, a phone if they like. No date of birth and no age check here. A name left out
 * (or empty) is the rule's to refuse, with its reason (`first_name_required`, `last_name_required`), not zod's.
 * W85 (Wayne, 30 Nov): `marketingConsent`, the popup's "Email me with news and offers" tick, saved on a new customer
 * (`customers.marketing_consent`); left out is no. A customer found instead (made meanwhile) keeps their own.
 */
export const customerSignInCreateInputSchema = z.object({
  firstName: z.string().nullish(),
  lastName: z.string().nullish(),
  phone: z.string().nullish(),
  marketingConsent: z.boolean().optional(),
})
export type CustomerSignInCreateInput = z.infer<typeof customerSignInCreateInputSchema>

/**
 * Always linked: made and linked in one transaction (`created`); or, when a customer with this email was made at the
 * same moment (staff, a guest checkout), or the login was already linked, that customer, and the details sent are not
 * written over theirs (`linked`, `none`).
 */
export const customerSignInCreateOutputSchema = customerSignInLinkedSchema
export type CustomerSignInCreateOutput = z.infer<typeof customerSignInCreateOutputSchema>

// GET /api/v1/customer/me

/**
 * The account's sections, in the menu's order (backend log 25; docs/url-map.md's /account rows). Always: `dashboard`,
 * `details` (Personal info), `preferences`. `bookings`, `events`, `orders` after the customer's first session booking,
 * event booking or order. `membership`, `passes`, `store_credit` once they have had one (any store credit at all,
 * even if it is spent), and they stay.
 */
export const ACCOUNT_SECTIONS = ['dashboard', 'bookings', 'events', 'orders', 'membership', 'passes', 'store_credit', 'details', 'preferences'] as const
export type AccountSection = (typeof ACCOUNT_SECTIONS)[number]

export const customerMeInputSchema = z.object({})

export const customerMeOutputSchema = z.object({
  firstName: z.string(),
  email: z.string(),
  sections: z.array(z.enum(ACCOUNT_SECTIONS)),
})
export type CustomerMeOutput = z.infer<typeof customerMeOutputSchema>
