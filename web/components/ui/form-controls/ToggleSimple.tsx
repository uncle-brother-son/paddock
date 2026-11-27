type ToggleSimpleProps = {
  on: boolean
  onChange: (on: boolean) => void
  /** What it switches, for a screen reader: "Email reminders". */
  label: string
  name?: string
  className?: string
}

/**
 * Figma "ToggleSimple" (03 UI, 882:4637): a switch, 40 by 20 with 4px corners, and inside it, 2px in, a 16px
 * square with 4px corners. Off (On=No) it is Surface/Card with the square in Text/Primary at its left, and Surface/Card
 * Selected under a mouse (State=hover, WQ80); on (On=Yes) it is Text/Primary with the square in Surface/Primary at its
 * right, the same under a mouse, as drawn.
 *
 * A real checkbox with the switch role lies unseen over it (docs/build-standards.md, section 1: Forms): Space
 * switches it, and a screen reader says its name and whether it is on. It reaches 2px above and below the switch
 * (24px), with no change to how it looks; the ring is drawn round the switch, for the keyboard only.
 *
 * Figma draws the two states and no movement between them. The square slides across over the short duration with
 * the smooth curve, as Toggle's chosen area does (WQ72); with reduced motion on it is there at once.
 */
export function ToggleSimple({ on, onChange, label, name, className }: ToggleSimpleProps) {
  return (
    <span
      data-toggle-simple=""
      className={`relative inline-flex h-20 w-40 shrink-0 items-center rounded-s p-2 transition-colors duration-short ease-smooth has-keyboard-focus:outline-2 has-keyboard-focus:outline-offset-2 has-keyboard-focus:outline-text-primary ${on ? 'bg-text-primary' : 'bg-surface-card hover:bg-surface-card-selected'} ${className ?? ''}`}
    >
      <span aria-hidden="true" className={`size-16 rounded-s transition-[translate,background-color] duration-short ease-smooth ${on ? 'translate-x-20 bg-surface-primary' : 'bg-text-primary'}`} />
      <input
        type="checkbox"
        role="switch"
        checked={on}
        {...(name ? { name } : {})}
        aria-label={label}
        onChange={(event) => onChange(event.target.checked)}
        className="absolute -top-2 left-0 m-0 h-24 w-full cursor-pointer appearance-none opacity-0"
      />
    </span>
  )
}
