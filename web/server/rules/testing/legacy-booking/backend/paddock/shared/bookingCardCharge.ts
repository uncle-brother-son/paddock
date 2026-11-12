import {
  chargeSavedCardUnguarded as chargeSavedCard,
  isChargeKeyInUse,
  isChargeUnsure,
  type ChargeSavedCardLineItem,
} from '../chargeSavedCard'

/**
 * A saved-card charge for Move, Add Guest and Settle, safe to ask for twice. The key is the flow, the
 * booking, its updated_at before the action and the amount, so a press after the function died gets
 * the same PaymentIntent from Stripe, and the Worker doesn't write a second order for it.
 *
 * Stripe replays a saved answer for a key, a decline included, and a PaymentIntent that has since
 * been refunded looks just as paid. So once a charge is finished with, its key must never be used
 * again (retireCardCharge): touching updated_at makes the next press a new charge. Everything else
 * that changes the booking does the same, so add, remove and add again is three real payments.
 *
 * Two presses that start from the same booking build the same key, so they share one payment. Three
 * audit_log rows keep them apart (W05k):
 *  - booking.card_charge_started, just before the charge (details.key). A press that is still
 *    running leaves one too, so a started row younger than the longest a press can run, with no
 *    finished row and its parts not given back, means "wait": earlierCardCharge refuses.
 *  - booking.card_charge_finished, in the flow's final statement and only when that statement wrote
 *    the booking (CHARGE_FINISHED_AUDIT): the key, the PaymentIntent and whose parts the press
 *    counted (`partsFrom`, a started row's id). A press that loses its statement looks for it before
 *    reversing (cardChargeWinner): the payment is the winner's, so it is never refunded, and the
 *    loser gives back only parts the winner didn't count.
 *  - booking.card_charge_parts_returned, when a press with no clear answer gave its parts back: the
 *    next press then takes them again, and Stripe replays the charge, rather than counting them.
 * Each flow's final statement also requires the booking's updated_at to be the one in the key, so a
 * loser's retire (which touches it) stops a winner that hasn't written yet: the finished row and the
 * retire can't both happen.
 *
 * Writes, so no read-only getter may import it (CLAUDE.md).
 */

export type BookingChargeFlow = 'move' | 'add_guest' | 'settle'

/**
 * The longest a press can run, in seconds: a started charge younger than this may belong to a press
 * still running, so another press on the same key waits. 60 for now; the lead sets it once Retool's
 * function limit is measured.
 */
export const LONGEST_PRESS_SECONDS = 60

export interface BookingCardCharge {
  paymentIntentId: string | null
  orderId: string | null
  /** This press's booking.card_charge_started row. */
  startedId: string
}

interface ChargeSubject {
  flow: BookingChargeFlow
  bookingId: string
  customerId: string
  /** bookings.updated_at as text, read before anything was taken. */
  bookingUpdatedAt: string
  amount: number
}

/** The charge's Stripe key: the same action on the same booking, so a retry, is the same charge. */
export const chargeKey = (subject: ChargeSubject) =>
  `booking-charge:${subject.flow}:${subject.bookingId}:${subject.bookingUpdatedAt}:${Math.round(subject.amount * 100)}`

export const CARD_CHARGE_UNSURE_MESSAGE = "The card charge's answer was lost, so it may have gone through. Check Stripe. Pressing again won't charge twice."

/** Another press on this booking is taking the same payment. Nothing was taken by this one. */
export const CARD_CHARGE_IN_PROGRESS_MESSAGE = 'A payment for this booking is still being taken. Wait a minute, then reload.'

/** No clear answer, and no order to show it landed. `startedId` is this press's started row. */
export class CardChargeUnsureError extends Error {
  constructor(
    message: string,
    readonly startedId: string
  ) {
    super(message)
  }
}

/** The started rows of an earlier press on the same key, if it got no clear answer. */
export function cardChargeUnsure(err: unknown): CardChargeUnsureError | null {
  return err instanceof CardChargeUnsureError ? err : null
}

/** What an earlier press left on this charge's key, read before anything is taken. */
export type EarlierCharge =
  | { state: 'none' }
  /** A press that may still be running: refuse with CARD_CHARGE_IN_PROGRESS_MESSAGE. */
  | { state: 'in_progress' }
  /** A press that died after its charge: its parts are counted as taken (`startedId` is whose). */
  | { state: 'resume'; startedId: string; paymentIntentId: string; orderId: string }

/** A Worker order for this charge: a saved card's order of this amount for this customer, written no
 *  earlier than the started row, with this booking's line, or no lines yet (add-ons alone have no
 *  booking line, and theirs are only linked when the press finishes). */
const ORDER_FOR_CHARGE = `
  SELECT o.id, o.stripe_payment_intent_id FROM orders o
  WHERE o.customer_id = p.customer_id AND o.order_total = p.amount AND o.created_at >= s.at
    AND o.stripe_payment_intent_id IS NOT NULL AND o.payment_method IS NULL
    AND (
      EXISTS (SELECT 1 FROM order_line_items oli WHERE oli.order_id = o.id AND oli.booking_id = p.booking_id AND oli.item_type = 'booking')
      OR (
        NOT EXISTS (SELECT 1 FROM order_line_items oli WHERE oli.order_id = o.id)
        AND NOT EXISTS (SELECT 1 FROM addon_order_lines aol WHERE aol.order_id = o.id)
      )
    )
  ORDER BY o.created_at DESC
  LIMIT 1`

/**
 * Read at the start of a press, before anything is taken. Only started rows with this key count: a
 * different action, or the same one on a booking that has changed since, has another key. A started
 * row with a finished row, or whose press gave its parts back, is over. Of the rest, one younger than
 * LONGEST_PRESS_SECONDS may be a press still running, so this press waits rather than share its
 * payment. An older one with its order is a press that died after its charge: it took everything it
 * takes before charging, and nothing gave it back, so the flow counts those parts and doesn't take
 * them again. A reversed charge can't be mistaken for one: retiring it moved the booking on first.
 */
export async function earlierCardCharge(subject: ChargeSubject): Promise<EarlierCharge> {
  const found = await paddockData.query<{ started_id: string; running: boolean; order_id: string | null; payment_intent_id: string | null }>(
    `WITH p AS (
       SELECT $1::uuid AS booking_id, $2::text AS charge_key, $3::uuid AS customer_id, $4::numeric AS amount, $5::int AS longest
     ),
     s AS (
       SELECT s.id, s.at FROM audit_log s, p
       WHERE s.action = 'booking.card_charge_started' AND s.entity_type = 'booking' AND s.entity_id = p.booking_id::text
         AND s.details->>'key' = p.charge_key
         AND NOT EXISTS (
           SELECT 1 FROM audit_log f
           WHERE f.action = 'booking.card_charge_finished' AND f.entity_type = 'booking' AND f.entity_id = p.booking_id::text
             AND f.details->>'key' = p.charge_key
         )
         AND NOT EXISTS (
           SELECT 1 FROM audit_log r
           WHERE r.action = 'booking.card_charge_parts_returned' AND r.entity_type = 'booking' AND r.entity_id = p.booking_id::text
             AND r.details->>'startedId' = s.id::text
         )
     )
     SELECT s.id AS started_id, s.at > now() - make_interval(secs => p.longest) AS running,
            o.id AS order_id, o.stripe_payment_intent_id AS payment_intent_id
     FROM s CROSS JOIN p
     LEFT JOIN LATERAL (${ORDER_FOR_CHARGE}) o ON true
     ORDER BY s.at DESC, s.id DESC`,
    [subject.bookingId, chargeKey(subject), subject.customerId, subject.amount, LONGEST_PRESS_SECONDS]
  )
  if (found.data.some((row) => row.running)) return { state: 'in_progress' }
  const dead = found.data.find((row) => row.order_id && row.payment_intent_id)
  return dead ? { state: 'resume', startedId: dead.started_id, paymentIntentId: dead.payment_intent_id!, orderId: dead.order_id! } : { state: 'none' }
}

/** After a lost answer: the order a charge on this key left, whichever press's it was. Landed. */
async function landedCardCharge(subject: ChargeSubject): Promise<{ paymentIntentId: string; orderId: string } | null> {
  const found = await paddockData.query<{ id: string; stripe_payment_intent_id: string }>(
    `WITH p AS (SELECT $1::uuid AS booking_id, $2::text AS charge_key, $3::uuid AS customer_id, $4::numeric AS amount)
     SELECT o.id, o.stripe_payment_intent_id
     FROM p
     JOIN audit_log s ON s.action = 'booking.card_charge_started' AND s.entity_type = 'booking'
                     AND s.entity_id = p.booking_id::text AND s.details->>'key' = p.charge_key
     CROSS JOIN LATERAL (${ORDER_FOR_CHARGE}) o
     ORDER BY s.at DESC
     LIMIT 1`,
    [subject.bookingId, chargeKey(subject), subject.customerId, subject.amount]
  )
  const row = found.data[0]
  return row ? { paymentIntentId: row.stripe_payment_intent_id, orderId: row.id } : null
}

/** The charge is finished with, by a decline or a reversal: the next press must be a new charge. */
export async function retireCardCharge(bookingId: string): Promise<void> {
  await paddockData.query('UPDATE bookings SET updated_at = now() WHERE id = $1', [bookingId])
}

/**
 * A press with no clear answer gave back the parts it holds (its own, or those of the dead press it
 * resumed): the next press must take them again, not count them. False if that couldn't be written,
 * when the next press would count them, so staff are told to check.
 */
export async function markCardChargePartsReturned(bookingId: string, startedIds: string[], staffId: string | null): Promise<boolean> {
  try {
    await paddockData.query(
      `INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, details)
       SELECT 'staff', $1, 'booking.card_charge_parts_returned', 'booking', $2, jsonb_build_object('startedId', x)
       FROM unnest($3::text[]) AS x`,
      [staffId, bookingId, startedIds]
    )
    return true
  } catch {
    return false
  }
}

/**
 * The finished row for a flow's final statement, inserted only when `bk` wrote the booking. `actor`,
 * `details` and `when` are its placeholders. The statement must also require the booking's
 * updated_at to be the key's (CHARGE_KEY_STILL_STANDS).
 */
export const CHARGE_FINISHED_AUDIT = (actor: string, details: string, when: string) => `charge_finished AS (
       INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, details)
       SELECT 'staff', ${actor}, 'booking.card_charge_finished', 'booking', bk.id::text, ${details}::jsonb FROM bk WHERE ${when}
       RETURNING id
     )`

/** A final statement's guard: with a card charge, updated_at must still be the one in its key (bind
 *  null when nothing was charged). Without it a loser's retire couldn't stop the winner. */
export const CHARGE_KEY_STILL_STANDS = (booking: string, seenUpdatedAt: string) => `${booking}.updated_at::text = COALESCE(${seenUpdatedAt}::text, ${booking}.updated_at::text)`

/** What the finished row says: the key, the payment, whose parts this press counted (`partsFrom`),
 *  and this press's own started row (`by`). */
export function chargeFinishedDetails(
  subject: ChargeSubject,
  charge: { paymentIntentId: string | null; partsFrom: string; by: string; resumed: boolean } | null
): string {
  if (!charge) return '{}'
  return JSON.stringify({
    key: chargeKey(subject),
    paymentIntentId: charge.paymentIntentId,
    partsFrom: charge.partsFrom,
    by: charge.by,
    resumed: charge.resumed,
  })
}

/**
 * Looked for by a press whose final statement didn't write, after it retired the key: a finished row
 * for its payment means another press (or its own statement, whose answer was lost) wrote the
 * booking with it. The payment is then the booking's, never to be refunded, and the parts that
 * finished press counted are `partsFrom`'s; `by` is the finishing press's own started row. Null when
 * nobody finished with it. Throws if it can't look.
 */
export async function cardChargeWinner(bookingId: string, paymentIntentId: string): Promise<{ partsFrom: string | null; by: string | null } | null> {
  const found = await paddockData.query<{ parts_from: string | null; by: string | null }>(
    `SELECT details->>'partsFrom' AS parts_from, details->>'by' AS by FROM audit_log
     WHERE action = 'booking.card_charge_finished' AND entity_type = 'booking' AND entity_id = $1
       AND details->>'paymentIntentId' = $2
     ORDER BY at
     LIMIT 1`,
    [bookingId, paymentIntentId]
  )
  const row = found.data[0]
  return row ? { partsFrom: row.parts_from, by: row.by } : null
}

/**
 * Charges the customer's saved card. Throws if no money was taken, or if it can't be told that any
 * was (CardChargeUnsureError). A lost answer whose order is there means the charge landed, so that
 * isn't a failure. With no order the caller gives back what it took and marks it given back, and the
 * key stands, so pressing again is safe either way. Stripe saying another request with this key is
 * still running is the same, worded as "wait".
 */
export async function chargeBookingCard(
  subject: ChargeSubject & { staffId: string | null; description: string; lineItems?: ChargeSavedCardLineItem[] }
): Promise<BookingCardCharge> {
  const { flow, bookingId, customerId, amount, description, lineItems, staffId } = subject
  const idempotencyKey = chargeKey(subject)
  // Written before the charge, so a press after this one dies can tell its order (earlierCardCharge).
  let startedId: string
  try {
    const started = await paddockData.query<{ id: string }>(
      `INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, details)
       VALUES ('staff', $1, 'booking.card_charge_started', 'booking', $2, $3::jsonb)
       RETURNING id`,
      [staffId, bookingId, JSON.stringify({ key: idempotencyKey, flow, amount })]
    )
    const id = started.data[0]?.id
    if (!id) throw new Error('no row came back')
    startedId = id
  } catch (err) {
    throw new Error(`Recording the card charge before making it failed, so no card was charged: ${err instanceof Error ? err.message : String(err)}`)
  }
  try {
    const charged = await chargeSavedCard({
      params: {
        customerId,
        amount,
        description,
        ...(lineItems ? { lineItems } : {}),
        idempotencyKey,
      },
    })
    return {
      paymentIntentId: typeof charged['paymentIntentId'] === 'string' ? charged['paymentIntentId'] : null,
      orderId: typeof charged['orderId'] === 'string' ? charged['orderId'] : null,
      startedId,
    }
  } catch (err) {
    if (isChargeUnsure(err)) {
      const landed = await landedCardCharge(subject).catch(() => null)
      if (landed) return { ...landed, startedId }
      throw new CardChargeUnsureError(isChargeKeyInUse(err) ? CARD_CHARGE_IN_PROGRESS_MESSAGE : CARD_CHARGE_UNSURE_MESSAGE, startedId)
    }
    await retireCardCharge(bookingId).catch(() => undefined)
    throw err
  }
}
