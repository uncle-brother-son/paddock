import type { ReactNode } from 'react'

import { readFrame } from '@/lib/frame/read'

import { FrameShell, type FrameVariant } from './FrameShell'

/**
 * The frame with its content read from Sanity (Site settings and Navigation, once for the request). With neither
 * document there it still stands: the logo, the Menu button over an empty menu, a footer with no links.
 * `variant="checkout"` is for the checkout's pages, once that route exists.
 */
export async function Frame({ variant = 'global', children }: { variant?: FrameVariant; children: ReactNode }) {
  const content = await readFrame()
  return (
    <FrameShell variant={variant} content={content}>
      {children}
    </FrameShell>
  )
}
