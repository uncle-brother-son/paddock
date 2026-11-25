import type { ReactNode } from 'react'

/**
 * Figma "InfoPanelLink" (1549:49650): Label 12, Text/Muted Primary on hover. It opens the Product Info Panel on a
 * tab (a product's Description, an event's Event Terms & Conditions). The press reaches 8px above and below its capitals.
 */
export function InfoPanelLink({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      onClick={onClick}
      className="relative block text-left text-label-12 text-text-primary transition-colors duration-short ease-smooth after:absolute after:inset-x-0 after:-inset-y-8 hover:text-text-muted-primary"
    >
      {children}
    </button>
  )
}
