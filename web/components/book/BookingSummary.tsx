import type { Ref } from 'react'

import { Button } from '@/components/ui/Button'
import type { BookingSummaryView, SummaryLine } from '@/lib/book/book'

/** Each of the summary's cards: Surface/Card with 4px corners, 12px inside each side. */
const CARD = 'flex flex-col gap-24 rounded-s bg-surface-card px-12'

/** Figma "SummaryRow" (1174:156): what a line is for, and its figure at the right in Label 12. Type=total: both in Label 12. */
function SummaryRow({ line, total = false }: { line: Pick<SummaryLine, 'label' | 'value'>; total?: boolean }) {
  return (
    <div className="flex items-center gap-8 text-text-primary">
      <dt className={`min-w-0 flex-1 ${total ? 'text-label-12' : 'text-copy-12'}`}>{line.label}</dt>
      <dd className="text-label-12 whitespace-nowrap">{line.value}</dd>
    </div>
  )
}

type BookingSummaryProps = {
  summary: BookingSummaryView
  /** Back to the sessions step, with the day and the people kept. */
  onChange: () => void
  onAddToBag: () => void
  onBookNow: () => void
  /** Its heading: the add-ons step moves focus here when it opens. */
  headingRef?: Ref<HTMLHeadingElement>
  className?: string
}

/**
 * Figma "BookingSummary" (03 UI, 1178:20011), "Your booking" on the Book panel's add-ons step, in its non-member
 * scenarios: cards 12px apart, with no lines between them.
 * - the session: "Your Booking", then the service with "Change" at its right (Link 12, Text/Muted Primary), when it
 *   is (WQ69: "08:00 - Thursday 12 November") and what it is ("60 min - Public - Off-Peak"; private: "60 min -
 *   Private"), then the people: "2 People" with the session's price for them; a private one says whose price it is
 *   ("4 People - Group price for 1 to 6");
 * - the add-ons, only when some are chosen: "Add-Ons", then a line each ("Towel × 2" with that line's figure);
 * - "Total to pay", with Add to bag and Book now side by side beneath it, each half the card;
 * - under the cards the two notes, in Copy 12 and Text/Muted Primary.
 *
 * The member's scenarios (the "You" and "N Guests" lines with credits, Session Credits and Add-on Credits above the
 * total, a member's price or a sale price on an add-on, a pass holder's) wait for sign-in (WQ64).
 */
export function BookingSummary({ summary, onChange, onAddToBag, onBookNow, headingRef, className }: BookingSummaryProps) {
  return (
    <section data-book="summary" aria-label="Your booking" className={`flex flex-col gap-12 ${className ?? ''}`}>
      <div className={`${CARD} py-16`}>
        {/* Focus by script only (the step's start), never in the Tab order; a heading shows no ring. */}
        <h2 ref={headingRef} tabIndex={-1} className="text-label-12 text-text-primary outline-none">
          Your Booking
        </h2>
        <div className="flex flex-col gap-8">
          <div className="flex items-center justify-between gap-8">
            <p className="min-w-0 text-label-12 text-text-primary">{summary.service}</p>
            {/* The link is as tall as its capitals: the press reaches 8px round it. */}
            <button type="button" onClick={onChange} className="relative shrink-0 text-link-12 text-text-muted-primary after:absolute after:-inset-8">
              Change<span className="sr-only"> the session</span>
            </button>
          </div>
          <p className="text-copy-12 text-text-primary">
            <time dateTime={summary.startsAt}>{summary.when}</time>
          </p>
          <p className="text-copy-12 text-text-muted-primary">{summary.detail}</p>
        </div>
        <dl>
          <SummaryRow line={summary.people} />
        </dl>
      </div>

      {summary.addOns.length > 0 ? (
        <div className={`${CARD} py-16`}>
          <h3 className="text-label-12 text-text-primary">Add-Ons</h3>
          <dl className="flex flex-col gap-8">
            {summary.addOns.map((line) => (
              <SummaryRow key={line.key} line={line} />
            ))}
          </dl>
        </div>
      ) : null}

      <div className={`${CARD} pt-16 pb-12`}>
        {/* The total follows the add-ons chosen: said to a screen reader as it changes. */}
        <dl aria-live="polite">
          <SummaryRow line={{ label: 'Total to pay', value: summary.total }} total />
        </dl>
        {/* Side by side, each half the card, wherever both fit with their own 32px each side; on a card too narrow for
            that (the panel on a 320px phone) Book now goes beneath, each the card's whole width (W78b, WQ78). */}
        <div className="flex flex-wrap gap-12">
          <Button onClick={onAddToBag} className="min-w-max flex-1">
            Add to bag
          </Button>
          <Button onClick={onBookNow} className="min-w-max flex-1">
            Book now
          </Button>
        </div>
      </div>

      {/* One block of two lines, as drawn: a text style is trimmed to its capitals, so two blocks would touch. */}
      <p className="px-12 text-copy-12 text-text-muted-primary">
        Guests’ details are added at checkout.
        <br />
        Cancel more than 24 hours before the session for store credit.
      </p>
    </section>
  )
}
