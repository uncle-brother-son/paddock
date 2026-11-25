import { IconButton } from './IconButton'

type PriceStepperProps = {
  /** The price as it is drawn: "£1". */
  price: string
  /** What the plus does, for a screen reader: "Add a towel". */
  label: string
  onAdd: () => void
  className?: string
}

/**
 * Figma "PriceStepper" (03 UI, 1157:16352; its one variant, Switch=no, Big=no): on Surface/Card with 4px corners, a
 * price in Label 12 with 8px all round it, then the plus (Figma's IconButton, Style=page). It is as wide as its parts
 * and as tall as the small QuantityStepper: what something that can be added shows before any is.
 */
export function PriceStepper({ price, label, onAdd, className }: PriceStepperProps) {
  return (
    <div data-price-stepper="" className={`inline-flex shrink-0 items-center rounded-s bg-surface-card ${className ?? ''}`}>
      <span className="flex items-center justify-center p-8">
        <span className="text-label-12 whitespace-nowrap text-text-primary">{price}</span>
      </span>
      <IconButton icon="plus" label={label} onClick={onAdd} />
    </div>
  )
}
