import type { ReactNode } from 'react'

import { Icon } from '@/components/brand/Icon'
import { RichText } from '@/components/ui/RichText'
import { SidewaysScroll } from '@/components/ui/SidewaysScroll'
import type { SizeGuide } from '@/lib/sanity/schemas'
import { SIZE_GUIDE_TAB, type Materials, type ProductView } from '@/lib/shop/product'

import type { InfoTab } from './ProductInfoPanel'

/** One heading of Materials & Care with what stands under it, 12px apart: the heading in Label 12, as drawn ("Composition:"). */
function Fact({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-12">
      <dt className="text-label-12 text-text-primary">{heading}</dt>
      <dd className="flex flex-col gap-12">{children}</dd>
    </div>
  )
}

/**
 * Materials & Care (Figma ProductInfoPanel, Tab=material & care: desktop 1802:39277, mobile 1802:39253; W78b, WQ75):
 * three headings in Label 12, each with its own words 12px beneath in Copy 14, 24px between one and the next:
 * "Composition:", "Made in:" and "Care Instructions:", whose lines are bullets as the rich text draws them (the
 * bullet icon, 4px, the line), 12px apart. Each only when an editor filled it; a care line is a line the editor typed.
 */
function MaterialsAndCare({ materials }: { materials: Materials }) {
  const care = materials.care?.split(/\n+/).filter((line) => line.trim()) ?? []
  return (
    <dl className="flex flex-col gap-24">
      {materials.composition ? (
        <Fact heading="Composition:">
          <p className="text-copy-14 whitespace-pre-line text-text-primary">{materials.composition}</p>
        </Fact>
      ) : null}
      {materials.madeIn ? (
        <Fact heading="Made in:">
          <p className="text-copy-14 text-text-primary">{materials.madeIn}</p>
        </Fact>
      ) : null}
      {care.length > 0 ? (
        <Fact heading="Care Instructions:">
          <ul className="flex flex-col gap-12">
            {care.map((line, index) => (
              <li key={index} className="flex items-start gap-4 text-text-primary">
                <Icon name="bullet" />
                <p className="text-copy-14">{line.trim()}</p>
              </li>
            ))}
          </ul>
        </Fact>
      ) : null}
    </dl>
  )
}

/**
 * The Size Guide (WQ39; Figma ProductInfoPanel, Tab=size guide: desktop 1802:39413, mobile 1802:39389; W78b, WQ75):
 * the guide's table, and 32px beneath it its notes in Copy 14. The table is ruled in Text/Muted Primary, 1px: a line
 * all round it, one under every row but the last and one after every column but the last. Its columns are equal in
 * width; each cell has 12px all round its words, which are centred: the headings in Label 12, the rest in Copy 14.
 * A guide with more columns than a phone has room for keeps each cell's words on one line and scrolls sideways by
 * itself (Figma draws three columns, which fit).
 */
function SizeGuideTable({ guide }: { guide: SizeGuide }) {
  // Equal columns, as drawn: each asks for its share of the table's width, and takes more only when its words need it.
  const share = { width: `${100 / Math.max(guide.columns.length, 1)}%` }
  const cell = 'border-r border-b border-text-muted-primary p-12 text-center whitespace-nowrap text-text-primary last:border-r-0'
  return (
    <div className="flex flex-col gap-32">
      <SidewaysScroll label={`Size guide: ${guide.title}`}>
        <table data-shop="size-guide" className="w-full border-separate border-spacing-0 border border-text-muted-primary">
          <caption className="sr-only">{guide.title}</caption>
          <thead>
            <tr>
              {guide.columns.map((column, index) => (
                <th key={index} scope="col" style={share} className={cell}>
                  {/* The text style is on an element of its own: a table's cell is not trimmed to its capitals. */}
                  <span className="block text-label-12">{column}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="[&>tr:last-child>td]:border-b-0">
            {guide.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {guide.columns.map((_, index) => (
                  <td key={index} className={cell}>
                    <span className="block text-copy-14">{row[index] ?? ''}</span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </SidewaysScroll>
      {guide.notes.length > 0 ? <RichText blocks={guide.notes} spacing="panel" /> : null}
    </div>
  )
}

/**
 * The Product Info Panel's tabs for a product, in order: Description, Materials & Care, Shipping & Returns (Shop
 * settings' summary, the same on every product) and, only for a product with a size guide, Size Guide (WQ39). A tab
 * with nothing to say is left out, and its link with it. Drawn on the server, so every tab's words are in the page.
 *
 * W78b (WQ75): each tab is one of Figma's variants of ProductInfoPanel (1402:53321), the same on a desktop and a
 * phone but for its width. Description (1402:53320, 1402:53319) and Shipping & returns (1802:39345, 1802:39321) are
 * rich text as the panel draws it (32px between a paragraph and a list, bullets 12px apart, a link in Link 14);
 * Materials & care and Size Guide have layouts of their own, above. The labels are Figma's own words.
 */
export function productInfoTabs(view: Pick<ProductView, 'description' | 'materials' | 'shipping' | 'sizeGuide'>): InfoTab[] {
  const tabs: InfoTab[] = []
  if (view.description.length > 0) tabs.push({ id: 'description', label: 'Description', content: <RichText blocks={view.description} spacing="panel" /> })
  if (view.materials) tabs.push({ id: 'materials', label: 'Materials & care', content: <MaterialsAndCare materials={view.materials} /> })
  if (view.shipping.length > 0) tabs.push({ id: 'shipping', label: 'Shipping & returns', content: <RichText blocks={view.shipping} spacing="panel" /> })
  if (view.sizeGuide) tabs.push({ id: SIZE_GUIDE_TAB, label: 'Size Guide', content: <SizeGuideTable guide={view.sizeGuide} /> })
  return tabs
}
