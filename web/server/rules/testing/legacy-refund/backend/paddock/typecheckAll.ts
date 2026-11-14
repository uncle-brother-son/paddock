/**
 * NOT a copy (the one file here that isn't): a stand-in for the staff app's typecheck barrel.
 *
 * The staff app's `refundOrder.ts` has a side-effect import of `./typecheckAll`, which there imports every
 * module under /backend/paddock/ so the staff app's typecheck covers them all. It has no exports and no runtime
 * behaviour. Copied as it is, it would pull the whole staff app into this folder, and break as step E and later
 * steps delete those modules. So that `refundOrder.ts` can stay byte for byte, its import lands here instead, on
 * what the barrel's own first line imports and nothing else. See ../../README.md.
 */
import './globals'
