import { vi } from 'vitest'
import { sweepFile } from './sweep'

// W64 (H-plan 3.3 step 3): the all-Worker sweep, this file's scenarios (sweep.ts, SWEEP_FILES['step-g-1']).
vi.mock('@/server/db/connection', async () => {
  const { sweepDb } = await import('./db-holder')
  return { openRequestDb: () => sweepDb.db, closeRequestDb: () => {} }
})
vi.mock('@/server/stripe/client', async (importOriginal) => {
  const { stripeClientMock } = await import('../replay/stripe-binding')
  return stripeClientMock(await importOriginal<typeof import('@/server/stripe/client')>())
})

sweepFile('step-g-1')
