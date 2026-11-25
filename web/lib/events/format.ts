// W75: an event's spaces as the designs write them. When it is, on its page and on its card, is written by the
// site's one formatter (W78a, WQ69: `whenLine` in lib/dates.ts, "16:00 - Tuesday 27 October").

/**
 * Under the button of a cancelled event, in the spaces line's place and style (WQ59: a cancelled event's page stays
 * and says so). The designs have no words for it: these are the brief's.
 */
export const EVENT_CANCELLED = 'This event has been cancelled'

/** Under an Event page's button: "6 spaces left", "1 space left". */
export const spacesLine = (spacesLeft: number): string => (spacesLeft === 1 ? '1 space left' : `${spacesLeft} spaces left`)

/**
 * On an EventCard, in the card's own capitals: "6 Spaces Left", "1 Space Left". A sold-out event keeps its card
 * (WQ17) with "Sold out" in its place: the card set draws no sold-out state, so these are the brief's words.
 */
export function cardSpaces(spacesLeft: number): string {
  if (spacesLeft <= 0) return 'Sold out'
  return spacesLeft === 1 ? '1 Space Left' : `${spacesLeft} Spaces Left`
}
