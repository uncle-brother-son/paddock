// W78b (WQ78): the Book panel's two columns from 768px, at every width.
//
// Figma draws the panel at 1440 (and at 390, one column): a column of the panel's 24 free, then the calendar and the
// log-in bar (6 columns), two columns free, then the day's sessions (13 columns), and two free at the right. The
// add-ons step is the same row with other shares: one free, the add-ons (12), two free, "Your booking" (7), two free.
//
// On a narrower window those columns are too narrow for what they hold (at 1024 a calendar's 6 columns are 236px, and
// its seven days need 255). So each step is a row that keeps Figma's sizes and gives way in this order:
// - the narrow column (the calendar with the log-in bar; "Your booking") is its columns of the 24, and never
//   narrower than 334px: the width Figma draws it at on a phone (the 366 panel less its 16px margins);
// - the wide column (the sessions; the add-ons) takes what is left, up to its columns of the 24, and what it holds
//   wraps as it does on a phone when it no longer fits on a line (SessionRow, the add-on cards);
// - once the wide column is down to 334px too, the free columns give way. At 768px the two columns are side by side,
//   each about as wide as the phone's one.
// From 1424px every column is exactly on the panel's grid, as drawn. Below 768px the step is one column (the page
// grid's six), and none of this applies.
//
// One column of the 24 is (100% - 23 gutters) / 24 of the row's own width, its margins being padding outside that.
// The classes are written out whole: Tailwind reads them as text.

/** The step's row from 768px: the page grid's margins and gutter, as a row whose parts are sized below. */
export const STEP_ROW = 'md:flex md:overflow-visible md:pb-0'

/** The one free column before the first part. It gives way before a part goes under its least width. */
export const FREE_ONE = 'hidden md:block md:min-w-0 md:shrink md:grow-0 md:basis-[calc((100%_-_var(--grid-gutter)_*_23)_/_24)]'

/** The two free columns between the parts. */
export const FREE_TWO = 'hidden md:block md:min-w-0 md:shrink md:grow-0 md:basis-[calc((100%_-_var(--grid-gutter)_*_23)_/_24_*_2_+_var(--grid-gutter))]'

/** The calendar and the log-in bar: 6 columns, never under 334px. Taller than the panel, it scrolls by itself. */
export const SIX_COLUMNS = 'md:min-h-0 md:w-[max(334px,calc((100%_-_var(--grid-gutter)_*_23)_/_24_*_6_+_var(--grid-gutter)_*_5))] md:flex-none md:overflow-y-auto'

/** "Your booking": 7 columns, never under 334px. Taller than the panel, it scrolls by itself. */
export const SEVEN_COLUMNS = 'md:min-h-0 md:w-[max(334px,calc((100%_-_var(--grid-gutter)_*_23)_/_24_*_7_+_var(--grid-gutter)_*_6))] md:flex-none md:overflow-y-auto'

/** The day's sessions: what is left, from 334px up to 13 columns. */
export const THIRTEEN_COLUMNS = 'md:min-w-[334px] md:max-w-[calc((100%_-_var(--grid-gutter)_*_23)_/_24_*_13_+_var(--grid-gutter)_*_12)] md:flex-1'

/**
 * The add-ons: what is left, from 334px up to 12 columns. It scrolls by itself and reaches 8px past its columns each
 * side, so a focus ring at its edge is whole: its box is 16px wider than its columns, and sits 8px out each side.
 */
export const TWELVE_COLUMNS =
  'md:-mx-8 md:min-h-0 md:min-w-[calc(334px_+_var(--spacing-16))] md:max-w-[calc((100%_-_var(--grid-gutter)_*_23)_/_24_*_12_+_var(--grid-gutter)_*_11_+_var(--spacing-16))] md:flex-1 md:overflow-y-auto md:px-8'
