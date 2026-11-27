import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { expect, waitFor } from 'storybook/test'

import { Header } from '@/components/frame/Header'
import { HeaderLogo } from '@/components/frame/HeaderLogo'
import { SAMPLE_FRAME } from '@/components/frame/sample-content'
import { OverlayTexture } from '@/components/ui/media/Overlay'
import type { SectionTheme } from '@/lib/modules/section'

import { AccordionList } from './content/AccordionList'
import { HeroMedia } from './content/HeroMedia'
import { PageHeader } from './content/PageHeader'
import { SAMPLE_PICTURE } from './content/sample-media'
import { SectionSpacer } from './content/SectionSpacer'
import { SAMPLE_BUTTON, SAMPLE_TEXT } from './content/story-parts'
import { TextBlock } from './content/TextBlock'
import { PageTheme } from './PageTheme'

// W80 (WQ87, Wayne, 27 Nov): when a section in another theme reaches the middle of the window, the whole page (its
// background, its words, the header) fades to that theme over the long duration, and back when it has passed. Here a
// page as Memberships & Passes is: a header, then a run of three modules on one theme, then a module with none.

type StoryArgs = {
  /** The theme of the run of modules in the middle of the page. */
  run: Exclude<SectionTheme, 'light'>
  /** A HeroMedia after the run, which is Dark by itself and takes no part in the fade. */
  hero: boolean
}

const ANSWER = [{ _type: 'block' as const, _key: 'a', style: 'normal' as const, listItem: null, level: null, children: [{ _type: 'span' as const, _key: 's', text: 'An answer.', marks: [] }], markDefs: [] }]

function SamplePage({ run, hero }: StoryArgs) {
  return (
    <>
      <OverlayTexture />
      <Header variant="global" logo={<HeaderLogo animated />} menuLinks={SAMPLE_FRAME.menuLinks} />
      {/* As on the site: the page's own element, which holds main and the footer and has the page's background. */}
      <div data-page-transition="" className="bg-surface-primary">
        <main id="main" data-behind-popups="">
          <PageHeader title="Memberships & Passes" intro={SAMPLE_TEXT} layout="split" buttons={[]} theme={null} sectionId={null} />
          <TextBlock heading="Session Passes" text={SAMPLE_TEXT} button={SAMPLE_BUTTON} align="left" theme={run} sectionId="passes" />
          <AccordionList heading="Session Pass FAQs" padding={false} items={[{ key: 'q', question: 'One', answer: ANSWER }]} theme={run} sectionId={null} />
          <SectionSpacer theme={run} />
          {hero ? <HeroMedia picture={SAMPLE_PICTURE} video={null} button={null} reducedMotion /> : null}
          <TextBlock heading="Book Your Experience today" text={SAMPLE_TEXT} button={SAMPLE_BUTTON} align="center" theme={null} sectionId={null} />
          <PageTheme />
        </main>
        <footer className="h-[600px] p-16">
          <p className="text-copy-14 text-text-primary">The footer</p>
        </footer>
      </div>
    </>
  )
}

const meta = {
  title: 'Frame/Page theme',
  parameters: { padded: false, layout: 'fullscreen', nextjs: { appDirectory: true } },
  args: { run: 'mud', hero: false },
  render: (args) => <SamplePage {...args} />,
  globals: { viewport: { value: 'desktop', isRotated: false } },
} satisfies Meta<StoryArgs>

export default meta
type Story = StoryObj<typeof meta>

const COLOURS = { light: 'rgb(241, 238, 227)', mud: 'rgb(110, 98, 88)', fjord: 'rgb(167, 187, 200)', dark: 'rgb(25, 48, 40)' } as const
const WORDS = { light: 'rgb(34, 34, 34)', mud: 'rgb(255, 255, 255)', fjord: 'rgb(34, 34, 34)', dark: 'rgb(241, 238, 227)' } as const

const parts = (canvasElement: HTMLElement) => ({
  page: canvasElement.querySelector('[data-page-transition]') as HTMLElement,
  header: canvasElement.querySelector('header') as HTMLElement,
  themed: [...canvasElement.querySelectorAll<HTMLElement>('[data-page-themed]')],
  title: canvasElement.querySelector('h1') as HTMLElement,
  last: canvasElement.querySelector('[data-orientation="center"]') as HTMLElement,
  footer: canvasElement.querySelector('footer') as HTMLElement,
  hero: canvasElement.querySelector('[data-module="hero"]') as HTMLElement | null,
})

/** Scrolls the page so the middle of `section` is at the middle of the window, or as near as the page's end allows. */
const bringToMiddle = async (section: HTMLElement) => {
  const box = section.getBoundingClientRect()
  const end = document.documentElement.scrollHeight - window.innerHeight
  const top = Math.min(Math.round(window.scrollY + box.top + box.height / 2 - window.innerHeight / 2), end)
  window.scrollTo(0, top)
  await waitFor(() => expect(Math.round(window.scrollY)).toBe(top))
}

/** The whole page has come to a theme: the page's element says so, and its background and its words are that theme's. */
const pageIs = async (page: HTMLElement, title: HTMLElement, theme: keyof typeof COLOURS) => {
  await waitFor(() => expect(page.dataset.theme).toBe(theme))
  await waitFor(() => expect([getComputedStyle(page).backgroundColor, getComputedStyle(title).color]).toEqual([COLOURS[theme], WORDS[theme]]), { timeout: 3000 })
}

/**
 * The page opens Light: the section at the middle of the window has no theme. Scrolled until the run on Mud reaches
 * the middle, the whole page is Mud: its background, the words of the module above the run, the header. Each module
 * of the run is the same colour as the page, so there is one colour on screen. Scrolled on until the module after
 * the run is at the middle, the page is Light again; and so it is at the footer, and back at the top.
 */
export const FadesToTheSectionAtTheMiddle: Story = {
  name: 'The page fades to the theme of the section at the middle',
  play: async ({ canvasElement }) => {
    const { page, header, themed, title, last, footer } = parts(canvasElement)
    try {
      await waitFor(() => expect(page.getAttribute('data-page-theme')).toBe('live'))
      await pageIs(page, title, 'light')
      await expect(themed.map((section) => section.dataset.theme)).toEqual(['mud', 'mud', 'mud'])
      // While the page is Light, a module of the run that is on screen is Light with it: one colour at a time.
      for (const section of themed) await expect(getComputedStyle(section).backgroundColor).toBe(COLOURS.light)

      await bringToMiddle(themed[0]!)
      await pageIs(page, title, 'mud')
      for (const section of themed) await waitFor(() => expect(getComputedStyle(section).backgroundColor).toBe(COLOURS.mud))
      // The header takes the page's theme, and fades with it.
      await waitFor(() => expect([header.dataset.theme, header.hasAttribute('data-theme-fade')]).toEqual(['mud', true]))
      await waitFor(() => expect(getComputedStyle(header).color).toBe(WORDS.mud), { timeout: 3000 })

      // The run's other modules keep the page on Mud: nothing changes between them.
      await bringToMiddle(themed[1]!)
      await pageIs(page, title, 'mud')

      await bringToMiddle(last)
      await pageIs(page, title, 'light')
      for (const section of themed) await waitFor(() => expect(getComputedStyle(section).backgroundColor).toBe(COLOURS.light))
      await waitFor(() => expect(header.dataset.theme).toBe('light'))

      await bringToMiddle(themed[0]!)
      await pageIs(page, title, 'mud')
      await bringToMiddle(footer)
      await pageIs(page, title, 'light')
    } finally {
      window.scrollTo(0, 0)
    }
  },
}

/**
 * The fade is the theme's own colours moving, over the long duration with the smooth curve: the page's element says
 * which, once it has had its first look (which fades nothing: a page that opens on a themed section is that theme at
 * once). Reduced motion: the site's rule makes every transition instant.
 */
export const OverTheLongDuration: Story = {
  name: 'Over the long duration, never on the first look',
  play: async ({ canvasElement }) => {
    const { page } = parts(canvasElement)
    await waitFor(() => expect(page.getAttribute('data-page-theme')).toBe('live'))
    const style = getComputedStyle(page)
    const fading = style.transitionProperty.split(', ')
    await expect(fading).toContain('--color-surface-primary')
    await expect(fading).toContain('--color-text-primary')
    await expect(fading).toHaveLength(18)
    // The site's own long duration and curve, read from the page: a story never types one in.
    const long = getComputedStyle(document.documentElement).getPropertyValue('--duration-long').trim()
    await expect([...new Set(style.transitionDuration.split(', ').map((seconds) => `${Math.round(parseFloat(seconds) * 1000)}ms`))]).toEqual([long])
    // The first look has no fade to run: it is marked, and that mark has no transition.
    const probe = document.createElement('div')
    probe.setAttribute('data-page-theme', 'first')
    page.append(probe)
    const first = getComputedStyle(probe).transitionProperty
    probe.remove()
    await expect(first).toBe('all')
  },
}

/**
 * Any of the three other themes. And a HeroMedia takes no part: it is a picture with a mode of its own (Dark, for
 * the header and the buttons over it), so with it at the middle of the window the page is Light.
 */
export const FjordAndAHero: Story = {
  name: 'Theme=Fjord; a HeroMedia takes no part',
  args: { run: 'fjord', hero: true },
  play: async ({ canvasElement }) => {
    const { page, themed, title, hero } = parts(canvasElement)
    try {
      await waitFor(() => expect(page.getAttribute('data-page-theme')).toBe('live'))
      await bringToMiddle(themed[0]!)
      await pageIs(page, title, 'fjord')
      await bringToMiddle(hero!)
      await pageIs(page, title, 'light')
      await expect([hero!.dataset.theme, hero!.hasAttribute('data-page-themed')]).toEqual(['dark', false])
    } finally {
      window.scrollTo(0, 0)
    }
  },
}
