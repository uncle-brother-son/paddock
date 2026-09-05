import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'

function getStripe() {
  return new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: '2026-07-29.dahlia',
    httpClient: Stripe.createFetchHttpClient(), // Workers' runtime doesn't support the SDK's default Node socket client
  })
}

type RefundMethod = 'card' | 'credit'

interface RefundBookingRequest {
  bookingId: string
  refundMethod: RefundMethod
}

// Verify Retool API key
function verifyRetoolAuth(request: NextRequest): boolean {
  const authHeader = request.headers.get('authorization')
  const retoolApiKey = process.env.RETOOL_API_KEY

  if (!retoolApiKey) {
    console.error('RETOOL_API_KEY not configured')
    return false
  }

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return false
  }

  const token = authHeader.substring(7)
  return token === retoolApiKey
}

function toDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10)
}

const GIFT_CARD_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // excludes ambiguous chars

function generateGiftCardCode(): string {
  let code = ''
  for (let i = 0; i < 10; i++) {
    code += GIFT_CARD_CODE_CHARS[Math.floor(Math.random() * GIFT_CARD_CODE_CHARS.length)]
  }
  return `GC-${code.slice(0, 5)}-${code.slice(5)}`
}

async function generateUniqueGiftCardCode(supabase: any): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateGiftCardCode()
    const { data } = await supabase.from('gift_cards').select('id').eq('code', code).maybeSingle()
    if (!data) return code
  }
  throw new Error('Failed to generate a unique gift card code')
}

export async function POST(request: NextRequest) {
  try {
    if (!verifyRetoolAuth(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body: RefundBookingRequest = await request.json()
    const { bookingId, refundMethod } = body

    if (!bookingId || !refundMethod) {
      return NextResponse.json(
        { error: 'Missing required fields: bookingId, refundMethod' },
        { status: 400 }
      )
    }

    if (refundMethod !== 'card' && refundMethod !== 'credit') {
      return NextResponse.json(
        { error: 'refundMethod must be "card" or "credit"' },
        { status: 400 }
      )
    }

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    const { data: booking, error: bookingError } = await supabase
      .from('bookings')
      .select('*')
      .eq('id', bookingId)
      .single()

    if (bookingError || !booking) {
      return NextResponse.json({ error: 'Booking not found' }, { status: 404 })
    }

    if (booking.status === 'cancelled') {
      return NextResponse.json({ error: 'Booking is already cancelled' }, { status: 400 })
    }

    // This endpoint only handles redemption sources that involve real money movement
    // (card payments, gift cards). Membership/session-pass credit returns never touch
    // Stripe and are a plain Postgres operation — handle those via a direct Retool
    // action (same pattern as the existing adjustMembershipCredits action), not here.
    if (booking.redemption_source !== 'paid' && booking.redemption_source !== 'gift_card') {
      return NextResponse.json(
        {
          error:
            'This endpoint only handles refunds for card or gift-card payments. Membership and session-pass credit returns should be handled directly in Retool.',
        },
        { status: 400 }
      )
    }

    const { data: session, error: sessionError } = await supabase
      .from('sessions')
      .select('id, start_time, total_booked')
      .eq('id', booking.session_id)
      .single()

    if (sessionError || !session) {
      return NextResponse.json({ error: 'Session not found for this booking' }, { status: 404 })
    }

    const hoursUntilStart = (new Date(session.start_time).getTime() - Date.now()) / (1000 * 60 * 60)
    if (hoursUntilStart < 24) {
      return NextResponse.json(
        { error: 'Not eligible for refund or credit — within 24 hours of session start.' },
        { status: 400 }
      )
    }

    let refundId: string | null = null
    let giftCard: Record<string, unknown> | null = null

    if (refundMethod === 'card') {
      if (!booking.stripe_payment_id) {
        return NextResponse.json(
          { error: 'Booking has no stripe_payment_id on file — cannot refund to card.' },
          { status: 400 }
        )
      }

      try {
        const refund = await getStripe().refunds.create({
          payment_intent: booking.stripe_payment_id,
        })
        refundId = refund.id
      } catch (stripeError) {
        console.error('Error creating Stripe refund:', stripeError)
        return NextResponse.json(
          {
            error: 'Failed to refund to card',
            details: stripeError instanceof Error ? stripeError.message : 'Unknown error',
          },
          { status: 500 }
        )
      }
    } else {
      // refundMethod === 'credit' — issue a new store-credit gift card.
      // A gift card payment becomes a new credit, never a restoration to the
      // original gift card balance (per cancellation policy).
      const code = await generateUniqueGiftCardCode(supabase)
      const issueDate = new Date()
      const expiryDate = new Date(issueDate)
      expiryDate.setMonth(expiryDate.getMonth() + 12) // monetary gift cards expire after 12 months

      const { data: createdGiftCard, error: giftCardError } = await supabase
        .from('gift_cards')
        .insert({
          code,
          type: 'monetary',
          original_value: booking.price_paid,
          remaining_balance: booking.price_paid,
          purchaser_id: booking.customer_id,
          origin: 'issued_as_credit',
          issue_date: toDateOnly(issueDate),
          expiry_date: toDateOnly(expiryDate),
        })
        .select()
        .single()

      if (giftCardError || !createdGiftCard) {
        console.error('Error creating credit gift card:', giftCardError)
        return NextResponse.json({ error: 'Failed to issue credit' }, { status: 500 })
      }

      giftCard = createdGiftCard
    }

    // Cancel the booking and release its capacity back into availability.
    const { data: updatedBooking, error: updateBookingError } = await supabase
      .from('bookings')
      .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
      .eq('id', bookingId)
      .select()
      .single()

    if (updateBookingError) {
      console.error('Error updating booking after refund/credit:', updateBookingError)
      // The refund/credit already happened — surface success but flag manual follow-up
      // rather than pretending the whole operation failed.
      return NextResponse.json({
        success: true,
        warning: 'Refund/credit succeeded but booking status update failed — verify manually.',
        refundId,
        giftCard,
      })
    }

    const { error: updateSessionError } = await supabase
      .from('sessions')
      .update({ total_booked: Math.max(0, session.total_booked - booking.party_size) })
      .eq('id', session.id)

    if (updateSessionError) {
      console.error('Error releasing session capacity:', updateSessionError)
      return NextResponse.json({
        success: true,
        warning: 'Refund/credit and booking cancellation succeeded but capacity release failed — verify manually.',
        booking: updatedBooking,
        refundId,
        giftCard,
      })
    }

    return NextResponse.json({
      success: true,
      booking: updatedBooking,
      refundId,
      giftCard,
    })
  } catch (error) {
    console.error('Error processing refund:', error)
    return NextResponse.json(
      { error: 'Internal server error', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
