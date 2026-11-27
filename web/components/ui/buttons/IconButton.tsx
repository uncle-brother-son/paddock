import type { ComponentPropsWithRef } from 'react'

import { Icon, type IconName } from '@/components/brand/Icon'

// Figma "IconButton" (03 UI, 608:2593): a button that is an icon alone, with 4px corners. Two styles, as Figma names
// them. Style=page, on a page's own surface: 8px round a 9px icon (25px square), nothing behind it at rest,
// Surface/Card Selected under a mouse (State=hover); disabled, its icon is Text/Muted Primary and a mouse changes
// nothing (State=disabled). Style=image, over a picture or a film: 8px round a 12px icon (28px square), Text/Secondary
// on Text/Muted Primary, and on Text/Primary under a mouse.

/** Style=page without its padding or its hover: what a button and a link drawn as one share. */
export const ICON_BUTTON_PAGE = 'flex items-center justify-center rounded-s text-text-primary transition-colors duration-short ease-smooth'

/** State=hover of Style=page, for a link drawn as an IconButton (a button's own is below: never while disabled). */
export const ICON_BUTTON_PAGE_HOVER = 'hover:bg-surface-card-selected'

/**
 * Style=page for a button without its padding: its hover, and its disabled state (PriceStepper's up and down halves).
 * State=disabled is drawn for `disabled` and for `aria-disabled="true"` alike: a stepper at its limit uses the second,
 * so the button keeps keyboard focus, ignores the press and is still said to be unavailable (W83 noticed 2).
 */
export const ICON_BUTTON_PAGE_BUTTON = `${ICON_BUTTON_PAGE} enabled:not-aria-disabled:hover:bg-surface-card-selected disabled:cursor-default disabled:text-text-muted-primary aria-disabled:cursor-default aria-disabled:text-text-muted-primary`

const PAGE = ICON_BUTTON_PAGE_BUTTON

const IMAGE = 'flex items-center justify-center rounded-s bg-text-muted-primary p-8 text-text-secondary transition-colors duration-short ease-smooth hover:bg-text-primary'

type IconButtonProps = Omit<ComponentPropsWithRef<'button'>, 'children' | 'aria-label'> & {
  icon: IconName
  /** Its name: an icon alone says nothing to a screen reader. */
  label: string
  /** Figma's Style: `page` on a page's own surface, `image` over a picture or a film. */
  look?: 'page' | 'image'
  /** Style=page only: 12px round the icon in place of 8 (33px square), as a big QuantityStepper's are. */
  big?: boolean
  /** For the icon itself: a chevron turned to point the way it leads. */
  iconClassName?: string
}

export function IconButton({ icon, label, look = 'page', big = false, iconClassName, className, type = 'button', ...rest }: IconButtonProps) {
  if (look === 'image') {
    return (
      <button type={type} aria-label={label} data-icon-button="image" className={`${IMAGE} ${className ?? ''}`} {...rest}>
        {/* The icons are drawn 9px tall; over a picture Figma shows them at 12. */}
        <span className="flex size-12 items-center justify-center">
          <Icon name={icon} className={`h-12 w-auto ${iconClassName ?? ''}`} />
        </span>
      </button>
    )
  }
  return (
    <button type={type} aria-label={label} data-icon-button="page" className={`${PAGE} ${big ? 'p-12' : 'p-8'} ${className ?? ''}`} {...rest}>
      <Icon name={icon} {...(iconClassName ? { className: iconClassName } : {})} />
    </button>
  )
}
