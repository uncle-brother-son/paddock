import { icons } from './art/icons'
import { BrandSvg } from './BrandSvg'

/** The 16 icons of Figma's 02 Icons page, by their Figma names ("Type=burger close" is `burger-close`). */
export type IconName = keyof typeof icons

export const ICON_NAMES = Object.keys(icons) as IconName[]

type IconProps = {
  name: IconName
  /** Its name for a screen reader, for an icon that stands alone. Left out, it is hidden from one. */
  label?: string
  className?: string
}

/** An icon at its file's own size (9 by 9, the burgers 24 by 9), in the text colour of where it sits. */
export function Icon({ name, label, className }: IconProps) {
  return <BrandSvg art={icons[name]} label={label} className={className ? `shrink-0 ${className}` : 'shrink-0'} />
}
