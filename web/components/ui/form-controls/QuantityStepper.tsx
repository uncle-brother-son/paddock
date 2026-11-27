import { IconButton } from '@/components/ui/buttons/IconButton'

type QuantityStepperProps = {
  value: number
  /** The least it goes to: 1 unless said. */
  min?: number
  /** The most it goes to. */
  max: number
  onChange: (value: number) => void
  /** What is being counted, for a screen reader: "Quantity" unless said. */
  label?: string
  /**
   * Figma's Big: yes unless said (12px round each icon: 33px tall, and as tall as a button beside it); no is the
   * small one (8px round each icon: 25px tall).
   */
  big?: boolean
  className?: string
}

/**
 * Figma "QuantityStepper" (03 UI, 608:2424; Big=yes 996:15488, on the Event page 1684:41502): Surface/Card with 4px
 * corners, the minus IconButton, the number in Label 12 (20px wide with 8px each side) and the plus IconButton
 * (components/ui/buttons/IconButton.tsx: Surface/Card Selected under a mouse). At its least the minus does nothing and its
 * icon is Text/Muted Primary (Figma's Switch=no); from there up both can be pressed (Switch=yes).
 *
 * Minus is unavailable at the least and plus at the most (WQ61: an event's goes from 1 to the spaces left). There the
 * button is `aria-disabled` and a press is ignored, not `disabled`: a button pressed up to its limit by keyboard keeps
 * focus (a disabled one would drop it to the page), and a screen reader still hears it is unavailable. The number
 * is said to a screen reader as it changes. Each press is a button with its own name; the group has the count's name.
 *
 * It is as wide as its parts unless it is given a width (W77: the whole width of a session's row on a phone, and of
 * an add-on's card), where the number takes the room between the two icons.
 */
export function QuantityStepper({ value, min = 1, max, onChange, label = 'Quantity', big = true, className }: QuantityStepperProps) {
  const atLeast = value <= min
  const atMost = value >= max
  return (
    <div role="group" aria-label={label} data-stepper="" className={`flex shrink-0 items-center rounded-s bg-surface-card ${className ?? ''}`}>
      <IconButton
        icon="minus"
        label="One fewer"
        big={big}
        aria-disabled={atLeast}
        onClick={() => {
          if (!atLeast) onChange(value - 1)
        }}
        className="self-stretch"
      />
      <output aria-live="polite" className="flex flex-1 items-center justify-center px-8">
        <span className="w-20 text-center text-label-12 text-text-primary">{value}</span>
      </output>
      <IconButton
        icon="plus"
        label="One more"
        big={big}
        aria-disabled={atMost}
        onClick={() => {
          if (!atMost) onChange(value + 1)
        }}
        className="self-stretch"
      />
    </div>
  )
}
