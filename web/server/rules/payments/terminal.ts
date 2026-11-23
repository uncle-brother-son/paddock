// Ported from backend/paddock/getTerminalConnectionToken.ts and createTerminalSetupIntent.ts, with the legacy
// app/api/terminal/connection-token and create-setup-intent routes (new in W11). W68 (H5): saveCustomerCardOnFile's port
// (`saveCustomerCard`, what the route did with `card_moves` off) is gone; the card is saved by customers/saved-card.ts.
import 'server-only'
import Stripe from 'stripe'
import type {
  TerminalConnectionTokenInput,
  TerminalConnectionTokenOutput,
  TerminalSetupIntentInput,
  TerminalSetupIntentOutput,
} from '@/contracts'
import type { Db } from '@/server/db'
import { ApiError } from '@/server/http/errors'
import { stripeIdempotencyKey } from '@/server/http/idempotency'
import type { StripeClient } from '@/server/stripe/client'
import { ensureStripeCustomer } from '@/server/stripe/customer'
import { NoTimeLeft, sendOptions, type StripeTiming } from '@/server/stripe/deadline'

/** The club's one Stripe Terminal location (the legacy route's default). */
export const DEFAULT_TERMINAL_LOCATION_ID = 'tml_GpvkTAMWAnUGe1'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const stripeErrorMessage = (err: unknown): string => (err instanceof Stripe.errors.StripeError && err.message ? err.message : 'Unknown error')

/** W11a: the words after the legacy route's prefix when a call wasn't sent because the press's deadline was near. */
export const SETUP_NOT_SENT_REASON = "Stripe was too slow to answer, so it wasn't asked: no card was saved. Try again."

/**
 * A connection token for the Terminal SDK, which asks for one whenever it needs one. Creating one
 * moves no money. Stripe's failure is answered with the legacy route's words.
 */
export async function terminalConnectionToken(stripe: StripeClient, input: TerminalConnectionTokenInput): Promise<TerminalConnectionTokenOutput> {
  try {
    const token = await stripe.terminal.connectionTokens.create({ location: input.locationId || DEFAULT_TERMINAL_LOCATION_ID })
    if (!token.secret) throw new Error('no secret')
    return { secret: token.secret }
  } catch (err) {
    throw new ApiError('INTERNAL', `Failed to create connection token: ${stripeErrorMessage(err)}`, { logDetail: err instanceof Error ? err.message : String(err) })
  }
}

/** The customer's row, or the old words when there isn't one. */
async function customerOf(db: Db, customerId: string | undefined): Promise<{ id: string; stripe_customer_id: string | null }> {
  if (!customerId) throw new ApiError('VALIDATION', 'customerId is required')
  const row = UUID.test(customerId)
    ? (await db.query<{ id: string; stripe_customer_id: string | null }>('SELECT id, stripe_customer_id FROM customers WHERE id = $1::uuid', [customerId]))[0]
    : undefined
  if (!row) throw new ApiError('NOT_FOUND', 'Customer not found')
  return row
}

/**
 * A SetupIntent the reader collects a card against, with no charge (createTerminalSetupIntent): the
 * customer's Stripe customer (found or made, ensureStripeCustomer), then the intent, `card_present`,
 * for off-session use, under a key from the customer and this press's own key, so a send repeated for
 * this press can't make a second one. Moves no money: only the card's save, after the tap, writes.
 *
 * W11a (review S1): with `timing` (the route's, from the request's start), every Stripe call and the
 * customer's statements end by the 30 s deadline, as on the other reader routes; one with too little
 * time left isn't made, and staff are told to try again.
 */
export async function terminalSetupIntent(
  db: Db,
  stripe: StripeClient,
  input: TerminalSetupIntentInput,
  pressKey: string,
  timing?: StripeTiming
): Promise<TerminalSetupIntentOutput> {
  const customer = await customerOf(db, input.customerId)
  let stripeCustomerId: string
  try {
    stripeCustomerId = await ensureStripeCustomer(db, stripe, { id: customer.id, stripeCustomerId: customer.stripe_customer_id }, timing)
  } catch (err) {
    if (err instanceof NoTimeLeft) throw new ApiError('INTERNAL', `Failed to create Stripe customer: ${SETUP_NOT_SENT_REASON}`, { logDetail: err.message })
    if (err instanceof Stripe.errors.StripeError) throw new ApiError('INTERNAL', `Failed to create Stripe customer: ${stripeErrorMessage(err)}`, { logDetail: err.message })
    throw err
  }
  const press = pressKey.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 48)
  let setupIntent: Stripe.SetupIntent
  try {
    setupIntent = await stripe.setupIntents.create(
      { customer: stripeCustomerId, payment_method_types: ['card_present'], usage: 'off_session' },
      sendOptions(timing, { idempotencyKey: stripeIdempotencyKey(customer.id, `setup-intent.${press}`) })
    )
  } catch (err) {
    const reason = err instanceof NoTimeLeft ? SETUP_NOT_SENT_REASON : stripeErrorMessage(err)
    throw new ApiError('INTERNAL', `Failed to create SetupIntent: ${reason}`, { logDetail: err instanceof Error ? err.message : String(err) })
  }
  if (!setupIntent.client_secret) throw new ApiError('INTERNAL', 'The setup-intent endpoint did not return the expected fields.')
  return { clientSecret: setupIntent.client_secret, setupIntentId: setupIntent.id, stripeCustomerId }
}
