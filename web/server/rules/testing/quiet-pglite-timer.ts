// W59 (W45 audit row 56; W47a "Noticed" 3, W47b 8, W52a 6): about 3,000 lines a full run said
// "TimeoutOverflowWarning: 41130010000 does not fit into a 32-bit signed integer. Timeout duration was set to 1."
// The timer is PGlite's own: its WebAssembly Postgres arms its timeout alarm (statement and lock timeouts) through
// `__setitimer_js` in @electric-sql/pglite, with a delay worked out against a clock the tests have moved (vi.setSystemTime),
// so it can come out at hundreds of days. Node then sets it to 1 ms, and Postgres looks again at its clock and finds no
// timeout due: that is how every run has passed. The run's behaviour is kept exactly (the timer is not capped, which
// would stop an alarm that is wanted from firing); only this one warning from that one place is no longer printed.
// Any other warning, and this kind from anywhere else, still prints. Proof: quiet-pglite-timer.test.ts.

const PGLITE_TIMER = /__setitimer_js[\s\S]*@electric-sql[\\/]pglite|@electric-sql[\\/]pglite[\s\S]*__setitimer_js/

/** Whether a warning is PGlite's timer one (and nothing else). */
export function isPgliteTimerWarning(warning: Error): boolean {
  return warning.name === 'TimeoutOverflowWarning' && PGLITE_TIMER.test(warning.stack ?? '')
}

/** Node's own printer, then everything but PGlite's timer warning handed to it. */
export function quietPgliteTimer(target: NodeJS.Process = process): void {
  const printers = target.listeners('warning')
  target.removeAllListeners('warning')
  target.on('warning', (warning: Error) => {
    if (isPgliteTimerWarning(warning)) return
    for (const printer of printers) printer.call(target, warning)
  })
}

quietPgliteTimer()
