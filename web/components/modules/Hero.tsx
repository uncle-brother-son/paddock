'use client'

import { useEffect, useRef, useState, type FocusEvent, type PointerEvent, type ReactNode } from 'react'

import { Icon, type IconName } from '@/components/brand/Icon'
import { ButtonLabel } from '@/components/ui/Button'
import { SiteLink } from '@/components/ui/SiteLink'
import type { HeroButton, HeroContent, HeroSide, HeroVideo } from '@/lib/modules/hero'
import { usePrefersReducedMotion } from '@/lib/motion/reduced-motion'
import type { SizedImage } from '@/lib/sanity/image'

const clamp = (value: number, least: number, most: number): number => Math.min(Math.max(value, least), most)

/** The two widths of screen the hero is drawn for: Figma's phone frame below 768px, its desktop frame from there. */
const FROM_DESKTOP = '(width >= 48rem)'
const BELOW_DESKTOP = '(width < 48rem)'

/** A picture one pixel big, with nothing in it: what a picture's file is on the width of screen it is not shown on. */
const NO_PICTURE = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=='

/**
 * What a hero's picture is on the other width of screen: the same picture cut the other way, or nothing at all
 * when that screen has media of its own. The browser picks before it fetches, so only the file the screen needs
 * is downloaded.
 */
type Elsewhere = { media: string; image: SizedImage | null }

/**
 * A hero's picture, across the whole hero. The first hero of a page is its largest picture, so it loads at once
 * and ahead of the rest (`priority`); any other waits until it is near.
 */
function HeroImage({ image, alt, elsewhere, priority }: { image: SizedImage; alt: string; elsewhere: Elsewhere; priority: boolean }) {
  return (
    <picture>
      {elsewhere.image ? (
        <source media={elsewhere.media} srcSet={elsewhere.image.srcSet} sizes="100vw" width={elsewhere.image.width} height={elsewhere.image.height} />
      ) : (
        <source media={elsewhere.media} srcSet={NO_PICTURE} />
      )}
      {/* A plain <img>: Next's image optimiser does not run on Workers. The address is Sanity's CDN, sized in lib/sanity/image.ts. */}
      <img
        src={image.src}
        srcSet={image.srcSet}
        sizes="100vw"
        width={image.width}
        height={image.height}
        alt={alt}
        loading={priority ? 'eager' : 'lazy'}
        fetchPriority={priority ? 'high' : 'auto'}
        decoding="async"
        className="absolute inset-0 size-full object-cover"
      />
    </picture>
  )
}

/** Figma "IconButton", Style=image (1456:35670, hover 1456:35672): 8px round a 12px icon, on Text/Muted Primary; Text/Primary on hover. */
function HeroIconButton({ label, icon, onClick }: { label: string; icon: IconName; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="flex items-center justify-center rounded-s bg-text-muted-primary p-8 text-text-secondary transition-colors duration-short ease-smooth hover:bg-text-primary"
    >
      {/* The icons are drawn 9px tall; on a picture Figma shows them at 12. */}
      <span className="flex size-12 items-center justify-center">
        <Icon name={icon} className="h-12 w-auto" />
      </span>
    </button>
  )
}

type Still = { image: SizedImage; alt: string; elsewhere: Elsewhere }

/**
 * A hero's video (WQ15, WQ18; docs/build-standards.md, Video): muted, looped and inline. Its poster is the picture
 * in the page from the start, and the video takes its place once it shows a frame. It plays only while it is on
 * screen, and loads nothing until then: a video for the other width of screen is never on screen, so it is never
 * fetched. With reduced motion on it never starts by itself: the poster stays, with Play.
 *
 * Pause is always there. The sound button is there only when the editor says the video has sound (W73b, Wayne).
 * Both show what a press will do, as Figma draws them for a video that is playing with its sound off: the speaker
 * and Pause.
 */
function HeroVideoPlayer({ video, still, priority, reducedMotion }: { video: HeroVideo; still: Still; priority: boolean; reducedMotion: boolean }) {
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
    <>
      {/* Once the video shows, it is the video that is described to a screen reader, not the picture beneath it. */}
      <HeroImage image={still.image} alt={started ? '' : still.alt} elsewhere={still.elsewhere} priority={priority} />
      <video
        ref={player}
        src={video.url}
        muted={muted}
        loop
        playsInline
        preload="none"
        {...(video.captionsUrl ? { crossOrigin: 'anonymous' as const } : {})}
        {...(started ? { 'aria-label': video.description } : { 'aria-hidden': true })}
        onPlaying={() => {
          setPlaying(true)
          setStarted(true)
        }}
        onPause={() => setPlaying(false)}
        className={`absolute inset-0 size-full object-cover ${started ? '' : 'invisible'}`}
      >
        {video.captionsUrl ? <track kind="captions" src={video.captionsUrl} srcLang="en" label="English" default /> : null}
      </video>
      <div data-hero-controls="" className="absolute right-16 bottom-16 z-20 flex items-center gap-8">
        {video.hasSound ? (
          <HeroIconButton label={muted ? 'Unmute video' : 'Mute video'} icon={muted ? 'audio-on' : 'audio-off'} onClick={() => setMuted((now) => !now)} />
        ) : null}
        <HeroIconButton label={playing ? 'Pause video' : 'Play video'} icon={playing ? 'pause' : 'play'} onClick={togglePlay} />
      </div>
    </>
  )
}

/**
 * What one width of screen shows, across the whole hero: its picture, or its video over its poster. `shown` is
 * the widths it is there for: both (the one media serves both), or one of the two (the hero has media for phones).
 */
function HeroLayer({ side, elsewhere, shown, priority, reducedMotion }: { side: HeroSide; elsewhere: Elsewhere; shown: 'both' | 'mobile' | 'desktop'; priority: boolean; reducedMotion: boolean }) {
  const still: Still = { image: side.image, alt: side.alt, elsewhere }
  const widths = { both: '', mobile: 'md:hidden', desktop: 'hidden md:block' }[shown]
  return (
    <div data-hero-media={shown} className={`absolute inset-0 ${widths}`}>
      {side.video ? (
        <HeroVideoPlayer video={side.video} still={still} priority={priority} reducedMotion={reducedMotion} />
      ) : (
        <HeroImage image={still.image} alt={still.alt} elsewhere={still.elsewhere} priority={priority} />
      )}
    </div>
  )
}

/** Figma's Button on the hero (1213:29162): the small primary Button with 12px all round. */
function HeroButtonLink({ button, onFocus, onBlur }: { button: HeroButton; onFocus: (event: FocusEvent<HTMLAnchorElement>) => void; onBlur: () => void }) {
  return (
    // A button to the booking panel asks for the panel first, as every link to /book does (SiteLink).
    <SiteLink href={button.href} onFocus={onFocus} onBlur={onBlur} className="inline-flex items-center justify-center rounded-s bg-surface-secondary p-12 text-text-secondary">
      <ButtonLabel>{button.text}</ButtonLabel>
    </SiteLink>
  )
}

type HeroProps = HeroContent & {
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
 * The Hero module (W73b; Figma "Hero", 1213:29172): a picture or a video across the whole window, 16 by 9 on a
 * desktop and 9 by 16 on a phone, in the Dark mode, so the header over it has light words. With media of its own
 * for phones, screens narrower than 768px show that and fetch nothing of the other; wider screens the reverse.
 *
 * The button (WQ24; Wayne, 24 Nov). Its resting place is towards the bottom, centred.
 * - With a mouse (a device whose main pointer is fine and can hover: the `hero-button` utility in app/globals.css)
 *   it is hidden until the pointer is over the hero. It fades in where the pointer is, follows it, eased over the
 *   short duration with the smooth curve and never past the hero's edges, and fades out where it is when the
 *   pointer leaves, or comes over the video's own buttons so they can be pressed. It never waits at its resting
 *   place unseen: each time it is shown it is put where it is wanted first.
 * - The keyboard: when it takes focus it fades in at its resting place and stays there while it has focus.
 * - A touch screen: always there, at its resting place.
 * - Reduced motion: it follows nothing. It fades in at its resting place while the pointer is over the hero or it
 *   has focus.
 */
export function Hero({ desktop, mobile, shared, button, priority = false, reducedMotion: reducedMotionSet, touch = false, children }: HeroProps) {
  const visitorReducedMotion = usePrefersReducedMotion()
  const reducedMotion = reducedMotionSet ?? visitorReducedMotion
  const mover = useRef<HTMLSpanElement>(null)
  const keyboardFocus = useRef(false)

  /**
   * Shows the button at a place (`''` is its resting place). Already showing, it glides there. Hidden, it is put
   * there at once, with no glide from wherever it was last, and then fades in.
   */
  const showAt = (translate: string) => {
    const moved = mover.current
    if (!moved) return
    if (moved.hasAttribute('data-shown')) {
      moved.style.translate = translate
      return
    }
    moved.style.transitionProperty = 'opacity'
    moved.style.translate = translate
    // Read once, so the browser takes the new place before the fade begins.
    void moved.offsetWidth
    moved.style.transitionProperty = ''
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

  // The one media for both widths of screen: on the other width the same picture, cut the other way.
  const layers = shared ? (
    <HeroLayer side={mobile} elsewhere={{ media: FROM_DESKTOP, image: desktop.image }} shown="both" priority={priority} reducedMotion={reducedMotion} />
  ) : (
    <>
      <HeroLayer side={mobile} elsewhere={{ media: FROM_DESKTOP, image: null }} shown="mobile" priority={priority} reducedMotion={reducedMotion} />
      <HeroLayer side={desktop} elsewhere={{ media: BELOW_DESKTOP, image: null }} shown="desktop" priority={priority} reducedMotion={reducedMotion} />
    </>
  )

  return (
    <section
      data-theme="dark"
      data-module="hero"
      onPointerMove={button ? pointerOver : undefined}
      onPointerDown={button ? pointerOver : undefined}
      onPointerLeave={button ? pointerGone : undefined}
      className="relative aspect-9/16 w-full overflow-clip bg-object-product-bg md:aspect-16/9"
    >
      {children}
      {layers}
      {button ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-120 z-10 flex justify-center">
          <span ref={mover} data-hero-button="" {...(touch ? { 'data-shown': '' } : {})} className="hero-button pointer-events-auto flex">
            <HeroButtonLink
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
