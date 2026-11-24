import type { Decorator, Preview } from '@storybook/nextjs-vite'
import { useEffect, type ReactNode } from 'react'

import { fontVariables } from '../app/fonts'
import '../app/globals.css'
import { MotionProviders } from '../components/providers/MotionProviders'
import tokens from '../lib/design/figma-tokens.json'
import { THEME_MODES, type ThemeMode } from '../lib/design/token-names'

// What app/layout.tsx puts on <html>: the font variables, the language and the Light mode.
if (typeof document !== 'undefined') {
  document.documentElement.classList.add(...fontVariables.split(' '))
  document.documentElement.lang = 'en-GB'
  document.documentElement.dataset.theme = 'light'
}

const frame = tokens.measurements['Spacing/Grid/Width']

const isThemeMode = (value: unknown): value is ThemeMode => THEME_MODES.includes(value as ThemeMode)

/**
 * A story sits in the mode picked in the toolbar, on that mode's Surface/Primary, inside the site's Motion
 * defaults. On a story's own page the mode fills the whole frame; on a docs page it stays inside the story.
 */
function ThemeFrame({ theme, wholePage, padded, children }: { theme: ThemeMode; wholePage: boolean; padded: boolean; children: ReactNode }) {
  useEffect(() => {
    if (wholePage) document.documentElement.dataset.theme = theme
  }, [theme, wholePage])

  return (
    <MotionProviders smoothScroll={false}>
      <div key={theme} data-theme={theme} className={`bg-surface-primary ${padded ? 'p-16' : ''} ${wholePage ? 'min-h-screen' : ''}`}>
        {children}
      </div>
    </MotionProviders>
  )
}

const withTheme: Decorator = (Story, context) => {
  const theme = isThemeMode(context.globals.theme) ? context.globals.theme : 'light'
  return (
    <ThemeFrame theme={theme} wholePage={context.viewMode === 'story'} padded={context.parameters.padded !== false}>
      <Story />
    </ThemeFrame>
  )
}

const preview: Preview = {
  decorators: [withTheme],

  globalTypes: {
    theme: {
      description: 'Theme mode (Figma: Light, Dark, Fjord, Mud)',
      toolbar: {
        title: 'Theme',
        icon: 'paintbrush',
        items: tokens.themeModes.map((mode) => ({ value: mode.toLowerCase(), title: mode })),
        dynamicTitle: true,
      },
    },
  },

  initialGlobals: {
    theme: 'light',
  },

  parameters: {
    layout: 'fullscreen',

    controls: {
      matchers: {
       color: /(background|color)$/i,
       date: /Date$/i,
      },
    },

    // The two Figma frames, and the width where the Mobile values give way to the Desktop ones.
    viewport: {
      options: {
        mobile: { name: `Mobile ${frame.Mobile}`, styles: { width: `${frame.Mobile}px`, height: '844px' }, type: 'mobile' },
        tablet: { name: 'Tablet 768', styles: { width: '768px', height: '1024px' }, type: 'tablet' },
        desktop: { name: `Desktop ${frame.Desktop}`, styles: { width: `${frame.Desktop}px`, height: '900px' }, type: 'desktop' },
      },
    },

    a11y: {
      // WCAG 2.2 AA: a11y violations fail Storybook tests (docs/build-standards.md, section 1: Checks)
      test: 'error'
    }
  },
};

export default preview;
