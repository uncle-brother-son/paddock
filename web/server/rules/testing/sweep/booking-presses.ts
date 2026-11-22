import path from 'node:path'
import type { Db } from '@/server/db'
import { quoteAddGuest } from '@/server/rules/bookings/add-guest'
import { openRefundClaimOn } from '@/server/rules/bookings/refunds'
import { quoteRemoveAddon } from '@/server/rules/bookings/remove-addon'
import { reconcileClaimNow } from '@/server/rules/orders/reconcile'
import type { AddBookingGuestInput, CancelQuote } from '@/contracts'
import { staffAppDir } from '../staff-app-dir'
import { REPLAY_USER } from './run'
import { replayStripe } from '../replay/stripe-binding'

/*
 * W64 (H-plan 3.3 step 3): step D's presses (W18 to W24), as the screen presses them, moved here unchanged from
 * `replay/booking-side.ts` so the all-Worker sweep and the Worker's own rule tests can press the Worker with nothing of the
 * old code loaded. The replay side re-exports all of it; what it keeps is its old side and its comparisons (W65).
 */

/** How the Worker answers one old action, in the old function's shape. */
export type NewBookingAction = (db: Db, params: unknown) => Promise<unknown>

/**
 * W18 on: the staff app's own thin wrapper, which calls the real route through the old side's paddockWorkerV1
 * stand-in (bindStaffRoutes), so the replay holds the wrapper and the route together to the old function. callWorker
 * puts a fresh request id into an error it throws; that id is left out so a recording repeats.
 */
export function throughStaffApp(name: string): NewBookingAction {
  return async (_db, params) => {
    const wrapper = (await import(/* @vite-ignore */ path.join(staffAppDir(), 'backend/paddock', `${name}.ts`))) as {
      default: (req: { params: unknown; user: typeof REPLAY_USER }) => Promise<unknown>
    }
    try {
      return await wrapper.default({ params, user: REPLAY_USER })
    } catch (err) {
      if (err instanceof Error) throw new Error(err.message.replace(/, request [^)]*\)$/, ')'))
      throw err
    }
  }
}

/**
 * W19: ORDER_SWITCH as it will be live once Wayne adds the booking kinds (W15's four, then `booking_changes` and
 * `reader_flows`), so a booking change that moves money isn't refused BOOKING_PATH_OFF.
 */
export const BOOKING_KINDS_ON = 'no_stripe,saved_card,reader,membership,booking_changes,reader_flows'

/**
 * W64a item 8 (W64 review, "for later" 1): while the all-Worker side presses (sweep/worker.ts sets it around each
 * press), every press runs with this one switch, the live one, in place of its family's set (`withSwitch` and New
 * Order's `postOrder` both replace the whole value). Null everywhere else, so a rule test's own route call keeps the
 * switch it sends.
 */
export const pressSwitch: { live: string | null } = { live: null }

/** `work` with ORDER_SWITCH set to `value` (or the press's live switch), put back after it (the old side's own calls see their own). */
export async function withSwitch<T>(value: string, work: () => Promise<T>): Promise<T> {
  const before = process.env.ORDER_SWITCH
  process.env.ORDER_SWITCH = pressSwitch.live ?? value
  try {
    return await work()
  } finally {
    if (before === undefined) delete process.env.ORDER_SWITCH
    else process.env.ORDER_SWITCH = before
  }
}

/**
 * W19 (Q18): the figures the Settle dialog sends, as the screen works them out from the booking it loaded: seat 1's
 * stored price as `amountDue`, and what the method takes after the gift card and store credit as `toCollect` (the
 * cash tick's own figure for cash, so a recorded cash mismatch still reaches the Worker as it was sent). The old
 * function's params had none.
 */
export async function withSettleFigures(db: Db, params: unknown): Promise<unknown> {
  const sent = params as { bookingId?: string; payment?: { method?: string; confirmedCashAmount?: number; giftCard?: { amount?: number }; storeCredit?: { amount?: number } } }
  if (!sent.bookingId) return params
  const seat = (
    await db.query<{ unit_price: string | null }>(
      'SELECT unit_price::text AS unit_price FROM booking_guests WHERE booking_id = $1 ORDER BY created_at, id LIMIT 1',
      [sent.bookingId]
    )
  )[0]
  if (!seat?.unit_price) return params
  const amountDue = Number.parseFloat(seat.unit_price)
  const left = Math.max(0, Math.round((amountDue - (sent.payment?.giftCard?.amount ?? 0) - (sent.payment?.storeCredit?.amount ?? 0)) * 100) / 100)
  const toCollect = sent.payment?.method === 'cash' && typeof sent.payment.confirmedCashAmount === 'number' ? sent.payment.confirmedCashAmount : left
  return { ...sent, figures: { amountDue, toCollect } }
}

/**
 * W20 (Q18): the figures the Add Guest dialog sends with a payment, as the screen has them from the Worker's quote (its
 * first call): `amountDue` the guest's seat plus the paid add-ons, and what the method takes after the gift card and
 * store credit as `toCollect` (the cash tick's own figure for cash, so a recorded cash mismatch still reaches the Worker
 * as it was sent). Read just before the call, without locking or writing. The old function's params had none.
 */
export async function withAddGuestFigures(db: Db, params: unknown): Promise<unknown> {
  const sent = params as AddBookingGuestInput & { bookingId?: string }
  if (!sent.bookingId || !sent.payment) return params
  const staff = (await db.query<{ can_manage_pricing: boolean | null }>('SELECT can_manage_pricing FROM staff WHERE email = $1', [REPLAY_USER.email]))[0]
  const quote = await quoteAddGuest(db, sent.bookingId, sent, staff?.can_manage_pricing === true)
  if (!quote) return params
  const payment = sent.payment
  const left = Math.max(0, Math.round((quote.amountDue - (payment.giftCard?.amount ?? 0) - (payment.storeCredit?.amount ?? 0)) * 100) / 100)
  const toCollect = payment.method === 'cash' && typeof payment.confirmedCashAmount === 'number' ? payment.confirmedCashAmount : left
  return { ...sent, figures: { amountDue: quote.amountDue, toCollect } }
}

/**
 * W20: Add Guest as the dialog presses it: with the figures it shows (withAddGuestFigures) and a press key. The dialog
 * keeps the key after a press that got no answer (or was refused for being sent again under it), and sends it on every
 * later press until it is closed; any other answer starts a new one. The replay models that per booking, so a press
 * after a dead one gets the first one's stored answer, or is refused if it changed, rather than adding a second guest.
 */
export function addGuestAsTheDialogPresses(): NewBookingAction {
  const heldKeys = new Map<string, string>()
  return async (db, params) => {
    const bookingId = (params as { bookingId?: string }).bookingId ?? ''
    const idempotencyKey = heldKeys.get(bookingId) ?? crypto.randomUUID()
    const answer = await withSwitch(BOOKING_KINDS_ON, async () =>
      throughStaffApp('addBookingGuest')(db, { ...((await withAddGuestFigures(db, params)) as object), idempotencyKey })
    )
    const reason = (answer as { reason?: string } | null)?.reason
    if (reason === 'no_answer' || reason === 'pressed_after_no_answer') heldKeys.set(bookingId, idempotencyKey)
    else heldKeys.delete(bookingId)
    return answer
  }
}

/**
 * W21: refundBooking's amount paths (Part refund, Refund the rest, It already arrived) as the dialogs press them: with
 * a press key kept after no answer (the dialog keeps it until it closes, W20a's rule), and the switch on. The wrapper
 * now answers a refusal as `failed` data (so the dialog can tell it from no answer); the dialogs show its words where
 * they showed the old function's thrown error, so the replay reads it as that throw. W23: Cancel & Refund (no amount)
 * too, as its dialog presses it: the Worker's quote for the ticked add-ons first, then the press with the quote's
 * figures as confirmed (Q18; the old params had none).
 */
export function refundAsTheDialogPresses(): NewBookingAction {
  const heldKeys = new Map<string, string>()
  return async (db, params) => {
    const sent = params as { bookingId?: string; refundMethod?: string; addonLineIds?: string[]; clubCancelled?: boolean }
    const bookingId = sent.bookingId ?? ''
    let press: object = params as object
    if (!refundBuiltFor(params)) {
      // W23a: Block Session's and Block Day's dialogs ask for the club's quote.
      const quoted = (await withSwitch(BOOKING_KINDS_ON, () =>
        throughStaffApp('refundBooking')(db, {
          bookingId,
          refundMethod: sent.refundMethod,
          ...(sent.addonLineIds ? { addonLineIds: sent.addonLineIds } : {}),
          ...(sent.clubCancelled === true ? { clubCancelled: true } : {}),
        })
      )) as { quote?: CancelQuote } | null
      press = { ...(params as object), confirmed: { refund: quoted?.quote?.refund ?? 0, addonsRefund: quoted?.quote?.addonsRefund ?? 0 } }
    }
    const idempotencyKey = heldKeys.get(bookingId) ?? crypto.randomUUID()
    const answer = (await withSwitch(BOOKING_KINDS_ON, () => throughStaffApp('refundBooking')(db, { ...press, idempotencyKey }))) as {
      failed?: { message: string }
      noAnswer?: unknown
      pressedAfterNoAnswer?: unknown
    } | null
    if (answer?.noAnswer || answer?.pressedAfterNoAnswer) heldKeys.set(bookingId, idempotencyKey)
    else heldKeys.delete(bookingId)
    if (answer?.failed) throw new Error(answer.failed.message)
    await settleHeldRefund(db, bookingId)
    return answer
  }
}

/**
 * W21: a refund the Worker held (Q35): staff check the Orders page, where reconcile has settled it, before they do
 * anything else to the booking. The replay settles it as reconcile does (it never sends a refund) straight after the
 * press, and again before the booking's next step if a write the scenario made fail was still failing then.
 */
export async function settleHeldRefund(db: Db, bookingId: string | undefined): Promise<void> {
  if (!bookingId || !replayStripe.current) return
  const held = await openRefundClaimOn(db, bookingId)
  if (held) await reconcileClaimNow(db, replayStripe.current, held, { actor: { type: 'system', id: null }, requestId: crypto.randomUUID() })
}

/**
 * W22: Remove Guest as the dialog presses it: the quote, then the removal with the amount it showed (the old params
 * carry both), with a press key kept after no answer (W20a's rule) per guest, and the switch on. A refund the Worker
 * held is settled straight after, as staff would find it on the Orders page.
 */
export function removeGuestAsTheDialogPresses(): NewBookingAction {
  const heldKeys = new Map<string, string>()
  return async (db, params) => {
    const guestId = (params as { guestId?: string }).guestId ?? ''
    const bookingId = await bookingOf(db, params)
    const idempotencyKey = heldKeys.get(guestId) ?? crypto.randomUUID()
    const answer = (await withSwitch(BOOKING_KINDS_ON, () => throughStaffApp('removeBookingGuest')(db, { ...(params as object), idempotencyKey }))) as { reason?: string } | null
    if (answer?.reason === 'no_answer' || answer?.reason === 'pressed_after_no_answer') heldKeys.set(guestId, idempotencyKey)
    else heldKeys.delete(guestId)
    await settleHeldRefund(db, bookingId)
    return answer
  }
}

/**
 * W22: Remove add-on as the dialog presses it: the Worker's quote first (the dialog asks for it on open), then the
 * removal with the refund it showed for the choice (`confirmedRefund`: the quote's refund for a paid add-on refunded
 * to the card or store credit, else £0), a press key kept after no answer, and the switch on. The old params had no
 * figure: the old function worked it out itself.
 */
export function removeAddonAsTheDialogPresses(): NewBookingAction {
  const heldKeys = new Map<string, string>()
  return async (db, params) => {
    const sent = params as { addonLineId?: string; refund?: string }
    const lineId = sent.addonLineId ?? ''
    const bookingId = await bookingOf(db, params)
    let confirmedRefund = 0
    try {
      const quote = await quoteRemoveAddon(db, lineId)
      confirmedRefund = quote.paid && (sent.refund === 'card' || sent.refund === 'credit') ? quote.refund : 0
    } catch {
      // The quote is refused as the removal will be (the line gone, removed, or its session started): £0 is sent.
    }
    const idempotencyKey = heldKeys.get(lineId) ?? crypto.randomUUID()
    const answer = (await withSwitch(BOOKING_KINDS_ON, () => throughStaffApp('removeBookingAddon')(db, { ...sent, confirmedRefund, idempotencyKey }))) as {
      removed?: boolean
      reason?: string
    } | null
    if (answer?.reason === 'no_answer' || answer?.reason === 'pressed_after_no_answer') heldKeys.set(lineId, idempotencyKey)
    else heldKeys.delete(lineId)
    await settleHeldRefund(db, bookingId)
    return answer
  }
}

/**
 * W23: Cancel & return credit and Cancel (payment needed) as their dialogs press them: the Worker's quote for the ticked
 * add-ons first, then the press with the paid add-ons' figure it showed when staff chose a refund for them (£0 otherwise,
 * as the dialog sends it), a press key kept after no answer, and the switch on. The old params had no figure.
 */
export function cancelCreditAsTheDialogPresses(): NewBookingAction {
  const heldKeys = new Map<string, string>()
  return async (db, params) => {
    const sent = params as { bookingId?: string; addonLineIds?: string[]; addonRefund?: string; clubCancelled?: boolean }
    const bookingId = sent.bookingId ?? ''
    const quoted = (await withSwitch(BOOKING_KINDS_ON, () =>
      throughStaffApp('cancelCreditBooking')(db, {
        bookingId,
        ...(sent.addonLineIds ? { addonLineIds: sent.addonLineIds } : {}),
        ...(sent.clubCancelled === true ? { clubCancelled: true } : {}),
      })
    )) as { quote?: CancelQuote } | null
    const refunded = sent.addonRefund === 'card' || sent.addonRefund === 'credit'
    const confirmed = { addonsRefund: refunded ? (quoted?.quote?.addonsRefund ?? 0) : 0 }
    const idempotencyKey = heldKeys.get(bookingId) ?? crypto.randomUUID()
    const answer = (await withSwitch(BOOKING_KINDS_ON, () => throughStaffApp('cancelCreditBooking')(db, { ...sent, confirmed, idempotencyKey }))) as { reason?: string } | null
    if (answer?.reason === 'no_answer' || answer?.reason === 'pressed_after_no_answer') heldKeys.set(bookingId, idempotencyKey)
    else heldKeys.delete(bookingId)
    await settleHeldRefund(db, bookingId)
    return answer
  }
}

/**
 * W24: Move as the dialog presses it. The quote (the dialog's "Check Price Difference") goes to the Worker's quote route
 * and its figures are kept for that booking, as the dialog keeps them on screen; the press sends them back (Q18:
 * `figures.amountDue`, signed; `toCollect` the cash tick's own figure for cash, else what the method takes after the
 * gift card and store credit), with a press key kept after no answer (W20a's rule), and the switch on. A press with no
 * quote before it (none in the golden files) asks for one first. The old params had no figures.
 */
export function moveAsTheDialogPresses(): NewBookingAction {
  const heldKeys = new Map<string, string>()
  const shown = new Map<string, number>()
  return async (db, params) => {
    const sent = params as { bookingId?: string; newSessionId?: string; confirmed?: boolean; payment?: { method?: string; confirmedCashAmount?: number; giftCard?: { amount?: number }; storeCredit?: { amount?: number } } }
    const bookingId = sent.bookingId ?? ''
    const quote = async () => {
      const answer = (await withSwitch(BOOKING_KINDS_ON, () => throughStaffApp('moveBooking')(db, { bookingId, newSessionId: sent.newSessionId }))) as { priceImpact?: { amountDue: number } } | null
      if (answer?.priceImpact) shown.set(bookingId, answer.priceImpact.amountDue)
      else shown.delete(bookingId)
      return answer
    }
    if (sent.confirmed !== true) return quote()
    if (!shown.has(bookingId)) await quote()
    const amountDue = shown.get(bookingId) ?? 0
    const payment = sent.payment
    const left = Math.max(0, Math.round((amountDue - (payment?.giftCard?.amount ?? 0) - (payment?.storeCredit?.amount ?? 0)) * 100) / 100)
    const toCollect = payment?.method === 'cash' && typeof payment.confirmedCashAmount === 'number' ? payment.confirmedCashAmount : left
    const idempotencyKey = heldKeys.get(bookingId) ?? crypto.randomUUID()
    const answer = (await withSwitch(BOOKING_KINDS_ON, () => throughStaffApp('moveBooking')(db, { ...sent, figures: { amountDue, toCollect }, idempotencyKey }))) as {
      reason?: string
      priceImpact?: { amountDue: number }
    } | null
    if (answer?.reason === 'no_answer' || answer?.reason === 'pressed_after_no_answer') heldKeys.set(bookingId, idempotencyKey)
    else heldKeys.delete(bookingId)
    // A refusal over the amount carries the new figures: the dialog moves to them.
    if (answer?.priceImpact) shown.set(bookingId, answer.priceImpact.amountDue)
    await settleHeldRefund(db, bookingId)
    return answer
  }
}

/** W22: the booking an action's params are about: its booking id, or the booking of its guest or add-on line. */
export async function bookingOf(db: Db, params: unknown): Promise<string | undefined> {
  const sent = (params ?? {}) as { bookingId?: string; guestId?: string; addonLineId?: string }
  if (sent.bookingId) return sent.bookingId
  if (sent.guestId) return (await db.query<{ booking_id: string }>('SELECT booking_id FROM booking_guests WHERE id = $1::uuid', [sent.guestId]))[0]?.booking_id
  if (sent.addonLineId) return (await db.query<{ booking_id: string }>('SELECT booking_id FROM addon_order_lines WHERE id = $1::uuid', [sent.addonLineId]))[0]?.booking_id
  return undefined
}

/** W21: the refundBooking calls with an amount (or about owed money); W23: the rest are Cancel & Refund. */
export function refundBuiltFor(params: unknown): boolean {
  const sent = (params ?? {}) as { amount?: unknown; refundOwed?: unknown; owedArrived?: unknown }
  return sent.amount !== undefined || sent.refundOwed === true || sent.owedArrived === true
}

/**
 * The booking actions the Worker answers, by old name, each with press keys and quoted figures of its own. W17: the
 * refund figures. W18: special requests and status, through the staff app's thin wrappers. W19: Settle, with the
 * figures the dialog now sends, and the reader flows' finalise and cancel, through the staff app's wrappers. W64a item 8
 * (W64 review, "for later" 5): the all-Worker side makes a new set for every scenario (sweep/worker.ts), so a key held
 * after no answer never follows a seeded booking id into the next scenario. W65: the old replay's one shared set
 * (BUILT_BOOKING_ACTIONS) and its empty PARTLY_BUILT went with the old side.
 */
export function bookingPresses(): ReadonlyMap<string, NewBookingAction> {
  return new Map<string, NewBookingAction>([
    ['setBookingSpecialRequests', throughStaffApp('setBookingSpecialRequests')],
    ['setBookingStatus', throughStaffApp('setBookingStatus')],
    ['settleLapsedBooking', async (db, params) => withSwitch(BOOKING_KINDS_ON, async () => throughStaffApp('settleLapsedBooking')(db, await withSettleFigures(db, params)))],
    ['addBookingGuest', addGuestAsTheDialogPresses()],
    ['finaliseReaderPayment', throughStaffApp('finaliseReaderPayment')],
    ['cancelReaderPayment', throughStaffApp('cancelReaderPayment')],
    // W21: through the staff app's thin wrapper and the figures route (W17 answered it from the rule directly).
    ['getBookingRefundFigures', throughStaffApp('getBookingRefundFigures')],
    ['refundBooking', refundAsTheDialogPresses()],
    // W22: Remove Guest and Remove add-on, through the staff app's thin wrappers as the dialogs press them.
    ['removeBookingGuest', removeGuestAsTheDialogPresses()],
    ['removeBookingAddon', removeAddonAsTheDialogPresses()],
    // W23: Cancel & return credit and Cancel (payment needed), through the staff app's thin wrapper as the dialogs press it.
    ['cancelCreditBooking', cancelCreditAsTheDialogPresses()],
    // W24: Move, through the staff app's thin wrapper as the dialog presses it.
    ['moveBooking', moveAsTheDialogPresses()],
  ])
}
