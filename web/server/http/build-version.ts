import 'server-only'
import { getCloudflareContext } from '@opennextjs/cloudflare'

declare global {
  interface CloudflareEnv {
    CF_VERSION_METADATA?: { id: string }
  }
}

/** The deployed Worker version id, or "dev" outside Workers. */
export function buildVersion(): string {
  try {
    return getCloudflareContext().env.CF_VERSION_METADATA?.id ?? 'dev'
  } catch {
    return 'dev'
  }
}
