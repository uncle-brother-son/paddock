type ToggleOption<Value extends string> = { value: Value; label: string }

type ToggleProps<Value extends string> = {
  /** What is being chosen, for a screen reader: "How it is sent". */
  label: string
  /** The radio group's name: one group for the two. */
  name: string
  value: Value
  /** The choices, left to right: two as drawn. W77: a day's private lengths may be one, or more than two. */
  options: readonly [ToggleOption<Value>, ...ToggleOption<Value>[]]
  onChange: (value: Value) => void
  className?: string
}

/**
 * Figma "Toggle" (03 UI, 597:5432; on the Gift Card page as Digital and Physical, and in the Book panel as Public and
 * Private and as a private session's 60 and 120 min): two choices side by side on
 * Surface/Card with 4px corners, each 32px each side and 12px above and below with its words in Label 12. The one
 * chosen is Surface/Secondary with Text/Secondary; the other has no fill and Text/Primary. It is as wide as its words.
 *
 * Two radio buttons under the designed look (docs/build-standards.md, section 1: Forms), so Left and Right move
 * between them and a screen reader says which is chosen. The ring is drawn round the choice that has focus, for the
 * keyboard only (`has-keyboard-focus`, app/globals.css).
 */
export function Toggle<Value extends string>({ label, name, value, options, onChange, className }: ToggleProps<Value>) {
  return (
    <div role="radiogroup" aria-label={label} data-toggle="" className={`inline-flex items-center rounded-s bg-surface-card ${className ?? ''}`}>
      {options.map((option) => {
        const chosen = option.value === value
        return (
          <label
            key={option.value}
            className={`relative flex cursor-pointer items-center justify-center rounded-s px-32 py-12 transition-colors duration-short ease-smooth has-keyboard-focus:outline-2 has-keyboard-focus:outline-offset-2 has-keyboard-focus:outline-text-primary ${chosen ? 'bg-surface-secondary text-text-secondary' : 'text-text-primary'}`}
          >
            <input type="radio" name={name} value={option.value} checked={chosen} onChange={() => onChange(option.value)} className="sr-only" />
            <span className="text-label-12 whitespace-nowrap">{option.label}</span>
          </label>
        )
      })}
    </div>
  )
}
