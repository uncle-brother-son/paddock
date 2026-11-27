'use client'

import { useId, useState } from 'react'

import { MembershipPlanCard } from '@/components/components/memberships/MembershipPlanCard'
import { Grid } from '@/components/layout/Grid'
import { Toggle } from '@/components/ui/form-controls/Toggle'
import { RichText } from '@/components/ui/RichText'
import { BILLING_NAMES, billingsOf, cardsFor, chosenLevel, hasWords, HERD_BENEFITS_TITLE, saveUpToLine, type Billing, type MembershipsContent, type OfferLevel } from '@/lib/memberships/cards'
import { addToBag, type BagLine } from '@/lib/shop/bag'

import { ModuleSection } from './ModuleSection'
import { PlanCardRow } from './PlanCardRow'

/** Figma's empty Column each side of the cards from 768px (1842:46323): three cards share the 22 between. */
const INSET_COLUMNS = 1

/** Figma draws three cards: with fewer on sale each keeps a third of the row. */
const CARDS_DRAWN = 3

type MembershipsProps = MembershipsContent & {
  /** Where "Add to bag" goes: the site's one seam. A story passes its own to see what was added. */
  onAdd?: (line: BagLine) => unknown
}

/**
 * Memberships (W81; Figma "Memberships", 05 Modules > Content, 1842:46324; WQ84-WQ86): 120px above and below (80px
 * below 768px), and 80px between its three parts, each centred:
 * - the Monthly / Yearly Toggle (03 UI; Monthly first, and chosen at first) with "Save up to N% yearly" 16px under
 *   it in Copy 14, Text/Muted Primary (WQ85: the largest saving, from the Worker's read; no line when no yearly price
 *   saves);
 * - the Membership cards (MembershipPlanCard) in Sanity's order, laid out by PlanCardRow. Each has its line, its
 *   name, an OfferSelector for Core and for All-Access with the price for the billing chosen (a yearly price with its
 *   before-price struck through), Add to bag, and the benefits listed for that billing (WQ86). Core is chosen at
 *   first on each card;
 * - the note an editor wrote, in Copy 14, Text/Muted Primary, centred: the middle 12 of the grid's 24 columns from
 *   768px, the grid's whole width below.
 *
 * A level that can't be bought under the billing chosen isn't offered under it, and a card with none isn't shown
 * under it (the cards that are keep their width, and the row is centred); with only one billing to buy by there is
 * no Toggle. With no card at all the module draws nothing.
 *
 * Add to bag goes to `addToBag()` with the plan chosen (its Sanity document id) and the billing: never a price.
 *
 * Figma draws no heading. One an editor gives is the section's h2 for screen readers only, and the cards' names are
 * then h3s under it (h2s without one).
 */
export function Memberships({ heading, saveUpTo, cards, note, theme, sectionId, onAdd = addToBag }: MembershipsProps) {
  const id = useId()
  const billings = billingsOf(cards)
  const [picked, setPicked] = useState<Billing>('monthly')
  const [levels, setLevels] = useState<Record<string, OfferLevel>>({})
  const billing = billings.includes(picked) ? picked : billings[0]
  if (billing === undefined) return null
  const shown = cardsFor(cards, billing)
  const [first, second] = billings
  return (
    <ModuleSection
      module="memberships"
      theme={theme}
      sectionId={sectionId}
      data-billing={billing}
      {...(heading ? { 'aria-labelledby': `${id}-heading` } : {})}
      className="@container flex flex-col items-center gap-80 py-80 md:py-120"
    >
      {heading ? (
        <h2 id={`${id}-heading`} className="sr-only">
          {heading}
        </h2>
      ) : null}
      {first && second ? (
        <div data-memberships="billing" className="flex flex-col items-center gap-16">
          <Toggle
            label="How a membership is paid for"
            name={`${id}-billing`}
            value={billing}
            options={[
              { value: first, label: BILLING_NAMES[first] },
              { value: second, label: BILLING_NAMES[second] },
            ]}
            onChange={setPicked}
          />
          {saveUpTo === null ? null : (
            <p data-memberships="saving" className="text-copy-14 text-text-muted-primary">
              {saveUpToLine(saveUpTo)}
            </p>
          )}
        </div>
      ) : null}
      <PlanCardRow
        insetColumns={INSET_COLUMNS}
        drawn={CARDS_DRAWN}
        cards={shown.map((card) => {
          const level = chosenLevel(card.offers, levels[card.id])
          const chosen = card.offers.find((offer) => offer.level === level)
          return {
            key: card.id,
            card: (
              <MembershipPlanCard
                type={card.line}
                name={card.name}
                headingLevel={heading ? 3 : 2}
                offers={card.offers.map((offer) => ({ value: offer.level, offer: offer.name, info: offer.description, price: offer.price, comparePrice: offer.before }))}
                chosen={level}
                onChoose={(value) => setLevels((now) => ({ ...now, [card.id]: value as OfferLevel }))}
                onAdd={() => {
                  if (chosen) onAdd({ membershipPlan: chosen.plan, billing })
                }}
                features={card.benefits}
                herdFeatures={card.herdBenefits}
                herdTitle={HERD_BENEFITS_TITLE}
              />
            ),
          }
        })}
      />
      {hasWords(note) ? (
        <Grid className="w-full">
          <RichText blocks={note} className="col-span-full text-center text-text-muted-primary md:col-span-12 md:col-start-7" />
        </Grid>
      ) : null}
    </ModuleSection>
  )
}
