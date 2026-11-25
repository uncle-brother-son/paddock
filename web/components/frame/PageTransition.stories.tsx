import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { expect, userEvent, waitFor } from 'storybook/test'

import { PAGE_IN, PAGE_OUT } from '@/lib/motion/page-transition'
import { DURATION_LONG, EASE_SMOOTH_CSS, linearEasingPoints } from '@/lib/motion/tokens'

import { Header } from './Header'
import { HeaderLogo } from './HeaderLogo'
import { PageTransitionView } from './PageTransition'
import { SAMPLE_FRAME } from './sample-content'

const PAGES = {
  one: { title: 'Page one', theme: 'dark', other: 'two' },
  two: { title: 'Page two', theme: 'fjord', other: 'one' },
} as const
type PageName = keyof typeof PAGES

/** The names this story gives the two pages while one gives way to the other. */
const NAMES = { out: 'story-page-out', in: 'story-page-in' }

const pageIn = (holder: HTMLElement | null) => holder?.querySelector<HTMLElement>('[data-page-transition]') ?? null

/**
 * Two sample pages and a button on each to go to the other. On the site React starts the transition when a link's
 * navigation lands; the React that Storybook runs can't yet, so this does by hand what React does there: it names
 * the page going and the page coming, gives them the two classes, and asks the browser for a view transition. The
 * movement is the site's own (the `page-out` and `page-in` rules in app/globals.css), and so is what happens on
 * arriving: the new page from its top, focus on its heading.
 */
function TwoPages() {
  const holder = useRef<HTMLDivElement>(null)
  const [page, setPage] = useState<PageName>('one')

  const go = (next: PageName) => {
    const swap = () => flushSync(() => setPage(next))
    const leaving = pageIn(holder.current)
    if (!leaving || !document.startViewTransition) return swap()
    const root = document.documentElement
    leaving.style.viewTransitionName = NAMES.out
    leaving.style.setProperty('view-transition-class', PAGE_OUT)
    root.style.viewTransitionName = 'none'
    const transition = document.startViewTransition(() => {
      swap()
      const arriving = pageIn(holder.current)
      if (!arriving) return
      arriving.style.viewTransitionName = NAMES.in
      arriving.style.setProperty('view-transition-class', PAGE_IN)
    })
    void transition.finished.finally(() => {
      root.style.viewTransitionName = ''
      const arrived = pageIn(holder.current)
      arrived?.style.removeProperty('view-transition-name')
      arrived?.style.removeProperty('view-transition-class')
    })
  }

  const { title, theme, other } = PAGES[page]
  return (
    <div ref={holder} className="flex min-h-screen flex-col">
      {/* The site's header, which stays where it is while the page beneath it changes. */}
      <Header variant="global" logo={<HeaderLogo animated />} menuLinks={SAMPLE_FRAME.menuLinks} />
      <PageTransitionView page={page}>
        <main id="main" tabIndex={-1} className="flex flex-1 flex-col outline-none">
          <section data-theme={theme} className="flex h-320 flex-col items-start justify-end gap-24 bg-surface-primary p-16">
            <h1 className="text-h1">{title}</h1>
            <button type="button" onClick={() => go(other)} className="rounded-s bg-surface-secondary px-32 py-12 text-text-secondary">
              <span className="text-label-12">Go to {PAGES[other].title.toLowerCase()}</span>
            </button>
          </section>
          {['Sauna', 'Cold plunge', 'Rest', 'Smoothies'].map((name) => (
            <section key={name} className="flex h-320 flex-col items-start justify-end gap-24 p-16">
              <h2 className="text-h2">
                {name}, on {title.toLowerCase()}
              </h2>
              <button type="button" onClick={() => go(other)} className="rounded-s bg-surface-secondary px-32 py-12 text-text-secondary">
                <span className="text-label-12">Go to {PAGES[other].title.toLowerCase()}</span>
              </button>
            </section>
          ))}
        </main>
      </PageTransitionView>
    </div>
  )
}

const meta = {
  title: 'Frame/Page transition',
  parameters: { padded: false, layout: 'fullscreen', nextjs: { appDirectory: true } },
  render: () => <TwoPages />,
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

/** The view transition's own animations of one page, by the name this story gave it. */
const animationsOf = (name: string) =>
  document.getAnimations().filter((animation) => {
    const pseudo = (animation.effect as KeyframeEffect | null)?.pseudoElement ?? ''
    return pseudo.startsWith('::view-transition') && pseudo.includes(`(${name})`)
  })

const LONG = DURATION_LONG * 1000

/**
 * Press a button (scroll down first to see the page being left where it was). The page being left drifts down
 * without fading (WQ54), and the new page is uncovered over it from the top of the window downwards, settling into
 * place; the long duration, the smooth curve. The new page starts at its top, with focus on its heading. With
 * reduced motion on, the page is swapped at once.
 */
export const TwoSamplePages: Story = {
  name: 'Two sample pages',
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole('heading', { level: 1, name: 'Page one' })).toBeVisible()
    const header = canvasElement.querySelector('header') as HTMLElement
    await waitFor(() => expect(header.dataset.theme).toBe('dark'))
    window.scrollTo(0, 400)
    await waitFor(() => expect(Math.round(window.scrollY)).toBe(400))
    await userEvent.click(canvas.getAllByRole('button', { name: 'Go to page two' })[1]!)
    // The page going: it drifts down a fifth of the window, as solid as it was. The page coming: uncovered over it from the top.
    await waitFor(() => expect(animationsOf(NAMES.out).length + animationsOf(NAMES.in).length).toBe(2))
    const [out] = animationsOf(NAMES.out) as [CSSAnimation]
    const [into] = animationsOf(NAMES.in) as [CSSAnimation]
    await expect([out.animationName, out.effect!.getComputedTiming().duration]).toEqual([PAGE_OUT, LONG])
    await expect([into.animationName, into.effect!.getComputedTiming().duration]).toEqual([PAGE_IN, LONG])
    const fifth = `${window.innerHeight / 5}px`
    const smooth = linearEasingPoints(EASE_SMOOTH_CSS)
    const outFrames = (out.effect as KeyframeEffect).getKeyframes()
    await expect(linearEasingPoints(outFrames[0]!.easing)).toEqual(smooth)
    await expect(outFrames.at(-1)!.translate).toBe(`0px ${fifth}`)
    // WQ54: it does not fade. No keyframe of it names an opacity, and it is as solid mid-way as at rest.
    await expect(outFrames.some((frame) => 'opacity' in frame)).toBe(false)
    await expect(getComputedStyle(document.documentElement, `::view-transition-old(${NAMES.out})`).opacity).toBe('1')
    const inFrames = (into.effect as KeyframeEffect).getKeyframes()
    await expect(linearEasingPoints(inFrames[0]!.easing)).toEqual(smooth)
    await expect([inFrames[0]!.translate, inFrames[0]!.clipPath]).toEqual([`0px -${fifth}`, 'polygon(0px 0px, 100% 0px, 100% 0px, 0px 0px)'])
    await expect(inFrames.some((frame) => 'opacity' in frame)).toBe(false)
    await expect(inFrames.at(-1)!.clipPath).toBe(`polygon(0px 0px, 100% 0px, 100% ${window.innerHeight}px, 0px ${window.innerHeight}px)`)
    // The header is a layer of its own above the two pages, and takes the new page's mode while they are still
    // moving: nothing on the page can be found by its place on screen then, so it goes by the page's sections.
    await expect(getComputedStyle(header).viewTransitionName).toBe('frame-header')
    await waitFor(() => expect(header.dataset.theme).toBe('fjord'))
    await expect(animationsOf(NAMES.in)).toHaveLength(1)
    // On arriving: the new page, from its top, with focus on its heading.
    const heading = await canvas.findByRole('heading', { level: 1, name: 'Page two' })
    await expect(Math.round(window.scrollY)).toBe(0)
    await expect(heading).toHaveFocus()
    await waitFor(() => expect(animationsOf(NAMES.in)).toHaveLength(0), { timeout: 3000 })
    await expect(canvas.queryByRole('heading', { level: 1, name: 'Page one' })).toBeNull()
  },
}
