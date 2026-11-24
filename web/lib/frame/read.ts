import { connection } from 'next/server'
import { cache } from 'react'

import { readSanity } from '@/lib/sanity/read'

import { frameContent, londonYear, type FrameContent } from './content'

/** A read that failed (Sanity not reachable, no project set, an answer that doesn't fit) is "not there": the frame still stands. */
async function orNull<T>(what: string, read: () => Promise<T | null>): Promise<T | null> {
  try {
    return await read()
  } catch (error) {
    console.error(`The frame could not read ${what} from Sanity; it is shown without it.`, error)
    return null
  }
}

/**
 * Site settings and Navigation, read once for each request however many parts of the page ask (React's `cache`,
 * Next's way to share a read that is not a `fetch`). `connection()` makes it a read at request time: a page is never
 * built once with the menu of that moment baked in. Between requests Sanity's CDN holds each query's answer until the
 * dataset next changes (lib/sanity/read.ts).
 */
export const readFrame = cache(async (): Promise<FrameContent> => {
  await connection()
  const [settings, navigation] = await Promise.all([
    orNull('Site settings', () => readSanity('siteSettings')),
    orNull('Navigation', () => readSanity('navigation')),
  ])
  return frameContent(settings, navigation, londonYear())
})
