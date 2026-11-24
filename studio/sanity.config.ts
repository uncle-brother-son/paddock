import {defineConfig} from 'sanity'
import {structureTool} from 'sanity/structure'
import {visionTool} from '@sanity/vision'
import {schemaTypes} from './schemaTypes'
import {isSingleton, structure} from './structure'

export default defineConfig({
  name: 'default',
  title: 'paddock',

  projectId: 'qx4gqx7t',
  dataset: 'production',

  autoUpdates: false,

  plugins: [structureTool({structure}), visionTool()],

  schema: {
    types: schemaTypes,
  },

  document: {
    // A single document can't be made twice, deleted or unpublished.
    newDocumentOptions: (items) => items.filter((item) => !isSingleton(item.templateId)),
    actions: (actions, {schemaType}) =>
      isSingleton(schemaType)
        ? actions.filter(({action}) => action === 'publish' || action === 'discardChanges' || action === 'restore')
        : actions,
  },
})
