import { vi } from 'vitest'
import type { Db } from '@/server/db'
import { lapseSweep, type LapseSweepResult } from '@/server/rules/bookings/lapse-sweep'

/*
 * W64 (H-plan 3.3 step 3): the Worker's lapse sweep where a scenario recorded the database's own (scenarios.ts,
 * sweepLapsed), as `replay/lapse-side.ts` ran it (W43), moved here so the all-Worker sweep can run it with nothing of
 * the old code loaded.
 */

/** The request id the replay's sweep writes on its rows. */
export const REPLAY_SWEEP_REQUEST = 'replay-lapse-sweep'

/** The Worker's sweep, run as the hourly job runs it, with the switch it is handed (default: the kind on). */
export async function lapseSweepAsTheWorkerRunsIt(sweepDb: Db, { orderSwitch = 'lapse_sweep', runs }: { orderSwitch?: string | null; runs?: LapseSweepResult[] } = {}): Promise<void> {
  // The clock moves between the scenario's last statement and the run, as it did between the old functions' statements.
  vi.setSystemTime(Date.now() + 1)
  const result = await lapseSweep(sweepDb, { requestId: REPLAY_SWEEP_REQUEST, orderSwitch })
  runs?.push(result)
}
