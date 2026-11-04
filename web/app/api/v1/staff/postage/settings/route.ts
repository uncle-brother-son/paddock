import { emptyInputSchema, postageSettingsOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { getPostageSettings } from '@/server/rules/pricing/postage-settings'

export const GET = defineRoute({ auth: 'staff', input: emptyInputSchema, output: postageSettingsOutputSchema }, async ({ db }) => getPostageSettings(db))
