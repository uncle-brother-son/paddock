/**
 * Zod schemas for every /api/v1 endpoint's input and output, with inferred types. Shared with the
 * website front end, so nothing here may import from server/. `npm run export:contracts` writes
 * every type exported from this file to the staff app (see scripts/export-contracts.mjs).
 */
export * from './errors'
export * from './envelope'
export * from './staff'
export * from './customer'
export * from './quotes'
export * from './orders'
export * from './terminal'
export * from './reconcile'
export * from './bookings'
export * from './refunds'
export * from './events'
