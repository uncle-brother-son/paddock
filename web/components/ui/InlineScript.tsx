'use client'

/**
 * A script written into the page's HTML, which the browser runs as it reads the page: before the first paint, and
 * long before Next's own code has arrived. It is Next 16's way for this (its guide "How to prevent flash before
 * hydration", node_modules/next/dist/docs/01-app/02-guides/preventing-flash-before-hydration.md): put it straight
 * after the element it works on.
 *
 * From the server its type is JavaScript, so it runs. Whenever React draws it in the browser its type is plain text,
 * which no browser runs: a script React makes there never runs anyway, and React warns in development about one that
 * looks as if it should ("Encountered a script tag while rendering React component"). The browser draws the whole
 * page itself on a 404, on a page that failed, and after a failed hydration. When React takes over the server's page
 * it leaves the type it finds (`suppressHydrationWarning`).
 *
 * Not next/script's "beforeInteractive": Next's own code runs that one, after the page has been painted (measured on
 * the deployed site, 25 Nov 2026: 145 ms after the first paint on fast 4G, 1.3 s after on slow 4G).
 *
 * `html` is the script's text, written by hand: never a function's `toString()` (lib/frame/intro.ts says why).
 */
export function InlineScript({ html }: { html: string }) {
  return <script type={typeof window === 'undefined' ? 'text/javascript' : 'text/plain'} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: html }} />
}
