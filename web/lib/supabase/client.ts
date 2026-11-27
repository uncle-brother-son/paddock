import { createBrowserClient, parseCookieHeader, serializeCookieHeader } from '@supabase/ssr'

import { forThisDevice, keepsSignedIn } from './keep-signed-in'

/**
 * The browser's Supabase client: sign-in only, with the anon key (server/no-service-role-key.test.ts); one a page
 * (Supabase's own rule in a browser). W85: its cookies are read and written here, not by Supabase's default, so that
 * "Keep me signed in" unticked writes them with no lifetime of their own (lib/supabase/keep-signed-in.ts).
 */
export function createClient() {
  return createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll() {
        return parseCookieHeader(document.cookie)
      },
      setAll(cookiesToSet) {
        const keep = keepsSignedIn(parseCookieHeader(document.cookie))
        for (const { name, value, options } of cookiesToSet) document.cookie = serializeCookieHeader(name, value, forThisDevice(options, keep))
      },
    },
  })
}
