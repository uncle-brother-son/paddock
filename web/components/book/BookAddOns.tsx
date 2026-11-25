import type { Ref } from 'react'

import type { BookAddOn, BookingSummaryView } from '@/lib/book/book'

import { AddOnCard } from './AddOnCard'
import { BookingSummary } from './BookingSummary'

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
 * With no add-on on sale the step is "Your booking" alone, in its own place.
 */
export function BookAddOns({ addOns, quantities, onQuantity, summary, onChange, onAddToBag, onBookNow, summaryHeading }: BookAddOnsProps) {
  return (
    <>
      {addOns.length > 0 ? (
        <section data-book="add-ons" data-lenis-prevent="" aria-labelledby="book-add-ons" // From 768px it reaches 8px past its columns each side, so a focus ring at its edge is whole.
          className="col-span-6 flex flex-col gap-12 md:col-span-12 md:col-start-2 md:-mx-8 md:min-h-0 md:overflow-y-auto md:px-8"
        >
          {/* From 768px the heading is as tall as the Close button it sits level with: 8px above and below its capitals. */}
          <h2 id="book-add-ons" className="shrink-0 text-label-12 text-text-primary md:py-8">
            Add ons
          </h2>
          <ul className="grid shrink-0 grid-cols-3 gap-x-4 gap-y-40 md:pb-32">
            {addOns.map((addOn) => (
              <AddOnCard key={addOn.id} addOn={addOn} quantity={quantities[addOn.id] ?? 0} onQuantity={(quantity) => onQuantity(addOn.id, quantity)} />
            ))}
          </ul>
        </section>
      ) : null}
      <BookingSummary
        summary={summary}
        onChange={onChange}
        onAddToBag={onAddToBag}
        onBookNow={onBookNow}
        {...(summaryHeading ? { headingRef: summaryHeading } : {})}
        className="col-span-6 md:col-span-7 md:col-start-16 md:self-start"
      />
    </>
  )
}
