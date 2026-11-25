import type { ReactNode } from 'react'

import { Button, SecondaryButton } from '@/components/ui/Button'
import { QuantityStepper } from '@/components/ui/QuantityStepper'
import type { PrivateSession, PublicSession } from '@/lib/book/api'
import { FULLY_BOOKED, groupFor, groupLine, privateBand, rowPrice, sessionLength, sessionTime, spotsLine } from '@/lib/book/book'

/** The row itself: Surface/Card, 16px inside. A phone stacks its details over its buttons, 16px apart. */
const ROW = 'flex flex-col gap-16 rounded-s p-16 md:flex-row md:items-center md:justify-between md:gap-0'

/**
 * One of a row's three pairs of words. From 768px they are one over the other, 8px apart; on a phone they are one
 * line, the first taking the room and the second at the right.
 */
const PAIR = 'flex items-start gap-12 md:flex-col md:gap-8'
const FIRST = 'min-w-0 flex-1 text-label-12 text-text-primary md:flex-none'
const SECOND = 'text-copy-12 whitespace-nowrap text-text-muted-primary'

/** Figma's column widths from 768px: the time's is 100 (no step of the spacing scale), the price's 160. */
const TIME = 'md:w-[100px] md:shrink-0'
const SERVICE = 'md:min-w-0 md:flex-1'
const PRICE = 'md:w-160 md:shrink-0'

function Details({ children }: { children: ReactNode }) {
  // From 768px the three pairs are the row's own columns.
  return <div className="flex flex-col gap-8 md:contents">{children}</div>
}

/**
 * The room a row's stepper and Book button take from 768px, kept by a row that has neither (a full session, a row
 * still loading), so every row's columns line up. It is not seen, heard or reached.
 */
function ActionsRoom() {
  return (
    <div aria-hidden="true" className="invisible hidden items-stretch gap-8 md:flex">
      <QuantityStepper value={1} max={1} onChange={() => undefined} />
      <Button tabIndex={-1}>Book</Button>
    </div>
  )
}

type SessionRowProps = {
  session: PublicSession | PrivateSession
  /** How many people the stepper is on: from 1 to the most this session allows now (W77a). */
  people: number
  onPeople: (people: number) => void
  onBook: () => void
  /** Book was pressed and the price is being asked: a second press does nothing. */
  asking?: boolean
}

/**
 * Figma "SessionRow" (03 UI, 775:3649), a session in the Book panel, for a visitor who isn't signed in:
 * - State=Non Member: when it starts with its length, the service with its band, the price with what is left, the
 *   people stepper and Book. A public session's price is one person's, with "3 Spots Left". A private session's is
 *   its group's (W77a's price for the size group the stepper is in) with that group beneath: "£105" over "1-6
 *   People", and at 7 "£120" over "7 People", as drawn (1174:13242); its band reads "Private - Off-Peak";
 * - State=Full: the row on Surface/Card Disabled, "Fully booked" under the price, and in the buttons' place a
 *   disabled "Full".
 * From 768px it is one line (Device=desktop); on a phone the three pairs of words are a line each, with the stepper
 * and Book beneath, each the row's whole width (Device=mobile).
 *
 * State=Member (credits, a member's price) waits for sign-in (WQ64): the member line belongs beside the price.
 */
export function SessionRow({ session, people, onPeople, onBook, asking = false }: SessionRowProps) {
  const isPrivate = 'prices' in session
  const full = session.state === 'full' || session.mostPeople < 1
  const time = sessionTime(session.startsAt)
  // Never more than the session allows, whatever the stepper was on before the day was read again.
  const chosen = Math.max(1, Math.min(people, session.mostPeople))
  const group = isPrivate ? groupFor(session, chosen) : null
  // A full private session has no group to price: its smallest group's price stands, as a full public one keeps its own.
  const price = isPrivate ? (group ?? session.prices[0])?.price : session.price
  const left = full ? FULLY_BOOKED : isPrivate ? (group ? groupLine(group) : '') : spotsLine(session.spotsLeft)

  return (
    <li data-book="session" data-session={session.id} data-session-state={full ? 'full' : 'bookable'} className={`${ROW} ${full ? 'bg-surface-card-disabled' : 'bg-surface-card'}`}>
      <Details>
        <div className={`${PAIR} ${TIME}`}>
          <p className={FIRST}>
            <time dateTime={session.startsAt}>{time}</time>
          </p>
          <p className={SECOND}>{sessionLength(session.minutes)}</p>
        </div>
        <div className={`${PAIR} ${SERVICE}`}>
          <p className={FIRST}>{session.service}</p>
          <p className={SECOND}>{isPrivate ? privateBand(session.band) : session.band}</p>
        </div>
        {/* The price follows the stepper on a private session: said to a screen reader as it changes. */}
        <div aria-live={isPrivate ? 'polite' : undefined} className={`${PAIR} ${PRICE}`}>
          <p className={FIRST}>{price === undefined ? '' : rowPrice(price)}</p>
          <p className={SECOND}>{left}</p>
        </div>
      </Details>
      {full ? (
        <div className="relative flex md:justify-end">
          <ActionsRoom />
          <SecondaryButton disabled className="w-full md:absolute md:inset-y-0 md:right-0 md:w-auto">
            Full
          </SecondaryButton>
        </div>
      ) : (
        <div className="flex flex-col gap-8 md:flex-row md:items-stretch">
          <QuantityStepper value={chosen} max={session.mostPeople} onChange={onPeople} label={`Number of people, ${time}`} className="w-full md:w-auto" />
          <Button aria-label={`Book ${time}`} aria-disabled={asking} onClick={asking ? undefined : onBook} className="w-full md:w-auto">
            Book
          </Button>
        </div>
      )}
    </li>
  )
}

/** A bar where words will be: Surface/Card, as wide and as tall as the words it stands for (Figma's "Skeleton": 9px tall). */
function Bar({ words, className }: { words: string; className: string }) {
  return <p className={`${className} rounded-[2px] bg-surface-card text-transparent select-none`}>{words}</p>
}

/**
 * Figma "SessionRow", State=Loading: the row on Surface/Card Disabled with a bar for each of its words and one for
 * its buttons, while a day's sessions are read. The bars are the size of the words and the buttons of a row as it
 * comes (Figma's sizes are those of "08:00", "60 min" and the rest), so a row takes the same room before and after.
 * It is nothing to a screen reader: the list says that it is loading (BookSessions).
 */
export function SessionRowLoading() {
  const bar = (first: string, second: string, place: string) => (
    <div className={`${PAIR} ${place}`}>
      {/* On a phone the first bar takes the room up to the second, as the words do. */}
      <Bar words={first} className="min-w-0 flex-1 text-label-12 md:flex-none" />
      <Bar words={second} className="text-copy-12 whitespace-nowrap" />
    </div>
  )
  return (
    <li aria-hidden="true" data-book="session" data-session-state="loading" className={`${ROW} bg-surface-card-disabled`}>
      <Details>
        {bar('08:00', '60 min', TIME)}
        {bar('Contrast Therapy', 'Off-Peak', SERVICE)}
        {bar('£15', '3 Spots Left', PRICE)}
      </Details>
      <div className="rounded-[2px] bg-surface-card">
        <ActionsRoom />
        {/* On a phone the bar is the row's width and a button's height. */}
        <div className="invisible md:hidden">
          <Button tabIndex={-1} className="w-full">
            Book
          </Button>
        </div>
      </div>
    </li>
  )
}
