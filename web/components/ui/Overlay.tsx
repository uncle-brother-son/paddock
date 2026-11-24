/** The id the stylesheet's `overlay-shade` points its backdrop filter at (app/globals.css). One per page. */
export const OVERLAY_TEXTURE_ID = 'overlay-texture'

/**
 * The Overlay's texture as an SVG filter (Figma's Texture effect: noise size 2, radius 8): fine noise that pushes
 * each pixel of the blurred page up to 8px about. Drawn once, by the root layout; it takes no room and a screen
 * reader never meets it. Only Chromium can use a filter like this on what lies behind an element; other browsers
 * get the grain layer below instead.
 */
export function OverlayTexture() {
  return (
    <svg aria-hidden="true" focusable="false" width="0" height="0" className="absolute">
      <filter id={OVERLAY_TEXTURE_ID} x="0" y="0" width="100%" height="100%">
        <feTurbulence type="fractalNoise" baseFrequency="0.5" numOctaves="1" seed="2" result="noise" />
        <feDisplacementMap in="SourceGraphic" in2="noise" scale="16" xChannelSelector="R" yChannelSelector="G" />
      </filter>
    </svg>
  )
}

type OverlayProps = {
  open: boolean
  /** A click on the shade: a popup closes itself with it. */
  onClick?: () => void
}

/**
 * Wayne's Overlay (Figma "Overlay", 136:1054 on 06 System): the shade over the page behind a popup. The menu uses
 * it, and the Book, Bag and Sign-in panels will. The whole window, no corners: Object/Light Shade over the page
 * blurred (Figma's 24 background blur is CSS's 12px) and textured. It fades in and out over the short duration with
 * the smooth curve, as prototyped; with reduced motion on it is just there or not.
 *
 * Two layers, because the texture has two ways of being drawn (the `overlay-shade` and `overlay-grain` utilities
 * in app/globals.css). Chromium displaces the blurred page with OverlayTexture, as Figma does, and has no grain
 * layer. Safari and Firefox can't, so they get the blur and the fill with fine grain blended over them. The grain is
 * a layer of its own, not a `::before`: the shade is a layer apart from the page, and nothing inside it can blend
 * with the page behind (measured: inside, the same grain greys the picture; beside, it matches Figma's colour).
 *
 * Popups sit above it (z-30); it sits above the header (z-20).
 */
export function Overlay({ open, onClick }: OverlayProps) {
  // Shown at once on opening; hidden only when the fade out has finished.
  const state = open ? 'visible opacity-100 transition-opacity' : 'invisible opacity-0 transition-[opacity,visibility]'
  return (
    <>
      <div aria-hidden="true" data-overlay="shade" data-frame-popup="" onClick={onClick} className={`overlay-shade fixed inset-0 z-20 duration-short ease-smooth ${state}`} />
      <div aria-hidden="true" data-overlay="grain" data-frame-popup="" className={`overlay-grain fixed inset-0 z-20 duration-short ease-smooth ${state}`} />
    </>
  )
}
