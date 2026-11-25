type RadioProps = {
  /** The radio group's name: one group for the choices that exclude each other. */
  name: string
  value: string
  checked: boolean
  onChange: () => void
  /** Its name for a screen reader, when it does not stand inside a <label> whose words name it. */
  label?: string
  className?: string
}

/**
 * Figma "Radio" (03 UI, 891:5691): a 20px circle. Not chosen it is Surface/Card Selected (State=default); under a
 * mouse it shows the 10px dot in Text/Muted Primary (State=hover); chosen it is Surface/Secondary with the dot in
 * Text/Secondary (State=selected).
 *
 * A real radio button lies unseen over the circle (docs/build-standards.md, section 1: Forms), so the arrow keys
 * move between the choices of a group and a screen reader says which is chosen. It reaches 2px beyond the circle all
 * round (24px, the least a press may be), with no change to how it looks; the ring is drawn round the circle, for the
 * keyboard only.
 */
export function Radio({ name, value, checked, onChange, label, className }: RadioProps) {
  return (
    <span
      data-radio=""
      className={`group/radio relative flex size-20 shrink-0 items-center justify-center rounded-full transition-colors duration-short ease-smooth has-keyboard-focus:outline-2 has-keyboard-focus:outline-offset-2 has-keyboard-focus:outline-text-primary ${checked ? 'bg-surface-secondary' : 'bg-surface-card-selected'} ${className ?? ''}`}
    >
      <span
        aria-hidden="true"
        className={`size-1/2 rounded-full transition-[opacity,background-color] duration-short ease-smooth ${checked ? 'bg-text-secondary' : 'bg-text-muted-primary opacity-0 group-hover/radio:opacity-100'}`}
      />
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onChange}
        {...(label ? { 'aria-label': label } : {})}
        className="absolute -top-2 -left-2 m-0 size-24 cursor-pointer appearance-none rounded-full opacity-0"
      />
    </span>
  )
}
