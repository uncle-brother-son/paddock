import { Grid } from '@/components/layout/Grid'
import type { ShopCategoryOption } from '@/lib/shop/cards'
import { itemCount, shopAddress, SHOP_SORTS, type ShopListing as Listing } from '@/lib/shop/listing'

import { Pagination } from '@/components/ui/navigation/Pagination'
import { ProductCard } from '@/components/components/cards/ProductCard'
import { ShopSelect } from './ShopSelect'

/** The value of "All" in the category list. No category's slug can be empty. */
const ALL = ''

type ShopListingProps = {
  /** Shop settings' title: the page's h1. */
  title: string
  listing: Listing
  /** The categories with something on sale, in their Order (WQ7). */
  categories: ShopCategoryOption[]
}

/**
 * The Shop (Figma "Shop", 1684:41835, and "Shop (mobile)", 1684:41876): the title in H1, the count of items, ALL
 * and SORT, the cards four to a row from 768px and two below, and the pages. The category, the sort and the page
 * are the address's (lib/shop/listing.ts): choosing a category or a sort goes back to its first page.
 */
export function ShopListing({ title, listing, categories }: ShopListingProps) {
  const { cards, count, page, pages, category, sort } = listing
  const chosen = category?.slug ?? null
  return (
    <section data-shop="listing" className="flex flex-col gap-80 pt-160 pb-120 md:pt-240">
      <Grid>
        <h1 className="col-span-full px-8 text-h1 text-text-primary">{title}</h1>
      </Grid>
      <div className="flex flex-col gap-24">
        <Grid>
          {/* As tall as its label alone: the two controls reach 8px above and below it, as drawn. */}
          <div className="col-span-full flex items-center justify-between pl-8">
            <p className="text-label-12 whitespace-nowrap text-text-primary" aria-live="polite">
              {itemCount(count)}
            </p>
            <div className="-my-8 flex items-center gap-8">
              <ShopSelect
                name="Category"
                shown={category?.title ?? 'All'}
                value={chosen ?? ALL}
                options={[
                  { value: ALL, label: 'All', href: shopAddress({ sort }) },
                  ...categories.map((option) => ({ value: option.slug, label: option.title, href: shopAddress({ category: option.slug, sort }) })),
                ]}
              />
              <ShopSelect
                name="Sort by"
                shown="Sort"
                value={sort}
                options={SHOP_SORTS.map((option) => ({ value: option.value, label: option.label, href: shopAddress({ category: chosen, sort: option.value }) }))}
              />
            </div>
          </div>
        </Grid>
        {cards.length > 0 ? (
          <Grid as="ul" className="gap-y-64 md:gap-y-80">
            {cards.map((card, index) => (
              <li key={card.id} className="col-span-3 md:col-span-6">
                {/* The first row is on screen as the page opens. */}
                <ProductCard card={card} priority={index < 4} />
              </li>
            ))}
          </Grid>
        ) : null}
      </div>
      <Pagination page={page} pages={pages} hrefOf={(to) => shopAddress({ category: chosen, sort, page: to })} />
    </section>
  )
}
