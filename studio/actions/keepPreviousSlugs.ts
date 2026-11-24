import {
  useDocumentOperation,
  type DocumentActionComponent,
  type DocumentActionProps,
  type DuplicateDocumentActionComponent,
} from 'sanity'
import {previousSlugsAfter, sameSlugs} from '../lib/checks'

// W72a (docs/build-standards.md: when an editor changes a slug, the old address keeps working). Each document with an
// address of its own keeps a hidden `previousSlugs` list. Publish adds the slug being replaced to it, and takes the
// new slug out of it (so a slug that goes back to an old value never points at itself). The site answers each old
// slug with a 301 to the current address (web/lib/sanity/redirects.ts).

/** The document types with an address of their own. The gift card's is the site's (/shop/gift-card): it has no slug. */
const KEEPS_PREVIOUS_SLUGS = ['contentPage', 'infoPage', 'product', 'event']

export const keepsPreviousSlugs = (type: string): boolean => KEEPS_PREVIOUS_SLUGS.includes(type)

type Slugged = {slug?: {current?: string}; previousSlugs?: string[]} | null

/**
 * The Studio's own Publish action, with one step first: the list of old slugs brought up to date on the draft, so
 * the publish carries it. Everything else (its label, when it is disabled, validation) is the original's.
 */
export function keepPreviousSlugsOnPublish(publishAction: DocumentActionComponent): DocumentActionComponent {
  const PublishKeepingSlugs: DocumentActionComponent = (props: DocumentActionProps) => {
    const original = publishAction(props)
    const {patch} = useDocumentOperation(props.id, props.type)
    if (!original) return null
    return {
      ...original,
      onHandle: () => {
        const draft = props.draft as Slugged
        const published = props.published as Slugged
        if (draft) {
          const before = draft.previousSlugs ?? []
          const after = previousSlugsAfter(before, published?.slug?.current, draft.slug?.current)
          if (!sameSlugs(before, after)) patch.execute([{set: {previousSlugs: after}}])
        }
        original.onHandle?.()
      },
    }
  }
  // Still the publish action to anything that looks for it by name.
  PublishKeepingSlugs.action = 'publish'
  PublishKeepingSlugs.displayName = 'PublishKeepingSlugs'
  return PublishKeepingSlugs
}

/**
 * The Studio's own Duplicate action, leaving the old slugs behind: they are the original's addresses, and a copy
 * holding them would stop the original taking one back (and events are made by duplicating: WQ17).
 */
export function duplicateWithoutPreviousSlugs(
  duplicateAction: DuplicateDocumentActionComponent,
): DuplicateDocumentActionComponent {
  const DuplicateWithoutSlugs: DuplicateDocumentActionComponent = (props) =>
    duplicateAction({
      ...props,
      mapDocument: (document) => {
        const copy = {...document}
        delete copy.previousSlugs
        return copy
      },
    })
  DuplicateWithoutSlugs.action = 'duplicate'
  DuplicateWithoutSlugs.displayName = 'DuplicateWithoutSlugs'
  return DuplicateWithoutSlugs
}
