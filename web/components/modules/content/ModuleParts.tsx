import { ButtonLabel, SMALL_SECONDARY_LINK } from '@/components/ui/buttons/Button'
import { SiteLink } from '@/components/ui/SiteLink'
import type { ModuleButton, Paragraph } from '@/lib/modules/content'

// W80: what the content modules share: their large text and their button.

/**
 * A module's large text, in Figma's H2 (or H1: TextMediaSticky's big size). Figma sets its paragraphs as one text
 * with 8px between them (the style's paragraph spacing), so the style is on the element round them: it is trimmed
 * to the capitals of its first line and the baseline of its last, and each paragraph after the first starts 8px
 * beneath the line before it.
 */
export function LeadText({ paragraphs, size = 'h2', className }: { paragraphs: Paragraph[]; size?: 'h2' | 'h1'; className?: string }) {
  if (paragraphs.length === 0) return null
  return (
    <div data-module-text="" className={`${size === 'h1' ? 'text-h1' : 'text-h2'} text-text-primary [&>p+p]:mt-8 ${className ?? ''}`}>
      {paragraphs.map((paragraph) => (
        <p key={paragraph.key}>{paragraph.text}</p>
      ))}
    </div>
  )
}

/**
 * A module's button: Figma's Button, Type=secondary, Big=No (329:8561), as a link. A link to a section of the page
 * scrolls there, and one to the booking panel opens it (SiteLink).
 */
export function ModuleButtonLink({ button, className }: { button: ModuleButton; className?: string }) {
  return (
    <SiteLink href={button.href} className={`${SMALL_SECONDARY_LINK} ${className ?? ''}`}>
      <ButtonLabel>{button.text}</ButtonLabel>
    </SiteLink>
  )
}
