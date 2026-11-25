import type { ComponentPropsWithoutRef, ComponentPropsWithRef, MouseEvent } from 'react'

// Figma "Button" (03 UI, 329:7955): 4px corners, its label in Label 12, 32px each side and 12px above and below.
// Type=primary is Surface/Secondary with Text/Secondary, and Figma draws its hover the same as its rest.
// Type=secondary is Surface/Card with Text/Primary, and Surface/Card Selected under a mouse. State=loading: the label
// reads "Loading" in the muted colour of its type (Text/Muted Secondary, Text/Muted Primary) on the same fill.
// State=disabled, either type: Surface/Card Disabled with Text/Muted Primary. Big=Yes is the taller one.

const SMALL = 'inline-flex items-center justify-center rounded-s px-32 py-12'

/**
 * Big=Yes. Figma fixes its height at 42, which is not on the spacing scale: it is the nearest step, 40 (W73, Wayne: a
 * size that is no token goes to the nearest one). On the site it is the whole width of what holds it (W74).
 */
const BIG = 'flex h-40 w-full items-center justify-center rounded-s px-32 py-12'

const PRIMARY = 'bg-surface-secondary text-text-secondary'
const SECONDARY = 'bg-surface-card text-text-primary'

/** State=hover of a secondary button: never while it is disabled. */
const SECONDARY_HOVER = 'transition-colors duration-short ease-smooth enabled:hover:bg-surface-card-selected'

/** State=disabled, the same for both types. */
const DISABLED = 'disabled:cursor-default disabled:bg-surface-card-disabled disabled:text-text-muted-primary'

/** State=loading: the fill of its type at rest (a mouse changes nothing), the label muted. */
const LOADING = {
  primary: 'cursor-default bg-surface-secondary text-text-muted-secondary',
  secondary: 'cursor-default bg-surface-card text-text-muted-primary',
} as const

type ButtonType = keyof typeof LOADING

/**
 * Type=primary, Big=No (329:8563) as a class, for a link drawn as the button ("Skip to content").
 */
export const SMALL_PRIMARY_BUTTON = `${SMALL} ${PRIMARY}`

/** Type=primary, Big=Yes (329:7958; State=disabled 1186:47993, "Sold out"). */
export const BIG_PRIMARY_BUTTON = `${BIG} ${PRIMARY} ${DISABLED}`

/** Type=secondary, Big=No (329:8561; State=disabled 1186:47999, a full session's "Full"). */
export const SMALL_SECONDARY_BUTTON = `${SMALL} ${SECONDARY} ${DISABLED}`

const look = (kind: ButtonType, big: boolean, loading: boolean): string => `${big ? BIG : SMALL} ${loading ? LOADING[kind] : kind === 'primary' ? PRIMARY : `${SECONDARY} ${SECONDARY_HOVER}`} ${DISABLED}`

/**
 * What a button is given while it is loading: a screen reader hears that it is busy and can't be pressed, a press
 * does nothing, and a form it would send is not sent. It keeps focus, which a disabled button would lose.
 */
const WHILE_LOADING = {
  'aria-busy': true,
  'aria-disabled': true,
  onClick: (event: MouseEvent<HTMLButtonElement>) => event.preventDefault(),
} as const

/** The label sits in an element of its own: Label 12 is trimmed to its capitals, and the padding belongs to the button. */
export function ButtonLabel({ children }: { children: React.ReactNode }) {
  return <span className="text-label-12 whitespace-nowrap">{children}</span>
}

type ButtonProps = ComponentPropsWithRef<'button'> & {
  /** Figma's State=loading: the label reads "Loading", muted, and the button can't be pressed until it is done. */
  loading?: boolean
}

function ButtonOf({ kind, big, loading = false, className, children, type = 'button', ...rest }: ButtonProps & { kind: ButtonType; big: boolean }) {
  return (
    <button type={type} className={`${look(kind, big, loading)} ${className ?? ''}`} {...rest} {...(loading ? WHILE_LOADING : {})}>
      <ButtonLabel>{loading ? 'Loading' : children}</ButtonLabel>
    </button>
  )
}

type BigButtonProps = ComponentPropsWithoutRef<'button'> & {
  loading?: boolean
  /**
   * W74c (WQ51): a second label that takes the first one's place while a mouse is over the button (the `label-swap`
   * utility in app/globals.css). It is for the eye only: the button's name stays its own label, which is what a
   * screen reader, the keyboard, a touch screen and reduced motion all get.
   */
  hoverLabel?: string
}

/** Type=primary, Big=Yes (329:7958): "Add to bag". */
export function BigButton({ className, children, hoverLabel, loading = false, type = 'button', ...rest }: BigButtonProps) {
  if (hoverLabel !== undefined && !loading) {
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
  // The same <button> as above, drawn here too: when the second label comes or goes the button stays the one it was,
  // with its focus.
  return (
    <button type={type} className={`${look('primary', true, loading)} ${className ?? ''}`} {...rest} {...(loading ? WHILE_LOADING : {})}>
      <ButtonLabel>{loading ? 'Loading' : children}</ButtonLabel>
    </button>
  )
}

/** Type=secondary, Big=Yes (329:7953). */
export function BigSecondaryButton(props: ButtonProps) {
  return <ButtonOf kind="secondary" big {...props} />
}

/**
 * Type=secondary, Big=No (329:8561; in the Book panel: "Log in", an add-on's "Add", a full session's "Full").
 */
export function SecondaryButton(props: ButtonProps) {
  return <ButtonOf kind="secondary" big={false} {...props} />
}

/** Type=primary, Big=No (329:8563). */
export function Button(props: ButtonProps) {
  return <ButtonOf kind="primary" big={false} {...props} />
}
