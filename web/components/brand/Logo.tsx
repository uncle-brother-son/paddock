import { logos } from './art/logos'
import { BrandSvg } from './BrandSvg'

/** The club's name, read out wherever a logo stands for it. */
export const LOGO_LABEL = 'The Paddock Wellness Club'

const LOGO_ART = {
  wordmark: logos.wordmark,
  original: logos['logo-original'],
  'hover-static': logos['logo-hover-static'],
  'hover-logo': logos['logo-hover-logo'],
  'hover-extended': logos['logo-hover-extended'],
} as const

/** Figma's 01 Logo page: Wordmark, Logo Original, and LogoHover's three states. */
export type LogoVariant = keyof typeof LOGO_ART

export const LOGO_VARIANTS = Object.keys(LOGO_ART) as LogoVariant[]

type BrandMarkProps = {
  /** True where the drawing is decoration (the name is already beside it): hidden from a screen reader. */
  decorative?: boolean
  className?: string
}

/** A logo in the text colour of where it sits, at its file's own size unless a class sizes it. */
export function Logo({ variant, decorative = false, className }: BrandMarkProps & { variant: LogoVariant }) {
  return <BrandSvg art={LOGO_ART[variant]} label={decorative ? undefined : LOGO_LABEL} className={className} />
}

/** Figma "Fence". */
export function Fence({ decorative = false, className }: BrandMarkProps) {
  return <BrandSvg art={logos.fence} label={decorative ? undefined : LOGO_LABEL} className={className} />
}

/**
 * Figma "HouseIllustration". The file is the whole drawing (460 by 200); Figma's component box is narrower
 * (HOUSE_BOX) and the porch hangs out of it to the left, so a layout that places the box lets the drawing overflow.
 */
export function HouseIllustration({ decorative = false, className }: BrandMarkProps) {
  return <BrandSvg art={logos['house-illustration']} label={decorative ? undefined : LOGO_LABEL} className={className} />
}

/** Figma's HouseIllustration component box (node 494:3397), as a CSS aspect ratio. */
export const HOUSE_BOX = '431 / 200'

/**
 * LogoHover as the desktop header animates it (Figma 190:2843, hover=logo to hover=extended): at rest a window the
 * width of the wordmark shows the middle of the extended logo; on hover or keyboard focus of the `group` it sits in,
 * the window widens to the whole of it and the drawing slides right, so "THE" and "WELLNESS CLUB" come into view.
 * The three lengths are the files' own: the two widths, and where the wordmark starts inside the extended logo
 * (Figma 251:5414, x = 35).
 */
export function LogoHover({ className }: { className?: string }) {
  const rest = logos['logo-hover-logo']
  const full = logos['logo-hover-extended']
  const lengths = { '--logo-rest': `${rest.width}px`, '--logo-full': `${full.width}px`, '--logo-shift': '-35px' } as React.CSSProperties
  return (
    <span
      style={lengths}
      className={`block w-(--logo-rest) overflow-clip transition-[width] duration-short ease-smooth group-hover:w-(--logo-full) group-focus-visible:w-(--logo-full) ${className ?? ''}`}
    >
      <BrandSvg
        art={full}
        label={LOGO_LABEL}
        className="block max-w-none translate-x-(--logo-shift) transition-transform duration-short ease-smooth group-hover:translate-x-0 group-focus-visible:translate-x-0"
      />
    </span>
  )
}
