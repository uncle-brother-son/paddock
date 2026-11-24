import type { ReactNode } from 'react'

import { Icon } from '@/components/brand/Icon'
import { linkHref } from '@/lib/sanity/links'
import type { RichText as RichTextBlocks } from '@/lib/sanity/schemas'

import { TextLink } from './TextLink'

type Block = RichTextBlocks[number]

/** One block's words: plain, bold (Bold 14's weight) and linked. A link to a page that isn't published is plain words (WQ24). */
function Spans({ block }: { block: Block }) {
  return block.children.map((span) => {
    let words: ReactNode = span.text
    for (const mark of span.marks) {
      if (mark === 'strong') {
        words = <strong className="font-medium">{words}</strong>
        continue
      }
      const link = block.markDefs.find((definition) => definition._key === mark)?.link
      const href = link ? linkHref(link) : null
      if (href) words = <TextLink href={href}>{words}</TextLink>
    }
    return <span key={span._key}>{words}</span>
  })
}

/** Bullets that follow one another are one list. */
function grouped(blocks: RichTextBlocks): Array<{ key: string; list: boolean; blocks: Block[] }> {
  const groups: Array<{ key: string; list: boolean; blocks: Block[] }> = []
  for (const block of blocks) {
    const list = block.listItem === 'bullet'
    const last = groups[groups.length - 1]
    if (list && last?.list) last.blocks.push(block)
    else groups.push({ key: block._key, list, blocks: [block] })
  }
  return groups
}

/**
 * Sanity's one rich text (W72: paragraphs, bullets, bold and links) in Copy 14, with Link 14 for its links. Every
 * text style is trimmed to its capitals, so the room between paragraphs is a gap from the spacing scale. Drawn on
 * the server: the words are in the page's HTML.
 *
 * W74: `spacing="panel"` is the Product Info Panel's, as Figma draws rich text there (1402:53320): 32px between a
 * paragraph and a list, and 4px between a bullet and its words.
 */
export function RichText({ blocks, className, spacing = 'page' }: { blocks: RichTextBlocks; className?: string; spacing?: 'page' | 'panel' }) {
  const panel = spacing === 'panel'
  return (
    <div className={`flex flex-col ${panel ? 'gap-32' : 'gap-16'} ${className ?? ''}`}>
      {grouped(blocks).map((group) =>
        group.list ? (
          <ul key={group.key} className="flex flex-col gap-12">
            {group.blocks.map((block) => (
              <li key={block._key} className={`flex items-start ${panel ? 'gap-4' : 'gap-8'}`}>
                <Icon name="bullet" />
                <p className="text-copy-14">
                  <Spans block={block} />
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p key={group.key} className="text-copy-14">
            <Spans block={group.blocks[0]!} />
          </p>
        ),
      )}
    </div>
  )
}
