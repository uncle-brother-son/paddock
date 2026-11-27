'use client'

import { useSearchParams } from 'next/navigation'
import { useState } from 'react'

import { ProductInfoContainer } from '@/components/components/shop/ProductInfoContainer'
import { Grid } from '@/components/layout/Grid'
import type { InfoTab } from '@/components/modules/shop/ProductInfoPanel'
import { FORMAT_PARAM, giftCardAddress, giftCardFormat, tabsForFormat, type GiftCardFormat, type GiftCardView } from '@/lib/shop/gift-card'

import { ProductGallery } from './ProductGallery'

/** Puts a format's address in the address bar where the page stands: no navigation, no new step for Back (Next keeps its router in step with it). */
const showInAddressBar = (address: string): void => window.history.replaceState(null, '', address)

type GiftCardDetailProps = {
  giftCard: Pick<GiftCardView, 'id' | 'name' | 'galleries' | 'amounts' | 'other'>
  /** The format the address asked for (?format=physical): what the page opens on. */
  format: GiftCardFormat
  tabs: InfoTab[]
  /** For Storybook and tests only: where a switch's address goes. The site puts it in the address bar. */
  showAddress?: (address: string) => void
  /** For Storybook and tests: reduced motion on or off, whatever the visitor's own setting. */
  reducedMotion?: boolean
}

/**
 * The gift card's gallery and details, and the Digital / Physical switch between them (W76, item 1). The choice
 * lives in the address (?format=physical), so either can be shared: the page opens on the one its address asks for,
 * and switching swaps the gallery (the Digital or the Physical card's own pictures, from its first) and the details
 * where they stand, with no page transition and no trip to the server, and writes the address of the choice. What
 * is chosen and typed in the details is kept.
 */
export function GiftCardDetail({ giftCard, format: asked, tabs, showAddress = showInAddressBar, reducedMotion }: GiftCardDetailProps) {
  const [format, setFormat] = useState(asked)
  // The address as it now is: a link to the page followed while it is open (the menu's Gift Cards, with the page on
  // Physical) changes it without the page being made afresh, and the page then shows what that address asks for.
  const inAddress = giftCardFormat(useSearchParams().get(FORMAT_PARAM))
  const [was, setWas] = useState(inAddress)
  if (was !== inAddress) {
    setWas(inAddress)
    setFormat(inAddress)
  }

  const choose = (next: GiftCardFormat) => {
    if (next === format) return
    setFormat(next)
    showAddress(giftCardAddress(next))
  }

  const { id, name, amounts, other } = giftCard
  return (
    <Grid as="section" data-shop="gift-card" data-format={format} className="items-start">
      <div className="col-span-full -mx-16 md:col-span-12 md:mr-0">
        {/* Keyed by the format: the other card's gallery starts at its first picture. */}
        <ProductGallery key={format} items={giftCard.galleries[format]} label="Gift card pictures" {...(reducedMotion === undefined ? {} : { reducedMotion })} />
      </div>
      <ProductInfoContainer type="gift card" giftCard={{ id, name, amounts, other }} format={format} onFormat={choose} tabs={tabsForFormat(tabs, format)} className="col-span-full md:col-span-7 md:col-start-15" />
    </Grid>
  )
}
