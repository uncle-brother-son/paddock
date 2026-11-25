import type { ComponentPropsWithRef, ReactNode } from 'react'

import { Icon } from '@/components/brand/Icon'

type AttributeProps = Omit<ComponentPropsWithRef<'button'>, 'children' | 'onClick' | 'type'> & {
  /** Its words, in Label 12: what is taken away by a press. */
  children: ReactNode
  onRemove: () => void
  /** What a press does, said before its words to a screen reader: "Remove" unless said. */
  removeWord?: string
}

/**
 * Figma "Attribute" (03 UI, 1027:5427): something chosen that a press takes away again. Its words in Label 12 and,
 * 4px to their right, the close icon, with 8px all round, on Surface/Card with 4px corners (State=default);
 * Surface/Card Selected under a mouse (State=hover).
 *
 * The whole of it is one button. Its name is what it does and then its own words ("Remove Sauna"): the close icon
 * alone says nothing to a screen reader.
 */
export function Attribute({ children, onRemove, removeWord = 'Remove', className, ...rest }: AttributeProps) {
  return (
    <button
      type="button"
      data-attribute=""
      onClick={onRemove}
      className={`inline-flex items-start gap-4 rounded-s bg-surface-card p-8 text-text-primary transition-colors duration-short ease-smooth hover:bg-surface-card-selected ${className ?? ''}`}
      {...rest}
    >
      <span className="text-label-12 whitespace-nowrap">
        <span className="sr-only">{removeWord} </span>
        {children}
      </span>
      <Icon name="close" />
    </button>
  )
}
