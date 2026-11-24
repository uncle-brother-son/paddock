import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { useState } from 'react'
import { expect, userEvent, waitFor } from 'storybook/test'

import { DURATION_SHORT } from '@/lib/motion/tokens'

import { Overlay, OVERLAY_TEXTURE_ID, OVERLAY_TEXTURE_SCALE, OverlayTexture } from './Overlay'

/** Something to blur: words and blocks of the palette, with a button above the shade to open and close it. */
function OverSomething({ startOpen }: { startOpen: boolean }) {
  const [open, setOpen] = useState(startOpen)
  return (
    <>
      <OverlayTexture />
      <div data-theme="dark" className="flex min-h-screen flex-col gap-40 bg-surface-primary p-32">
        <h1 className="text-h1">The Paddock Wellness Club</h1>
        <p className="max-w-320 text-copy-16">Sauna and contrast therapy in Hebden Bridge. The shade blurs and textures whatever lies beneath it.</p>
        <div className="flex gap-8">
          <div className="h-160 flex-1 bg-mustard" />
          <div className="h-160 flex-1 bg-fjord" />
          <div className="h-160 flex-1 bg-sand-light" />
          <div className="h-160 flex-1 bg-mud" />
        </div>
      </div>
      <Overlay open={open} onClick={() => setOpen(false)} />
      <button type="button" onClick={() => setOpen((now) => !now)} className="fixed right-16 bottom-16 z-30 rounded-s bg-surface-secondary px-32 py-12 text-text-secondary">
        <span className="text-label-12">{open ? 'Close' : 'Open'}</span>
      </button>
    </>
  )
}

const meta = {
  title: 'UI/Overlay',
  component: Overlay,
  parameters: { padded: false, layout: 'fullscreen' },
  args: { open: true },
  render: ({ open }) => <OverSomething startOpen={open} />,
} satisfies Meta<typeof Overlay>

export default meta
type Story = StoryObj<typeof meta>

const layer = (canvasElement: HTMLElement, name: 'shade' | 'grain') => canvasElement.querySelector(`[data-overlay="${name}"]`) as HTMLElement

/**
 * Wayne's Overlay (Figma 136:1054): Object/Light Shade over the page, blurred and textured, the whole window. In
 * Chrome and Edge the texture is a real displacement of the blurred page, as in Figma; in Safari and Firefox it is
 * the blur with fine grain over it. Click the shade (or the button) to see it fade out.
 */
export const Open: Story = {
  play: async ({ canvasElement }) => {
    const shade = layer(canvasElement, 'shade')
    const style = getComputedStyle(shade)
    await expect(shade).toBeVisible()
    await expect([shade.getBoundingClientRect().width, shade.getBoundingClientRect().height]).toEqual([window.innerWidth, window.innerHeight])
    await expect(style.borderRadius).toBe('0px')
    // Object/Light Shade: white at 4%.
    await expect(style.backgroundColor).toMatch(/^(rgba\(255, 255, 255, 0\.04\)|color\(srgb 1 1 1 \/ 0\.04\))$/)
    await expect(style.transitionDuration).toBe(`${DURATION_SHORT}s`)
    await expect(shade.getAttribute('aria-hidden')).toBe('true')
    // This test runs in Chromium: the blur, then the texture filter, and no grain layer.
    await expect(style.backdropFilter).toBe(`blur(12px) url("#${OVERLAY_TEXTURE_ID}")`)
    await expect(getComputedStyle(layer(canvasElement, 'grain')).display).toBe('none')
    // The filter it points at is on the page once, and hidden from a screen reader.
    const filters = document.querySelectorAll(`#${OVERLAY_TEXTURE_ID}`)
    await expect(filters).toHaveLength(1)
    await expect(filters[0]!.closest('svg')?.getAttribute('aria-hidden')).toBe('true')
    await expect(filters[0]!.querySelector('feTurbulence')?.getAttribute('baseFrequency')).toBe('0.5')
    // W73b: the scale measured against Figma's Menu Open.
    await expect(OVERLAY_TEXTURE_SCALE).toBe(20)
    await expect(filters[0]!.querySelector('feDisplacementMap')?.getAttribute('scale')).toBe(String(OVERLAY_TEXTURE_SCALE))
  },
}

/** Closed, it is not there at all: nothing is blurred and a click goes through to the page. */
export const Closed: Story = {
  args: { open: false },
  play: async ({ canvas, canvasElement }) => {
    const shade = layer(canvasElement, 'shade')
    await expect(shade).not.toBeVisible()
    await userEvent.click(canvas.getByRole('button', { name: 'Open' }))
    await waitFor(() => expect(getComputedStyle(shade).opacity).toBe('1'))
    // A click on the shade closes it: it fades, and only then is hidden.
    await userEvent.click(shade)
    await waitFor(() => expect(shade).not.toBeVisible())
    await expect(getComputedStyle(shade).opacity).toBe('0')
  },
}
