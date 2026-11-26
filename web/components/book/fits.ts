// W78b (WQ78): what "nothing overlaps and nothing is cut off" means for the Book panel, as one measure. The Book
// stories ask it at every width they are run at (BookPanel.widths.stories.tsx), and the real panel is asked the same
// on a running site (staff app repo, briefs/W78b-logs/tools/book-widths.cjs). It draws nothing and the site never
// runs it: it reads boxes.

/** Half a pixel either way is the browser's own rounding; a whole pixel is something out of its place. */
const SLACK = 1

type Box = { left: number; right: number; top: number; bottom: number }

/** One of the things the panel shows: a line of words, a button, a picture. */
type Part = { element: Element; box: Box }

const SHOWN_CONTROLS = 'button, img, select, textarea'

const isSeen = (element: Element): boolean => {
  const { width, height } = element.getBoundingClientRect()
  // A screen reader's own words (sr-only) are a pixel square; an invisible copy that only holds room is not seen.
  return width > 2 && height > 2 && getComputedStyle(element).visibility === 'visible'
}

/** The text nodes that are an element's own, not its children's. */
const ownWords = (element: Element): Text[] => [...element.childNodes].filter((node): node is Text => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== '')

/**
 * Where a part is: its own box, made wider by its words wherever they run out of it (a box can be squeezed narrower
 * than the words it holds, and the words are then drawn over whatever is beside it).
 */
function boxOf(element: Element): Box {
  const own = element.getBoundingClientRect()
  const box = { left: own.left, right: own.right, top: own.top, bottom: own.bottom }
  for (const words of ownWords(element)) {
    const range = document.createRange()
    range.selectNode(words)
    for (const line of range.getClientRects()) {
      if (line.width === 0) continue
      box.left = Math.min(box.left, line.left)
      box.right = Math.max(box.right, line.right)
    }
  }
  return box
}

const partsIn = (root: Element): Part[] =>
  [...root.querySelectorAll('*')]
    .filter((element) => (element.matches(SHOWN_CONTROLS) || ownWords(element).length > 0) && isSeen(element))
    .map((element) => ({ element, box: boxOf(element) }))

const named = (element: Element): string => {
  const words = (element.getAttribute('aria-label') ?? element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)
  const book = element.closest('[data-book]')?.getAttribute('data-book')
  return `${element.tagName.toLowerCase()}${book ? ` in ${book}` : ''} "${words}"`
}

const clipsSideways = (style: CSSStyleDeclaration): boolean => style.overflowX !== 'visible'
const clipsUpAndDown = (style: CSSStyleDeclaration): boolean => style.overflowY === 'hidden' || style.overflowY === 'clip'
const scrollsUpAndDown = (style: CSSStyleDeclaration): boolean => style.overflowY === 'auto' || style.overflowY === 'scroll'

const isFilled = (style: CSSStyleDeclaration): boolean => {
  const fill = style.backgroundColor
  return fill !== 'transparent' && !/^rgba\(.*,\s*0\)$/.test(fill) && !/\/\s*0\)$/.test(fill)
}

const pixels = (value: string): number => Number.parseInt(value, 10) || 0

/** The room inside a filled box, between its left and right padding: where what it holds belongs. */
function insideOf(element: Element, style: CSSStyleDeclaration): Pick<Box, 'left' | 'right'> {
  const box = element.getBoundingClientRect()
  return { left: box.left + pixels(style.borderLeftWidth) + pixels(style.paddingLeft), right: box.right - pixels(style.borderRightWidth) - pixels(style.paddingRight) }
}

/**
 * Everything in the panel that is out of its place, in words; an empty list when all is well:
 * - two parts that overlap (neither inside the other);
 * - a part that runs out of the filled box it sits in (a row, a card, a button: its words over the box's padding or
 *   past its edge), or out of a box that cuts off what leaves it;
 * - a part cut off above or below with no way to scroll to it, and a box that scrolls up and down which itself
 *   leaves the panel;
 * - a box that would scroll sideways.
 */
export function misfitsIn(panel: Element): string[] {
  const found: string[] = []
  const parts = partsIn(panel)

  for (const [index, first] of parts.entries()) {
    for (const second of parts.slice(index + 1)) {
      if (first.element.contains(second.element) || second.element.contains(first.element)) continue
      const across = Math.min(first.box.right, second.box.right) - Math.max(first.box.left, second.box.left)
      const down = Math.min(first.box.bottom, second.box.bottom) - Math.max(first.box.top, second.box.top)
      if (across > SLACK && down > SLACK) found.push(`overlap: ${named(first.element)} and ${named(second.element)} by ${Math.round(across)} x ${Math.round(down)}`)
    }
  }

  for (const { element, box } of parts) {
    let reached = false
    for (let holder = element.parentElement; holder; holder = holder === panel ? null : holder.parentElement) {
      const style = getComputedStyle(holder)
      const edge = holder.getBoundingClientRect()
      if (clipsSideways(style) && (box.left < edge.left - SLACK || box.right > edge.right + SLACK)) found.push(`cut off at the side: ${named(element)} by ${named(holder)}`)
      else if (isFilled(style)) {
        const inside = insideOf(holder, style)
        if (box.left < inside.left - SLACK || box.right > inside.right + SLACK) found.push(`out of its box: ${named(element)} in ${holder.tagName.toLowerCase()} by ${Math.round(Math.max(inside.left - box.left, box.right - inside.right))}`)
      }
      if (scrollsUpAndDown(style)) reached = true
      if (!reached && clipsUpAndDown(style) && (box.top < edge.top - SLACK || box.bottom > edge.bottom + SLACK)) found.push(`cut off above or below: ${named(element)}`)
    }
  }

  const edge = panel.getBoundingClientRect()
  for (const holder of [panel, ...panel.querySelectorAll('*')]) {
    if (!isSeen(holder)) continue
    const style = getComputedStyle(holder)
    if (clipsSideways(style) && holder.scrollWidth > holder.clientWidth + SLACK) found.push(`scrolls sideways: ${named(holder)} by ${holder.scrollWidth - holder.clientWidth}`)
    if (holder !== panel && scrollsUpAndDown(style)) {
      const box = holder.getBoundingClientRect()
      if (box.top < edge.top - SLACK || box.bottom > edge.bottom + SLACK) found.push(`a scrolling box leaves the panel: ${named(holder)}`)
    }
  }
  if (document.documentElement.scrollWidth > window.innerWidth + SLACK) found.push('the page behind scrolls sideways')
  // One line for each thing wrong, however many times it was met on the way up.
  return [...new Set(found)]
}
