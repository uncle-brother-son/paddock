'use client'

import { useEffect, useRef } from 'react'

import { SecondaryButton } from '@/components/ui/buttons/Button'
import { QuantityStepper } from '@/components/ui/form-controls/QuantityStepper'
import { MOST_OF_AN_ADD_ON, rowPrice, type BookAddOn } from '@/lib/book/book'

/** A card is a third of the add-ons column: 12 of the panel's 24 columns from 768px, the panel's whole width on a phone. */
export const ADD_ON_CARD_SIZES = '(min-width: 768px) 16vw, 30vw'

type AddOnCardProps = {
  addOn: BookAddOn
  /** How many are chosen: none shows "Add", any shows the stepper. */
  quantity: number
  onQuantity: (quantity: number) => void
}

/**
 * Figma "AddOnCard" (03 UI, 845:16651): the add-on's picture, 4 by 5 with 4px corners, 8px beneath it the name and
 * the price, each in Copy 12, and 12px beneath those "Add" (Added=no: the small secondary button, the card's whole
 * width) or, once added, the quantity stepper in its place (Added=yes).
 *
 * The picture is the add-on's Sanity document's first image; with none its place stays empty, as a product card's
 * does. The price is what a visitor pays for one (W77a). The stepper goes down to none, which takes the add-on off
 * again and brings "Add" back: so at 1 its minus is live, where Figma draws it dimmed and draws no way to remove one.
 * Focus follows the swap, so the keyboard is never left on a button that has gone.
 *
 * The card's sale price (its `showSalePrice`) and any member's price wait: W77a gives a visitor's one price.
 */
export function AddOnCard({ addOn, quantity, onQuantity }: AddOnCardProps) {
  const card = useRef<HTMLLIElement>(null)
  // Whether the control was swapped by a press inside this card: then focus goes to what took its place.
  const swapped = useRef(false)
  const added = quantity > 0

  useEffect(() => {
    if (!swapped.current) return
    swapped.current = false
    card.current?.querySelector<HTMLElement>(added ? 'button[aria-label="One more"]' : '[data-add]')?.focus()
  }, [added])

  const change = (to: number) => {
    if (to > 0 !== added) swapped.current = true
    onQuantity(to)
  }
  const { picture } = addOn

  return (
    <li ref={card} data-book="add-on" className="flex min-w-0 flex-col gap-12">
      <div className="flex flex-col gap-8">
        <div className="relative aspect-4/5 w-full overflow-clip rounded-s">
          {picture ? (
            // eslint-disable-next-line @next/next/no-img-element -- Next's image optimiser does not run on Workers: the address is Sanity's CDN, sized in lib/sanity/image.ts.
            <img
              src={picture.src}
              srcSet={picture.srcSet}
              sizes={ADD_ON_CARD_SIZES}
              width={picture.width}
              height={picture.height}
              alt={picture.alt}
              loading="lazy"
              decoding="async"
              className="absolute inset-0 size-full object-cover"
            />
          ) : null}
        </div>
        <div className="flex flex-col gap-8 pr-8">
          <p className="text-copy-12 text-text-primary">{addOn.name}</p>
          <p className="text-copy-12 text-text-primary">{rowPrice(addOn.price)}</p>
        </div>
      </div>
      {added ? (
        <QuantityStepper value={quantity} min={0} max={MOST_OF_AN_ADD_ON} onChange={change} label={`${addOn.name}: how many`} className="w-full" />
      ) : (
        <SecondaryButton data-add="" aria-label={`Add ${addOn.name}`} onClick={() => change(1)} className="w-full">
          Add
        </SecondaryButton>
      )}
    </li>
  )
}
