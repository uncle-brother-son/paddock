// W78a (WQ71): a state Figma names "hover" can be looked at in Storybook without a mouse. The toolbar's State switch
// (and a story of its own for each of Figma's hover variants: `globals: { pseudo: 'hover' }`) marks the story's frame
// with `data-pseudo="hover"`, and every rule of the site's stylesheet that answers to `:hover` is written out a
// second time here to answer to that mark as well. The site's own stylesheet is not touched, and nothing here is in
// the site: a real mouse over a control still shows its hover, here and there, by the one rule.

/** The mark on a story's frame while a state is forced, and the value of the toolbar's switch that sets it. */
export const PSEUDO_ATTRIBUTE = 'data-pseudo'
export const PSEUDO_STATES = ['none', 'hover'] as const
export type PseudoState = (typeof PSEUDO_STATES)[number]

const MADE = 'data-pseudo-states'

/** `(hover: hover)` is a question about the device, not the state: it is put aside while the state is rewritten. */
const DEVICE = /\(\s*hover\s*:\s*hover\s*\)/g
const KEPT = '(--device-can-hover)'

/** `:hover` as a state. Never the colon of a class's own name (`.hover\:bg-x` is written `hover\:`, `.md\:hover\:x` `\:hover`). */
const STATE = /(?<!\\):hover/g

const FORCED = `:is(:hover, [${PSEUDO_ATTRIBUTE}~="hover"], [${PSEUDO_ATTRIBUTE}~="hover"] *)`

const usesHover = (css: string): boolean => /(?<!\\):hover/.test(css.replace(DEVICE, ''))

const forced = (css: string): string => css.replace(DEVICE, KEPT).replace(STATE, FORCED).replaceAll(KEPT, '(hover: hover)')

/** The rules among `rules` that answer to `:hover`, rewritten, each still inside whatever it was inside (a layer, a media query, a rule it is nested in). */
function forcedRules(rules: CSSRuleList): string {
  let out = ''
  for (const rule of rules) {
    if (!usesHover(rule.cssText)) continue
    if (rule instanceof CSSStyleRule && usesHover(rule.selectorText)) {
      out += `${forced(rule.cssText)}\n`
      continue
    }
    const inner = (rule as CSSGroupingRule).cssRules
    if (!inner) continue
    // Only something inside it answers to :hover: its own opening is kept and its own declarations are left out.
    const opening = rule instanceof CSSStyleRule ? rule.selectorText : rule.cssText.slice(0, rule.cssText.indexOf('{'))
    out += `${opening} {\n${forcedRules(inner)}}\n`
  }
  return out
}

/**
 * Writes the forced copies of the hover rules into the document, once for the stylesheets as they now are: called
 * each time a story is drawn with a state forced, so a stylesheet that arrived later (or changed while editing) is in.
 */
export function forcePseudoStates(): void {
  let css = ''
  for (const sheet of document.styleSheets) {
    if (sheet.ownerNode instanceof Element && sheet.ownerNode.hasAttribute(MADE)) continue
    try {
      css += forcedRules(sheet.cssRules)
    } catch {
      // A stylesheet from another origin can't be read: it has none of the site's rules.
    }
  }
  let made = document.head.querySelector<HTMLStyleElement>(`style[${MADE}]`)
  if (!made) {
    made = document.createElement('style')
    made.setAttribute(MADE, '')
    document.head.append(made)
  }
  if (made.textContent !== css) made.textContent = css
}
