import { Radio } from '@/components/ui/form-controls/Radio'

export type OfferSelectorProps = {
  /** The radio group's name: one group for the offers of a card. */
  name: string
  value: string
  checked: boolean
  onChange: () => void
  /** Figma's Offer: the level's name ("Core"). */
  offer: string
  /** Figma's Info: what the level covers ("Off-Peak and Core times"). */
  info: string
  /** Figma's Price ("£490"). */
  price: string
  /** Figma's ComparePrice, struck through before the price ("£540"). None: Show Compare Price is off. */
  comparePrice?: string | null
  /**
   * Holds it to one of Figma's two arrangements whatever its width, for the stories of Figma's variants. Left out, it
   * answers to its own width.
   */
  device?: 'desktop' | 'mobile'
  className?: string
}

/**
 * Figma draws Device=desktop 371px wide: its padding (24 each side) off, 323px for what it holds. A container query
 * measures that inner width.
 */
const INFO = {
  auto: 'flex-col @min-[323px]:flex-row @min-[323px]:items-end',
  desktop: 'flex-row items-end',
  mobile: 'flex-col',
} as const

/**
 * Figma "OfferSelector" (04 Components > Memberships, 1841:45039): one level of a Membership or Session Pass card,
 * to choose. Surface/Primary with 4px corners and 24px all round; the Radio (03 UI), 12px, then the level's name in
 * Label 12 with what it covers 8px under it in Copy 12, Text/Muted Primary, and the price in H2, a yearly price's
 * before-price struck through 4px before it in Copy 12, Text/Muted Primary.
 * - Device=desktop: the price at the right, its foot level with the foot of the words.
 * - Device=mobile: the price 12px under the words, at their left.
 * Which of the two it is follows its own width (a container query, as SessionRow's): Device=desktop from the width
 * Figma draws that one at (371px), Device=mobile when it is narrower, as on a phone's card (265px) and on a card at a
 * tablet's width.
 * - State=hover: the Radio's hover (its dot in Text/Muted Primary) under a mouse anywhere on it.
 * - State=selected: the Radio's selected.
 *
 * The whole of it is the radio button's label, so a press anywhere chooses it, and a screen reader hears the level,
 * what it covers and its price ("was £540, now £490"). The card that holds a group of them is the radio group.
 */
export function OfferSelector({ name, value, checked, onChange, offer, info, price, comparePrice, device, className }: OfferSelectorProps) {
  return (
    <label
      data-offer-selector=""
      {...(checked ? { 'data-chosen': '' } : {})}
      // `relative`: the words for screen readers only are placed from here, so a row of cards that scrolls sideways
      // keeps them inside it (placed from the page, those of a card off the screen would widen the page itself).
      className={`@container relative flex cursor-pointer items-center gap-12 rounded-s bg-surface-primary p-24 [&:hover_[data-radio]>span]:opacity-100 ${className ?? ''}`}
    >
      <Radio name={name} value={value} checked={checked} onChange={onChange} />
      <span data-offer="info" className={`flex min-w-0 flex-1 gap-12 ${INFO[device ?? 'auto']}`}>
        <span data-offer="offer" className="flex min-w-0 flex-1 flex-col gap-8">
          <span className="text-label-12 text-text-primary">{offer}</span>
          <span className="text-copy-12 text-text-muted-primary">{info}</span>
        </span>
        <span data-offer="price" className="flex shrink-0 items-end gap-4">
          {comparePrice ? (
            <s className="text-copy-12 whitespace-nowrap text-text-muted-primary line-through">
              <span className="sr-only">was </span>
              {comparePrice}
            </s>
          ) : null}
          <span className="text-h2 whitespace-nowrap text-text-primary">
            {comparePrice ? <span className="sr-only">now </span> : null}
            {price}
          </span>
        </span>
      </span>
    </label>
  )
}
