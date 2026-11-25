import type { ComponentPropsWithoutRef, ComponentPropsWithRef } from 'react'

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

type BigButtonProps = ComponentPropsWithoutRef<'button'> & {
  /**
   * W74c (WQ51): a second label that takes the first one's place while a mouse is over the button (the `label-swap`
   * utility in app/globals.css). It is for the eye only: the button's name stays its own label, which is what a
   * screen reader, the keyboard, a touch screen and reduced motion all get.
   */
  hoverLabel?: string
}

export function BigButton({ className, children, hoverLabel, type = 'button', ...rest }: BigButtonProps) {
  if (hoverLabel !== undefined) {
    // Each label fills the button, so each travels the button's whole height and is clipped at its edge.
    return (
      <button type={type} className={`${BIG_PRIMARY_BUTTON} label-swap relative overflow-clip ${className ?? ''}`} {...rest}>
        <span data-label="rest" className="absolute inset-0 flex items-center justify-center">
          <ButtonLabel>{children}</ButtonLabel>
        </span>
        <span data-label="hover" aria-hidden="true" className="absolute inset-0 flex items-center justify-center">
          <ButtonLabel>{hoverLabel}</ButtonLabel>
        </span>
      </button>
    )
  }
  return (
    <button type={type} className={`${BIG_PRIMARY_BUTTON} ${className ?? ''}`} {...rest}>
      <ButtonLabel>{children}</ButtonLabel>
    </button>
  )
}

/**
 * W77. Figma "Button", Type=secondary, Big=No (in the Book panel: "Log in", an add-on's "Add", a full session's
 * "Full"): the small button on Surface/Card with its label in Text/Primary. Disabled (State=disabled, 1180:19887's
 * "Full"), it is Surface/Card Disabled with its label in Text/Muted Primary.
 */
export const SMALL_SECONDARY_BUTTON =
  'inline-flex items-center justify-center rounded-s bg-surface-card px-32 py-12 text-text-primary disabled:cursor-default disabled:bg-surface-card-disabled disabled:text-text-muted-primary'

export function SecondaryButton({ className, children, type = 'button', ...rest }: ComponentPropsWithRef<'button'>) {
  return (
    <button type={type} className={`${SMALL_SECONDARY_BUTTON} ${className ?? ''}`} {...rest}>
      <ButtonLabel>{children}</ButtonLabel>
    </button>
  )
}

export function Button({ className, children, type = 'button', ...rest }: ComponentPropsWithRef<'button'>) {
  return (
    <button type={type} className={`${SMALL_PRIMARY_BUTTON} ${className ?? ''}`} {...rest}>
      <ButtonLabel>{children}</ButtonLabel>
    </button>
  )
}
