import type { Ref } from 'react'

import type { BookAddOn, BookingSummaryView } from '@/lib/book/book'

import { AddOnCard } from './AddOnCard'
import { BookingSummary } from './BookingSummary'
import { FREE_ONE, FREE_TWO, SEVEN_COLUMNS, TWELVE_COLUMNS } from './columns'

/**
 * The cards, three to a row as drawn, 4px apart, for as long as a card is at least 102px wide: the width of its
 * quantity stepper (two 33px icon buttons and the number's 36), which a card can't go under. Narrower than that
 * (the panel on a 320px phone), they wrap to as many as fit. The half pixel keeps three from rounding down to two.
 */
const CARDS = 'grid-cols-[repeat(auto-fill,minmax(max(102px,calc((100%_-_var(--spacing-8))_/_3_-_0.5px)),1fr))]'

type BookAddOnsProps = {
  addOns: readonly BookAddOn[]
  /** How many of each add-on are chosen, by its id: none where none is noted. */
  quantities: Readonly<Record<string, number>>
  onQuantity: (addOn: string, quantity: number) => void
  summary: BookingSummaryView
  onChange: () => void
  onAddToBag: () => void
  onBookNow: () => void
  summaryHeading?: Ref<HTMLHeadingElement>
}

/**
 * The Book panel's add-ons step (Figma "BookingPanel", Step=add-ons: 1174:13322, on a phone 1176:18453; drawn for a
 * member only, so the non-member's is this layout with BookingSummary's non-member scenarios). From 768px it is two
 * columns of the panel's own 24: "Add ons" over the add-on cards, three to a row, 4px apart with 40px between rows
 * (12 columns, from the 2nd), which scroll by themselves; and "Your booking" (7 columns, from the 16th), which
 * stays. On a phone they are one column, 32px apart, the cards still three to a row, and the panel scrolls.
 *
 * W78b (WQ78): between those two widths "Your booking" keeps at least its phone's width and the add-ons take what is
 * left (components/book/columns.ts); and where three cards would each be narrower than a card's own stepper (a 320px
 * phone), they are two to a row.
 *
 * With no add-on on sale the step is "Your booking" alone, in its own place.
 */
export function BookAddOns({ addOns, quantities, onQuantity, summary, onChange, onAddToBag, onBookNow, summaryHeading }: BookAddOnsProps) {
  return (
    <>
      <div aria-hidden="true" className={FREE_ONE} />
      {addOns.length > 0 ? (
        // From 768px it reaches 8px past its columns each side, so a focus ring at its edge is whole (TWELVE_COLUMNS).
        <section data-book="add-ons" data-lenis-prevent="" aria-labelledby="book-add-ons" className={`col-span-6 flex flex-col gap-12 ${TWELVE_COLUMNS}`}>
          {/* From 768px the heading is as tall as the Close button it sits level with: 8px above and below its capitals. */}
          <h2 id="book-add-ons" className="shrink-0 text-label-12 text-text-primary md:py-8">
            Add ons
          </h2>
          <ul className={`grid shrink-0 gap-x-4 gap-y-40 md:pb-32 ${CARDS}`}>
            {addOns.map((addOn) => (
              <AddOnCard key={addOn.id} addOn={addOn} quantity={quantities[addOn.id] ?? 0} onQuantity={(quantity) => onQuantity(addOn.id, quantity)} />
            ))}
          </ul>
        </section>
      ) : (
        // With no add-on on sale their columns stay empty, so "Your booking" is where it always is.
        <div aria-hidden="true" className={`hidden md:block ${TWELVE_COLUMNS}`} />
      )}
      <div aria-hidden="true" className={FREE_TWO} />
      <BookingSummary
        summary={summary}
        onChange={onChange}
        onAddToBag={onAddToBag}
        onBookNow={onBookNow}
        {...(summaryHeading ? { headingRef: summaryHeading } : {})}
        className={`col-span-6 ${SEVEN_COLUMNS}`}
      />
    </>
  )
}
