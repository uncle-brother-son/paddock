'use client'

import { createContext, useContext } from 'react'

/** The panels the header's buttons open. Book is built (W77); Bag and Account come with the buying stage. */
export type FramePanel = 'book' | 'bag' | 'account'

export type FramePanels = {
  /** How many items are in the bag: the number beside "Bag", left out at none. */
  bagCount: number
  /**
   * Opens a panel. True when it opened; false when there is no such panel to open, and whoever asked falls back
   * on its own (Book is a link to /book and lets the click go through).
   */
  open: (panel: FramePanel) => boolean
}

/** With no panels round it (a story of one component, a test): opening one does nothing and says so, and the bag is empty. */
const NO_PANELS: FramePanels = { bagCount: 0, open: () => false }

/** What `FramePanelsHost` (components/frame/FramePanelsHost.tsx) gives everything inside the frame. */
export const FramePanelsContext = createContext<FramePanels>(NO_PANELS)

/**
 * The one place the frame's Book and Bag meet their panels (W73). W77: the Book panel exists, so inside the frame
 * opening `book` opens it over the page and says so. Bag and Account still open nothing; the buying stage fills
 * them in and nothing in the header changes.
 */
export function useFramePanels(): FramePanels {
  return useContext(FramePanelsContext)
}
