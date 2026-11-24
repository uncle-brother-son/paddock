import {defineConfig} from 'sanity'
import {structureTool} from 'sanity/structure'
import {visionTool} from '@sanity/vision'
import {
  duplicateWithoutPreviousSlugs,
  keepPreviousSlugsOnPublish,
  keepsPreviousSlugs,
} from './actions/keepPreviousSlugs'
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
    actions: (actions, {schemaType}) => {
      if (isSingleton(schemaType)) {
        return actions.filter(
          ({action}) => action === 'publish' || action === 'discardChanges' || action === 'restore',
        )
      }
      // A document with an address keeps its old slugs on publish, and a copy of it starts with none (W72a).
      if (keepsPreviousSlugs(schemaType)) {
        return actions.map((action) => {
          if (action.action === 'publish') return keepPreviousSlugsOnPublish(action)
          if (action.action === 'duplicate') return duplicateWithoutPreviousSlugs(action)
          return action
        })
      }
      return actions
    },
  },
})
