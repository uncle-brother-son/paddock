import { Memberships } from '@/components/modules/content/Memberships'
import { SessionPasses } from '@/components/modules/content/SessionPasses'
import { readMembershipCards, readPassCards } from '@/lib/memberships/pages'
import type { SectionSettings } from '@/lib/modules/section'
import type { RichText } from '@/lib/sanity/schemas'

// W81 (WQ84-WQ86): the Memberships and Session Passes modules read their cards here, as the Upcoming Events module
// reads its events, and hand them to the components that draw them (components/modules/content/).

/**
 * The Memberships module (W81's `memberships`): the Membership cards an editor made in Sanity, each with the plans
 * on sale and their prices from the Worker. An editor gives the module only its heading and the note under the
 * cards. With no card to show it draws nothing.
 */
export async function MembershipsModule({ heading, note, theme, sectionId }: SectionSettings & { heading: string | null; note: RichText }) {
  const { cards, saveUpTo } = await readMembershipCards()
  return <Memberships heading={heading?.trim() || null} saveUpTo={saveUpTo} cards={cards} note={note} theme={theme} sectionId={sectionId} />
}

/**
 * The Session Passes module (W81's `sessionPasses`): the Session Pass cards, each with the passes on sale, their
 * prices and how long they last from the Worker. With no card to show it draws nothing.
 */
export async function SessionPassesModule({ heading, theme, sectionId }: SectionSettings & { heading: string | null }) {
  const cards = await readPassCards()
  return <SessionPasses heading={heading?.trim() || null} cards={cards} theme={theme} sectionId={sectionId} />
}
