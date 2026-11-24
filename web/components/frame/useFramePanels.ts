'use client'

/** The panels the header's buttons open. They are built in the buying stage. */
export type FramePanel = 'book' | 'bag' | 'account'

export type FramePanels = {
  /** How many items are in the bag: the number beside "Bag", left out at none. */
  bagCount: number
  open: (panel: FramePanel) => void
}

/**
 * The one place the frame's Book, Bag and Account buttons meet their panels (W73). The panels don't exist yet, so
 * opening one does nothing and the bag is empty; the buying stage fills this in and nothing in the header changes.
 */
export function useFramePanels(): FramePanels {
  return {
    bagCount: 0,
    open: (panel) => {
      void panel
    },
  }
}
