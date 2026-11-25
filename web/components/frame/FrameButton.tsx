import type { ComponentPropsWithRef, ComponentPropsWithoutRef, ReactNode } from 'react'

import { SiteLink } from '@/components/ui/SiteLink'

// Figma "MenuButton" (03 UI, 206:2915): 8px all round with 4px corners, its icons and its words (Label 12) 8px apart.
// State=default: Text/Primary, nothing behind it. State=hover: Surface/Card Selected behind it. State=not selected:
// everything in it in Text/Muted Primary (one of several that is not the one chosen).

/** State=default, and State=hover under a mouse. */
export const FRAME_BUTTON = 'flex items-center gap-8 rounded-s p-8 text-text-primary transition-colors duration-short ease-smooth hover:bg-surface-card-selected'

/** State=not selected (324:5630): the same, its icons and words muted. */
export const FRAME_BUTTON_NOT_SELECTED = 'flex items-center gap-8 rounded-s p-8 text-text-muted-primary transition-colors duration-short ease-smooth hover:bg-surface-card-selected'

type Selected = {
  /** False for Figma's State=not selected: one of several that is not the one chosen. Left out, it is State=default. */
  selected?: boolean
}

const look = (selected: boolean | undefined): string => (selected === false ? FRAME_BUTTON_NOT_SELECTED : FRAME_BUTTON)

/** One of the header's buttons. Its words go in a FrameButtonLabel: Label 12 is trimmed to its capitals. */
export function FrameButton({ className, children, selected, ...rest }: ComponentPropsWithRef<'button'> & Selected) {
  return (
    <button type="button" className={`${look(selected)} ${className ?? ''}`} {...rest}>
      {children}
    </button>
  )
}

/** The same look on a link: Book and Account go to pages of their own (W73, Wayne). */
export function FrameLink({ className, children, selected, ...rest }: ComponentPropsWithoutRef<typeof SiteLink> & Selected) {
  return (
    <SiteLink className={`${look(selected)} ${className ?? ''}`} {...rest}>
      {children}
    </SiteLink>
  )
}

export function FrameButtonLabel({ children }: { children: ReactNode }) {
  return <span className="text-label-12 whitespace-nowrap">{children}</span>
}
