'use client'

import { useId, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'

import { Icon } from '@/components/brand/Icon'
import { FRAME_BUTTON, FrameButtonLabel } from '@/components/frame/FrameButton'
import { Overlay } from '@/components/ui/Overlay'
import { usePopup } from '@/components/ui/usePopup'

/** One tab of the panel: its words on the tab, and what it holds, drawn on the server so it is in the page's HTML. */
export type InfoTab = { id: string; label: string; content: ReactNode }

type ProductInfoPanelProps = {
  open: boolean
  tabs: InfoTab[]
  /** The tab on show: one of the tabs' ids. */
  tab: string
  onTab: (id: string) => void
  onClose: () => void
  /** Its name for a screen reader: "Product information" unless said (W75: an event's is "Event information"). */
  label?: string
}

/**
 * The Product Info Panel (Figma "ProductInfoPanel", 1402:53321; on the page 1684:41935 and 1684:42004): a Light
 * panel 12px inside the window's top, right and bottom over Wayne's Overlay, its tabs in Label 12 (the one on show in
 * Text/Primary, the others Text/Muted Primary), what the tab holds beneath in Copy 14, and Close at its top right:
 * Figma's MenuButton with its label shown (WQ50, as drawn on the two pages: the close icon, 8px, "Close" in Label 12).
 * On a phone it is 12px inside every edge, and the tabs are a row to swipe when they don't all fit: it stands at its
 * start, its middle or its end, the first of them that shows the chosen tab whole, as Figma's phone variants draw it
 * (W78b, WQ75: Device=mobile, Tab=description 1402:53319, material & care 1802:39253, shipping & returns 1802:39321,
 * size guide 1802:39389). What each tab holds is drawn by whoever gives the tabs (ProductInfoTabs.tsx).
 *
 * Its width from 768px: Figma draws 519, which is no column of the grid; it is 9 columns (523 on Figma's frame),
 * the nearest (W73, Wayne: a size that is no token goes to the nearest token or grid column).
 *
 * A popup by the build standards (components/ui/usePopup.ts): focus moves in, to the tab on show; the page behind
 * is inert and does not scroll; Esc, Close and the shade close it; focus goes back to the link that opened it. The
 * tabs follow the tabs pattern: Left and Right move between them, Home and End go to the first and last, and each
 * shows its panel as it takes focus. Every tab's words are in the page's HTML whether or not the panel is open
 * (docs/build-standards.md, section 9), hidden until asked for.
 *
 * It slides in from the right as the Bag does in Wayne's prototype (WQ49; Figma 04 Animations, Bag 1569:62058 and
 * 1576:62771): from just beyond the window's right edge to its place, with no fade of its own, while the shade fades
 * in behind it; closing is the same backwards. It opens and closes over the short duration with the smooth curve
 * (W78a; Wayne, 25 Nov: the panels take 320 ms, where the prototype's spring ran 667), the panel and the shade
 * alike. With reduced motion on it is just there or not.
 */
export function ProductInfoPanel({ open, tabs, tab, onTab, onClose, label = 'Product information' }: ProductInfoPanelProps) {
  const panel = useRef<HTMLDivElement>(null)
  const tabRow = useRef<HTMLDivElement>(null)
  const shownTab = useRef<HTMLButtonElement>(null)
  const id = useId()
  usePopup({ open, onClose, popup: panel, firstFocus: shownTab })

  const current = tabs.some((one) => one.id === tab) ? tab : tabs[0]?.id

  // W78b (WQ75): where the row of tabs stands when they don't all fit, as each of Figma's phone variants draws it
  // for its tab: at its start (Description, Materials & care), in the middle (Shipping & returns) or at its end
  // (Size Guide). That is the first of the three that shows the chosen tab whole, so any panel's tabs follow it.
  // After the browser has scrolled the row to a tab that took focus, and whenever the panel opens on a tab.
  useLayoutEffect(() => {
    const row = tabRow.current
    const chosen = shownTab.current
    if (!open || !row || !chosen) return
    const room = row.scrollWidth - row.clientWidth
    if (room <= 0) return
    const rowBox = row.getBoundingClientRect()
    const tabBox = chosen.getBoundingClientRect()
    // A tab's place in the row, whatever the row is scrolled to now. The first tab's is the room the row keeps at
    // each end (the panel's own 16px), which a tab shown whole stays inside.
    const placeOf = (box: DOMRect) => box.left - rowBox.left + row.scrollLeft
    const edge = placeOf((row.firstElementChild ?? chosen).getBoundingClientRect())
    const left = placeOf(tabBox)
    const whole = (at: number) => left - at >= edge - 0.5 && left + tabBox.width - at <= row.clientWidth - edge + 0.5
    row.scrollLeft = [0, room / 2, room].find(whole) ?? Math.min(Math.max(left - edge, 0), room)
  }, [open, current])
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.findIndex((one) => one.id === current)
    const to = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: tabs.length - 1 }[event.key]
    if (to === undefined || index === -1) return
    event.preventDefault()
    const next = tabs[(to + tabs.length) % tabs.length]
    if (!next) return
    onTab(next.id)
    event.currentTarget.querySelector<HTMLElement>(`[data-tab="${next.id}"]`)?.focus()
  }

  return (
    <>
      <Overlay open={open} onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        data-theme="light"
        data-shop="info-panel"
        // Shut, it waits just beyond the window's right edge: its own width and the 12px it keeps from the edge.
        // Shown at once on opening, so the tab can take focus straight away; hidden only when the slide out has finished.
        className={`fixed inset-12 z-30 flex flex-col gap-64 overflow-clip rounded-s bg-surface-primary px-16 pt-64 pb-24 duration-short ease-smooth md:left-auto md:w-[calc((100vw_-_var(--grid-margin)_*_2_-_var(--grid-gutter)_*_23)_/_24_*_9_+_var(--grid-gutter)_*_8)] ${open ? 'visible translate-x-0 transition-[translate]' : 'invisible translate-x-[calc(100%_+_var(--spacing-12))] transition-[translate,visibility]'}`}
      >
        {/* The row reaches the panel's edges, and has room above and below, so a tab's focus ring is never cut off. */}
        <div ref={tabRow} role="tablist" aria-label={label} onKeyDown={move} className="-mx-16 -my-12 flex shrink-0 gap-24 overflow-x-auto px-16 py-12 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {tabs.map((one) => (
            <button
              key={one.id}
              ref={one.id === current ? shownTab : undefined}
              type="button"
              role="tab"
              id={`${id}-tab-${one.id}`}
              data-tab={one.id}
              aria-selected={one.id === current}
              aria-controls={`${id}-panel-${one.id}`}
              tabIndex={one.id === current ? 0 : -1}
              onClick={() => onTab(one.id)}
              // The label is as tall as its capitals: the press reaches 8px round it.
              className={`relative shrink-0 text-label-12 whitespace-nowrap transition-colors duration-short ease-smooth after:absolute after:-inset-8 ${one.id === current ? 'text-text-primary' : 'text-text-muted-primary hover:text-text-primary'}`}
            >
              {one.label}
            </button>
          ))}
        </div>
        {tabs.map((one) => (
          <div
            key={one.id}
            role="tabpanel"
            id={`${id}-panel-${one.id}`}
            aria-labelledby={`${id}-tab-${one.id}`}
            hidden={one.id !== current}
            tabIndex={0}
            data-lenis-prevent=""
            // It scrolls by itself when its words are longer than the panel, so it has room of its own all round: a text
            // style is trimmed to its capitals, and what rises above them would be cut off at its very edge. Its focus
            // ring is drawn inside it: it reaches the panel's edges.
            className={`-mx-16 -mt-16 -mb-24 min-h-0 flex-1 overflow-y-auto px-16 pt-16 pb-24 focus-visible:-outline-offset-2 ${one.id === current ? 'flex flex-col' : ''}`}
          >
            {one.content}
          </div>
        ))}
        {/* Its words are its name: "Close". */}
        <button type="button" onClick={onClose} className={`absolute top-12 right-12 ${FRAME_BUTTON}`}>
          <Icon name="close" />
          <FrameButtonLabel>Close</FrameButtonLabel>
        </button>
      </div>
    </>
  )
}
