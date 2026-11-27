import { useId, type ReactNode } from 'react'

import { Icon } from '@/components/brand/Icon'

type CheckboxControlProps = {
  checked: boolean
  disabled?: boolean
  /** Something is wrong with the choice (Figma "Checkbox", Error=yes): Surface/Card Error while it is not ticked. */
  wrong?: boolean
  /** The real checkbox, unseen, when the box stands for one. */
  children?: ReactNode
}

/**
 * Figma "CheckboxControl" (03 UI, 891:5676): the 20px box with 4px corners, the icon set's tick at 12px in its
 * middle. State=default: Surface/Card Selected, empty. State=hover: the tick shows, in Text/Primary. State=selected:
 * Surface/Secondary with the tick in Text/Secondary. State=disabled: Surface/Card Disabled, empty, and a mouse shows
 * nothing. The mouse is one over the box itself, or anywhere over the Checkbox it is the box of.
 *
 * The ring is drawn round the box, for the keyboard only, when the real checkbox inside it has focus.
 */
export function CheckboxControl({ checked, disabled = false, wrong = false, children }: CheckboxControlProps) {
  const fill = checked
    ? 'bg-surface-secondary text-text-secondary'
    : disabled
      ? 'bg-surface-card-disabled text-text-primary'
      : wrong
        ? 'bg-surface-card-error text-text-primary'
        : 'bg-surface-card-selected text-text-primary'
  const tick = checked ? '' : disabled ? 'opacity-0' : 'opacity-0 group-hover/checkbox:opacity-100 group-hover/control:opacity-100'
  return (
    <span
      data-checkbox-control=""
      className={`group/control relative flex size-20 shrink-0 items-center justify-center rounded-s transition-colors duration-short ease-smooth has-keyboard-focus:outline-2 has-keyboard-focus:outline-offset-2 has-keyboard-focus:outline-text-primary ${fill}`}
    >
      {children}
      <Icon name="tick" className={`size-12 transition-opacity duration-short ease-smooth ${tick}`} />
    </span>
  )
}

type CheckboxProps = {
  checked: boolean
  onChange: (checked: boolean) => void
  /** Its words, in Copy 12: they are its name, and a press on them ticks it. */
  children: ReactNode
  name?: string
  /** What is wrong, in words (Figma's Error=yes); null or left out when nothing is. */
  error?: string | null
  /** Figma's Wrapped=yes: on a Surface/Card of its own, as tall as a field. */
  wrapped?: boolean
  disabled?: boolean
  className?: string
}

/**
 * Wrapped=yes (1027:7630): 16px each side and 11px above and below, 4px corners. 11 is not a step of the spacing
 * scale: it is half of 6 and 16, which makes the row Figma's 42px, the height of the Input it sits among.
 */
const WRAPPED = 'rounded-s px-16 py-[calc((var(--spacing-6)_+_var(--spacing-16))_/_2)]'

/**
 * Figma "Checkbox" (03 UI, 960:22442, with "CheckboxControl", 891:5676): the box and its words in Copy 12, 8px apart,
 * the first line of the words level with the middle of the box. Under a mouse the box shows its tick (Hover=yes);
 * ticked it is Selected=yes. Error=yes: the box is Surface/Card Error and the message sits 8px under the words in
 * Text/Error. Wrapped=yes: the whole on Surface/Card; with Disabled=yes on Surface/Card Disabled, its words in
 * Text/Muted Primary.
 *
 * A real checkbox under the designed look (docs/build-standards.md, section 1: Forms): Space ticks it, and a screen
 * reader says its words and whether it is ticked; the message is tied to it and read out when it appears. Not
 * wrapped, the press reaches 2px above and below the box (24px in all), with no change to how it looks.
 */
export function Checkbox({ checked, onChange, children, name, error = null, wrapped = false, disabled = false, className }: CheckboxProps) {
  const id = useId()
  const wordsId = `${id}-words`
  const errorId = `${id}-error`
  const frame = wrapped ? `${WRAPPED} ${disabled ? 'bg-surface-card-disabled' : 'bg-surface-card'}` : '-my-2 py-2'
  return (
    <label data-checkbox="" className={`group/checkbox flex items-start gap-8 ${disabled ? 'cursor-default' : 'cursor-pointer'} ${frame} ${className ?? ''}`}>
      <CheckboxControl checked={checked} disabled={disabled} wrong={error !== null}>
        <input
          type="checkbox"
          {...(name ? { name } : {})}
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
          // Its name is its words alone: the message beneath them is what describes it.
          aria-labelledby={wordsId}
          {...(error !== null ? { 'aria-invalid': true, 'aria-describedby': errorId } : {})}
          className="sr-only"
        />
      </CheckboxControl>
      {/* The capitals of the first line sit level with the middle of the 20px box, however many lines there are. */}
      <span className="flex min-w-0 flex-1 flex-col pt-[calc((var(--spacing-20)_-_1cap)_/_2)] text-copy-12 [text-box-trim:none]">
        <span id={wordsId} className={`block text-copy-12 ${disabled ? 'text-text-muted-primary' : 'text-text-primary'}`}>
          {children}
        </span>
        <span aria-live="polite" className="block">
          {error !== null ? (
            <span id={errorId} data-checkbox-error="" className="mt-8 block text-copy-12 text-text-error">
              {error}
            </span>
          ) : null}
        </span>
      </span>
    </label>
  )
}
