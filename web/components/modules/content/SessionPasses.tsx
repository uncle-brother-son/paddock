'use client'

import { useId, useState } from 'react'

import { MembershipPlanCard } from '@/components/components/memberships/MembershipPlanCard'
import { chosenLevel, type OfferLevel, type SessionPassesContent } from '@/lib/memberships/cards'
import { addToBag, type BagLine } from '@/lib/shop/bag'

import { ModuleSection } from './ModuleSection'
import { PlanCardRow } from './PlanCardRow'

/** Figma's four empty Columns each side of the cards from 768px (1842:48612): two cards share the 16 between. */
const INSET_COLUMNS = 4

/** Figma draws two cards: one alone keeps half of the row, in the middle. */
const CARDS_DRAWN = 2

type SessionPassesProps = SessionPassesContent & {
  /** Where "Add to bag" goes: the site's one seam. A story passes its own to see what was added. */
  onAdd?: (line: BagLine) => unknown
}

/**
 * SessionPasses (W81; Figma "SessionPasses", 05 Modules > Content, 1842:48611; WQ84): the Session Pass cards
 * (MembershipPlanCard) in Sanity's order, laid out by PlanCardRow, with 120px above and below (80px below 768px).
 * Each has its line, its name, an OfferSelector for Core and for All-Access with its price, Add to bag, and one
 * ticked line, "Valid for N months": how long the pass that is chosen lasts, from the Worker's read. Core is chosen
 * at first on each card. With no card the module draws nothing.
 *
 * Add to bag goes to `addToBag()` with the pass chosen (its Sanity document id): never a price.
 *
 * Figma draws no heading. One an editor gives is the section's h2 for screen readers only, and the cards' names are
 * then h3s under it (h2s without one).
 */
export function SessionPasses({ heading, cards, theme, sectionId, onAdd = addToBag }: SessionPassesProps) {
  const id = useId()
  const [levels, setLevels] = useState<Record<string, OfferLevel>>({})
  if (cards.length === 0) return null
  return (
    <ModuleSection module="session-passes" theme={theme} sectionId={sectionId} {...(heading ? { 'aria-labelledby': `${id}-heading` } : {})} className="@container flex flex-col items-center py-80 md:py-120">
      {heading ? (
        <h2 id={`${id}-heading`} className="sr-only">
          {heading}
        </h2>
      ) : null}
      <PlanCardRow
        insetColumns={INSET_COLUMNS}
        drawn={CARDS_DRAWN}
        cards={cards.map((card) => {
          const level = chosenLevel(card.offers, levels[card.id])
          const chosen = card.offers.find((offer) => offer.level === level)
          return {
            key: card.id,
            card: (
              <MembershipPlanCard
                type={card.line}
                name={card.name}
                headingLevel={heading ? 3 : 2}
                offers={card.offers.map((offer) => ({ value: offer.level, offer: offer.name, info: offer.description, price: offer.price }))}
                chosen={level}
                onChoose={(value) => setLevels((now) => ({ ...now, [card.id]: value as OfferLevel }))}
                onAdd={() => {
                  if (chosen) onAdd({ sessionPass: chosen.pass })
                }}
                features={chosen ? [{ key: 'valid', text: chosen.validFor }] : []}
              />
            ),
          }
        })}
      />
    </ModuleSection>
  )
}
