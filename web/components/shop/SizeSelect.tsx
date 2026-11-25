import type { ComponentPropsWithoutRef } from 'react'

// Figma "SizeSelect" (03 UI, 276:6625): the chip for a size. Two sizes of chip, each with its states as drawn: small
// (a ProductCard's hover strip: default, hover, OOS, selected) and big (the Product page: default, hover, selected,
// sold out). A size that is gone keeps its place, muted and struck through, and reads "M, sold out".

/** The line through a size that is gone: 16px of Text/Muted Primary across its middle. */
function StruckThrough() {
  return <span aria-hidden="true" className="absolute top-1/2 left-1/2 h-px w-16 -translate-x-1/2 -translate-y-1/2 bg-text-muted-primary" />
}

/** How a size is read out: its own name, and that it is gone when it is. */
export const sizeName = (size: string, available: boolean): string => (available ? size : `${size}, sold out`)

type SizeButtonProps = Omit<ComponentPropsWithoutRef<'button'>, 'children' | 'disabled'> & {
  size: string
  available: boolean
  /** Figma's State=selected, Big=no (1195:108): the size chosen. Left out, the chip is a plain button (a ProductCard's adds at a press). */
  selected?: boolean
}

/**
 * The small chip, a button (Big=No: 8px above and below, Copy 12): Surface/Card Selected on hover; chosen
 * (State=selected), Surface/Secondary with Text/Secondary. Out of stock (State=OOS) it can't be pressed.
 */
export function SizeButton({ size, available, selected, className, ...rest }: SizeButtonProps) {
  const look = !available ? 'cursor-default text-text-muted-primary' : selected ? 'bg-surface-secondary text-text-secondary' : 'text-text-primary hover:bg-surface-card-selected'
  return (
    <button
      type="button"
      disabled={!available}
      {...(selected === undefined ? {} : { 'aria-pressed': selected })}
      className={`relative flex min-w-0 flex-1 items-center justify-center rounded-s py-8 transition-colors duration-short ease-smooth ${look} ${className ?? ''}`}
      {...rest}
    >
      <span className="text-copy-12 whitespace-nowrap">{size}</span>
      {available ? null : <StruckThrough />}
    </button>
  )
}

type SizeOptionProps = {
  /** The radio group's name: one group for a product's sizes. */
  name: string
  size: string
  available: boolean
  selected: boolean
  onSelect: () => void
  /** What says something is wrong with the choice ("Please select a size"), by its id. */
  describedBy?: string
}

/**
 * The big chip (Big=Yes: 16px above and below, Copy 14), a radio button under the designed look, so the arrow keys
 * move between sizes and a screen reader says which is picked. Surface/Card, Surface/Card Selected on hover,
 * Surface/Secondary with Text/Secondary once picked; sold out it is Surface/Card Disabled and can't be picked.
 */
export function SizeOption({ name, size, available, selected, onSelect, describedBy }: SizeOptionProps) {
  const look = !available
    ? 'bg-surface-card-disabled text-text-muted-primary'
    : selected
      ? 'cursor-pointer bg-surface-secondary text-text-secondary'
      : 'cursor-pointer bg-surface-card text-text-primary hover:bg-surface-card-selected'
  return (
    <label
      className={`relative flex min-w-0 flex-1 items-center justify-center rounded-s py-16 transition-colors duration-short ease-smooth has-keyboard-focus:outline-2 has-keyboard-focus:outline-offset-2 has-keyboard-focus:outline-text-primary ${look}`}
    >
      <input
        type="radio"
        name={name}
        value={size}
        checked={selected}
        disabled={!available}
        onChange={onSelect}
        aria-label={sizeName(size, available)}
        {...(describedBy ? { 'aria-describedby': describedBy } : {})}
        className="sr-only"
      />
      <span aria-hidden="true" className="text-copy-14 whitespace-nowrap">
        {size}
      </span>
      {available ? null : <StruckThrough />}
    </label>
  )
}
