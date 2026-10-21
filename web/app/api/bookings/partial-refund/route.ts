import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'
import { londonWallClockToUtc } from '@/lib/london-time'

function getStripe() {
  return new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: '2026-07-29.dahlia',
    httpClient: Stripe.createFetchHttpClient(), // Workers' runtime doesn't support the SDK's default Node socket client
  })
}

type RefundMethod = 'card' | 'credit'

interface PartialRefundBookingRequest {
  bookingId: string
  amount: number
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

// Rejects amounts with more than 2 decimal places (e.g. 10.001), not just non-positive ones.
function isValidAmount(amount: unknown): amount is number {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) return false
  return Math.round(amount * 100) === amount * 100
}

export async function POST(request: NextRequest) {
  try {
    if (!verifyRetoolAuth(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body: PartialRefundBookingRequest = await request.json()
    const { bookingId, amount, refundMethod } = body

    if (!bookingId || amount === undefined || !refundMethod) {
      return NextResponse.json(
        { error: 'Missing required fields: bookingId, amount, refundMethod' },
        { status: 400 }
      )
    }

    if (!isValidAmount(amount)) {
      return NextResponse.json(
        { error: 'amount must be a positive number with at most 2 decimal places' },
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

    const hoursUntilStart = (londonWallClockToUtc(session.start_time).getTime() - Date.now()) / (1000 * 60 * 60)
    if (hoursUntilStart < 24) {
      return NextResponse.json(
        { error: 'Not eligible for refund or credit — within 24 hours of session start.' },
        { status: 400 }
      )
    }

    if (amount > booking.price_paid) {
      return NextResponse.json(
        { error: 'amount must not exceed the booking\'s price_paid' },
        { status: 400 }
      )
    }

    let refundId: string | null = null
    let storeCreditBalance: number | null = null

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
          amount: Math.round(amount * 100),
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
      // refundMethod === 'credit' — add to the customer's non-expiring store credit balance via
      // the ledger function, for the partial amount. A gift-card payment becomes store credit,
      // never a restoration to the original gift card's balance (per cancellation policy).
      const { data: creditResult, error: creditError } = await supabase.rpc('store_credit_apply', {
        p_customer_id: booking.customer_id,
        p_amount: amount,
        p_reason: 'refund',
        p_booking_id: bookingId,
        p_note: 'Refund to store credit: partial booking refund',
      })

      if (creditError || !creditResult?.ok) {
        console.error('Error applying store credit:', creditError ?? creditResult)
        return NextResponse.json(
          { error: `Failed to issue store credit${creditResult?.reason ? `: ${creditResult.reason}` : ''}` },
          { status: 500 }
        )
      }

      storeCreditBalance = creditResult.balance
    }

    // Deliberately does NOT cancel the booking, change sessions.total_booked, or modify
    // bookings.price_paid — this is a partial refund, the booking stays active and the
    // caller (Retool) is responsible for any further state changes.
    return NextResponse.json({
      success: true,
      refundId,
      storeCreditBalance,
    })
  } catch (error) {
    console.error('Error processing partial refund:', error)
    return NextResponse.json(
      { error: 'Internal server error', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
