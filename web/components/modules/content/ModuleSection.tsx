import type { ComponentPropsWithoutRef, ReactNode } from 'react'

import { themeOf, type SectionSettings } from '@/lib/modules/section'

type ModuleSectionProps = Omit<ComponentPropsWithoutRef<'section'>, 'id'> &
  Partial<SectionSettings> & {
    /** The module's name on the page: `data-module="text-block"`. */
    module: string
    /** `div` for a module that is no section of the page's outline (SectionSpacer). */
    as?: 'section' | 'div'
    children?: ReactNode
  }

/**
 * The section every content module stands in (W80; WQ81, WQ83, WQ87).
 *
 * - Section ID: when an editor gave the module one, it is the section's `id`, which a link to "A section on this
 *   page" scrolls to (components/ui/SiteLink.tsx).
 * - Theme: a module in Dark, Fjord or Mud carries W73's `data-theme` and paints that mode's Surface/Primary, so
 *   modules of one theme, one after the other, sit on one colour. A module with no theme (or Light) carries
 *   nothing: it is in the page's own mode.
 * - `data-page-themed` (WQ87): the section takes part in the page's fade. Once components/modules/PageTheme.tsx is
 *   watching, the whole page (its background, its words, the header) fades to the theme of the section at the middle
 *   of the window, and a section so marked follows the page's mode in place of its own (app/globals.css), so there
 *   is one colour on screen at a time.
 */
export function ModuleSection({ module, theme, sectionId, as: Element = 'section', className, children, ...rest }: ModuleSectionProps) {
  const mode = themeOf(theme)
  return (
    <Element
      {...(sectionId ? { id: sectionId } : {})}
      data-module={module}
      {...(mode ? { 'data-theme': mode, 'data-page-themed': '' } : {})}
      className={`${mode ? 'bg-surface-primary ' : ''}${className ?? ''}`}
      {...rest}
    >
      {children}
    </Element>
  )
}
