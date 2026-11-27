'use client'

import { useId, useState } from 'react'

import { StickyColumn } from '@/components/layout/StickyColumn'
import { ProductInfoPanel, type InfoTab } from '@/components/modules/shop/ProductInfoPanel'
import { SIZE_GUIDE_TAB } from '@/lib/shop/product'

import { CallToAction, type EventCallToAction, type GiftCardCallToAction, type ProductCallToAction } from './CallToAction'
import { InfoPanelLink } from './InfoPanelLink'

type ProductInfoContainerProps = (ProductCallToAction | EventCallToAction | GiftCardCallToAction) & {
  /**
   * The info panel's tabs, in order. A product's: the Product Info Panel's, the Size Guide's (SIZE_GUIDE_TAB) only
   * when it has a guide; an event's: Description, Event Terms & Conditions; the gift card's: Description, Gift Card
   * Terms & Conditions, Shipping & returns.
   */
  tabs: InfoTab[]
  /** Where the details sit on the page: their columns of the grid. They stick there as a StickyColumn does (components/layout/StickyColumn.tsx). */
  className?: string
}

/** The info panel's name for a screen reader, by what the page sells. */
const PANEL_LABELS = { product: undefined, event: 'Event information', 'gift card': 'Gift card information' } as const

/**
 * Figma "ProductInfoContainer" (04 Components > Shop, 1389:40291): the details beside a page's gallery, for a
 * product (desktop 1389:40292, mobile 1389:40301), an event (1402:49329, 1402:49341) and the gift card (digital
 * 1389:40289 and 1389:40290, physical 1389:41012 and 1389:41024): its CallToAction, then the links that open the
 * info panel (InfoPanelLink), in a StickyColumn. A product's Size Guide opens from its SizeField instead.
 */
export function ProductInfoContainer(props: ProductInfoContainerProps) {
  return props.type === 'product' ? <ProductContainer {...props} /> : <Container {...props} id={null} />
}

/** A product's sizes are named from an id of the container's own. */
function ProductContainer(props: ProductInfoContainerProps & ProductCallToAction) {
  const id = useId()
  return <Container {...props} id={id} />
}

function Container({ id, tabs, className, ...forBox }: ProductInfoContainerProps & { id: string | null }) {
  const [panel, setPanel] = useState<{ open: boolean; tab: string }>({ open: false, tab: tabs[0]?.id ?? '' })
  const product = forBox.type === 'product'
  const links = product ? tabs.filter((tab) => tab.id !== SIZE_GUIDE_TAB) : tabs
  const sizeGuide = product && tabs.some((tab) => tab.id === SIZE_GUIDE_TAB) ? () => setPanel({ open: true, tab: SIZE_GUIDE_TAB }) : null
  const label = PANEL_LABELS[forBox.type]

  return (
    <>
      <StickyColumn
        place={className ?? ''}
        {...(forBox.type === 'event' ? { 'data-event': 'details' } : { 'data-shop': 'details' })}
        className="flex flex-col gap-64 pt-24 pb-120 md:pt-240 md:pb-80"
      >
        {forBox.type === 'product' ? <CallToAction {...forBox} id={id ?? ''} onSizeGuide={sizeGuide} /> : <CallToAction {...forBox} />}

        {links.length > 0 ? (
          <ul className="flex flex-col items-start gap-16">
            {links.map((tab) => (
              <li key={tab.id}>
                <InfoPanelLink onClick={() => setPanel({ open: true, tab: tab.id })}>{tab.label}</InfoPanelLink>
              </li>
            ))}
          </ul>
        ) : null}
      </StickyColumn>
      {/* Beside the details, not inside them: they stick as the gallery scrolls past, and what sticks is a layer of its own, which would hold the panel beneath the header. */}
      {tabs.length > 0 ? (
        <ProductInfoPanel
          open={panel.open}
          tabs={tabs}
          tab={panel.tab}
          onTab={(tab) => setPanel({ open: true, tab })}
          onClose={() => setPanel((now) => ({ ...now, open: false }))}
          {...(label ? { label } : {})}
        />
      ) : null}
    </>
  )
}
