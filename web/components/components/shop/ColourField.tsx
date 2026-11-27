import { SiteLink } from '@/components/ui/SiteLink'
import type { ProductView } from '@/lib/shop/product'

/** The swatches are a sixth of the details' width each, as drawn. */
const SWATCH_SIZES = '(min-width: 768px) 5vw, 15vw'

/**
 * Figma "ColourField" (04 Components > Shop, 1389:39463), in a product's CallToAction: "Colour:" with the colour's
 * name, then a swatch for each colour of its family, six to a row and 4px apart, the product's own outlined in
 * Text/Primary (State=colour 1, colour 2: which is the page's own).
 */
export function ColourField({ colourName, colours }: Pick<ProductView, 'colourName' | 'colours'>) {
  return (
    <div className="flex flex-col gap-12">
      {colourName ? (
        <p className="flex items-start gap-8">
          <span className="text-copy-12 text-text-primary">Colour:</span>
          <span className="text-copy-12 text-text-muted-primary">{colourName}</span>
        </p>
      ) : null}
      {colours.length > 0 ? (
        <ul aria-label="Colours" className="grid grid-cols-6 gap-4">
          {colours.map((colour) => (
            <li key={colour.id}>
              {/* WQ52 (as amended again): another colour is another product's page, swapped in where this one
                  stands with no page transition; the window then scrolls smoothly to the page's top, and focus
                  goes to the product's name once it is there (components/frame/PageTransition.tsx). */}
              <SiteLink
                href={colour.href}
                transition={false}
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
  )
}
