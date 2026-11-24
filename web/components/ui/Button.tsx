import type { ComponentPropsWithoutRef } from 'react'

/**
 * Figma "Button", Type=primary, Big=No (03 UI, node 329:8563): Surface/Secondary with its label in Label 12 and
 * Text/Secondary, 32px each side and 12px above and below. The designs draw its hover the same as its rest. Only
 * this one of Figma's Buttons is built so far (W73 needs it for "Skip to content"); the Big and secondary ones come
 * with the pages that use them.
 */
export const SMALL_PRIMARY_BUTTON = 'inline-flex items-center justify-center rounded-s bg-surface-secondary px-32 py-12 text-text-secondary'

/** The label sits in an element of its own: Label 12 is trimmed to its capitals, and the padding belongs to the button. */
export function ButtonLabel({ children }: { children: React.ReactNode }) {
  return <span className="text-label-12 whitespace-nowrap">{children}</span>
}

/**
 * W74. Figma "Button", Type=primary, Big=Yes (329:7958; State=disabled 1186:47993): the same button the whole width of
 * what holds it, taller. Disabled, it is Surface/Card Disabled with its label in Text/Muted Primary ("Sold out").
 * Figma fixes its height at 42, which is not on the spacing scale: it is the nearest step, 40 (W73, Wayne: a size
 * that is no token goes to the nearest one).
 */
export const BIG_PRIMARY_BUTTON =
  'flex h-40 w-full items-center justify-center rounded-s bg-surface-secondary px-32 py-12 text-text-secondary disabled:cursor-default disabled:bg-surface-card-disabled disabled:text-text-muted-primary'

export function BigButton({ className, children, type = 'button', ...rest }: ComponentPropsWithoutRef<'button'>) {
  return (
    <button type={type} className={`${BIG_PRIMARY_BUTTON} ${className ?? ''}`} {...rest}>
      <ButtonLabel>{children}</ButtonLabel>
    </button>
  )
}

export function Button({ className, children, type = 'button', ...rest }: ComponentPropsWithoutRef<'button'>) {
  return (
    <button type={type} className={`${SMALL_PRIMARY_BUTTON} ${className ?? ''}`} {...rest}>
      <ButtonLabel>{children}</ButtonLabel>
    </button>
  )
}
