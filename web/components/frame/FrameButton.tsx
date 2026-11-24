import type { ComponentPropsWithRef, ReactNode } from 'react'

/** Figma "MenuButton" (03 UI, 206:2915): 8px all round, Label 12, and Surface/Card Selected behind it on hover. */
export const FRAME_BUTTON = 'flex items-center gap-8 rounded-s p-8 text-text-primary transition-colors duration-short ease-smooth hover:bg-surface-card-selected'

/** One of the header's buttons. Its words go in a FrameButtonLabel: Label 12 is trimmed to its capitals. */
export function FrameButton({ className, children, ...rest }: ComponentPropsWithRef<'button'>) {
  return (
    <button type="button" className={`${FRAME_BUTTON} ${className ?? ''}`} {...rest}>
      {children}
    </button>
  )
}

export function FrameButtonLabel({ children }: { children: ReactNode }) {
  return <span className="text-label-12 whitespace-nowrap">{children}</span>
}
