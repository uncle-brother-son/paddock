import { SizeOption } from '@/components/ui/form-controls/SizeSelect'

type SizeFieldProps = {
  /** The CallToAction's own id, which its words and the sizes' radio group are named from. */
  id: string
  /** The product's sizes, each with whether any is left. */
  sizes: { size: string; available: boolean }[]
  /** The size picked; null with none. */
  picked: string | null
  /** Add to bag was pressed with no size picked (State=select size). */
  wrong: boolean
  /** Opens the info panel on its Size Guide; null when the product has no guide. */
  onSizeGuide: (() => void) | null
  onPick: (size: string) => void
}

/**
 * Figma "SizeField" (04 Components > Shop, 1389:39374), in a product's CallToAction: "Size" in Copy 12 with "Size
 * guide" at the right when the product has one, then a SizeSelect for each size, 4px apart, one group of radio
 * buttons. Its states, as drawn: default; selected (a size picked); select size ("Please select a size" in
 * Text/Error under the sizes, when Add to bag is pressed with none picked).
 */
export function SizeField({ id, sizes, picked, wrong, onSizeGuide, onPick }: SizeFieldProps) {
  return (
    <div className="flex flex-col gap-12">
      <div className="flex items-start gap-8">
        <p id={`${id}-size`} className="min-w-0 flex-1 text-copy-12 text-text-primary">
          Size
        </p>
        {onSizeGuide ? (
          <button
            type="button"
            aria-haspopup="dialog"
            onClick={onSizeGuide}
            className="relative shrink-0 text-link-12 whitespace-nowrap text-text-muted-primary transition-colors duration-short ease-smooth after:absolute after:-inset-8 hover:text-text-primary focus-visible:text-text-primary"
          >
            Size guide
          </button>
        ) : null}
      </div>
      <div role="radiogroup" aria-labelledby={`${id}-size`} aria-required="true" {...(wrong ? { 'aria-invalid': true } : {})} className="flex gap-4">
        {sizes.map((size) => (
          <SizeOption
            key={size.size}
            name={`${id}-sizes`}
            size={size.size}
            available={size.available}
            selected={picked === size.size}
            onSelect={() => onPick(size.size)}
            {...(wrong ? { describedBy: `${id}-size-wrong` } : {})}
          />
        ))}
      </div>
      {wrong ? (
        <p id={`${id}-size-wrong`} role="alert" className="text-copy-12 text-text-error">
          Please select a size
        </p>
      ) : null}
    </div>
  )
}
