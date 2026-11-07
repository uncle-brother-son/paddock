import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FakeStripe } from '@/server/stripe/fake'
import { oldSide, replay, startReplay, type ReplayEnvironment, type Scenario } from './harness'
import { bea, ID, publicOnCard, scenarios, seed, w05lPay } from './scenarios'

// W05l on the old functions: Move and Settle with a gift card part write a gift_card_redemptions
// row in their final statement, as Add Guest does, and every undo or reversal leaves none behind.

interface Redemption {
  gift_card_id: string
  order_id: string | null
  booking_id: string | null
  amount_used: string
  redeemed_at: string | null
}

interface After {
  rows: Redemption[]
  balance: string
  booking: { id: string; status: string; session_id: string; price_paid: string | null }
  stripe: FakeStripe
  results: unknown[]
  /** Places counted on each session the scenarios move between. */
  places: Record<string, number>
  guests: number
  pressRows: number
}

const byName = (name: string): Scenario => {
  const scenario = scenarios.find((s) => s.name === name)
  if (!scenario) throw new Error(`No scenario ${name}`)
  return scenario
}

/** Add Guest's own row for the same payment: £5 on the gift card, the rest on the saved card. */
const addGuestOnGiftCardAndCard: Scenario = {
  name: 'w05l-add-guest-gift-card-and-card',
  seed,
  async run({ call }) {
    const placed = (await call('createOrder', { customerId: ID.customer, ...publicOnCard })) as { bookingId: string }
    await call('addBookingGuest', { bookingId: placed.bookingId, ...bea })
    await call('addBookingGuest', { bookingId: placed.bookingId, ...bea, payment: w05lPay.card })
  },
}

describe('W05l: gift card redemptions on Move and Settle', () => {
  let environment: ReplayEnvironment

  beforeAll(async () => {
    environment = await startReplay()
  })
  afterAll(() => environment.stop())

  async function after(scenario: Scenario): Promise<After> {
    let stripe: FakeStripe | null = null
    const recording = await replay(environment, scenario, (db, fake) => {
      stripe = fake
      return oldSide(db, fake)
    })
    const { db } = environment.database
    const rows = await db.query<Redemption>(
      'SELECT gift_card_id, order_id, booking_id, amount_used, redeemed_at FROM gift_card_redemptions ORDER BY redeemed_at'
    )
    const [card] = await db.query<{ remaining_balance: string }>('SELECT remaining_balance FROM gift_cards WHERE id = $1', [ID.giftCard])
    // The scenario's own booking: the seeded ones have no order line.
    const [booking] = await db.query<After['booking']>(
      `SELECT b.id, b.status, b.session_id, b.price_paid FROM bookings b
       WHERE EXISTS (SELECT 1 FROM order_line_items oli WHERE oli.booking_id = b.id) OR b.customer_id = $1
       ORDER BY b.created_at DESC LIMIT 1`,
      [ID.member]
    )
    const sessions = await db.query<{ id: string; total_booked: number }>('SELECT id, total_booked FROM sessions WHERE id = ANY($1::uuid[])', [
      [ID.session, ID.peakSession, ID.laterPublicSession],
    ])
    const [guests] = await db.query<{ n: string }>('SELECT count(*) AS n FROM booking_guests WHERE booking_id = $1', [booking?.id])
    const [press] = await db.query<{ n: string }>(`SELECT count(*) AS n FROM audit_log WHERE action = 'booking.press_finished'`)
    return {
      rows,
      balance: card?.remaining_balance ?? '',
      booking: booking as After['booking'],
      stripe: stripe as unknown as FakeStripe,
      results: recording.results,
      places: Object.fromEntries(sessions.map((row) => [row.id, Number(row.total_booked)])),
      guests: Number(guests?.n ?? 0),
      pressRows: Number(press?.n ?? 0),
    }
  }

  /** The one row a £5 part leaves: this booking, no order, as Add Guest's. */
  const oneRow = (state: After) => {
    expect(state.rows).toHaveLength(1)
    expect(state.rows[0]).toMatchObject({ gift_card_id: ID.giftCard, order_id: null, booking_id: state.booking.id, amount_used: '5.00' })
    expect(state.rows[0]?.redeemed_at).not.toBeNull()
    expect(state.balance).toBe('35.00')
  }

  /** Nothing taken and nothing written down. */
  const noRow = (state: After) => {
    expect(state.rows).toEqual([])
    expect(state.balance).toBe('40.00')
  }

  it('Add Guest writes the row the other two are held to (control)', async () => {
    const state = await after(addGuestOnGiftCardAndCard)
    oneRow(state)
  })

  it('Move and Settle write the same columns as Add Guest, with the same ones empty', async () => {
    const shape = (row: Redemption | undefined) =>
      Object.fromEntries(Object.entries(row ?? {}).map(([column, value]) => [column, value === null ? 'empty' : 'set']))
    const addGuest = shape((await after(addGuestOnGiftCardAndCard)).rows[0])
    expect(shape((await after(byName('w05l-move-gift-card-and-card-then-cancel'))).rows[0])).toEqual(addGuest)
    expect(shape((await after(byName('w05l-settle-gift-card-and-card-then-cancel'))).rows[0])).toEqual(addGuest)
  })

  describe.each([
    'w05l-move-gift-card-and-card-then-cancel',
    'w05l-move-gift-card-and-reader-then-cancel',
    'w05l-move-gift-card-and-cash-then-cancel',
    'w05l-settle-gift-card-and-card-then-cancel',
    'w05l-settle-gift-card-and-reader-then-cancel',
  ])('%s', (name) => {
    it('records the £5 against the booking with no order, and Cancel & Refund leaves it', async () => {
      const state = await after(byName(name))
      oneRow(state)
      expect(state.booking.status).toBe('cancelled')
    })
  })

  it('Move on the reader, undone: no row and the £5 back on the card, then Cancel & Refund', async () => {
    const state = await after(byName('w05l-move-gift-card-and-reader-undone-then-cancel'))
    noRow(state)
    expect(state.booking.session_id).toBe(ID.session)
  })

  it('Settle on the reader, undone, then settled on the saved card: one row, for the second', async () => {
    oneRow(await after(byName('w05l-settle-gift-card-and-reader-undone-then-settled')))
  })

  it('Move: the row cannot be written, so the move is not either, and the £5 and the £6 go back', async () => {
    const state = await after(byName('w05l-move-gift-card-row-fails-then-cancel'))
    noRow(state)
    expect(state.booking.session_id).toBe(ID.session)
    // The £6 charge refunded by the move, then the £40 by Cancel & Refund.
    expect(state.stripe.refundedPence).toBe(4600)
  })

  it('Settle: the row cannot be written, so the booking is still awaiting payment, with the £5 and the £15 back', async () => {
    const state = await after(byName('w05l-settle-gift-card-row-fails'))
    noRow(state)
    expect(state.booking.status).toBe('payment_needed')
    expect(state.stripe.refundedPence).toBe(1500)
  })

  it('Move: the statement wrote and its answer was lost: the row stays with the move and nothing goes back', async () => {
    const state = await after(byName('w05l-move-gift-card-answer-lost-then-cancel'))
    oneRow(state)
    expect(state.booking.session_id).toBe(ID.peakSession)
    expect(state.results).toContainEqual(expect.objectContaining({ reason: 'already_moved' }))
    // Only Cancel & Refund's £46: the card money of the move is the booking's.
    expect(state.stripe.refundedPence).toBe(4600)
  })

  it('Settle: the statement wrote and its answer was lost: the row stays with the settle and nothing goes back', async () => {
    const state = await after(byName('w05l-settle-gift-card-answer-lost-then-cancel'))
    oneRow(state)
    expect(state.results).toContainEqual(expect.objectContaining({ reason: 'booking_not_payment_needed' }))
    expect(state.stripe.refundedPence).toBe(1500)
  })

  // --- A statement that wrote and lost its answer, with no card charge -------------------------------
  const told = (state: After, answer: Record<string, unknown>) => expect(state.results).toContainEqual(expect.objectContaining(answer))
  const UNCLEAR = expect.stringContaining('checking whether it was saved failed too, so nothing was put back')

  it('Move, gift card and cash: the move stands with its £5 row, staff are told it moved, and the places follow the booking', async () => {
    const state = await after(byName('w05l-move-gift-card-and-cash-answer-lost-then-cancel'))
    told(state, { moved: true })
    oneRow(state)
    expect(state.pressRows).toBe(1)
    expect(state.booking).toMatchObject({ session_id: ID.peakSession, status: 'cancelled' })
    expect(state.places).toMatchObject({ [ID.session]: 0, [ID.peakSession]: 0 })
  })

  it('Move on the reader: the reader payment is handed back, collected and finalised, with one row', async () => {
    const state = await after(byName('w05l-move-gift-card-and-reader-answer-lost-then-cancel'))
    told(state, { moved: true, pendingReaderPayment: expect.objectContaining({ flow: 'move' }) })
    told(state, { finalised: true })
    oneRow(state)
    expect(state.booking.session_id).toBe(ID.peakSession)
  })

  it('Move to a cheaper session: the £11 still goes back to the card and the places follow the booking', async () => {
    const state = await after(byName('w05l-move-cheaper-answer-lost'))
    told(state, { moved: true })
    expect(state.stripe.refundedPence).toBe(1100)
    expect(state.booking).toMatchObject({ session_id: ID.laterPublicSession, price_paid: '40.00' })
    expect(state.places).toMatchObject({ [ID.peakSession]: 0, [ID.laterPublicSession]: 2 })
  })

  it('Move to a cheaper session: the refund claim the lost statement wrote is finished, as given', async () => {
    await after(byName('w05l-move-cheaper-answer-lost'))
    const rows = await environment.database.db.query<{ claimed: string; finished: Record<string, unknown> | null }>(
      `SELECT c.id AS claimed,
              (SELECT f.details FROM audit_log f WHERE f.action = 'booking.refund_finished' AND f.details->>'claimId' = c.id::text) AS finished
       FROM audit_log c WHERE c.action = 'booking.refund_claimed'`
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.finished).toMatchObject({ outcome: 'given', cardRefunded: 11 })
  })

  it('Move: when the look fails too, nothing is put back and staff are told to check', async () => {
    const state = await after(byName('w05l-move-answer-lost-and-the-look-fails'))
    told(state, { moved: false, reason: 'move_failed_restore_failed', message: UNCLEAR })
    oneRow(state)
    expect(state.booking.session_id).toBe(ID.peakSession)
    expect(state.places).toMatchObject({ [ID.session]: 0, [ID.peakSession]: 2 })
  })

  it('Settle, gift card and cash: the settle stands with its £5 row and staff are told it settled', async () => {
    const state = await after(byName('w05l-settle-gift-card-and-cash-answer-lost-then-cancel'))
    told(state, { settled: true, booking: expect.objectContaining({ status: 'confirmed', price_paid: '20.00' }) })
    oneRow(state)
    expect(state.pressRows).toBe(1)
  })

  it('Settle on the reader: the reader payment is handed back, collected and finalised, with one row', async () => {
    const state = await after(byName('w05l-settle-gift-card-and-reader-answer-lost-then-cancel'))
    told(state, { pendingReaderPayment: expect.objectContaining({ flow: 'settle' }) })
    told(state, { finalised: true })
    oneRow(state)
  })

  it('Settle: when the look fails too, nothing is put back and staff are told to check', async () => {
    const state = await after(byName('w05l-settle-answer-lost-and-the-look-fails'))
    told(state, { settled: false, reason: 'settle_failed', message: UNCLEAR })
    oneRow(state)
    expect(state.booking.status).toBe('confirmed')
  })

  it('Add Guest, gift card and cash: the guest stands with the £5 on its order, and staff are told it was added', async () => {
    const state = await after(byName('w05l-add-guest-gift-card-and-cash-answer-lost-then-cancel'))
    told(state, { added: true })
    expect(state.rows).toHaveLength(1)
    expect(state.rows[0]).toMatchObject({ gift_card_id: ID.giftCard, booking_id: state.booking.id, amount_used: '5.00' })
    expect(state.rows[0]?.order_id).not.toBeNull()
    expect(state.balance).toBe('35.00')
    expect(state.guests).toBe(3)
    expect(state.pressRows).toBe(1)
  })

  it('Add Guest on the reader: the reader payment is handed back, collected and finalised, with one row', async () => {
    const state = await after(byName('w05l-add-guest-gift-card-and-reader-answer-lost-then-cancel'))
    told(state, { added: true, pendingReaderPayment: expect.objectContaining({ flow: 'add_guest' }) })
    told(state, { finalised: true })
    oneRow(state)
    expect(state.guests).toBe(3)
  })

  it('Add Guest: when the look fails too, nothing is put back and staff are told to check', async () => {
    const state = await after(byName('w05l-add-guest-answer-lost-and-the-look-fails'))
    told(state, { added: false, reason: 'guest_add_failed_reversal_incomplete', message: UNCLEAR })
    expect(state.rows).toHaveLength(1)
    expect(state.balance).toBe('35.00')
    expect(state.guests).toBe(3)
  })

  it("Move after another press finished on the booking: its own statement failed, so it is undone (another press's row isn't its own)", async () => {
    const state = await after(byName('w05l-move-fails-after-another-press-finished'))
    noRow(state)
    told(state, { moved: false, reason: 'move_failed' })
    expect(state.booking.session_id).toBe(ID.session)
    expect(state.pressRows).toBe(1)
  })

  it('a press with a card charge writes no press row: its finished row does that job (control)', async () => {
    const state = await after(byName('w05l-move-gift-card-and-card-then-cancel'))
    expect(state.pressRows).toBe(0)
  })
}, 180_000)
