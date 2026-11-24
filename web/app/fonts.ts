import localFont from 'next/font/local'

// The GT typefaces, self-hosted (docs/build-standards.md, section 6: woff2 only, `swap`, only the weights the Figma
// text styles use, a size-matched fallback so text doesn't jump when the font arrives). Each call is preloaded:
// all three faces are used above the fold. next/font needs every value here written out as a literal.

/** Figma "Font/Family/Primary": GT Sectra Fine, Regular 400. */
export const fontPrimary = localFont({
  src: [{ path: '../public/fonts/GT-Sectra-Fine-Regular.woff2', weight: '400', style: 'normal' }],
  variable: '--font-primary',
  display: 'swap',
  preload: true,
  adjustFontFallback: 'Times New Roman',
  fallback: ['serif'],
})

/** Figma "Font/Family/Secondary": GT America Standard, Regular 400 and Medium 500. */
export const fontSecondary = localFont({
  src: [
    { path: '../public/fonts/GT-America-Standard-Regular.woff2', weight: '400', style: 'normal' },
    { path: '../public/fonts/GT-America-Standard-Medium.woff2', weight: '500', style: 'normal' },
  ],
  variable: '--font-secondary',
  display: 'swap',
  preload: true,
  adjustFontFallback: 'Arial',
  fallback: ['sans-serif'],
})

/** Both variables' classes, for <html> (and Storybook's document). */
export const fontVariables = `${fontPrimary.variable} ${fontSecondary.variable}`
