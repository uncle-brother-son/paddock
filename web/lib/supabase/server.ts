import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

import { forThisDevice, keepsSignedIn } from './keep-signed-in'

export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            // W85: a sign-in for this visit only ("Keep me signed in" unticked) is written with no lifetime.
            const keep = keepsSignedIn(cookieStore.getAll())
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, forThisDevice(options, keep))
            )
          } catch {
            // The `setAll` method was called from a Server Component.
            // This can be ignored if you have middleware refreshing
            // user sessions.
          }
        },
      },
    }
  )
}
