'use client'

import { useEffect, useRef, useState, type FocusEvent, type MouseEvent, type PointerEvent, type ReactNode } from 'react'

import { Icon, type IconName } from '@/components/brand/Icon'
import { useFramePanels } from '@/components/frame/useFramePanels'
import { ButtonLabel } from '@/components/ui/Button'
import { SiteLink } from '@/components/ui/SiteLink'
import type { HeroButton, HeroContent, HeroMedia, HeroPicture } from '@/lib/modules/hero'
import { usePrefersReducedMotion } from '@/lib/motion/reduced-motion'

const clamp = (value: number, least: number, most: number): number => Math.min(Math.max(value, least), most)

/**
 * The hero's picture, across the whole hero: the tall cut on a phone, the wide one from 768px. The first hero of a
 * page is its largest picture, so it loads at once and ahead of the rest (`priority`); any other waits until it is near.
 */
function HeroImage({ picture, priority, alt }: { picture: HeroPicture; priority: boolean; alt: string }) {
  return (
    <picture>
      <source media="(width >= 48rem)" srcSet={picture.desktop.srcSet} sizes="100vw" width={picture.desktop.width} height={picture.desktop.height} />
      {/* A plain <img>: Next's image optimiser does not run on Workers. The address is Sanity's CDN, sized in lib/sanity/image.ts. */}
      <img
        src={picture.mobile.src}
        srcSet={picture.mobile.srcSet}
        sizes="100vw"
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

/**
 * A hero's video (WQ15, WQ18; docs/build-standards.md, Video): muted, looped and inline. Its poster is the picture
 * in the page from the start, and the video takes its place once it shows a frame. It plays only while it is on
 * screen, and loads nothing until then. With reduced motion on it never starts by itself: the poster stays, with Play.
 * The two buttons show what a press will do, as Figma draws them for a video that is playing with its sound off:
 * the speaker and Pause.
 */
function HeroVideo({ media, priority, reducedMotion }: { media: Extract<HeroMedia, { kind: 'video' }>; priority: boolean; reducedMotion: boolean }) {
  const video = useRef<HTMLVideoElement>(null)
  const [playing, setPlaying] = useState(false)
  const [started, setStarted] = useState(false)
  const [muted, setMuted] = useState(true)
  // What the visitor last asked for with the button. Until they press it, the video plays unless motion is reduced.
  const [asked, setAsked] = useState<'play' | 'pause' | null>(null)
  const wanted = asked ?? (reducedMotion ? 'pause' : 'play')

  // React leaves `muted` out of the page's HTML, so the element is told here, before anything asks it to play.
  useEffect(() => {
    if (video.current) video.current.muted = muted
  }, [muted])

  useEffect(() => {
    const element = video.current
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
    const element = video.current
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
      <HeroImage picture={media.poster} priority={priority} alt={started ? '' : media.poster.alt} />
      <video
        ref={video}
        src={media.url}
        muted={muted}
        loop
        playsInline
        preload="none"
        {...(media.captionsUrl ? { crossOrigin: 'anonymous' as const } : {})}
        {...(started ? { 'aria-label': media.description } : { 'aria-hidden': true })}
        onPlaying={() => {
          setPlaying(true)
          setStarted(true)
        }}
        onPause={() => setPlaying(false)}
        className={`absolute inset-0 size-full object-cover ${started ? '' : 'invisible'}`}
      >
        {media.captionsUrl ? <track kind="captions" src={media.captionsUrl} srcLang="en" label="English" default /> : null}
      </video>
      <div data-hero-controls="" className="absolute right-16 bottom-16 z-20 flex items-center gap-8">
        <HeroIconButton label={muted ? 'Unmute video' : 'Mute video'} icon={muted ? 'audio-on' : 'audio-off'} onClick={() => setMuted((now) => !now)} />
        <HeroIconButton label={playing ? 'Pause video' : 'Play video'} icon={playing ? 'pause' : 'play'} onClick={togglePlay} />
      </div>
    </>
  )
}

/**
 * Figma's Button on the hero (1213:29162): the small primary Button with 12px all round. On a desktop it follows the
 * pointer (see Hero); this is the button itself, at its resting place.
 */
function HeroButtonLink({ button, onFocus, onBlur }: { button: HeroButton; onFocus: (event: FocusEvent<HTMLAnchorElement>) => void; onBlur: () => void }) {
  const panels = useFramePanels()
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    // The booking panel when there is one; the link when there isn't (as the header's Book).
    if (button.opensBooking && panels.open('book')) event.preventDefault()
  }
  return (
    <SiteLink
      href={button.href}
      onClick={open}
      onFocus={onFocus}
      onBlur={onBlur}
      className="inline-flex items-center justify-center rounded-s bg-surface-secondary p-12 text-text-secondary"
    >
      <ButtonLabel>{button.text}</ButtonLabel>
    </SiteLink>
  )
}

type HeroProps = HeroContent & {
  /** The page's first hero: its picture is the page's largest, so it loads first. */
  priority?: boolean
  /** For Storybook and tests: reduced motion on or off, whatever the visitor's own setting. */
  reducedMotion?: boolean
  /** The page's heading, when the hero is the page's first section and holds it (components/modules/PageModules.tsx). */
  children?: ReactNode
}

/**
 * The Hero module (W73b; Figma "Hero", 1213:29172): a picture or a video across the whole window, 16 by 9 on a
 * desktop and 9 by 16 on a phone, in the Dark mode, so the header over it has light words. A video has its sound and
 * Pause buttons at the bottom right.
 *
 * The button (WQ24): its resting place is towards the bottom, centred, as the phone design draws it. With a mouse it
 * follows the pointer about the hero, eased over the short duration with the smooth curve, never past the hero's
 * edges, and goes back to its resting place when the pointer leaves, or comes over the video's buttons so they can
 * be pressed. It stays at rest on a touch screen, while it has keyboard focus, and with reduced motion on.
 */
export function Hero({ media, button, priority = false, reducedMotion: reducedMotionSet, children }: HeroProps) {
  const visitorReducedMotion = usePrefersReducedMotion()
  const reducedMotion = reducedMotionSet ?? visitorReducedMotion
  const mover = useRef<HTMLSpanElement>(null)
  const keyboardFocus = useRef(false)

  const rest = () => {
    if (mover.current) mover.current.style.translate = ''
  }

  const follow = (event: PointerEvent<HTMLElement>) => {
    const moved = mover.current
    const holder = moved?.parentElement
    if (!moved || !holder) return
    const overControls = event.target instanceof Element && event.target.closest('[data-hero-controls]') !== null
    if (event.pointerType !== 'mouse' || reducedMotion || keyboardFocus.current || overControls) return rest()
    const hero = event.currentTarget.getBoundingClientRect()
    // The button's resting place is the middle of its holder, which never moves; its own box is on its way somewhere.
    const place = holder.getBoundingClientRect()
    const size = moved.getBoundingClientRect()
    const halfWidth = size.width / 2
    const halfHeight = size.height / 2
    const x = clamp(event.clientX, hero.left + halfWidth, hero.right - halfWidth)
    const y = clamp(event.clientY, hero.top + halfHeight, hero.bottom - halfHeight)
    moved.style.translate = `${x - (place.left + place.width / 2)}px ${y - (place.top + place.height / 2)}px`
  }

  // Reduced motion switched on while the button is away from its place: it goes back.
  useEffect(() => {
    if (reducedMotion && mover.current) mover.current.style.translate = ''
  }, [reducedMotion])

  return (
    <section
      data-theme="dark"
      data-module="hero"
      onPointerMove={button ? follow : undefined}
      onPointerLeave={button ? rest : undefined}
      className="relative aspect-9/16 w-full overflow-clip bg-object-product-bg md:aspect-16/9"
    >
      {children}
      {media.kind === 'image' ? <HeroImage picture={media.picture} priority={priority} alt={media.picture.alt} /> : <HeroVideo media={media} priority={priority} reducedMotion={reducedMotion} />}
      {button ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-120 z-10 flex justify-center">
          <span ref={mover} data-hero-button="" className="pointer-events-auto flex transition-[translate] duration-short ease-smooth">
            <HeroButtonLink
              button={button}
              onFocus={(event) => {
                // The keyboard finds the button at its resting place, wherever the pointer left it.
                if (!event.currentTarget.matches(':focus-visible')) return
                keyboardFocus.current = true
                rest()
              }}
              onBlur={() => {
                keyboardFocus.current = false
              }}
            />
          </span>
        </div>
      ) : null}
    </section>
  )
}
