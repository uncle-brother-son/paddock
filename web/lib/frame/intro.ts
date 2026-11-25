// The intro's start (W73b; WQ20, WQ23): once in a browser session, on whichever page is landed on first.
//
// It is put into the page as a small inline script straight after the intro's element (components/frame/Intro.tsx),
// so the choice is made before the first paint and long before React runs: a visitor who has seen the intro never
// sees a flash of it, and one who hasn't never sees the page first. With no script at all (a search engine, an AI
// tool) the intro is never shown: its element is `display: none` until this says otherwise (the `intro` utility in
// app/globals.css).
//
// The script is written here as text, by hand, and never made from a function with `toString()`. A build may rewrite
// a function's body with helpers of its own that a page does not have: Cloudflare's build (OpenNext, esbuild's
// keepNames) wrapped the two inner functions in `__name(...)`, so on the deployed site the script threw "__name is
// not defined" and the intro never played (found 25 Nov 2026; `next build` alone does not do it). A build leaves text
// alone. So the text uses nothing from outside itself, only plain, old-fashioned JavaScript, and holds no backtick
// and no `${`. lib/frame/intro.test.ts puts it through such a build and runs what comes out.

/** What the browser's session storage remembers once the intro has been shown. The text below spells it out too. */
export const INTRO_SEEN_KEY = 'paddock-intro'

/** The parts of the page's session storage the intro uses. */
type SeenStore = Pick<Storage, 'getItem' | 'setItem'>

type StartIntro = (intro: HTMLElement, reducedMotion: boolean, storage: SeenStore | null) => boolean

/**
 * The start, as text: a function of the intro's element, the visitor's reduced-motion setting and the session's
 * storage, answering whether the intro started.
 *
 * It plays the intro, unless it has been shown in this session or the visitor has reduced motion on (then: no intro).
 * `storage` null, or a storage that refuses (private browsing, blocked cookies): the intro plays once for each page
 * load. A key pressed or a click ends it at once; otherwise it ends when its last transition, the mask, has run: the
 * logo's and the location's own transitions end inside the panel and pass through it, the panel's own is the mask.
 */
export const START_INTRO_TEXT = `function(intro,reducedMotion,storage){
if(reducedMotion)return false;
try{if(storage){if(storage.getItem('paddock-intro'))return false;storage.setItem('paddock-intro','shown')}}catch(refused){}
function end(){intro.setAttribute('data-intro','done');window.removeEventListener('keydown',end,true);window.removeEventListener('pointerdown',end,true);intro.removeEventListener('animationend',maskRun)}
function maskRun(event){if(event.target===intro)end()}
intro.setAttribute('data-intro','play');
window.addEventListener('keydown',end,true);
window.addEventListener('pointerdown',end,true);
intro.addEventListener('animationend',maskRun);
return true}`

/**
 * The inline script: the start, on the element just before the script, with the visitor's reduced-motion setting and
 * the session's storage. Asking for the storage can itself be refused, so that is inside a try as well.
 */
export const INTRO_SCRIPT = `(function(){var storage=null;try{storage=window.sessionStorage}catch(refused){}(${START_INTRO_TEXT})(document.currentScript.previousElementSibling,window.matchMedia('(prefers-reduced-motion: reduce)').matches,storage)})()`

/**
 * The same start as a function, for Storybook's "Play the intro" and the tests: made from the text each time it is
 * called, so there is one copy of the rules and what is tested is what the page runs. The site never calls it (a page
 * runs INTRO_SCRIPT), and nothing on the server may: a Worker refuses to make code from text.
 */
export const startIntro: StartIntro = (intro, reducedMotion, storage) => (new Function(`return ${START_INTRO_TEXT}`)() as StartIntro)(intro, reducedMotion, storage)
