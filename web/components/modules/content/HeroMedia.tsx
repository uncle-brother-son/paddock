'use client'

import { useEffect, useRef, useState, type FocusEvent, type PointerEvent, type ReactNode } from 'react'

import { ButtonLabel } from '@/components/ui/buttons/Button'
import { IconButton } from '@/components/ui/buttons/IconButton'
import { SiteLink } from '@/components/ui/SiteLink'
import type { HeroMediaButton, HeroMediaContent, HeroMediaPicture } from '@/lib/modules/hero-media'
import type { SectionTheme } from '@/lib/modules/section'
import { usePrefersReducedMotion } from '@/lib/motion/reduced-motion'
import type { ScreenVideo } from '@/lib/sanity/media'

const clamp = (value: number, least: number, most: number): number => Math.min(Math.max(value, least), most)

/**
 * The hero's picture, across the whole hero: the tall cut on a phone, the wide one from 768px. The browser picks
 * before it fetches, so a screen downloads only its own cut (for a video with a poster for phones, only its own
 * poster). The first hero of a page is its largest picture, so it loads at once and ahead of the rest (`priority`);
 * any other waits until it is near.
 */
function HeroMediaImage({
  picture,
  alt,
  priority,
  desktopSizes = '100vw',
  mobileSizes = '100vw',
}: {
  picture: HeroMediaPicture
  alt: string
  priority: boolean
  desktopSizes?: string
  mobileSizes?: string
}) {
  return (
    <picture>
      <source media="(width >= 48rem)" srcSet={picture.desktop.srcSet} sizes={desktopSizes} width={picture.desktop.width} height={picture.desktop.height} />
      {/* A plain <img>: Next's image optimiser does not run on Workers. The address is Sanity's CDN, sized in lib/sanity/image.ts. */}
      <img
        src={picture.mobile.src}
        srcSet={picture.mobile.srcSet}
        sizes={mobileSizes}
        width={picture.mobile.width}
        height={picture.mobile.height}
        alt={alt}
        loading={priority ? 'eager' : 'lazy'}
        fetchPriority={priority ? 'high' : 'auto'}
        decoding="async"
        className="absolute inset-0 size-full object-cover"
      />
    </picture>
  )
}

/** The widths of screen one of a video's files is for: every width, or one of the two when the film has a file for phones. */
type Screens = 'both' | 'mobile' | 'desktop'
const ON_SCREENS: Record<Screens, string> = { both: '', mobile: 'md:hidden', desktop: 'hidden md:block' }

/**
 * One file of a hero's video, with its buttons (WQ15, WQ18; docs/build-standards.md, Video): muted, looped and
 * inline, over the poster that is in the page from the start, and seen once it shows a frame. It plays only while
 * it is on screen, and loads nothing until then: a file for the other width of screen is never on screen, so it is
 * never fetched (WQ35). With reduced motion on it never starts by itself: the poster stays, with Play.
 *
 * Pause is always there. The sound button is there only when the editor says the video has sound (W73b, Wayne).
 * Both show what a press will do, as Figma draws them for a video that is playing with its sound off: the speaker
 * and Pause. Each is Figma's "IconButton", Style=image (components/ui/buttons/IconButton.tsx): on Text/Muted Primary, and on
 * Text/Primary under a mouse.
 */
function HeroMediaVideoPlayer({ url, video, screens, reducedMotion, onStarted }: { url: string; video: ScreenVideo; screens: Screens; reducedMotion: boolean; onStarted: () => void }) {
  const player = useRef<HTMLVideoElement>(null)
  const [playing, setPlaying] = useState(false)
  const [started, setStarted] = useState(false)
  const [muted, setMuted] = useState(true)
  // What the visitor last asked for with the button. Until they press it, the video plays unless motion is reduced.
  const [asked, setAsked] = useState<'play' | 'pause' | null>(null)
  const wanted = asked ?? (reducedMotion ? 'pause' : 'play')

  // React leaves `muted` out of the page's HTML, so the element is told here, before anything asks it to play.
  useEffect(() => {
    if (player.current) player.current.muted = muted
  }, [muted])

  useEffect(() => {
    const element = player.current
    if (!element) return
    if (wanted === 'pause') {
      element.pause()
      return
    }
    const observer = new IntersectionObserver((entries) => {
      const onScreen = entries[entries.length - 1]?.isIntersecting ?? false
      // A browser that refuses to start it (a data saver, autoplay switched off) leaves the poster and Play.
      if (onScreen) element.play().catch(() => undefined)
      else element.pause()
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [wanted])

  const togglePlay = () => {
    const element = player.current
    if (!element) return
    if (element.paused) {
      setAsked('play')
      element.play().catch(() => undefined)
    } else {
      setAsked('pause')
    }
  }

  return (
    <div data-hero-video={screens} className={`absolute inset-0 ${ON_SCREENS[screens]}`}>
      <video
        ref={player}
        src={url}
        muted={muted}
        loop
        playsInline
        preload="none"
        {...(video.captionsUrl ? { crossOrigin: 'anonymous' as const } : {})}
        {...(started ? { 'aria-label': video.description } : { 'aria-hidden': true })}
        onPlaying={() => {
          setPlaying(true)
          setStarted(true)
          onStarted()
        }}
        onPause={() => setPlaying(false)}
        className={`absolute inset-0 size-full object-cover ${started ? '' : 'invisible'}`}
      >
        {video.captionsUrl ? <track kind="captions" src={video.captionsUrl} srcLang="en" label="English" default /> : null}
      </video>
      <div data-hero-controls="" className="absolute right-16 bottom-16 z-20 flex items-center gap-8">
        {video.hasSound ? (
          <IconButton look="image" label={muted ? 'Unmute video' : 'Mute video'} icon={muted ? 'audio-on' : 'audio-off'} onClick={() => setMuted((now) => !now)} />
        ) : null}
        <IconButton look="image" label={playing ? 'Pause video' : 'Play video'} icon={playing ? 'pause' : 'play'} onClick={togglePlay} />
      </div>
    </div>
  )
}

/**
 * The hero's media: its picture, and over it its video when it is one. A film with a file for phones (WQ35) has
 * two players, one for each width of screen, each hidden on the other and so never fetched there; they share the
 * film's description, captions and sound. A film with one file has one player for every screen.
 *
 * W74: a product's gallery draws its pictures and videos with this too (components/shop/ProductGallery.tsx), in a
 * box of its own shape. `desktopSizes`: how wide the picture is drawn from 768px, where it is not the whole window.
 * `mobileSizes`: the same below 768px (a GalleryCarousel's panorama is wider than the window there, WQ89).
 */
export function HeroMediaFill({
  picture,
  video,
  priority,
  reducedMotion,
  desktopSizes,
  mobileSizes,
}: {
  picture: HeroMediaPicture
  video: ScreenVideo | null
  priority: boolean
  reducedMotion: boolean
  desktopSizes?: string
  mobileSizes?: string
}) {
  // Once the video shows, it is the video that is described to a screen reader, not the picture beneath it.
  const [started, setStarted] = useState(false)
  const player = (url: string, screens: Screens) =>
    video ? <HeroMediaVideoPlayer url={url} video={video} screens={screens} reducedMotion={reducedMotion} onStarted={() => setStarted(true)} /> : null
  return (
    <>
      <HeroMediaImage picture={picture} alt={started ? '' : picture.alt} priority={priority} {...(desktopSizes ? { desktopSizes } : {})} {...(mobileSizes ? { mobileSizes } : {})} />
      {video?.phoneUrl ? (
        <>
          {player(video.phoneUrl, 'mobile')}
          {player(video.url, 'desktop')}
        </>
      ) : video ? (
        player(video.url, 'both')
      ) : null}
    </>
  )
}

/** Figma's Button on the hero (1213:29162): the small primary Button with 12px all round. */
function HeroMediaButtonLink({ button, onFocus, onBlur }: { button: HeroMediaButton; onFocus: (event: FocusEvent<HTMLAnchorElement>) => void; onBlur: () => void }) {
  return (
    // A button to the booking panel asks for the panel first, as every link to /book does (SiteLink).
    <SiteLink href={button.href} onFocus={onFocus} onBlur={onBlur} className="inline-flex items-center justify-center rounded-s bg-surface-secondary p-12 text-text-secondary">
      <ButtonLabel>{button.text}</ButtonLabel>
    </SiteLink>
  )
}

type HeroMediaProps = HeroMediaContent & {
  /**
   * W80 (WQ81): the mode of the hero's section, for the header over it and the buttons on it. Dark unless an editor
   * chose another, as it is designed. It is the hero's own: the page does not fade to it (WQ87).
   */
  theme?: SectionTheme | null
  /** W80 (WQ83): the section's id, when an editor gave it one. */
  sectionId?: string | null
  /** The page's first hero: its picture is the page's largest, so it loads first. */
  priority?: boolean
  /** For Storybook and tests: reduced motion on or off, whatever the visitor's own setting. */
  reducedMotion?: boolean
  /** For Storybook and tests: as on a touch screen (the button always at its resting place), whatever this device has. */
  touch?: boolean
  /** The page's heading, when the hero is the page's first section and holds it (components/modules/PageModules.tsx). */
  children?: ReactNode
}

/**
 * HeroMedia module (W73b; Figma "HeroMedia", 1213:29172): a picture or a video across the whole window, 16 by 9 on a
 * desktop and 9 by 16 on a phone, in the Dark mode, so the header over it has light words. A picture is one file,
 * cut for each screen round its hotspot. A video is one film (WQ35): screens narrower than 768px show its file and
 * poster for phones when it has them, and fetch nothing of the desktop's; wider screens the reverse.
 *
 * The button (WQ24; Wayne, 24 Nov). Its resting place is towards the bottom, centred.
 * - With a mouse (a device whose main pointer is fine and can hover: the `hero-button` utility in app/globals.css)
 *   it is hidden until the pointer is over the hero. It fades in where the pointer is (the short duration, the
 *   smooth curve), follows it directly, under the pointer at every move with no easing (WQ80), never past the
 *   hero's edges, and fades out where it is when the
 *   pointer leaves, or comes over the video's own buttons so they can be pressed. It never waits at its resting
 *   place unseen: each time it is shown it is put where it is wanted first.
 *   The pointer over anything else (the header and its buttons included) is the pointer leaving: the hero is a layer
 *   of its own (`isolate`), under the header. Without that the button, under the pointer at every move since WQ80
 *   and drawn after the header at the same height, took the pointer itself and so never let it leave the hero,
 *   and covered the header's buttons (Level 3, 27 Nov; at 7f8c710 its glide trailed the pointer, which hid this).
 * - The keyboard: when it takes focus it fades in at its resting place and stays there while it has focus.
 * - A touch screen: always there, at its resting place.
 * - Reduced motion: it follows nothing. It fades in at its resting place while the pointer is over the hero or it
 *   has focus.
 */
export function HeroMedia({ picture, video, button, theme, sectionId, priority = false, reducedMotion: reducedMotionSet, touch = false, children }: HeroMediaProps) {
  const visitorReducedMotion = usePrefersReducedMotion()
  const reducedMotion = reducedMotionSet ?? visitorReducedMotion
  const mover = useRef<HTMLSpanElement>(null)
  const keyboardFocus = useRef(false)

  /**
   * Shows the button at a place (`''` is its resting place), there at once: only its fade has a transition (WQ80).
   * Hidden, it fades in where it is put.
   */
  const showAt = (translate: string) => {
    const moved = mover.current
    if (!moved) return
    moved.style.translate = translate
    moved.setAttribute('data-shown', '')
  }

  /** Fades the button out where it is. */
  const hide = () => mover.current?.removeAttribute('data-shown')

  const pointerOver = (event: PointerEvent<HTMLElement>) => {
    const moved = mover.current
    const holder = moved?.parentElement
    if (touch || keyboardFocus.current || !moved || !holder) return
    // A finger on a device that also has a mouse: the button is wanted, at its resting place.
    if (event.pointerType !== 'mouse') return showAt('')
    if (event.target instanceof Element && event.target.closest('[data-hero-controls]')) return hide()
    if (reducedMotion) return showAt('')
    const hero = event.currentTarget.getBoundingClientRect()
    // The button's resting place is the middle of its holder, which never moves; its own box is on its way somewhere.
    const place = holder.getBoundingClientRect()
    const size = moved.getBoundingClientRect()
    const halfWidth = size.width / 2
    const halfHeight = size.height / 2
    const x = clamp(event.clientX, hero.left + halfWidth, hero.right - halfWidth)
    const y = clamp(event.clientY, hero.top + halfHeight, hero.bottom - halfHeight)
    showAt(`${x - (place.left + place.width / 2)}px ${y - (place.top + place.height / 2)}px`)
  }

  const pointerGone = (event: PointerEvent<HTMLElement>) => {
    // A finger lifting is not the pointer leaving: the button stays.
    if (touch || keyboardFocus.current || event.pointerType !== 'mouse') return
    hide()
  }

  // Reduced motion switched on while the button is away from its resting place: it goes back.
  useEffect(() => {
    if (reducedMotion && mover.current) mover.current.style.translate = ''
  }, [reducedMotion])

  return (
    <section
      {...(sectionId ? { id: sectionId } : {})}
      data-theme={theme ?? 'dark'}
      data-module="hero"
      onPointerMove={button ? pointerOver : undefined}
      onPointerDown={button ? pointerOver : undefined}
      onPointerLeave={button ? pointerGone : undefined}
      // `isolate`: the hero is a layer of its own, so its button (z-10 inside it) is always under the header, never over
      // it (Level 3, 27 Nov).
      className="relative isolate aspect-9/16 w-full overflow-clip bg-object-product-bg md:aspect-16/9"
    >
      {children}
      <HeroMediaFill picture={picture} video={video} priority={priority} reducedMotion={reducedMotion} />
      {button ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-120 z-10 flex justify-center">
          <span ref={mover} data-hero-button="" {...(touch ? { 'data-shown': '' } : {})} className="hero-button pointer-events-auto flex">
            <HeroMediaButtonLink
              button={button}
              onFocus={(event) => {
                // The keyboard finds the button at its resting place, wherever the pointer is.
                if (!event.currentTarget.matches(':focus-visible')) return
                keyboardFocus.current = true
                showAt('')
              }}
              onBlur={() => {
                if (!keyboardFocus.current) return
                keyboardFocus.current = false
                if (!touch) hide()
              }}
            />
          </span>
        </div>
      ) : null}
    </section>
  )
}
