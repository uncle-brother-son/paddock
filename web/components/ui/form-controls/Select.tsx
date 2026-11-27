import { Icon } from '@/components/brand/Icon'

/** One choice of the list: what the browser's list shows, and the value it stands for. */
export type SelectOption = { value: string; label: string }

type SelectProps = {
  /** What is being chosen: its name for a screen reader, and the words drawn on it while nothing is chosen. */
  label: string
  /** The value of the choice made; empty while none is. */
  value: string
  options: readonly SelectOption[]
  onValue: (value: string) => void
  disabled?: boolean
  name?: string
  autoComplete?: string
  className?: string
}

/**
 * Figma "Select" (03 UI, 947:3179): a field-sized list to choose from. Surface/Card over Surface/Primary with 4px
 * corners, 16px to the left of its words in Copy 14 and Text/Primary, and at its right, 6px in from the top, right
 * and bottom, a square on Surface/Card with 4px corners holding the chevron. Under a mouse it is Surface/Card
 * Selected (State=hover); disabled, Surface/Card Disabled with its words and its chevron in Text/Muted Primary.
 *
 * It is as tall as an Input (components/ui/form-controls/Field.tsx: 16px above and below Copy 14's capitals, Figma's 42px), so the
 * two sit level in a form, and the chevron's square is what the 6px leaves (Figma's 30px).
 *
 * The control drawn is a real <select> lying unseen over it, as the Shop's ALL and SORT have (ShopSelect): a press
 * opens the browser's own list, on a phone its own picker, and the keyboard works as on any select. Figma draws it
 * no focus state, so it gets the keyboard's ring, round what is seen (`has-keyboard-focus`, app/globals.css).
 */
export function Select({ label, value, options, onValue, disabled = false, name, autoComplete, className }: SelectProps) {
  const chosen = options.find((option) => option.value === value)
  return (
    <div data-select="" className={`rounded-s bg-surface-primary ${className ?? ''}`}>
      <div
        className={`relative flex h-[calc(1cap_+_var(--spacing-32))] items-center rounded-s py-6 pr-6 pl-16 text-copy-14 [text-box-trim:none] transition-colors duration-short ease-smooth has-keyboard-focus:outline-2 has-keyboard-focus:outline-offset-2 has-keyboard-focus:outline-text-primary ${disabled ? 'bg-surface-card-disabled text-text-muted-primary' : 'bg-surface-card text-text-primary hover:bg-surface-card-selected'}`}
      >
        <span className="min-w-0 flex-1 overflow-x-clip text-copy-14 text-ellipsis whitespace-nowrap">{chosen ? chosen.label : label}</span>
        <span className="flex aspect-square h-full shrink-0 items-center justify-center rounded-s bg-surface-card">
          <Icon name="chevron" />
        </span>
        <select
          aria-label={label}
          value={value}
          disabled={disabled}
          {...(name ? { name } : {})}
          {...(autoComplete ? { autoComplete } : {})}
          onChange={(event) => onValue(event.target.value)}
          // Copy 16: a phone zooms into a field whose words are smaller than 16px, seen or not.
          className={`absolute inset-0 size-full appearance-none text-copy-16 opacity-0 ${disabled ? 'cursor-default' : 'cursor-pointer'}`}
        >
          {/* Nothing chosen yet: the prompt is the list's first line, and can't be chosen. */}
          {chosen ? null : (
            <option value="" disabled>
              {label}
            </option>
          )}
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  )
}
