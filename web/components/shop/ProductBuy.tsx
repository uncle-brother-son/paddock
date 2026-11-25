'use client'

import { useEffect, useId, useState } from 'react'

import { BigButton } from '@/components/ui/Button'
import { isPlainClick, SiteLink } from '@/components/ui/SiteLink'
import type { ShopAvailabilityRouteOutput } from '@/contracts/shop'
import { keepFocusOnArrival } from '@/lib/motion/page-transition'
import { readAvailability } from '@/lib/shop/availability'
import { addToBag } from '@/lib/shop/bag'
import { productSizes, SIZE_GUIDE_TAB, type PriceLine, type ProductView } from '@/lib/shop/product'

import { InfoPanelLink } from './InfoPanelLink'
import { ProductInfoPanel, type InfoTab } from './ProductInfoPanel'
import { SizeOption } from './SizeSelect'

/** The swatches are a sixth of the details' width each, as drawn. */
const SWATCH_SIZES = '(min-width: 768px) 5vw, 15vw'

/** The swatch of the colour a product's page is showing: the one a visitor chose, once its page is there. */
const CHOSEN_SWATCH = '[data-shop="swatch"][aria-current="page"]'

/** PIC's price line: the price before a sale struck through, the price ("From" while the sizes differ), and the member's. */
function Price({ price }: { price: PriceLine }) {
  if (price.now === null) return null
  return (
    <p className="flex flex-wrap items-baseline gap-8">
      {price.before !== null ? (
        <s className="text-copy-14 text-text-muted-primary">
          <span className="sr-only">Was </span>
          {price.before}
        </s>
      ) : null}
      <span className="text-copy-14 text-text-primary">{price.from ? `From ${price.now}` : price.now}</span>
      {price.member !== null ? <span className="text-copy-14 text-text-muted-primary">(Member from {price.member})</span> : null}
    </p>
  )
}

type ProductBuyProps = {
  product: Pick<ProductView, 'id' | 'name' | 'colourName' | 'price' | 'sizes' | 'soldOut' | 'colours' | 'fulfilment'>
  /** The Product Info Panel's tabs, in order; the Size Guide's (SIZE_GUIDE_TAB) only when the product has a guide. */
  tabs: InfoTab[]
  /**
   * The product's sizes now, asked once the page has loaded (lib/shop/availability.ts). Storybook and tests give
   * their own, or null to ask nothing.
   */
  readSizes?: ((product: string) => Promise<ShopAvailabilityRouteOutput | null>) | null
  /** Where the details sit on the page: their columns of the grid, and that they stick. */
  className?: string
}

/**
 * The details beside a product's gallery (Figma "PIC", Type=product: desktop 1389:40292, mobile 1389:40301, holding
 * "CTA", Type=product, 1684:39401): the name in H2, the price line, the colours of its family, its sizes, the button
 * and the line under it, and the links that open the Product Info Panel.
 *
 * CTA's states, as drawn: non-member ("Add to bag"); select size ("Please select a size" in Text/Error under the
 * sizes, when the button is pressed with none picked); sold out (every size struck through, the button disabled and
 * reading "Sold out"). The member's state waits for accounts. A press with a size picked goes to the one
 * `addToBag()` seam (lib/shop/bag.ts), which does nothing until the bag is built. While a size is still to pick, a
 * mouse over the button slides its label up and "Select size" in from beneath (WQ51); the button's name stays.
 *
 * The sizes it is sent with may be up to a minute old, so once it has loaded it asks the availability route and
 * shows what that says: a size that sold out in between is struck through, and no longer the one picked.
 */
export function ProductBuy({ product, tabs, readSizes = readAvailability, className }: ProductBuyProps) {
  const id = useId()
  const [live, setLive] = useState({ sizes: product.sizes, soldOut: product.soldOut })
  const [chosen, setChosen] = useState<string | null>(null)
  const [asked, setAsked] = useState(false)
  const [panel, setPanel] = useState<{ open: boolean; tab: string }>({ open: false, tab: tabs[0]?.id ?? '' })

  useEffect(() => {
    if (!readSizes) return
    const stop = new AbortController()
    readSizes(product.id).then((now) => {
      if (now && !stop.signal.aborted) setLive({ sizes: productSizes(now.sizes), soldOut: now.soldOut })
    })
    return () => stop.abort()
  }, [product.id, readSizes])

  const { sizes, soldOut } = live
  // A product that comes in one size only has no size to pick: that one is the size.
  const named = sizes.flatMap((size) => (size.size === null ? [] : [{ ...size, size: size.size }]))
  const picked = named.find((size) => size.size === chosen && size.available) ?? null
  const needsSize = named.length > 0 && picked === null
  const wrong = asked && needsSize && !soldOut
  const links = tabs.filter((tab) => tab.id !== SIZE_GUIDE_TAB)
  const hasSizeGuide = tabs.some((tab) => tab.id === SIZE_GUIDE_TAB)

  const add = () => {
    if (soldOut) return
    if (needsSize) return setAsked(true)
    addToBag({ product: product.id, size: picked?.size ?? null })
  }

  return (
    <>
    <div data-shop="details" className={`flex flex-col gap-64 pt-24 pb-120 md:pt-240 md:pb-80 ${className ?? ''}`}>
      <div className="flex flex-col gap-32">
        <div className="flex flex-col gap-24">
          <h1 className="text-h2 text-text-primary">{product.name}</h1>
          <div aria-live="polite">
            <Price price={picked?.price ?? product.price} />
          </div>
        </div>

        {product.colourName || product.colours.length > 0 ? (
          <div className="flex flex-col gap-12">
            {product.colourName ? (
              <p className="flex items-start gap-8">
                <span className="text-copy-12 text-text-primary">Colour:</span>
                <span className="text-copy-12 text-text-muted-primary">{product.colourName}</span>
              </p>
            ) : null}
            {product.colours.length > 0 ? (
              <ul aria-label="Colours" className="grid grid-cols-6 gap-4">
                {product.colours.map((colour) => (
                  <li key={colour.id}>
                    {/* WQ52: another colour is another product's page, swapped in where this one stands: no page
                        transition, the new page from its top at once, and focus on the swatch that was chosen. */}
                    <SiteLink
                      href={colour.href}
                      transition={false}
                      onClick={(event) => {
                        if (isPlainClick(event)) keepFocusOnArrival(colour.href, CHOSEN_SWATCH)
                      }}
                      data-shop="swatch"
                      aria-label={colour.name}
                      {...(colour.current ? { 'aria-current': 'page' as const } : {})}
                      className={`relative block aspect-4/5 overflow-clip rounded-s border bg-object-product-bg ${colour.current ? 'border-text-primary' : 'border-text-secondary'}`}
                    >
                      {colour.picture ? (
                        // eslint-disable-next-line @next/next/no-img-element -- Next's image optimiser does not run on Workers: the address is Sanity's CDN, sized in lib/sanity/image.ts.
                        <img
                          src={colour.picture.src}
                          srcSet={colour.picture.srcSet}
                          sizes={SWATCH_SIZES}
                          width={colour.picture.width}
                          height={colour.picture.height}
                          alt=""
                          decoding="async"
                          className="absolute inset-0 size-full object-cover"
                        />
                      ) : null}
                    </SiteLink>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        {named.length > 0 ? (
          <div className="flex flex-col gap-12">
            <div className="flex items-start gap-8">
              <p id={`${id}-size`} className="min-w-0 flex-1 text-copy-12 text-text-primary">
                Size
              </p>
              {hasSizeGuide ? (
                <button
                  type="button"
                  aria-haspopup="dialog"
                  onClick={() => setPanel({ open: true, tab: SIZE_GUIDE_TAB })}
                  className="relative shrink-0 text-link-12 whitespace-nowrap text-text-muted-primary transition-colors duration-short ease-smooth after:absolute after:-inset-8 hover:text-text-primary focus-visible:text-text-primary"
                >
                  Size guide
                </button>
              ) : null}
            </div>
            <div role="radiogroup" aria-labelledby={`${id}-size`} aria-required="true" {...(wrong ? { 'aria-invalid': true } : {})} className="flex gap-4">
              {named.map((size) => (
                <SizeOption
                  key={size.size}
                  name={`${id}-sizes`}
                  size={size.size}
                  available={size.available}
                  selected={picked?.size === size.size}
                  onSelect={() => setChosen(size.size)}
                  {...(wrong ? { describedBy: `${id}-size-wrong` } : {})}
                />
              ))}
            </div>
            {wrong ? (
              <p id={`${id}-size-wrong`} role="alert" className="text-copy-12 text-text-error">
                Please select a size
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="flex flex-col gap-24">
          {/* WQ51: with a size still to pick, a mouse over the button slides "Select size" in over its label. */}
          <BigButton disabled={soldOut} onClick={add} {...(needsSize && !soldOut ? { hoverLabel: 'Select size' } : {})}>
            {soldOut ? 'Sold out' : 'Add to bag'}
          </BigButton>
          {product.fulfilment ? <p className="text-copy-12 text-text-primary">{product.fulfilment}</p> : null}
        </div>
      </div>

      {links.length > 0 ? (
        <ul className="flex flex-col items-start gap-16">
          {links.map((tab) => (
            <li key={tab.id}>
              <InfoPanelLink onClick={() => setPanel({ open: true, tab: tab.id })}>{tab.label}</InfoPanelLink>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
    {/* Beside the details, not inside them: they stick as the gallery scrolls past, and what sticks is a layer of its own, which would hold the panel beneath the header. */}
    {tabs.length > 0 ? (
      <ProductInfoPanel open={panel.open} tabs={tabs} tab={panel.tab} onTab={(tab) => setPanel({ open: true, tab })} onClose={() => setPanel((now) => ({ ...now, open: false }))} />
    ) : null}
    </>
  )
}
