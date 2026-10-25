import type { Preview } from '@storybook/nextjs-vite'

const preview: Preview = {
  parameters: {
    controls: {
      matchers: {
       color: /(background|color)$/i,
       date: /Date$/i,
      },
    },

    a11y: {
      // WCAG 2.2 AA: a11y violations fail Storybook tests (ubs-frontend-standards)
      test: 'error'
    }
  },
};

export default preview;