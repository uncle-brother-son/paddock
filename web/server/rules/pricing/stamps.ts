// New in W54a (W49 + W54 review S1; the step G rule in admin/stamp.ts): how the Pricing page's three stamped edits
// read their row's stamp as it is now, under the lock each already holds. The reads (pricing-config.ts,
// postage-settings.ts) answer the same stamps from the same rows they show. Read-only: no write statement here.
import 'server-only'
import { rowStampSql } from '@/server/rules/admin/stamp'

/** One day's band windows, each with its id and stamp: rowsStamp makes the day's one stamp from them. */
export const DAY_WINDOW_STAMPS_SQL = `SELECT r.id, ${rowStampSql('r')} AS stamp FROM band_rules r WHERE r.day_of_week = $1`

/** One membership level's term in one band. No row: the term has never been saved (NO_ROW_STAMP). */
export const MEMBER_TERM_STAMP_SQL = `SELECT ${rowStampSql('t')} AS stamp FROM membership_band_terms t WHERE t.membership_level = $1 AND t.band_id = $2::uuid`

/** The one postage settings row. */
export const POSTAGE_STAMP_SQL = `SELECT ${rowStampSql('p')} AS stamp FROM postage_settings p WHERE p.id = true`
