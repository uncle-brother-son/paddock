import type { ReactNode } from 'react'

type StatusTagProps = {
  /** Its word or two, in Label 10. */
  children: ReactNode
  /** Figma's State=warning: the words in Text/Error. */
  warning?: boolean
  className?: string
}

/**
 * Figma "StatusTag" (03 UI, 1080:11824): a word or two in Label 10 with 6px each side and 4px above and below, on
 * Surface/Card with 4px corners; Text/Primary (State=default) or, for a warning, Text/Error (State=warning).
 *
 * As drawn, the tag takes the room of a line of Label 12's capitals, not its own height: it stands centred on that
 * line and overhangs it equally above and below, so it sits level with the words beside it and moves nothing.
 */
export function StatusTag({ children, warning = false, className }: StatusTagProps) {
  return (
    <span data-status-tag={warning ? 'warning' : 'default'} className={`inline-flex h-[1cap] items-center text-label-12 ${className ?? ''}`}>
      <span className="flex shrink-0 items-center justify-center rounded-s bg-surface-card px-6 py-4">
        <span className={`text-label-10 whitespace-nowrap ${warning ? 'text-text-error' : 'text-text-primary'}`}>{children}</span>
      </span>
    </span>
  )
}
