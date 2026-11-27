import { useId, type ReactNode } from 'react'

import { Icon } from '@/components/brand/Icon'
import { BigButton } from '@/components/ui/buttons/Button'

import { OfferSelector } from './OfferSelector'

/** One offer of a card: its value in the card's radio group, and what its OfferSelector says. */
export type PlanCardOffer = { value: string; offer: string; info: string; price: string; comparePrice?: string | null }

/** One line of a card's ticked lists. */
export type PlanCardFeature = { key: string; text: string }

export type MembershipPlanCardProps = {
  /** Figma's Type: the line above the name ("4 Sessions a month", "Session Pass"). None: no line. */
  type: string | null
  /** Figma's Name ("Foal", "5 Session"). */
  name: string
  /** The name's place in the page's outline: an h3 under a module's heading, an h2 without one. */
  headingLevel?: 2 | 3
  /** The offers, top to bottom: one or two. */
  offers: PlanCardOffer[]
  /** The value of the offer that is chosen. */
  chosen: string
  onChoose: (value: string) => void
  /** Add to bag, with the offer that is chosen. */
  onAdd: () => void
  /** Figma's IncludedFeatures: the ticked list under the button. None: no list. */
  features?: PlanCardFeature[]
  /** Figma's HerdFeatures: the ticked list under its title. None: neither is drawn. */
  herdFeatures?: PlanCardFeature[]
  /** The words over the Herd list ("Herd benefits"). */
  herdTitle?: string
  /** Holds its OfferSelectors to one of Figma's two arrangements, for the stories of Figma's variants. */
  device?: 'desktop' | 'mobile'
  className?: string
}

/**
 * Figma "FeatureItem" (1864:8274): a tick (Icon, Type=tick) and, 8px after it, a line in Copy 14, both Text/Primary.
 * The tick is level with the capitals of the first line, so a benefit that wraps keeps its tick at its start.
 */
export function FeatureItem({ children }: { children: ReactNode }) {
  return (
    <li data-feature-item="" className="flex items-start gap-8 text-text-primary">
      <span className="flex h-[1cap] shrink-0 items-center text-copy-14">
        <Icon name="tick" />
      </span>
      <span className="min-w-0 flex-1 text-copy-14">{children}</span>
    </li>
  )
}

/**
 * Figma "MembershipPlanCard" (04 Components > Memberships, 1841:45273; a Membership's card and a Session Pass's):
 * Surface/Card Selected with 4px corners, 16px at its top and sides and 32px at its foot.
 * - CardHeader: the line in Label 12 and, 80px under it, the name in H1.
 * - 120px under that, CardBody: the OfferSelectors and the Add to bag button (Button, Type=primary, Big=Yes) 8px
 *   apart; 40px under them the ticked list (12px between two lines); 32px under that "Herd benefits" in Label 12 with
 *   its own ticked list 12px under it.
 * It is as tall as the row it stands in, with what it holds at its top.
 *
 * The OfferSelectors are one radio group, named by the card's name, so the arrow keys move between the offers and a
 * screen reader says which is chosen; with one offer it is a group of one, already chosen. The button is described
 * by the card's name, so three "Add to bag" buttons in a row are told apart.
 */
export function MembershipPlanCard({ type, name, headingLevel = 3, offers, chosen, onChoose, onAdd, features = [], herdFeatures = [], herdTitle = 'Herd benefits', device, className }: MembershipPlanCardProps) {
  const id = useId()
  const nameId = `${id}-name`
  const herdId = `${id}-herd`
  const Name = headingLevel === 2 ? 'h2' : 'h3'
  return (
    <article data-plan-card="" aria-labelledby={nameId} className={`flex flex-1 flex-col gap-120 rounded-s bg-surface-card-selected px-16 pt-16 pb-32 ${className ?? ''}`}>
      <header data-plan-card="header" className="flex flex-col gap-80">
        {type ? (
          <p data-plan-card="type" className="text-label-12 text-text-primary">
            {type}
          </p>
        ) : null}
        <Name id={nameId} data-plan-card="name" className="text-h1 text-text-primary">
          {name}
        </Name>
      </header>
      <div data-plan-card="body" className="flex flex-col gap-40">
        <div data-plan-card="purchase" className="flex flex-col gap-8">
          <div role="radiogroup" aria-labelledby={nameId} className="flex flex-col gap-8">
            {offers.map((offer) => (
              <OfferSelector
                key={offer.value}
                name={`${id}-offer`}
                value={offer.value}
                checked={offer.value === chosen}
                onChange={() => onChoose(offer.value)}
                offer={offer.offer}
                info={offer.info}
                price={offer.price}
                comparePrice={offer.comparePrice ?? null}
                {...(device ? { device } : {})}
              />
            ))}
          </div>
          <BigButton onClick={onAdd} aria-describedby={nameId}>
            Add to bag
          </BigButton>
        </div>
        {features.length > 0 || herdFeatures.length > 0 ? (
          <div data-plan-card="features" className="flex flex-col gap-32">
            {features.length > 0 ? (
              <ul data-plan-card="included" className="flex flex-col gap-12">
                {features.map((feature) => (
                  <FeatureItem key={feature.key}>{feature.text}</FeatureItem>
                ))}
              </ul>
            ) : null}
            {herdFeatures.length > 0 ? (
              <div data-plan-card="herd" className="flex flex-col gap-12">
                <p id={herdId} className="text-label-12 text-text-primary">
                  {herdTitle}
                </p>
                <ul aria-labelledby={herdId} className="flex flex-col gap-12">
                  {herdFeatures.map((feature) => (
                    <FeatureItem key={feature.key}>{feature.text}</FeatureItem>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  )
}
