// Brief W57 (G-plan 1.4, 4.4, 4.7; bugs GB1, GB2, GB19, GB20; Wayne's Q53): the new words of membership plans and
// membership settings, for what the old functions had no words of their own for. The old functions' own sentences
// stay in failure-messages.ts (CATALOG_ADMIN_WORDS, LEGACY_CATALOG_ROUTE_WORDS), held to the frozen copy by
// server/rules/admin/words.test.ts; these are kept apart so that test still holds both ways. Read-only: a read may
// import it.

const money = (pounds: number): string => `£${pounds.toFixed(2)}`
const members = (count: number): string => (count === 1 ? '1 member' : `${count} members`)

/** A plan's price as the dialog shows it before the press (Q53), per frequency whose price changes. */
export interface PlanMoveFigures {
  monthly?: { members: number; price: number }
  yearly?: { members: number; price: number }
}

/**
 * Q53 (Wayne, 21 Nov): what the dialog says before the press. "3 members on this plan will pay £50.00 a month from
 * their next renewal." With both prices changing, both are named; with nobody on the changed price, it says so.
 */
export function planMoveWords(figures: PlanMoveFigures): string {
  const { monthly, yearly } = figures
  if (!monthly && !yearly) return 'No price changes, so no member is moved.'
  if ((monthly?.members ?? 0) + (yearly?.members ?? 0) === 0) return 'No member is on the price that changes, so nobody is moved. New members pay the new price.'
  const month = monthly ? `${members(monthly.members)} on this plan will pay ${money(monthly.price)} a month` : null
  if (month && !yearly) return `${month} from their next renewal.`
  const year = yearly ? `${members(yearly.members)}${month ? '' : ' on this plan'} will pay ${money(yearly.price)} a year` : ''
  return month ? `${month}, and ${year}, from their next renewal.` : `${year} from their next renewal.`
}

/** Q53: what staff are told after the press, as replace card says it: "3 moved, 0 still to move." */
export function planMovedWords(moved: number, toMove: number): string {
  return `${moved} moved, ${toMove} still to move.`
}

export const PLAN_NEW_WORDS = {
  /** A press that changes a price without the member count the dialog showed (Q53). */
  confirmCountMissing:
    "A plan's price change moves the members on it to the new price from their next renewal, so it needs the number of members the screen showed. Use Edit on the Membership Plans page, which shows it first.",
  /** Q53: the number of members who will move has changed since the dialog showed it. */
  countChanged: (shown: unknown, now: number): string =>
    `The number of members on this plan's changing price is now ${now}, not ${String(shown)}: someone joined or left since the page loaded. The page has been reloaded: check the number and save again.`,
  /** A second price change while one on the plan is still being made, or its members are still being moved by its press. */
  changeStillOpen:
    "A price change on this plan is still being made in Stripe (or its members are still being moved). Wait a few minutes for it to finish, reload the page, then try again. If it is still here after 20 minutes, check the Orders page's list of things that need attention.",
  /** Stripe refused the new price: the price is unchanged; the details the same press carried were saved (D1). */
  priceRefused: (stripeMessage: string): string =>
    `Stripe refused the new price, so the plan's price was not changed (its other details were saved): ${stripeMessage}`,
  /** The new price got no clear answer from Stripe: the change is held for the automatic check. */
  priceHeld:
    "The new price didn't get a clear answer from Stripe, so the plan still has its old price for now (its other details were saved). The automatic check finishes the change, or marks it failed, within about 20 minutes: reload the page then. Don't change the price again before that.",
  /** The price was changed, and the moves went as the counts say (Q53). */
  priceChanged: (moved: number, toMove: number): string =>
    toMove === 0
      ? `Price changed. ${planMovedWords(moved, toMove)}`
      : `Price changed. ${planMovedWords(moved, toMove)} The automatic check moves the rest within about 20 minutes; any Stripe refuses for good is listed on the Orders page.`,
  /** GB20: the plan's Stripe set-up was refused for good. The row stays off sale and is left off every list. */
  createRefused: (stripeMessage: string): string => `Stripe refused to set up the plan, so it was not made: ${stripeMessage}`,
  /** GB20: the plan's Stripe set-up got no clear answer: the plan is left off sale for the automatic check to finish. */
  createHeld:
    "The plan was saved off sale, but setting it up in Stripe didn't get a clear answer. The automatic check finishes it and puts it on sale (or says it failed) within about 20 minutes. Don't make it again.",
  /** On sale for a plan with no Stripe product (never set up, or one whose set-up failed). */
  noStripeProduct: "This plan isn't set up in Stripe, so it can't be put on sale. Make a new plan instead.",
  /** On sale while the plan is still being set up in Stripe. */
  stillBeingSetUp: 'This plan is still being set up in Stripe. Wait for it to go on sale by itself (about 20 minutes at most), then reload the page.',
  /** On sale while the off-sale press's Stripe step may still be on its way. */
  offStillBeingSent: 'This plan was just taken off sale and Stripe is still being told. Try again in a few minutes.',
  /** On sale: Stripe refused to put the product back on sale. Nothing changed. */
  onRefused: (stripeMessage: string): string => `Stripe refused to put the plan back on sale, so it is still off sale: ${stripeMessage}`,
  /** On sale: no clear answer from Stripe. Nothing changed here. */
  onUnclear: "Putting the plan back on sale didn't get a clear answer from Stripe, so it is still off sale here. Press the switch again.",
  /**
   * W57a (W57 review L3): on sale, but an off press for the plan was made while this one was at Stripe. The off press
   * stands (the row stays off, and its Stripe step is sent or checked); nothing is written for this one.
   */
  offPressedMeanwhile: 'Someone took this plan off sale while this was putting it back on sale, so it stays off sale. Reload the page, and press the switch again if it should be on sale.',
  /** A plan's details or price, sent with isUnlimited that isn't true or false (the details edit never checked it). */
  isUnlimitedTrueOrFalse: 'isUnlimited must be true or false',
} as const

/** GB19: what the settings control says before the press: how many members' Herd status the new waiting period changes. */
export function herdChangeWords(months: number, becomeHerd: number, leaveHerd: number): string {
  const total = becomeHerd + leaveHerd
  if (total === 0) return `With ${months} month${months === 1 ? '' : 's'}, no member's Herd status changes.`
  const parts: string[] = []
  if (becomeHerd > 0) parts.push(`${members(becomeHerd)} ${becomeHerd === 1 ? 'becomes a Herd member' : 'become Herd members'} (add-on credits usable at once)`)
  if (leaveHerd > 0) parts.push(`${members(leaveHerd)} ${leaveHerd === 1 ? 'stops being a Herd member' : 'stop being Herd members'}`)
  return `With ${months} month${months === 1 ? '' : 's'}: ${parts.join(', and ')}.`
}

export const MEMBERSHIP_SETTINGS_NEW_WORDS = {
  /** GB19: the press without the count the control showed. */
  confirmCountMissing: "Changing the waiting period changes members' Herd status, so it needs the number the screen showed. Reload the page and save again.",
  /** GB19: the count has changed since it was shown. */
  countChanged: (shown: unknown, now: number): string =>
    `The number of members whose Herd status changes is now ${now}, not ${String(shown)}. The page has been reloaded: check it and save again.`,
} as const

/** The stuck list's words for a plan's own lines (G-plan 4.7). */
export const PLAN_STUCK_WORDS = {
  priceHeld: (planName: string): string =>
    `A price change on the plan "${planName}" didn't get a clear answer from Stripe, so the plan still has its old price. The automatic check looks for the new price every 5 minutes: it finishes the change if Stripe made it, or marks it failed. Nothing to do yet. If this is still here after an hour, tell a manager.`,
  createHeld: (planName: string): string =>
    `The new plan "${planName}" was saved off sale, but setting it up in Stripe didn't finish. The automatic check finishes it every 5 minutes and then puts it on sale. Nothing to do yet. If this is still here after an hour, tell a manager.`,
  productLeft: (planName: string, active: boolean): string =>
    `The plan "${planName}" was ${active ? 'put on' : 'taken off'} sale here, but Stripe hasn't confirmed its product ${active ? 'on' : 'off'} sale yet. The automatic check tries again every 5 minutes. Nothing to do yet. If this is still here after an hour, set the product ${active ? 'active' : 'archived'} in Stripe by hand (or tell a manager).`,
  productRefused: (planName: string, active: boolean): string =>
    `The plan "${planName}" was ${active ? 'put on' : 'taken off'} sale here, but Stripe refused to ${active ? 'put its product on sale' : 'archive its product'}, so the automatic check has stopped trying. Set the product ${active ? 'active' : 'archived'} in Stripe by hand (or tell a manager), then press Mark sorted (needs the Issue refunds permission).`,
  archiveLeft: (planName: string): string =>
    `The plan "${planName}" has a new price, but Stripe hasn't confirmed its old price archived yet. Nothing sells on the old price here; the automatic check tries again every 5 minutes. Nothing to do yet.`,
  archiveRefused: (planName: string): string =>
    `The plan "${planName}" has a new price, but Stripe refused to archive the old one, so the automatic check has stopped trying. Nothing here sells on it. Archive the old price in Stripe by hand (or tell a manager), then press Mark sorted (needs the Issue refunds permission).`,
} as const
