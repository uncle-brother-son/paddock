'use client'

import { useId, useState, type ReactNode } from 'react'

import { Icon } from '@/components/brand/Icon'

type AccordionProps = {
  /** Its heading, in Label 12: the words of the button that opens and shuts it. */
  label: string
  /** What it holds. Plain words are set in Copy 14; anything else (rich text) brings its own text styles. */
  children: ReactNode
  /** Open from the start. Left out, it starts shut. */
  defaultOpen?: boolean
  className?: string
}

/**
 * Figma "Accordion" (03 UI, 1492:11780): on Surface/Card with 4px corners and 16px all round, its heading in Label
 * 12 with the chevron 8px to its right (Open=no). Open (Open=yes) the chevron is turned half-way round and what it
 * holds sits under the heading in Copy 14, with 32px above and below it, no wider than the heading: clear of the
 * chevron's column.
 *
 * The heading and the chevron are one button, as large as the shut accordion, which says whether it is open
 * (`aria-expanded`) and what it opens. What it holds is in the page's HTML whether it is open or not.
 *
 * It opens and shuts with motion (WQ80): what it holds grows from nothing to its own height, or back, over the short
 * duration (320 ms) with the smooth curve, as the chevron turns. The height moves as a grid row going from 0fr to 1fr,
 * so no height is measured. Shut, what it holds is hidden (`visibility`, which also keeps it from a screen reader and
 * the Tab key). Opening, it is shown at once; shutting, it is hidden only once the movement has ended, so it is seen
 * as it closes. Reduced motion: the site's rule makes both
 * instant (app/globals.css). What it holds is clipped only while it moves or is shut, so a focus ring inside it is
 * never cut off once it is open.
 */
export function Accordion({ label, children, defaultOpen = false, className }: AccordionProps) {
  const id = useId()
  const [open, setOpen] = useState(defaultOpen)
  // From a press until the height has finished moving.
  const [moving, setMoving] = useState(false)
  return (
    <div data-accordion="" className={`flex flex-col rounded-s bg-surface-card p-16 ${className ?? ''}`}>
      {/* The button reaches the accordion's own edges: its padding is the accordion's, taken back by the margin. */}
      <button
        type="button"
        id={`${id}-heading`}
        aria-expanded={open}
        aria-controls={`${id}-held`}
        onClick={() => {
          setMoving(true)
          setOpen(!open)
        }}
        className="-m-16 flex items-start gap-8 rounded-s p-16 text-left text-text-primary"
      >
        <span className="min-w-0 flex-1 text-label-12">{label}</span>
        <Icon name="chevron" className={`transition-transform duration-short ease-smooth ${open ? 'rotate-180' : ''}`} />
      </button>
      {/* A group named by the heading, not a region: a page of these would otherwise be a page of landmarks. */}
      <div
        id={`${id}-held`}
        role="group"
        aria-labelledby={`${id}-heading`}
        onTransitionEnd={(event) => {
          if (event.target === event.currentTarget && event.propertyName === 'grid-template-rows') setMoving(false)
        }}
        className={`grid duration-short ease-smooth ${open ? 'visible grid-rows-[1fr] transition-[grid-template-rows]' : 'invisible grid-rows-[0fr] transition-[grid-template-rows,visibility]'}`}
      >
        <div className={`min-h-0 ${open && !moving ? '' : 'overflow-hidden'}`}>
          <div data-accordion-held="" className="flex gap-8 py-32 text-text-primary">
            <div className="min-w-0 flex-1">{typeof children === 'string' ? <p className="text-copy-14">{children}</p> : children}</div>
            {/* An unseen chevron keeps what is held as wide as the heading, as drawn. */}
            <Icon name="chevron" className="invisible" />
          </div>
        </div>
      </div>
    </div>
  )
}
