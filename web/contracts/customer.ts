import { z } from 'zod'

/** The signed-in website customer, as established by customer auth on /api/v1/customer requests. */
export const customerContextSchema = z.object({
  customerId: z.string(),
  authUserId: z.string(),
  email: z.string(),
})
export type CustomerContext = z.infer<typeof customerContextSchema>
