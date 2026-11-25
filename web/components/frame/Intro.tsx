import { Logo } from '@/components/brand/Logo'
import { InlineScript } from '@/components/ui/InlineScript'
import { INTRO_SCRIPT } from '@/lib/frame/intro'

/**
 * The intro's panel alone (Wayne's, Figma 04 Animations: Intro 1 to 3 and the Homepage they land on): Surface/Secondary
 * (Moss) over the whole window, with the original logo and "Hebden Bridge" in Object/Product BG, 40px apart. It is not
 * shown until `data-intro="play"` is set on it (lib/frame/intro.ts), and then runs its three transitions back to back
 * (the `intro` utilities in app/globals.css): the logo fades in at the window's middle; the logo slides up as the
 * location fades in beneath it, the two together now at the middle; the panel is masked away to the top.
 *
 * It is decoration: hidden from screen readers, and the page is whole beneath it from the start. On a phone the logo
 * keeps 64px from each side, as drawn (262 of 390), and the location is Label 10; from 768px they are the logo's own
 * size and Label 12. `data-frame-popup` keeps the header from taking its words' colour from the panel while it is up.
 */
export function IntroPanel() {
  return (
    <div
      aria-hidden="true"
      data-frame-intro=""
      data-frame-popup=""
      // The script below sets `data-intro` before React wakes up: React is told not to mind.
      suppressHydrationWarning
      className="intro fixed inset-0 z-30 items-center justify-center bg-surface-secondary px-64 text-object-product-bg"
    >
      {/* The label's own size is on this element too: the slide is half of the gap plus the label's capital height. */}
      <div className="intro-mark flex flex-col items-center gap-40 text-label-10 md:text-label-12">
        <Logo variant="original" decorative className="intro-logo h-auto max-w-full" />
        <p className="intro-place text-label-10 md:text-label-12">Hebden Bridge</p>
      </div>
    </div>
  )
}

/**
 * The intro (W73b; WQ20, WQ23): once in a browser session, on whichever page is landed on first; never with reduced
 * motion on. The root layout draws it first in the page, so its panel and the script that starts it arrive before
 * anything else and the choice is made before the first paint. The script is an InlineScript: it runs only from the
 * server's HTML, so on a page the browser draws whole (a 404, a page that failed) there is no intro, and the session
 * is not told it was seen: it plays on the next page loaded from the server.
 */
export function Intro() {
  return (
    <>
      <IntroPanel />
      <InlineScript html={INTRO_SCRIPT} />
    </>
  )
}
