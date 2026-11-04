import { z } from 'zod'

export const staffRoleSchema = z.enum(['admin', 'manager', 'staff'])
export type StaffRole = z.infer<typeof staffRoleSchema>

/** The acting staff member, as established by staff auth on every /api/v1/staff request. */
export const staffContextSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: staffRoleSchema,
  canIssueRefunds: z.boolean(),
  canManagePricing: z.boolean(),
})
export type StaffContext = z.infer<typeof staffContextSchema>

/** For endpoints that take no input. */
export const emptyInputSchema = z.object({})
export type EmptyInput = z.infer<typeof emptyInputSchema>

/** GET /api/v1/staff/health */
export const staffHealthOutputSchema = z.object({
  database: z.literal('ok'),
  /** The deployed Worker version id, or "dev" when running locally. */
  version: z.string(),
})
export type StaffHealthOutput = z.infer<typeof staffHealthOutputSchema>

/** GET /api/v1/staff/whoami */
export const staffWhoamiOutputSchema = staffContextSchema
export type StaffWhoamiOutput = z.infer<typeof staffWhoamiOutputSchema>

/** POST /api/v1/staff/parity: one old-versus-new comparison from shadowCompare. */
export const staffParityInputSchema = z.object({
  action: z.string().min(1),
  oldResult: z.unknown(),
  newResult: z.unknown(),
  matches: z.boolean(),
  diff: z.unknown(),
})
export type StaffParityInput = z.infer<typeof staffParityInputSchema>

export const staffParityOutputSchema = z.object({ recorded: z.literal(true) })
export type StaffParityOutput = z.infer<typeof staffParityOutputSchema>
