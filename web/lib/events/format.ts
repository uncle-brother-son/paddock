// W75: an event's spaces as the designs write them. When it is, on its page and on its card, is written by the
// site's one formatter (W78a, WQ69: `whenLine` in lib/dates.ts, "16:00 - Tuesday 27 October").

/**
 * Under the button of a cancelled event, in the spaces line's place and style (WQ59: a cancelled event's page stays
 * and says so). The designs have no words for it: these are the brief's.
 */
export const EVENT_CANCELLED = 'This event has been cancelled'

/** Under an Event page's button: "6 spaces left", "1 space left". */
export const spacesLine = (spacesLeft: number): string => (spacesLeft === 1 ? '1 space left' : `${spacesLeft} spaces left`)

/** A card is Figma's EventCard Type=sold out (W83, Wayne 27 Nov) when no space is left. */
export const cardSoldOut = (spacesLeft: number): boolean => spacesLeft <= 0

/**
 * On an EventCard, in the card's own capitals: "6 Spaces Left", "1 Space Left". A sold-out event keeps its card
 * (WQ17) with "Sold Out" in its place, as Figma's EventCard Type=sold out writes it (1896:8636, 1896:8646).
 */
export function cardSpaces(spacesLeft: number): string {
  if (cardSoldOut(spacesLeft)) return 'Sold Out'
  return spacesLeft === 1 ? '1 Space Left' : `${spacesLeft} Spaces Left`
}

/** After the price on Figma's EventCard, Type=members only (1802:11329, 1802:11338; W78b, WQ77), in the card's own words. */
export const CARD_MEMBERS_ONLY = 'Members Only'
