'use client'

import type { CSSProperties, FocusEvent, ReactNode } from 'react'

type PlanCardRowProps = {
  /** Figma's empty Column frames each side of the row from 768px: 1 for the memberships, 4 for the passes. */
  insetColumns: number
  /** How many cards Figma draws in the row: 3 memberships, 2 passes. */
  drawn: number
  cards: Array<{ key: string; card: ReactNode }>
}

/**
 * When focus reaches something in a card without a pointer (the Tab key, a screen reader), the whole card is brought
 * into the strip, with the grid's margin beside it. A browser does this by itself only for something wholly off the
 * screen: the button of a card that is half in the window would take focus where it stands, partly out of sight.
 * A press with a mouse or a finger moves nothing (the note on <html> is components/frame/InputKind.tsx's, as the
 * focus ring's rule reads it).
 * WQ93 amended: the strip rests only with a card lined up at the grid's left margin (or at its end), so a card that
 * is not wholly in view is brought to that place: its start at the margin, or as near as the strip's end allows,
 * which still shows it whole. (Brought in by its right edge, the strip's snapping could carry it back out again.)
 */
function bringCardIntoView(event: FocusEvent<HTMLDivElement>) {
  if (document.documentElement.dataset.input === 'pointer') return
  const strip = event.currentTarget
  const row = strip.firstElementChild
  const card = event.target.closest('[data-plan-cards="card"]')
  if (!row?.firstElementChild || !card) return
  // The row's margin: how far its first card stands inside it.
  const margin = row.firstElementChild.getBoundingClientRect().left - row.getBoundingClientRect().left
  const [outer, inner] = [strip.getBoundingClientRect(), card.getBoundingClientRect()]
  if (inner.left - margin < outer.left || inner.right + margin > outer.right) strip.scrollBy({ left: inner.left - margin - outer.left })
}

/**
 * The row of cards of the Memberships and SessionPasses modules (W81; Figma's MembershipsSection in 1842:46324 and
 * 1842:48611), laid out by the `plan-strip`, `plan-row` and `plan-card` utilities in app/globals.css:
 * - below 768px Figma's Carousel: each card 5 of the grid's 6 columns, as tall as what it holds, the row starting at
 *   the grid's margin and going on past the window's edge, to be swiped sideways;
 * - from 768px the cards share the grid's columns between `insetColumns` empty ones each side, all as tall as the
 *   tallest. With fewer cards than Figma draws (one is off sale) each keeps the width Figma draws and the row is
 *   centred; with more they share the row. Where they would be narrower than Figma's narrowest card the row scrolls
 *   sideways as it does on a phone.
 * It is the browser's own sideways scrolling: a finger swipes it, Lenis leaves a sideways gesture over it alone
 * (`data-lenis-prevent-horizontal`, as the GalleryCarousel), and the keyboard brings each card into view by reaching
 * what it holds (`bringCardIntoView`). The module's section must be a size container (`@container`).
 * WQ93 amended (Wayne, 27 Nov): wherever it scrolls it settles as the GalleryCarousel does, on the nearest card lined
 * up at the grid's left margin: the browser's own scroll snapping, in the same utilities.
 */
export function PlanCardRow({ insetColumns, drawn, cards }: PlanCardRowProps) {
  const sharedBy = cards.length > drawn ? cards.length : drawn
  return (
    <div
      data-plan-cards="strip"
      data-lenis-prevent-horizontal=""
      onFocus={bringCardIntoView}
      className="plan-strip w-full"
      style={{ '--plan-cards': sharedBy, '--plan-inset-columns': insetColumns } as CSSProperties}
    >
      <ul data-plan-cards="row" className="plan-row items-start md:items-stretch">
        {cards.map(({ key, card }) => (
          <li key={key} data-plan-cards="card" className="plan-card flex flex-col">
            {card}
          </li>
        ))}
      </ul>
    </div>
  )
}
