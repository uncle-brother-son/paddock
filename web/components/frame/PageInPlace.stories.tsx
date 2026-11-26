import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { ReactLenis, type LenisRef } from 'lenis/react'
import { useState } from 'react'
import { flushSync } from 'react-dom'
import { expect, userEvent, waitFor } from 'storybook/test'

import { arriveInPlace } from '@/lib/motion/page-transition'
import { DURATION_LONG, EASE_SMOOTH } from '@/lib/motion/tokens'

import { PageTransitionView } from './PageTransition'

const PAGES = {
  brown: { title: 'The Paddock T-Shirt, brown', other: 'white' },
  white: { title: 'The Paddock T-Shirt, white', other: 'brown' },
} as const
type PageName = keyof typeof PAGES

/** Lenis as the story now on show runs it, for a play function to note what it is asked for. */
let running: LenisRef | null = null

/**
 * Two sample pages that swap where they stand, as a product's page does for a colour swatch (WQ52): the button says
 * the next page arrives in place, as SiteLink does for a link with `transition={false}`, and swaps the page with no
 * transition. What happens on arriving is the site's own. `smooth` runs Lenis, as the site does for a visitor without
 * reduced motion on (Storybook's own frame runs none).
 */
function SwappedInPlace({ smooth }: { smooth: boolean }) {
  const [page, setPage] = useState<PageName>('brown')
  const { title, other } = PAGES[page]
  const swap = () => {
    arriveInPlace(other)
    flushSync(() => setPage(other))
  }
  return (
    <div className="flex min-h-screen flex-col">
      {smooth ? (
        <ReactLenis
          root
          ref={(lenis) => {
            running = lenis
          }}
        />
      ) : null}
      <PageTransitionView page={page}>
        <main id="main" tabIndex={-1} className="flex flex-1 flex-col outline-none">
          {['Front', 'Back', 'Label', 'Folded', 'Worn'].map((name, index) => (
            <section key={name} className="flex h-320 flex-col items-start justify-end gap-24 p-16">
              {index === 0 ? <h1 className="text-h1">{title}</h1> : <h2 className="text-h2">{name}</h2>}
              <button type="button" onClick={swap} className="rounded-s bg-surface-secondary px-32 py-12 text-text-secondary">
                <span className="text-label-12">In {other}</span>
              </button>
            </section>
          ))}
        </main>
      </PageTransitionView>
    </div>
  )
}

const meta = {
  title: 'Frame/Page swapped in place',
  component: SwappedInPlace,
  parameters: { padded: false, layout: 'fullscreen', nextjs: { appDirectory: true } },
  globals: { viewport: { value: 'desktop', isRotated: false } },
} satisfies Meta<typeof SwappedInPlace>

export default meta
type Story = StoryObj<typeof meta>

const LONG = DURATION_LONG * 1000

/** The window's place at every frame from now until `done` says so, with the time since the first. */
function watchScroll(done: () => boolean): Promise<{ at: number; y: number }[]> {
  return new Promise((resolve) => {
    const seen: { at: number; y: number }[] = []
    const start = performance.now()
    const tick = () => {
      seen.push({ at: performance.now() - start, y: window.scrollY })
      if (done() || performance.now() - start > 3000) resolve(seen)
      else requestAnimationFrame(tick)
    }
    tick()
  })
}

/**
 * WQ52 (as amended again): the new page comes where the old one stood, with the window where it was; the window then
 * scrolls smoothly to the page's top (Lenis, the long duration, the smooth curve), and only once it is there does
 * focus go to the page's heading, the product's name.
 */
export const ScrollsToItsTop: Story = {
  name: 'Scrolls to its top, then focus on the name',
  args: { smooth: true },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('heading', { level: 1, name: 'The Paddock T-Shirt, brown' })).toBeVisible()
    // Lenis is running: it has put its class on the page.
    await waitFor(() => expect(document.documentElement.classList.contains('lenis')).toBe(true))
    window.scrollTo(0, 600)
    await waitFor(() => expect(Math.round(window.scrollY)).toBe(600))
    // What Lenis is asked for from here on is noted: where to, how long for, and by which curve.
    const lenis = running?.lenis
    if (!lenis) throw new Error('Lenis is not running in this story')
    const asked: unknown[][] = []
    const scrollTo = lenis.scrollTo.bind(lenis)
    lenis.scrollTo = (target, options) => {
      asked.push([target, options?.duration, options?.easing])
      scrollTo(target, options)
    }
    await userEvent.click(canvas.getAllByRole('button', { name: 'In white' })[2]!)
    // The new page is there at once, where the window was, and focus has not gone to its name yet.
    const name = canvas.getByRole('heading', { level: 1, name: 'The Paddock T-Shirt, white' })
    await expect(Math.round(window.scrollY)).toBeGreaterThan(500)
    await expect(name).not.toHaveFocus()
    const seen = await watchScroll(() => document.activeElement === name)
    lenis.scrollTo = scrollTo
    // It was asked to go to the top over the long duration with the smooth curve: the curve is held here, by what
    // Lenis was asked, and not by counting frames (a browser running many stories at once draws only a few).
    await expect(asked.at(-1)).toEqual([0, DURATION_LONG, EASE_SMOOTH])
    // It went up all the way, never back down, took about the long duration and not less, and focus came only at the top.
    await expect(name).toHaveFocus()
    await expect(Math.round(window.scrollY)).toBe(0)
    await expect(seen.every((frame, index) => index === 0 || frame.y <= seen[index - 1]!.y + 0.5)).toBe(true)
    await expect(seen.at(-1)!.at).toBeGreaterThan(LONG * 0.8)
  },
}

/**
 * At the page's top already, there is nothing to scroll: focus goes to the name at once.
 */
export const AlreadyAtItsTop: Story = {
  name: 'Already at its top',
  args: { smooth: true },
  play: async ({ canvas }) => {
    await waitFor(() => expect(document.documentElement.classList.contains('lenis')).toBe(true))
    window.scrollTo(0, 0)
    await userEvent.click(canvas.getAllByRole('button', { name: 'In white' })[0]!)
    const name = canvas.getByRole('heading', { level: 1, name: 'The Paddock T-Shirt, white' })
    await waitFor(() => expect(name).toHaveFocus())
    await expect(Math.round(window.scrollY)).toBe(0)
  },
}

/**
 * The visitor takes the scrolling over part-way (a wheel): the scroll to the top is given up, and focus goes to the
 * name there and then, so it is never left nowhere.
 */
export const TakenOverPartWay: Story = {
  name: 'Taken over part-way',
  args: { smooth: true },
  play: async ({ canvas }) => {
    await waitFor(() => expect(document.documentElement.classList.contains('lenis')).toBe(true))
    window.scrollTo(0, 600)
    await waitFor(() => expect(Math.round(window.scrollY)).toBe(600))
    await userEvent.click(canvas.getAllByRole('button', { name: 'In white' })[2]!)
    const name = canvas.getByRole('heading', { level: 1, name: 'The Paddock T-Shirt, white' })
    await expect(name).not.toHaveFocus()
    window.dispatchEvent(new WheelEvent('wheel', { deltaY: 40, bubbles: true }))
    await expect(name).toHaveFocus()
  },
}

/**
 * Reduced motion (Lenis is not running): the new page is at its top at once, with focus on the name.
 */
export const ReducedMotion: Story = {
  name: 'Reduced motion: the jump',
  args: { smooth: false },
  play: async ({ canvas }) => {
    window.scrollTo(0, 600)
    await waitFor(() => expect(Math.round(window.scrollY)).toBe(600))
    await userEvent.click(canvas.getAllByRole('button', { name: 'In white' })[2]!)
    const name = canvas.getByRole('heading', { level: 1, name: 'The Paddock T-Shirt, white' })
    await expect(Math.round(window.scrollY)).toBe(0)
    await expect(name).toHaveFocus()
  },
}
