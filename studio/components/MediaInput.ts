import { useEffect, useRef } from 'react'
import type { ObjectInputProps } from 'sanity'
import { hasPhoneVersion } from '../lib/checks'

/** The name of the media block's "For phones (optional)" group (schemaTypes/objects/media.ts). */
export const PHONES_GROUP = 'phones'

/**
 * The media block's own form, as Sanity draws it, with one thing added (WQ42): the "For phones (optional)" group
 * is closed by default, and opened here when the video already has a file or a poster for phones, so what is there
 * is never hidden from an editor. A fieldset can only say "closed" or "open" for every document alike, so this is
 * done when the form appears, and again if a first file for phones arrives.
 */
export function MediaInput(props: ObjectInputProps) {
  const { onFieldSetExpand, renderDefault, value } = props
  const hasPhones = hasPhoneVersion(value)
  // The latest opener, without making the effect below run again each time the form is drawn: an editor who
  // closes the group by hand keeps it closed.
  const expand = useRef(onFieldSetExpand)
  useEffect(() => {
    expand.current = onFieldSetExpand
  })
  useEffect(() => {
    if (hasPhones) expand.current(PHONES_GROUP)
  }, [hasPhones])
  return renderDefault(props)
}
