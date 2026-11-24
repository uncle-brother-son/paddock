import { Grid } from '@/components/layout/Grid'
import type { ShopAvailabilityRouteOutput } from '@/contracts/shop'
import type { ShopCard } from '@/lib/shop/cards'
import type { ProductView } from '@/lib/shop/product'

import { ProductBuy } from './ProductBuy'
import { ProductGallery } from './ProductGallery'
import { productInfoTabs } from './ProductInfoTabs'
import { SimilarMerch } from './SimilarMerch'

type ProductPageViewProps = {
  view: ProductView
  similar: ShopCard[]
  /** For Storybook and tests only: where the sizes are asked again after load, or null to ask nothing. The site asks its own route. */
  readSizes?: ((product: string) => Promise<ShopAvailabilityRouteOutput | null>) | null
  /** For Storybook and tests: reduced motion on or off, whatever the visitor's own setting. */
  reducedMotion?: boolean
}

/**
 * A product's page (Figma "Product", 1684:41920, and "Product (mobile)", 1684:41990).
 * - From 768px: the gallery fills the window's left half, from its edge to the end of the grid's 12th column, its
 *   pictures stacked; the details are columns 15 to 21, and stay in view (they stick to the window's top) while the
 *   gallery scrolls past, as drawn.
 * - Below: the gallery is the window's whole width, a row to swipe, with the details beneath it.
 * Then Similar Merch. The Product Info Panel is the details' own (components/shop/ProductBuy.tsx).
 */
export function ProductPageView({ view, similar, readSizes, reducedMotion }: ProductPageViewProps) {
  // Only what the details draw goes to the browser with them: the tabs' words are drawn here, on the server.
  const { id, name, colourName, price, sizes, soldOut, colours, fulfilment } = view
  return (
    <>
      <Grid as="section" data-shop="product" className="items-start">
        <div className="col-span-full -mx-16 md:col-span-12 md:mr-0">
          <ProductGallery items={view.gallery} {...(reducedMotion === undefined ? {} : { reducedMotion })} />
        </div>
        <ProductBuy
          product={{ id, name, colourName, price, sizes, soldOut, colours, fulfilment }}
          tabs={productInfoTabs(view)}
          className="col-span-full md:sticky md:top-0 md:col-span-7 md:col-start-15"
          {...(readSizes === undefined ? {} : { readSizes })}
        />
      </Grid>
      <SimilarMerch cards={similar} />
    </>
  )
}
