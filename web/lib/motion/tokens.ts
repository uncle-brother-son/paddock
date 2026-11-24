// Motion tokens (WQ20-WQ23): one curve and two durations for the whole site. These are the values Motion reads, in
// seconds; app/globals.css holds the same three as CSS variables (--ease-smooth, --duration-short, --duration-long)
// and tokens.test.ts fails when the two differ. No animation uses its own curve or a typed-in duration:
// typed-in-motion.test.ts looks for one under app/, components/ and features/.

/** The "smooth" curve, cubic-bezier(0, 0, 0.2, 1): every animation uses it. */
export const EASE_SMOOTH = [0, 0, 0.2, 1] as const

/** The same curve as CSS writes it, for the rare place that needs the words and can't use `var(--ease-smooth)`. */
export const EASE_SMOOTH_CSS = `cubic-bezier(${EASE_SMOOTH.join(', ')})`

/** Hovers, and the panels (Menu, Book, Bag, Sign in). Seconds. */
export const DURATION_SHORT = 0.32

/** Page transitions, and each of the intro's three transitions. Seconds. */
export const DURATION_LONG = 0.64
