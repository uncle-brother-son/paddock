'use client'

import { useRouter } from 'next/navigation'

import { Icon } from '@/components/brand/Icon'
import { FRAME_BUTTON, FrameButtonLabel } from '@/components/frame/FrameButton'
import { PAGE_TRANSITION_TYPES } from '@/lib/motion/page-transition'

/** One choice of the list: what the browser's list shows, and the Shop's address with it chosen. */
export type ShopSelectOption = { value: string; label: string; href: string }

type ShopSelectProps = {
  /** What the control is, for a screen reader: "Category", "Sort by". */
  name: string
  /** The words drawn on it: "All", "Sort". */
  shown: string
  value: string
  options: ShopSelectOption[]
}

/**
 * The Shop's ALL and SORT (WQ37; Figma 1684:41843 and 1684:41844, each a MenuButton: Label 12 and the chevron, 8px
 * all round, Surface/Card Selected on hover). The control drawn is a real <select> lying unseen over it, so a press
 * opens the browser's own list, on a phone its own picker, and the keyboard works as on any select. Choosing goes to
 * the Shop's address for that choice, staying where the page is scrolled to.
 */
export function ShopSelect({ name, shown, value, options }: ShopSelectProps) {
  const router = useRouter()
  return (
    // The ring is drawn here, round what is seen, and only for the keyboard: a browser counts a clicked <select> as
    // keyboard focus, so it follows what the visitor last used (`has-keyboard-focus`, app/globals.css).
    <div className={`relative ${FRAME_BUTTON} has-keyboard-focus:outline-2 has-keyboard-focus:outline-offset-2 has-keyboard-focus:outline-text-primary`}>
      <FrameButtonLabel>{shown}</FrameButtonLabel>
      <Icon name="chevron" />
      <select
        aria-label={name}
        value={value}
        onChange={(event) => {
          const chosen = options.find((option) => option.value === event.target.value)
          if (chosen) router.push(chosen.href, { scroll: false, transitionTypes: PAGE_TRANSITION_TYPES })
        }}
        // Copy 16: a phone zooms into a field whose words are smaller than 16px, seen or not.
        className="absolute inset-0 size-full cursor-pointer appearance-none text-copy-16 opacity-0"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  )
}
