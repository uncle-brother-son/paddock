// The intro's start (W73b; WQ20, WQ23): once in a browser session, on whichever page is landed on first.
//
// `startIntro` is put into the page as a small inline script straight after the intro's element
// (components/frame/Intro.tsx), so the choice is made before the first paint and long before React runs: a visitor
// who has seen the intro never sees a flash of it, and one who hasn't never sees the page first. The function is
// written out into the page as text (`INTRO_SCRIPT`), so it uses nothing from outside itself and only plain,
// old-fashioned JavaScript. With no script at all (a search engine, an AI tool) the intro is never shown: its
// element is `display: none` until this says otherwise (the `intro` utility in app/globals.css).

/** What the browser's session storage remembers once the intro has been shown. */
export const INTRO_SEEN_KEY = 'paddock-intro'

/** The parts of the page's session storage the intro uses. */
type SeenStore = Pick<Storage, 'getItem' | 'setItem'>

/**
 * Plays the intro, unless it has been shown in this session or the visitor has reduced motion on (then: no intro).
 * `storage` null, or a storage that refuses (private browsing, blocked cookies): the intro plays once for each page
 * load. A key pressed or a click ends it at once; otherwise it ends when its last transition, the mask, has run.
 * Answers whether it started.
 */
export function startIntro(intro: HTMLElement, reducedMotion: boolean, storage: SeenStore | null): boolean {
  if (reducedMotion) return false
  try {
    if (storage) {
      if (storage.getItem('paddock-intro')) return false
      storage.setItem('paddock-intro', 'shown')
    }
  } catch (refused) {
    void refused
  }
  function end() {
    intro.setAttribute('data-intro', 'done')
    window.removeEventListener('keydown', end, true)
    window.removeEventListener('pointerdown', end, true)
    intro.removeEventListener('animationend', maskRun)
  }
  // The logo's and the location's own transitions end inside the panel and pass through it; the panel's own is the mask.
  function maskRun(event: Event) {
    if (event.target === intro) end()
  }
  intro.setAttribute('data-intro', 'play')
  window.addEventListener('keydown', end, true)
  window.addEventListener('pointerdown', end, true)
  intro.addEventListener('animationend', maskRun)
  return true
}

/**
 * The inline script: `startIntro` on the element just before the script, with the visitor's reduced-motion setting
 * and the session's storage. Asking for the storage can itself be refused, so that is inside a try as well.
 */
export const INTRO_SCRIPT = `(function(){var storage=null;try{storage=window.sessionStorage}catch(refused){}(${startIntro.toString()})(document.currentScript.previousElementSibling,window.matchMedia('(prefers-reduced-motion: reduce)').matches,storage)})()`
