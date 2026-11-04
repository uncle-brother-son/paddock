import { describe, it, expect, vi } from 'vitest'
import type { StaffContext } from '@/contracts'
import type { Queryable } from '@/server/db'
import { ApiError } from '@/server/http/errors'
import { authenticateStaff, keysMatch, requireAdmin, requireIssueRefunds, requireManagePricing } from './staff'

const KEY = 'a-long-random-staff-api-key'

const row = {
  id: 'staff-1',
  email: 'jo@example.com',
  role: 'manager',
  can_issue_refunds: true,
  can_manage_pricing: null,
  active: true,
}

function fakeDb(rows: unknown[] = [row]) {
  return { query: vi.fn().mockResolvedValue(rows) } as unknown as Queryable & { query: ReturnType<typeof vi.fn> }
}

function headers(values: Record<string, string> = {}) {
  return new Headers({ authorization: `Bearer ${KEY}`, 'x-staff-email': 'jo@example.com', ...values })
}

async function failure(attempt: Promise<unknown>): Promise<ApiError> {
  const err = await attempt.catch((e: unknown) => e)
  expect(err).toBeInstanceOf(ApiError)
  return err as ApiError
}

describe('keysMatch', () => {
  it('matches only the identical key', async () => {
    expect(await keysMatch(KEY, KEY)).toBe(true)
    expect(await keysMatch(`${KEY}x`, KEY)).toBe(false)
    expect(await keysMatch('', KEY)).toBe(false)
  })
})

describe('authenticateStaff', () => {
  it('builds the StaffContext from the staff row, matching on the exact email', async () => {
    const db = fakeDb()

    const staff = await authenticateStaff(headers(), db, KEY)

    expect(staff).toEqual({
      id: 'staff-1',
      email: 'jo@example.com',
      role: 'manager',
      canIssueRefunds: true,
      canManagePricing: false,
    })
    expect(db.query).toHaveBeenCalledWith(
      'SELECT id, email, role, can_issue_refunds, can_manage_pricing, active FROM staff WHERE email = $1 LIMIT 1',
      ['jo@example.com']
    )
  })

  it('rejects a missing or wrong key without touching the database', async () => {
    for (const authorization of ['', 'Bearer wrong', KEY, `Basic ${KEY}`]) {
      const db = fakeDb()
      const err = await failure(authenticateStaff(headers({ authorization }), db, KEY))
      expect(err.code).toBe('UNAUTHORISED')
      expect(db.query).not.toHaveBeenCalled()
    }
  })

  it('fails closed when STAFF_API_KEY is not set, whatever the caller sends', async () => {
    for (const secret of [undefined, '']) {
      const err = await failure(authenticateStaff(headers({ authorization: 'Bearer ' }), fakeDb(), secret))
      expect(err.code).toBe('UNAUTHORISED')
    }
  })

  it('rejects a request with no staff email', async () => {
    const err = await failure(authenticateStaff(headers({ 'x-staff-email': ' ' }), fakeDb(), KEY))
    expect(err.code).toBe('UNAUTHORISED')
  })

  it("rejects an unknown email with the staff app's wording", async () => {
    const err = await failure(authenticateStaff(headers(), fakeDb([]), KEY))
    expect(err.code).toBe('UNAUTHORISED')
    expect(err.message).toBe(
      "No staff record matches the logged-in user's email (jo@example.com). Ask an admin to add you as staff before performing this action."
    )
  })

  it('rejects inactive staff, and treats an unset active flag as inactive', async () => {
    for (const active of [false, null]) {
      const err = await failure(authenticateStaff(headers(), fakeDb([{ ...row, active }]), KEY))
      expect(err.code).toBe('FORBIDDEN')
    }
  })
})

describe('permission helpers', () => {
  const staff: StaffContext = { id: 's', email: 'e', role: 'staff', canIssueRefunds: false, canManagePricing: false }

  it('requireAdmin allows the admin role only', () => {
    expect(() => requireAdmin({ ...staff, role: 'admin' })).not.toThrow()
    for (const role of ['manager', 'staff'] as const) {
      expect(() => requireAdmin({ ...staff, role })).toThrow('Admins only — this action requires the admin role.')
    }
  })

  it('requireIssueRefunds follows the switch', () => {
    expect(() => requireIssueRefunds({ ...staff, canIssueRefunds: true })).not.toThrow()
    expect(() => requireIssueRefunds(staff)).toThrow(
      'Needs Issue refunds permission — this action moves money back to the customer.'
    )
  })

  it('requireManagePricing follows the switch', () => {
    expect(() => requireManagePricing({ ...staff, canManagePricing: true })).not.toThrow()
    expect(() => requireManagePricing(staff)).toThrow(
      'You do not have permission to manage pricing (staff.can_manage_pricing is off for your account).'
    )
  })

  it('fails as FORBIDDEN', () => {
    try {
      requireAdmin(staff)
      expect.unreachable()
    } catch (err) {
      expect((err as ApiError).code).toBe('FORBIDDEN')
    }
  })
})
