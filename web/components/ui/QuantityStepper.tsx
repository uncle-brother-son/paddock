import { Icon } from '@/components/brand/Icon'

type QuantityStepperProps = {
  value: number
  /** The least it goes to: 1 unless said. */
  min?: number
  /** The most it goes to. */
  max: number
  onChange: (value: number) => void
  /** What is being counted, for a screen reader: "Quantity" unless said. */
  label?: string
  className?: string
}

/** Figma "IconButton" inside the stepper: 12px round a 9px icon. Figma draws no disabled look, so at its end it looks the same and does nothing. */
const STEP = 'flex items-center justify-center self-stretch rounded-s p-12 text-text-primary disabled:cursor-default'

/**
 * Figma "QuantityStepper" (03 UI, 996:15488; on the Event page 1684:41502): Surface/Card with 4px corners, the minus
 * icon, the number in Label 12 (20px wide with 8px each side) and the plus icon, as tall as the button beside it.
 *
 * Minus is disabled at the least and plus at the most (WQ61: an event's goes from 1 to the spaces left). The number
 * is said to a screen reader as it changes. Each press is a button with its own name; the group has the count's name.
 */
export function QuantityStepper({ value, min = 1, max, onChange, label = 'Quantity', className }: QuantityStepperProps) {
  return (
    <div role="group" aria-label={label} data-stepper="" className={`flex shrink-0 items-center rounded-s bg-surface-card ${className ?? ''}`}>
      <button type="button" aria-label="One fewer" disabled={value <= min} onClick={() => onChange(value - 1)} className={STEP}>
        <Icon name="minus" />
      </button>
      <output aria-live="polite" className="flex items-center justify-center px-8">
        <span className="w-20 text-center text-label-12 text-text-primary">{value}</span>
      </output>
      <button type="button" aria-label="One more" disabled={value >= max} onClick={() => onChange(value + 1)} className={STEP}>
        <Icon name="plus" />
      </button>
    </div>
  )
}
