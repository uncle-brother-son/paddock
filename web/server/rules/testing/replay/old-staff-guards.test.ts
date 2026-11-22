import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { legacyAdminDir } from './harness'

/*
 * W64a item 7: the old staff app's own staff checks (shared/staffAccess, resolveStaffId, pricingStaff), tested on step
 * G's frozen copy. Moved unchanged from server/staff-app-helpers.test.ts ("inactive staff"), which W61 left testing the
 * copy because the staff app had deleted them: they test the old code only (the Worker's staff check has its own tests,
 * GB14 and FB16), so they go with the copy at W65. The old words are held to the Worker's in staff-app-helpers.test.ts
 * from testing/old-words.json.
 */

const loadOld = (name: string) => import(/* @vite-ignore */ path.join(legacyAdminDir, 'shared', name))

describe('the old staff checks (W01c), on the frozen copy', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const INACTIVE = 'This staff account is inactive. Ask an admin to reactivate it.'
  const row = (active: boolean | null) => ({
    id: 'staff-1',
    email: 'jo@example.com',
    role: 'admin',
    can_issue_refunds: true,
    can_manage_pricing: true,
    active,
  })

  /** A staff table of the given rows, honouring the `AND active = true` filter. */
  function stubStaffTable(rows: Array<ReturnType<typeof row>>) {
    const query = vi.fn(async (sql: string) => ({
      data: sql.includes('AND active = true') ? rows.filter((r) => r.active === true) : rows,
    }))
    vi.stubGlobal('paddockData', { query })
    return query
  }

  const guards = async () => {
    const access = await loadOld('staffAccess')
    const ids = await loadOld('resolveStaffId')
    const pricing = await loadOld('pricingStaff')
    return {
      getStaffAccessRow: access.getStaffAccessRow,
      requireStaffAdmin: access.requireStaffAdmin,
      // W44: requireCanIssueRefunds left the staff app (no caller: the Worker checks Issue refunds).
      resolveStaffId: ids.resolveStaffId,
      requireStaffId: ids.requireStaffId,
      requireCanManagePricing: pricing.requireCanManagePricing,
    } as Record<string, (email: string) => Promise<unknown>>
  }

  it('every lookup gives the same refusal, with active off or unset', async () => {
    for (const active of [false, null]) {
      stubStaffTable([row(active)])
      for (const [name, guard] of Object.entries(await guards())) {
        await expect(guard('jo@example.com'), name).rejects.toThrow(INACTIVE)
      }
    }
  })

  it('every lookup filters on active', async () => {
    const query = stubStaffTable([row(true)])
    for (const guard of Object.values(await guards())) await guard('jo@example.com')
    expect(query.mock.calls.every(([sql]) => sql.includes('AND active = true'))).toBe(true)
  })

  it('active staff pass, with one query', async () => {
    const query = stubStaffTable([row(true)])
    const { getStaffAccessRow, resolveStaffId } = await guards()

    expect(await getStaffAccessRow?.('jo@example.com')).toMatchObject({ id: 'staff-1' })
    expect(await resolveStaffId?.('jo@example.com')).toBe('staff-1')
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('an unknown email keeps its own outcome, not the inactive refusal', async () => {
    stubStaffTable([])
    const { getStaffAccessRow, resolveStaffId, requireStaffId, requireStaffAdmin, requireCanManagePricing } = await guards()

    expect(await getStaffAccessRow?.('x@example.com')).toBeNull()
    expect(await resolveStaffId?.('x@example.com')).toBeNull()
    await expect(requireStaffId?.('x@example.com')).rejects.toThrow('No staff record matches')
    await expect(requireStaffAdmin?.('x@example.com')).rejects.toThrow('No staff record matches')
    await expect(requireCanManagePricing?.('x@example.com')).rejects.toThrow('No staff record matches')
  })

  it('getStaffRowAnyStatus still shows the screen an inactive row', async () => {
    stubStaffTable([row(false)])
    const { getStaffRowAnyStatus } = await loadOld('staffAccess')

    expect(await getStaffRowAnyStatus('jo@example.com')).toMatchObject({ active: false })
  })
})
