import { useId } from 'react'

/** One drawing from components/brand/art/ (made by scripts/build-brand.mjs): its own box and what is inside it. */
export type Art = { readonly width: number; readonly height: number; readonly ids: boolean; readonly body: string }

/** What the script puts in front of every id inside a drawing (scripts/build-brand.mjs, ID_TOKEN). */
const ID_TOKEN = '__BRAND_ID__'

type BrandSvgProps = {
  art: Art
  /** Its name for a screen reader. Left out, the drawing is decoration and hidden from one. */
  label?: string | undefined
  className?: string | undefined
}

/**
 * Draws one of the brand's SVG files inline, at the file's own size unless a class sizes it. The ids inside (the
 * logos' masks and strokes) get this element's own id in front, so two of the same logo on a page never share one.
 * The markup is the repo's own file, checked by the script: no script, no handler, no outside address.
 */
export function BrandSvg({ art, label, className }: BrandSvgProps) {
  const id = useId().replace(/[^A-Za-z0-9]/g, '')
  const body = art.ids ? art.body.replaceAll(ID_TOKEN, `${id}-`) : art.body
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={art.width}
      height={art.height}
      viewBox={`0 0 ${art.width} ${art.height}`}
      fill="none"
      className={className}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
      focusable="false"
      dangerouslySetInnerHTML={{ __html: body }}
    />
  )
}
