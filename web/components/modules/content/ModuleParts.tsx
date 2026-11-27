import type { ReactNode } from 'react'

import { ButtonLabel, SMALL_SECONDARY_LINK } from '@/components/ui/buttons/Button'
import { SiteLink } from '@/components/ui/SiteLink'
import { TextLink } from '@/components/ui/TextLink'
import type { ModuleButton, Paragraph } from '@/lib/modules/content'

// W80: what the content modules share: their large text and their button.

/**
 * A module's large text, in Figma's H2 (or H1: TextMediaSticky's big size). Figma sets its paragraphs as one text
 * with 8px between them (the style's paragraph spacing), so the style is on the element round them: it is trimmed
 * to the capitals of its first line and the baseline of its last, and each paragraph after the first starts 8px
 * beneath the line before it.
 *
 * WQ89 (Wayne, 27 Nov): paragraphs and links only. A link is a TextLink in the paragraph's own type (`size="text"`):
 * underlined, Text/Muted Primary, Text/Primary on hover and keyboard focus.
 *
 * `runIn`: a heading that runs in at the start of the first line (TextMediaSticky's big size, as Figma's Homepage
 * mobile draws it, 1678:6640). It is the first thing inside, floated to the left with its capitals level with the
 * text's, so the first line's words start after it and the lines below run the text's whole width. It is the real
 * heading, read before the text; no space is typed into the words for it.
 */
export function LeadText({ paragraphs, size = 'h2', runIn, className }: { paragraphs: Paragraph[]; size?: 'h2' | 'h1'; runIn?: ReactNode; className?: string }) {
  if (paragraphs.length === 0) return null
  return (
    <div data-module-text="" className={`${size === 'h1' ? 'text-h1' : 'text-h2'} text-text-primary [&>p+p]:mt-8 ${className ?? ''}`}>
      {runIn}
      {paragraphs.map((paragraph) => (
        <p key={paragraph.key}>
          {paragraph.parts
            ? paragraph.parts.map((part) =>
                part.href ? (
                  <TextLink key={part.key} href={part.href} size="text">
                    {part.text}
                  </TextLink>
                ) : (
                  <span key={part.key}>{part.text}</span>
                ),
              )
            : paragraph.text}
        </p>
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
