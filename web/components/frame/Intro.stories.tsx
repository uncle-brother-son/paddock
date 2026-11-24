import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { useRef } from 'react'
import { expect, userEvent, waitFor } from 'storybook/test'

import { INTRO_SEEN_KEY, startIntro } from '@/lib/frame/intro'
import { DURATION_LONG } from '@/lib/motion/tokens'

import { IntroPanel } from './Intro'
import { SamplePage } from './sample-content'

type StoryArgs = { reducedMotion: boolean }

/**
 * The intro's panel over a sample page, with a button to play it. On the site a small script starts it before the
 * first paint, once in a browser session; here the same function is called by the button, as often as it is pressed.
 */
function IntroOverAPage({ reducedMotion }: StoryArgs) {
  const holder = useRef<HTMLDivElement>(null)
  const play = () => {
    const panel = holder.current?.querySelector<HTMLElement>('[data-frame-intro]')
    if (panel) startIntro(panel, reducedMotion, null)
  }
  return (
    <div ref={holder}>
      <SamplePage />
      <IntroPanel />
      <button type="button" onClick={play} className="fixed right-16 bottom-16 z-40 rounded-s bg-surface-secondary px-32 py-12 text-text-secondary">
        <span className="text-label-12">Play the intro</span>
      </button>
    </div>
  )
}

const meta = {
  title: 'Frame/Intro',
  parameters: { padded: false, layout: 'fullscreen' },
  args: { reducedMotion: false },
  render: (args) => <IntroOverAPage {...args} />,
} satisfies Meta<StoryArgs>

export default meta
type Story = StoryObj<typeof meta>

const panelIn = (canvasElement: HTMLElement) => canvasElement.querySelector('[data-frame-intro]') as HTMLElement

const parts = (panel: HTMLElement) => ({
  mark: panel.querySelector('.intro-mark') as HTMLElement,
  logo: panel.querySelector('.intro-logo') as SVGElement,
  place: panel.querySelector('.intro-place') as HTMLElement,
})

const middleOf = (element: Element) => {
  const box = element.getBoundingClientRect()
  return box.top + box.height / 2
}

/** The intro's animations, each held at one moment of the whole run (milliseconds from its start). */
const holdAt = (panel: HTMLElement, milliseconds: number) => {
  for (const animation of panel.getAnimations({ subtree: true })) {
    animation.pause()
    animation.currentTime = milliseconds
  }
}

/** Lets the held animations run on from where they are. */
const letRun = (panel: HTMLElement) => {
  // eslint-disable-next-line storybook/context-in-play-function -- this is a browser animation's own play(), not another story's play function.
  for (const animation of panel.getAnimations({ subtree: true })) animation.play()
}

const LONG = DURATION_LONG * 1000

/**
 * Wayne's intro (Figma 04 Animations, Intro 1 to 3): press "Play the intro". On Moss, the logo fades in at the middle
 * of the window; it slides up as "Hebden Bridge" fades in beneath it; the panel is masked away to the top. Three
 * transitions of the long duration, back to back, with the smooth curve. A key or a click ends it at once.
 */
export const PlayIt: Story = {
  name: 'Play it',
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    const panel = panelIn(canvasElement)
    const { mark, logo, place } = parts(panel)
    // Not there at all until it is started: decoration, hidden from a screen reader.
    await expect(getComputedStyle(panel).display).toBe('none')
    await expect(panel.getAttribute('aria-hidden')).toBe('true')
    await userEvent.click(canvas.getByRole('button', { name: 'Play the intro' }))
    await expect(panel.dataset.intro).toBe('play')
    const box = panel.getBoundingClientRect()
    await expect([box.left, box.top, box.width, box.height]).toEqual([0, 0, window.innerWidth, window.innerHeight])
    // Surface/Secondary (Moss), with the logo and the location in Object/Product BG (Sand).
    await expect([getComputedStyle(panel).backgroundColor, getComputedStyle(place).color]).toEqual(['rgb(25, 48, 40)', 'rgb(214, 210, 194)'])
    // Three transitions, each the long duration, one after another with no pause: the logo, the rise with the location, the mask.
    const timings = panel
      .getAnimations({ subtree: true })
      .map((animation) => {
        const timing = animation.effect!.getComputedTiming()
        return `${(animation as CSSAnimation).animationName} ${timing.delay} ${timing.duration}`
      })
      .sort()
    await expect(timings).toEqual([`intro-fade 0 ${LONG}`, `intro-fade ${LONG} ${LONG}`, `intro-mask ${LONG * 2} ${LONG}`, `intro-rise ${LONG} ${LONG}`])
    const windowMiddle = window.innerHeight / 2
    // 1: the logo, alone, at the middle of the window (its own size: 292 by 81).
    holdAt(panel, LONG)
    await expect(Math.abs(middleOf(logo) - windowMiddle)).toBeLessThan(1)
    await expect([Math.round(logo.getBoundingClientRect().width), getComputedStyle(logo).opacity, getComputedStyle(place).opacity]).toEqual([292, '1', '0'])
    // 2: the logo has slid up and the location is in, 40px beneath it: the two together at the middle.
    holdAt(panel, LONG * 2)
    await expect(Math.abs(middleOf(mark) - windowMiddle)).toBeLessThan(1)
    await expect(Math.round(place.getBoundingClientRect().top - logo.getBoundingClientRect().bottom)).toBe(40)
    await expect(getComputedStyle(place).opacity).toBe('1')
    await expect(getComputedStyle(panel).clipPath).toBe('inset(0px 0px 0%)')
    // 3: masked away to the top, and then it is gone.
    holdAt(panel, LONG * 2.5)
    await expect(getComputedStyle(panel).clipPath).toMatch(/^inset\(0px 0px \d+(\.\d+)?%\)$/)
    letRun(panel)
    await waitFor(() => expect(panel.dataset.intro).toBe('done'), { timeout: 3000 })
    await expect(getComputedStyle(panel).display).toBe('none')
  },
}

/** Tests only: a key pressed while it plays ends it at once, and so does a click. */
export const EndedAtOnce: Story = {
  name: 'Ended at once by a key or a click',
  tags: ['!dev'],
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    const panel = panelIn(canvasElement)
    const play = canvas.getByRole('button', { name: 'Play the intro' })
    await userEvent.click(play)
    await expect(panel.dataset.intro).toBe('play')
    await userEvent.keyboard('{Shift}')
    await expect(panel.dataset.intro).toBe('done')
    await expect(getComputedStyle(panel).display).toBe('none')
    await userEvent.click(play)
    await expect(panel.dataset.intro).toBe('play')
    await userEvent.pointer({ keys: '[MouseLeft>]', target: panel })
    await expect(panel.dataset.intro).toBe('done')
  },
}

/** Reduced motion: there is no intro. Press "Play the intro" and nothing shows. */
export const ReducedMotion: Story = {
  name: 'Reduced motion',
  args: { reducedMotion: true },
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    const panel = panelIn(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Play the intro' }))
    await expect(panel.hasAttribute('data-intro')).toBe(false)
    await expect(getComputedStyle(panel).display).toBe('none')
  },
}

/** On a phone the logo keeps 64px from each side (262 of Figma's 390) and the location is Label 10. */
export const OnAPhone: Story = {
  name: 'On a phone',
  globals: { viewport: { value: 'mobile', isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    const panel = panelIn(canvasElement)
    const { logo, place } = parts(panel)
    await userEvent.click(canvas.getByRole('button', { name: 'Play the intro' }))
    holdAt(panel, LONG * 2)
    const box = logo.getBoundingClientRect()
    await expect([Math.round(box.left), Math.round(box.width)]).toEqual([64, 262])
    await expect(getComputedStyle(place).fontSize).toBe('10px')
    await expect(Math.round(place.getBoundingClientRect().top - box.bottom)).toBe(40)
    for (const animation of panel.getAnimations({ subtree: true })) animation.finish()
    await waitFor(() => expect(panel.dataset.intro).toBe('done'))
  },
}

/** Tests only: once in a browser session. What the session remembers stops a second showing; a session that can't remember shows it each time. */
export const OnceASession: Story = {
  name: 'Once a session',
  tags: ['!dev'],
  play: async ({ canvasElement }) => {
    const panel = panelIn(canvasElement)
    const remembered = new Map<string, string>()
    const session = { getItem: (key: string) => remembered.get(key) ?? null, setItem: (key: string, value: string) => void remembered.set(key, value) }
    await expect(startIntro(panel, false, session)).toBe(true)
    await expect(remembered.get(INTRO_SEEN_KEY)).toBe('shown')
    panel.removeAttribute('data-intro')
    await expect(startIntro(panel, false, session)).toBe(false)
    await expect(panel.hasAttribute('data-intro')).toBe(false)
    // A browser that refuses to remember: shown each time.
    const refusing = {
      getItem: (): string | null => {
        throw new DOMException('refused', 'SecurityError')
      },
      setItem: () => undefined,
    }
    await expect(startIntro(panel, false, refusing)).toBe(true)
    await userEvent.keyboard('{Shift}')
    await expect(panel.dataset.intro).toBe('done')
    await expect(startIntro(panel, false, refusing)).toBe(true)
    await userEvent.keyboard('{Shift}')
  },
}
