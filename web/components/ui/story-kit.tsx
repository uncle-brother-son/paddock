import type { ReactNode } from 'react'

import { BothModes } from '@/components/brand/BothModes'

// For the stories of Figma's 03 UI page (W78a; WQ71). Each component has one story for each of Figma's variants, under
// Figma's own name for it ("Type=primary, Big=Yes, State=hover"), drawn in Light and in Dark. A hover variant's story
// sets `globals: { pseudo: 'hover' }` (.storybook/pseudo-states.ts), so it is drawn as under a mouse without one.

/** One variant twice, in Light and in Dark, each on its own Surface/Primary. `width` holds a component that fills what it is in (Figma's own width for it). */
export function InBothModes({ children, width }: { children: ReactNode; width?: string }) {
  return (
    <BothModes>
      <div className={`flex items-start ${width ?? ''}`}>{children}</div>
    </BothModes>
  )
}

/** Every element in the story that matches, one for each mode: Light first, then Dark. */
export const inEachMode = <Found extends Element = HTMLElement>(canvasElement: HTMLElement, selector: string): Found[] =>
  [...canvasElement.querySelectorAll<HTMLElement>('section[data-theme]')].flatMap((mode) => [...mode.querySelectorAll<Found>(selector)])

/**
 * The colour a token's class paints where `beside` stands (so in its mode), as the browser reports it: what a
 * component's own colour is compared with. `painted(button, 'bg-surface-card-selected')` is Surface/Card Selected there.
 *
 * Never call it inside `waitFor`: it puts an element into the page and takes it out again, `waitFor` looks again on
 * every change to the page, and a check that fails the first time then goes round for ever with no error. Read the
 * colour first, then wait for the component to reach it.
 */
export function painted(beside: Element, className: string, property: 'backgroundColor' | 'color' = 'backgroundColor'): string {
  const probe = document.createElement('span')
  probe.className = className
  probe.hidden = true
  beside.parentElement?.append(probe)
  const colour = getComputedStyle(probe)[property]
  probe.remove()
  return colour
}

/** A colour that paints nothing, as the browser reports it. */
export const CLEAR = 'rgba(0, 0, 0, 0)'
