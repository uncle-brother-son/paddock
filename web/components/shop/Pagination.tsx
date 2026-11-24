import { Icon } from '@/components/brand/Icon'
import { SiteLink } from '@/components/ui/SiteLink'

type PaginationProps = {
  page: number
  pages: number
  /** The address of a page of the list. */
  hrefOf: (page: number) => string
}

/** Figma "IconButton": 8px round a 9px icon. Surface/Card Selected on hover, as the MenuButton beside it in the designs. */
const ARROW = 'flex items-center justify-center rounded-s p-8 text-text-primary'

/**
 * Figma "Pagination" (03 UI, 1402:47982): an arrow each side of "1 / 3" in Label 12, 32px apart. Each arrow is a
 * link to the page before or after, so every page of a list can be reached and crawled; where there is no such page
 * (before the first, after the last) the arrow is drawn as designed but is no link. With one page there is nothing
 * to page through, and it is not drawn.
 */
export function Pagination({ page, pages, hrefOf }: PaginationProps) {
  if (pages <= 1) return null
  const arrow = (to: number, name: string, turn: string) =>
    to >= 1 && to <= pages ? (
      <SiteLink href={hrefOf(to)} aria-label={name} className={`${ARROW} transition-colors duration-short ease-smooth hover:bg-surface-card-selected`}>
        <Icon name="chevron" className={turn} />
      </SiteLink>
    ) : (
      <span aria-hidden="true" className={ARROW}>
        <Icon name="chevron" className={turn} />
      </span>
    )
  return (
    <nav aria-label="Pages" className="flex items-center justify-center gap-32">
      {arrow(page - 1, 'Previous page', 'rotate-90')}
      <p className="text-label-12 whitespace-nowrap text-text-primary">
        <span className="sr-only">Page </span>
        {page} <span aria-hidden="true">/</span>
        <span className="sr-only">of</span> {pages}
      </p>
      {arrow(page + 1, 'Next page', '-rotate-90')}
    </nav>
  )
}
