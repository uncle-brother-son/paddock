'use client'

import { useLayoutEffect, useRef, useState } from 'react'

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

/** Where the selected area is: from the left edge of the Toggle, and how wide. */
type Selected = { left: number; width: number }

/**
 * Figma "Toggle" (03 UI, 597:5432; on the Gift Card page as Digital and Physical, and in the booking panel as Public and
 * Private and as a private session's 60 and 120 min): two choices side by side on
 * Surface/Card with 4px corners, each 32px each side and 12px above and below with its words in Label 12. The one
 * chosen is Surface/Secondary with Text/Secondary; the other has no fill and Text/Primary. It is as wide as its words.
 * Under a mouse the whole of it is Surface/Card Selected (State=hover, 1803:42778).
 *
 * W78a (WQ72): the selected area slides to the choice made, over the short duration with the smooth curve, its words
 * changing colour as it goes. It is one element behind the words, put where the chosen choice measures; until that
 * is measured (in the HTML from the server) the chosen choice has the fill itself, so nothing is seen to arrive.
 * Reduced motion: the site's one rule makes every transition instant, so it is there at once and nothing slides.
 *
 * Two radio buttons under the designed look (docs/build-standards.md, section 1: Forms), so Left and Right move
 * between them and a screen reader says which is chosen. The ring is drawn round the choice that has focus, for the
 * keyboard only (`has-keyboard-focus`, app/globals.css).
 */
export function Toggle<Value extends string>({ label, name, value, options, onChange, className }: ToggleProps<Value>) {
  const track = useRef<HTMLDivElement>(null)
  const [selected, setSelected] = useState<Selected | null>(null)
  // The choices as they are drawn: when their words change, so may their widths.
  const drawn = options.map((option) => `${option.value}:${option.label}`).join('|')

  useLayoutEffect(() => {
    const element = track.current
    if (!element) return
    const measure = () => {
      const chosen = element.querySelector<HTMLElement>('[data-chosen]')
      if (!chosen) return setSelected(null)
      const [outer, inner] = [element.getBoundingClientRect(), chosen.getBoundingClientRect()]
      const next = { left: inner.left - outer.left, width: inner.width }
      setSelected((now) => (now && now.left === next.left && now.width === next.width ? now : next))
    }
    measure()
    // The words can change width after they are first drawn (the site's fonts arriving, a window made narrower).
    const watcher = new ResizeObserver(measure)
    watcher.observe(element)
    for (const choice of element.querySelectorAll('label')) watcher.observe(choice)
    return () => watcher.disconnect()
  }, [value, drawn])

  return (
    <div
      ref={track}
      role="radiogroup"
      aria-label={label}
      data-toggle=""
      className={`relative inline-flex items-center rounded-s bg-surface-card transition-colors duration-short ease-smooth hover:bg-surface-card-selected ${className ?? ''}`}
    >
      {selected ? (
        <span
          aria-hidden="true"
          data-toggle-selected=""
          className="pointer-events-none absolute inset-y-0 left-0 rounded-s bg-surface-secondary transition-[translate,width] duration-short ease-smooth"
          style={{ width: selected.width, translate: `${selected.left}px 0` }}
        />
      ) : null}
      {options.map((option) => {
        const chosen = option.value === value
        return (
          <label
            key={option.value}
            {...(chosen ? { 'data-chosen': '' } : {})}
            className={`relative flex cursor-pointer items-center justify-center rounded-s px-32 py-12 transition-colors duration-short ease-smooth has-keyboard-focus:outline-2 has-keyboard-focus:outline-offset-2 has-keyboard-focus:outline-text-primary ${chosen ? `text-text-secondary ${selected ? '' : 'bg-surface-secondary'}` : 'text-text-primary'}`}
          >
            <input type="radio" name={name} value={option.value} checked={chosen} onChange={() => onChange(option.value)} className="sr-only" />
            <span className="text-label-12 whitespace-nowrap">{option.label}</span>
          </label>
        )
      })}
    </div>
  )
}
