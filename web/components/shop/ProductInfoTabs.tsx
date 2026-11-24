import { RichText } from '@/components/ui/RichText'
import type { SizeGuide } from '@/lib/sanity/schemas'
import { SIZE_GUIDE_TAB, type Materials, type ProductView } from '@/lib/shop/product'

import type { InfoTab } from './ProductInfoPanel'

/** Materials & Care: what the product is made of, where, and how to look after it; each only when an editor filled it. */
function MaterialsAndCare({ materials }: { materials: Materials }) {
  const care = materials.care?.split(/\n+/).filter((line) => line.trim()) ?? []
  return (
    <div className="flex flex-col gap-32">
      {materials.composition ? <p className="text-copy-14 whitespace-pre-line">{materials.composition}</p> : null}
      {materials.madeIn ? <p className="text-copy-14">Made in {materials.madeIn}</p> : null}
      {care.length > 0 ? (
        <div className="flex flex-col gap-12">
          {care.map((line, index) => (
            <p key={index} className="text-copy-14">
              {line}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/**
 * The Size Guide (WQ39): the guide's table and its notes. Figma draws no size guide yet, so this is the plainest
 * table the text styles make: its headings in Label 12, its cells in Copy 14, 12px between rows. It scrolls sideways
 * by itself when a phone is too narrow for its columns.
 */
function SizeGuideTable({ guide }: { guide: SizeGuide }) {
  return (
    <div className="flex flex-col gap-32">
      <div className="overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <table className="w-full border-collapse text-left">
          <caption className="sr-only">{guide.title}</caption>
          <thead>
            <tr>
              {guide.columns.map((column, index) => (
                <th key={index} scope="col" className="pr-16 pb-6 text-label-12 whitespace-nowrap text-text-primary last:pr-0">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {guide.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {guide.columns.map((_, index) => (
                  <td key={index} className="py-6 pr-16 text-copy-14 whitespace-nowrap text-text-primary last:pr-0">
                    {row[index] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {guide.notes.length > 0 ? <RichText blocks={guide.notes} spacing="panel" /> : null}
    </div>
  )
}

/**
 * The Product Info Panel's tabs for a product, in order: Description, Materials & Care, Shipping & Returns (Shop
 * settings' summary, the same on every product) and, only for a product with a size guide, Size Guide (WQ39). A tab
 * with nothing to say is left out, and its link with it. Drawn on the server, so every tab's words are in the page.
 */
export function productInfoTabs(view: Pick<ProductView, 'description' | 'materials' | 'shipping' | 'sizeGuide'>): InfoTab[] {
  const tabs: InfoTab[] = []
  if (view.description.length > 0) tabs.push({ id: 'description', label: 'Description', content: <RichText blocks={view.description} spacing="panel" /> })
  if (view.materials) tabs.push({ id: 'materials', label: 'Materials & care', content: <MaterialsAndCare materials={view.materials} /> })
  if (view.shipping.length > 0) tabs.push({ id: 'shipping', label: 'Shipping & returns', content: <RichText blocks={view.shipping} spacing="panel" /> })
  if (view.sizeGuide) tabs.push({ id: SIZE_GUIDE_TAB, label: 'Size guide', content: <SizeGuideTable guide={view.sizeGuide} /> })
  return tabs
}
