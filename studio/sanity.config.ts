import {defineConfig} from 'sanity'
import {structureTool} from 'sanity/structure'
import {visionTool} from '@sanity/vision'
import {schemaTypes} from './schemaTypes'

export default defineConfig({
  name: 'default',
  title: 'paddock',

  projectId: 'qx4gqx7t',
  dataset: 'production',

  autoUpdates: false,

  plugins: [structureTool(), visionTool()],

  schema: {
    types: schemaTypes,
  },
})
