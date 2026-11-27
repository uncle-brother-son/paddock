import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// Brief W71, item 7: what the root layout gives every page. The layout itself can't be loaded here (next/font only
// runs inside Next's build), so this reads its source; the built page is checked in a browser for each brief's report.

const layout = readFileSync(path.resolve(__dirname, 'layout.tsx'), 'utf8')

describe('the root layout (W71, item 7)', () => {
  it('British English, the Light mode and both font variables on <html>', () => {
    expect(layout).toMatch(/<html lang="en-GB" data-theme="light" className=\{`\$\{fontVariables\} antialiased`\}>/)
  })

  it('zoom is never switched off', () => {
    expect(layout).toMatch(/export const viewport: Viewport = \{\s*width: "device-width",\s*initialScale: 1,\s*\};/)
    expect(layout).not.toMatch(/maximumScale|minimumScale|userScalable/)
  })

  it('the smooth scroll and Motion defaults wrap every page, inside the frame (W73)', () => {
    expect(layout).toMatch(/<MotionProviders>\s*<Frame>\{children\}<\/Frame>\s*<\/MotionProviders>/)
  })

  it('W73: the grid overlay comes after the frame, and the frame is the only thing that draws <main>', () => {
    expect(layout.indexOf('<GridOverlay />')).toBeGreaterThan(layout.indexOf('</MotionProviders>'))
    expect(layout).not.toMatch(/<main/)
    expect(readFileSync(path.resolve(__dirname, 'page.tsx'), 'utf8')).not.toMatch(/<main/)
    expect(readFileSync(path.resolve(__dirname, '../components/frame/FrameShell.tsx'), 'utf8')).toMatch(/<main id="main" tabIndex=\{-1\}/)
  })

  it("W73: the Overlay's texture filter is drawn once, by the layout", () => {
    expect(layout.match(/<OverlayTexture \/>/g)).toHaveLength(1)
    const overlay = readFileSync(path.resolve(__dirname, '../components/ui/media/Overlay.tsx'), 'utf8')
    expect(overlay).toMatch(/export const OVERLAY_TEXTURE_ID = 'overlay-texture'/)
    expect(overlay).toMatch(/<svg aria-hidden="true" focusable="false" width="0" height="0"/)
    // The stylesheet points at the same id.
    expect(readFileSync(path.resolve(__dirname, 'globals.css'), 'utf8')).toMatch(/backdrop-filter: blur\(12px\) url\(#overlay-texture\);/)
  })

  it('the page\'s height does not hang on <html>: Lenis sets <html> and <body> to height: auto while it runs', () => {
    // With `h-full` on <html> and `min-h-full` on <body>, the page lost its full height the moment Lenis started,
    // and kept it for a visitor with reduced motion on: two layouts, and a jump after loading.
    expect(layout).toMatch(/<body className="flex min-h-dvh flex-col">/)
    expect(layout).not.toMatch(/h-full/)
  })

  it('the site name is a placeholder until Sanity supplies it, and page titles go into one template', () => {
    expect(layout).toMatch(/title: \{ default: SITE_NAME, template: "%s \| The Paddock" \}/)
    expect(layout).toMatch(/openGraph: \{ siteName: SITE_NAME, locale: "en_GB", type: "website" \}/)
  })
})
