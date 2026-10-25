import type { StorybookConfig } from '@storybook/nextjs-vite';

const config: StorybookConfig = {
  // Stories sit next to the components they document (see ubs-frontend-standards).
  stories: [
    '../components/**/*.mdx',
    '../components/**/*.stories.@(ts|tsx)',
    '../features/**/*.mdx',
    '../features/**/*.stories.@(ts|tsx)',
  ],
  addons: [
    '@storybook/addon-vitest',
    '@storybook/addon-a11y',
    '@storybook/addon-docs',
    '@storybook/addon-mcp',
  ],
  framework: '@storybook/nextjs-vite',
  staticDirs: ['../public'],
};
export default config;
