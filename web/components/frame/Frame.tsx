import type { ReactNode } from 'react'

import { readBookAddOns } from '@/lib/book/read'
import { readFrame } from '@/lib/frame/read'

import { FrameShell, type FrameVariant } from './FrameShell'

/**
 * The frame with its content read from Sanity (Site settings and Navigation, once for the request). With neither
 * document there it still stands: the logo, the Menu button over an empty menu, a footer with no links.
 * `variant="checkout"` is for the checkout's pages, once that route exists. W77: the Book panel's add-ons are read with
 * it (the panel opens over every page), and without them the frame stands just the same.
 */
export async function Frame({ variant = 'global', children }: { variant?: FrameVariant; children: ReactNode }) {
  const [content, bookAddOns] = await Promise.all([readFrame(), readBookAddOns()])
  return (
    <FrameShell variant={variant} content={content} bookAddOns={bookAddOns}>
      {children}
    </FrameShell>
  )
}
