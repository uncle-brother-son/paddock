import type { Decorator, Preview } from '@storybook/nextjs-vite'
import { useEffect, useLayoutEffect, type ReactNode } from 'react'

import { fontVariables } from '../app/fonts'
import '../app/globals.css'
import { InputKind } from '../components/frame/InputKind'
import { MotionProviders } from '../components/providers/MotionProviders'
import tokens from '../lib/design/figma-tokens.json'
import { THEME_MODES, type ThemeMode } from '../lib/design/token-names'
import { forcePseudoStates, PSEUDO_ATTRIBUTE, PSEUDO_STATES, type PseudoState } from './pseudo-states'

// What app/layout.tsx puts on <html>: the font variables, the language and the Light mode.
if (typeof document !== 'undefined') {
  document.documentElement.classList.add(...fontVariables.split(' '))
  document.documentElement.lang = 'en-GB'
  document.documentElement.dataset.theme = 'light'
}

const frame = tokens.measurements['Spacing/Grid/Width']

const isThemeMode = (value: unknown): value is ThemeMode => THEME_MODES.includes(value as ThemeMode)

const isPseudoState = (value: unknown): value is PseudoState => PSEUDO_STATES.includes(value as PseudoState)

/**
 * A story sits in the mode picked in the toolbar, on that mode's Surface/Primary, inside the site's Motion
 * defaults. On a story's own page the mode fills the whole frame; on a docs page it stays inside the story.
 *
 * W78a (WQ71): with the toolbar's State on Hover (or in a story of one of Figma's hover variants) everything in the
 * story is drawn as it is under a mouse, so a hover can be looked at without one (.storybook/pseudo-states.ts).
 */
function ThemeFrame({ theme, pseudo, wholePage, padded, children }: { theme: ThemeMode; pseudo: PseudoState; wholePage: boolean; padded: boolean; children: ReactNode }) {
  useEffect(() => {
    if (wholePage) document.documentElement.dataset.theme = theme
  }, [theme, wholePage])

  // Before the story is painted, and before its play function runs.
  useLayoutEffect(() => {
    if (pseudo !== 'none') forcePseudoStates()
  }, [pseudo])

  return (
    <MotionProviders smoothScroll={false}>
      {/* As app/layout.tsx: the focus ring follows what was last used, a key or a pointer. */}
      <InputKind />
      <div key={theme} data-theme={theme} {...(pseudo === 'none' ? {} : { [PSEUDO_ATTRIBUTE]: pseudo })} className={`bg-surface-primary ${padded ? 'p-16' : ''} ${wholePage ? 'min-h-screen' : ''}`}>
        {children}
      </div>
    </MotionProviders>
  )
}

const withTheme: Decorator = (Story, context) => {
  const theme = isThemeMode(context.globals.theme) ? context.globals.theme : 'light'
  const pseudo = isPseudoState(context.globals.pseudo) ? context.globals.pseudo : 'none'
  return (
    <ThemeFrame theme={theme} pseudo={pseudo} wholePage={context.viewMode === 'story'} padded={context.parameters.padded !== false}>
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
    // W78a (WQ71): Figma's State=hover, without a mouse.
    pseudo: {
      description: 'State (Figma: hover), drawn without a mouse',
      toolbar: {
        title: 'State',
        icon: 'pointerhand',
        items: [
          { value: 'none', title: 'State: as it is' },
          { value: 'hover', title: 'State: hover' },
        ],
        dynamicTitle: true,
      },
    },
  },

  initialGlobals: {
    theme: 'light',
    pseudo: 'none',
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
        // W78b (WQ78): the other widths the booking panel is looked at, from the narrowest phone to a wide desktop.
        w320: { name: 'Narrow phone 320', styles: { width: '320px', height: '568px' }, type: 'mobile' },
        w1024: { name: 'Small laptop 1024', styles: { width: '1024px', height: '768px' }, type: 'tablet' },
        w1280: { name: 'Laptop 1280', styles: { width: '1280px', height: '800px' }, type: 'desktop' },
        w1920: { name: 'Wide desktop 1920', styles: { width: '1920px', height: '1080px' }, type: 'desktop' },
      },
    },

    a11y: {
      // WCAG 2.2 AA: a11y violations fail Storybook tests (docs/build-standards.md, section 1: Checks)
      test: 'error'
    }
  },
};

export default preview;
