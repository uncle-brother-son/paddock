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
export * from './customer-cancels'
export * from './account'
export * from './money-owed'
export * from './payment-retry'
// W48: step G's admin contracts, last, so the staff app's generated types keep the order of every earlier union.
export * from './admin'
// W55 + W56: the catalogue's routes' own inputs and answers, after admin's, so every earlier union keeps its order.
export * from './catalog-admin'
