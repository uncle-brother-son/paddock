import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { expect, userEvent, waitFor } from 'storybook/test'

import { leavePage, PAGE_IN, PAGE_LEAVING, PAGE_OUT, PAGE_OUT_SURFACES, PAGE_SURFACE } from '@/lib/motion/page-transition'
import { DURATION_LONG, EASE_SMOOTH_CSS } from '@/lib/motion/tokens'

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
    // WQ57: its backgrounds come out of it before the browser takes its picture, as the site does just before React
    // changes the page.
    leavePage(leaving)
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

/** A colour as the browser reports it that paints nothing. */
const CLEAR = 'rgba(0, 0, 0, 0)'

/**
 * Press a button (scroll down first to see the page being left where it was). The content of the page being left
 * drifts up and fades to 40%, over its own backgrounds, which stay where they are (WQ57); the new page, solid, slides
 * up from below the window into its place, covering it as it rises (W78a, WQ67: it moves, nothing masks it); the
 * long duration, the smooth curve. The new page starts at its top, with focus on its heading. With reduced motion
 * on, the page is swapped at once. On the site the browser's Back and Forward play the same (WQ68).
 */
export const TwoSamplePages: Story = {
  name: 'Two sample pages',
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole('heading', { level: 1, name: 'Page one' })).toBeVisible()
    const header = canvasElement.querySelector('header') as HTMLElement
    await waitFor(() => expect(header.dataset.theme).toBe('dark'))
    // At rest the page is solid: its own background is the window's, and its first section's surface is its mode's.
    const root = document.documentElement
    const windowColour = getComputedStyle(document.body).backgroundColor
    const pageOne = pageIn(canvasElement)!
    const sectionOne = pageOne.querySelector<HTMLElement>('section[data-theme="dark"]')!
    const surfaceOne = getComputedStyle(sectionOne).backgroundColor
    await expect(windowColour).not.toBe(CLEAR)
    await expect(getComputedStyle(pageOne).backgroundColor).toBe(windowColour)
    await expect([surfaceOne === CLEAR, surfaceOne === windowColour]).toEqual([false, false])
    const placeOne = { width: sectionOne.offsetWidth, height: sectionOne.offsetHeight }
    window.scrollTo(0, 400)
    await waitFor(() => expect(Math.round(window.scrollY)).toBe(400))
    await userEvent.click(canvas.getAllByRole('button', { name: 'Go to page two' })[1]!)
    // The page going: its content drifts up a fifth of the window and fades to 40%. The page coming: up from below the window.
    await waitFor(() => expect(animationsOf(NAMES.out).length + animationsOf(NAMES.in).length).toBe(2))
    const [out] = animationsOf(NAMES.out) as [CSSAnimation]
    const [into] = animationsOf(NAMES.in) as [CSSAnimation]
    await expect([out.animationName, out.effect!.getComputedTiming().duration]).toEqual([PAGE_OUT, LONG])
    await expect([into.animationName, into.effect!.getComputedTiming().duration]).toEqual([PAGE_IN, LONG])
    const fifth = `${window.innerHeight / 5}px`
    const smooth = EASE_SMOOTH_CSS
    const outFrames = (out.effect as KeyframeEffect).getKeyframes()
    await expect(outFrames[0]!.easing).toBe(smooth)
    await expect([outFrames.at(-1)!.translate, outFrames.at(-1)!.opacity]).toEqual([`0px -${fifth}`, '0.4'])
    // WQ57: behind its picture, still, are its backgrounds: the page's own, and its dark section's where that stood
    // (the section is the page's first, so at the page's top left). Nothing animates them.
    const still = getComputedStyle(root, `::view-transition-group(${NAMES.out})`)
    await expect(still.backgroundColor).toBe(windowColour)
    await expect(root.style.getPropertyValue(PAGE_OUT_SURFACES)).toBe(`linear-gradient(${surfaceOne}, ${surfaceOne}) 0px 0px / ${placeOne.width}px ${placeOne.height}px no-repeat`)
    await expect(still.backgroundImage).toBe(`linear-gradient(${surfaceOne}, ${surfaceOne})`)
    await expect([still.backgroundPosition, still.backgroundSize, still.backgroundRepeat]).toEqual(['0px 0px', `${placeOne.width}px ${placeOne.height}px`, 'no-repeat'])
    await expect(document.getAnimations().filter((animation) => ((animation.effect as KeyframeEffect | null)?.pseudoElement ?? '').startsWith('::view-transition-group'))).toEqual([])
    // The page coming is solid: its own background, and its first section's surface, neither taken out.
    const pageTwo = pageIn(canvasElement)!
    const sectionTwo = pageTwo.querySelector<HTMLElement>('section[data-theme="fjord"]')!
    await expect([pageTwo.hasAttribute(PAGE_LEAVING), sectionTwo.hasAttribute(PAGE_SURFACE)]).toEqual([false, false])
    await expect(getComputedStyle(pageTwo).backgroundColor).toBe(windowColour)
    await expect([getComputedStyle(sectionTwo).backgroundColor === CLEAR, getComputedStyle(sectionTwo).backgroundColor === surfaceOne]).toEqual([false, false])
    // And the element the pages stand in draws nothing of its own once the page being left has gone.
    await expect(getComputedStyle(canvasElement.querySelector<HTMLElement>('[data-page-stage]')!).backgroundImage).toBe('none')
    const inFrames = (into.effect as KeyframeEffect).getKeyframes()
    await expect(inFrames[0]!.easing).toBe(smooth)
    // WQ67: it starts a whole window down, so just below the window, and moves to its place. Nothing masks it, and it never fades.
    await expect([inFrames[0]!.translate, inFrames.at(-1)!.translate]).toEqual([`0px ${window.innerHeight}px`, '0px'])
    await expect(inFrames.some((frame) => 'opacity' in frame || 'clipPath' in frame)).toBe(false)
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

/**
 * What happens to a page just before it is left (WQ57), with no transition played: its backgrounds are taken out of
 * it, so that the browser's picture of it holds its content only, and are drawn in the same places on the element
 * the pages stand in. Nothing is seen to change: this page looks as it did.
 */
export const BackgroundsTakenOut: Story = {
  name: 'A page about to be left',
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole('heading', { level: 1, name: 'Page one' })).toBeVisible()
    const page = pageIn(canvasElement)!
    const stage = canvasElement.querySelector<HTMLElement>('[data-page-stage]')!
    const dark = page.querySelector<HTMLElement>('section[data-theme="dark"]')!
    const light = page.querySelector<HTMLElement>('section:not([data-theme])')!
    const surface = getComputedStyle(dark).backgroundColor
    await expect(page.parentElement).toBe(stage)
    await expect(getComputedStyle(stage).backgroundImage).toBe('none')
    window.scrollTo(0, 150)
    await waitFor(() => expect(Math.round(window.scrollY)).toBe(150))

    leavePage(page)
    // Out of the page: its own background and its dark section's. A section with no mode had none to take.
    await expect([page.hasAttribute(PAGE_LEAVING), dark.hasAttribute(PAGE_SURFACE), light.hasAttribute(PAGE_SURFACE)]).toEqual([true, true, false])
    await expect([getComputedStyle(page).backgroundColor, getComputedStyle(dark).backgroundColor]).toEqual([CLEAR, CLEAR])
    // And drawn where the section stands, by its place in the page (so wherever the page is scrolled to), on the
    // element the page stands in: as wide and as tall as the section, from the page's top left.
    const layer = `linear-gradient(${surface}, ${surface}) 0px 0px / ${dark.offsetWidth}px ${dark.offsetHeight}px no-repeat`
    await expect(document.documentElement.style.getPropertyValue(PAGE_OUT_SURFACES)).toBe(layer)
    const drawn = getComputedStyle(stage)
    await expect([drawn.backgroundImage, drawn.backgroundPosition, drawn.backgroundSize, drawn.backgroundRepeat]).toEqual([`linear-gradient(${surface}, ${surface})`, '0px 0px', `${dark.offsetWidth}px ${dark.offsetHeight}px`, 'no-repeat'])
    const [stageBox, darkBox] = [stage.getBoundingClientRect(), dark.getBoundingClientRect()]
    await expect([darkBox.left - stageBox.left, darkBox.top - stageBox.top]).toEqual([0, 0])

    // A second call (the page is already about to be left) changes nothing: it does not read the emptied page.
    leavePage(page)
    await expect(document.documentElement.style.getPropertyValue(PAGE_OUT_SURFACES)).toBe(layer)
  },
}
