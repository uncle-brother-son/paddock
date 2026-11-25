import type { ReactNode } from 'react'

import { Icon } from '@/components/brand/Icon'

type CheckboxProps = {
  checked: boolean
  onChange: (checked: boolean) => void
  /** Its words, in Copy 12: they are its name, and a press on them ticks it. */
  children: ReactNode
  name?: string
  className?: string
}

/**
 * Figma "Checkbox" (03 UI, 960:22442, with "CheckboxControl", 891:5676): a 20px box with 4px corners and its words in
 * Copy 12, 8px apart. Unticked the box is Surface/Card Selected; under a mouse it shows the tick in Text/Primary;
 * ticked it is Surface/Secondary with the tick in Text/Secondary. The tick is the icon set's, drawn at 12px.
 *
 * A real checkbox under the designed look (docs/build-standards.md, section 1: Forms): Space ticks it, and a screen
 * reader says its words and whether it is ticked. The press reaches 2px above and below the box (24px in all), with
 * no change to how it looks; the ring is drawn round the box, for the keyboard only.
 */
export function Checkbox({ checked, onChange, children, name, className }: CheckboxProps) {
  return (
    <label data-checkbox="" className={`group -my-2 flex cursor-pointer items-start gap-8 py-2 ${className ?? ''}`}>
      <span
        className={`relative flex size-20 shrink-0 items-center justify-center rounded-s transition-colors duration-short ease-smooth has-keyboard-focus:outline-2 has-keyboard-focus:outline-offset-2 has-keyboard-focus:outline-text-primary ${checked ? 'bg-surface-secondary text-text-secondary' : 'bg-surface-card-selected text-text-primary'}`}
      >
        <input type="checkbox" {...(name ? { name } : {})} checked={checked} onChange={(event) => onChange(event.target.checked)} className="sr-only" />
        <Icon name="tick" className={`size-12 transition-opacity duration-short ease-smooth ${checked ? '' : 'opacity-0 group-hover:opacity-100'}`} />
      </span>
      {/* One line of words sits level with the middle of the box, as drawn. */}
      <span className="flex min-h-20 min-w-0 flex-1 items-center">
        <span className="text-copy-12 text-text-primary">{children}</span>
      </span>
    </label>
  )
}
