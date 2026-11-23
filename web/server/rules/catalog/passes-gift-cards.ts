// Brief W56 (G-plan 1.3, 4.1, 4.3, 4.6, 4.8; bugs GB9, GB10, GB14, GB15; Wayne's Q52; lead calls L2, L11, L13;
// W53 review L7; W54a's stale-page rule): Catalog → Session Passes and Gift Card Types on the Worker: the two reads, a
// pass type's sessions, expiry and level, a gift card type's custom amounts and expiry, and a gift card preset made
// and re-priced. On and off sale and a pass type's price are items.ts's. Ported from the staff app's old functions as
// they were at W48, with their words.
//
// GB10. Nothing checked a pass type's sessions or expiry, or a gift card type's expiry: a pass type saved with 0
// sessions sold at full price and gave nothing; an expiry of -1 expired the pass the day it was bought. Now each is a
// whole number of 1 or more (expiry 1 to 120 months, W38a's cap), refused in words. The Worker holds it alone: every
// write of these columns goes through here (the website's content sync writes neither), so no database check.
//
// GB9 and Wayne's Q52 (21 Nov 2026: leave as today): a pass type's level change still reaches passes already sold,
// both ways. The lead's words, no change of behaviour: before saving, the dialog says how many customers hold unused
// sessions on the pass type (the level quote), and the press counts them again under the pass type's lock and keeps
// the count in its audit row.
//
// A gift card preset's price change leaves the gift cards already sold at the amount they were sold for: a sold card
// keeps its own amount on its own row (gift_cards), which nothing here touches.
import 'server-only'
import type { AdminAction } from '@/contracts'
import type { Db, Queryable, Tx } from '@/server/db'
import { isUuid } from '@/server/rules/admin/locks'
import { adminRead, namedRead } from '@/server/rules/admin/read'
import { adminRefusal, requireAdminPermission, type AdminActor } from '@/server/rules/admin/refusal'
import { fieldsStampSql, NO_ROW_STAMP } from '@/server/rules/admin/stamp'
import { adminWrite, WRITES_ONLY_WHAT_WAS_PRESSED, type AdminWriteOptions } from '@/server/rules/admin/write'
import { CATALOG_ADMIN_DIALOG_WORDS, CATALOG_ADMIN_WORDS } from './failure-messages'
import { CATALOG_ITEM_NEW_WORDS, passLevelHolderWords } from './item-failure-messages'
import { isPoundsAndPence, itemColumnsSql, priceText, withIsoTimes, type CatalogReader } from './items'

const WORDS = CATALOG_ADMIN_WORDS
const NEW_WORDS = CATALOG_ITEM_NEW_WORDS

// --- Session pass types

const PASS_TYPES_SQL = `SELECT ${itemColumnsSql('session_pass_type', 'spt')} FROM session_pass_types spt ORDER BY spt.name`
const PASS_TYPES_FOR_SESSION_SQL = `SELECT ${itemColumnsSql('session_pass_type', 'spt')}, pass_covers_session(spt.id, $1::uuid) AS covers_session FROM session_pass_types spt ORDER BY spt.name`
/**
 * The shop's columns (G-plan 4.8; the lead's check of the backend log, 16): pass types on sale, no Stripe ids, each
 * with its LEVEL, so the website offers only passes that cover the chosen slot (with a session, `covers_session`).
 */
const CUSTOMER_PASS_COLUMNS = 'spt.id, spt.sanity_pass_type_id, spt.name, spt.thumbnail_url, spt.price::text AS price, spt.sessions_included, spt.expiry_months, spt.level'
const CUSTOMER_PASS_TYPES_SQL = `SELECT ${CUSTOMER_PASS_COLUMNS} FROM session_pass_types spt WHERE spt.active = true ORDER BY spt.name`
const CUSTOMER_PASS_TYPES_FOR_SESSION_SQL = `SELECT ${CUSTOMER_PASS_COLUMNS}, pass_covers_session(spt.id, $1::uuid) AS covers_session FROM session_pass_types spt WHERE spt.active = true ORDER BY spt.name`

/**
 * getSessionPassTypes (`GET catalog/session-pass-types`, with `sessionId`): every pass type by name; with a session,
 * each also says whether its level covers that session (pass_covers_session: a Core pass never covers Peak), as
 * before. Any active staff member (GB14). A session id that isn't an id covers nothing (the old read showed the
 * database's cast error). On the customer channel: pass types on sale, the shop's columns, with the level.
 */
export function listPassTypes(db: Queryable, sessionId: string | undefined, reader: CatalogReader): Promise<Array<Record<string, unknown>>> {
  const withSession = sessionId !== undefined && sessionId !== ''
  const params = withSession ? [isUuid(sessionId) ? sessionId : null] : []
  if (reader.channel === 'customer') return namedRead(db, { name: 'catalog.pass_types', sql: withSession ? CUSTOMER_PASS_TYPES_FOR_SESSION_SQL : CUSTOMER_PASS_TYPES_SQL, params })
  return adminRead(db, { name: 'catalog.pass_types', needs: 'staff', sql: withSession ? PASS_TYPES_FOR_SESSION_SQL : PASS_TYPES_SQL, params, times: ['created_at', 'updated_at'] }, { actor: reader.actor })
}

/** The customers holding unused sessions on a pass type: sessions left, and not yet expired (London's today). */
const HOLDERS_SQL = `
SELECT count(DISTINCT csp.customer_id)::int AS holders
  FROM customer_session_passes csp
 WHERE csp.pass_type_id = $1::uuid AND csp.sessions_remaining > 0 AND csp.expiry_date >= (now() AT TIME ZONE 'Europe/London')::date`
const holdersOf = async (db: Queryable, passTypeId: string): Promise<number> => Number((await db.query<{ holders: unknown }>(HOLDERS_SQL, [passTypeId]))[0]?.holders ?? 0)

/**
 * Q52's words (`GET catalog/session-pass-types/:passTypeId/level-quote`): how many customers hold unused sessions on
 * the pass type, and the sentence the level dialog shows before saving. Any active staff member (a read: the level
 * itself still needs Manage pricing). A pass type that isn't there is refused `pass_type_not_found`.
 */
export async function passLevelQuote(db: Queryable, passTypeId: string, actor: AdminActor): Promise<{ passTypeId: string; level: string; holders: number; message: string }> {
  // An id that isn't one names no pass type (the route's staff check has already run).
  const [row] = isUuid(passTypeId)
    ? await adminRead<{ id: string; level: string }>(db, { name: 'catalog.pass_level_quote', needs: 'staff', sql: 'SELECT id, level FROM session_pass_types WHERE id = $1::uuid', params: [passTypeId] }, { actor })
    : []
  if (!row) throw adminRefusal('NOT_FOUND', 'catalog.pass_level_quote', 'pass_type_not_found', CATALOG_ADMIN_DIALOG_WORDS.EditSessionPassTypeDialog.pass_type_not_found)
  const holders = await holdersOf(db, passTypeId)
  return { passTypeId, level: row.level, holders, message: passLevelHolderWords(holders) }
}

/** A pass type's three single settings (`field`), each its own press (lead call L11: three functions, one route). */
export const PASS_DETAIL_FIELDS = ['sessions_included', 'expiry_months', 'level'] as const
export type PassDetailField = (typeof PASS_DETAIL_FIELDS)[number]

/** GB10: a whole number of 1 or more; an expiry no more than 120 months (W38a's cap). */
const wholeAtLeastOne = (value: unknown, cap?: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1 && (cap === undefined || value <= cap)
const EXPIRY_CAP_MONTHS = 120

export type PassDetailAnswer = { id: string; sessions_included?: number | null; expiry_months?: number; level?: string; holders?: number }

/**
 * setSessionPassSessionsIncluded, setSessionPassExpiry and setSessionPassLevel (`POST
 * catalog/session-pass-types/:passTypeId/details`, one `field` a press). Manage pricing (the level's refusal keeps its
 * old reason, `no_pricing_permission`); GB10's numbers in words; a level that isn't Core or All-Access
 * (`invalid_level`); one transaction under the pass type's lock, and a `catalog.details_set` row with the setting
 * before and after (for the level, Q52's holder count, read under the lock). A pass type that isn't there is refused
 * `pass_type_not_found` (the old setters answered null, the level `pass_type_not_found`; the wrappers still do). Each
 * press sets one value, so none carries a stamp.
 */
export async function setPassDetail(db: Db, passTypeId: string, field: unknown, value: unknown, options: AdminWriteOptions): Promise<PassDetailAnswer> {
  const action: AdminAction = 'catalog.details_set'
  const levelWords = CATALOG_ADMIN_DIALOG_WORDS.EditSessionPassTypeDialog
  if (field === 'level' && !options.actor.canManagePricing) throw adminRefusal('FORBIDDEN', action, 'no_pricing_permission', levelWords.no_pricing_permission)
  requireAdminPermission(options.actor, 'manage_pricing', action)
  if (field === 'sessions_included' && !wholeAtLeastOne(value)) throw adminRefusal('VALIDATION', action, 'invalid_params', NEW_WORDS.sessionsWholeNumber, { field: 'sessionsIncluded' })
  if (field === 'expiry_months' && !wholeAtLeastOne(value, EXPIRY_CAP_MONTHS)) throw adminRefusal('VALIDATION', action, 'invalid_params', NEW_WORDS.expiryWholeMonths, { field: 'expiryMonths' })
  if (field === 'level' && value !== 'core' && value !== 'all_access') throw adminRefusal('VALIDATION', action, 'invalid_level', levelWords.invalid_level, { field: 'level' })
  if (typeof field !== 'string' || !(PASS_DETAIL_FIELDS as readonly string[]).includes(field)) throw adminRefusal('VALIDATION', action, 'invalid_params', `Invalid field: ${String(field)}`, { field: 'field' })
  const column = field as PassDetailField
  const gone = () => adminRefusal('NOT_FOUND', action, 'pass_type_not_found', levelWords.pass_type_not_found)
  type Setting = Record<string, unknown>
  return adminWrite<Setting, Setting, PassDetailAnswer>(
    db,
    {
      action,
      needs: 'manage_pricing',
      entity: { type: 'session_pass_type', id: passTypeId },
      locks: [{ table: 'session_pass_types', ids: [passTypeId] }],
      unchangedSince: WRITES_ONLY_WHAT_WAS_PRESSED,
      async before(tx, held) {
        if (!held.session_pass_types?.length) throw gone()
        // eslint-disable-next-line no-restricted-syntax -- the column is one of PASS_DETAIL_FIELDS, never a value from a request
        const [row] = await tx.query<Setting>(`SELECT ${column} FROM session_pass_types WHERE id = $1::uuid`, [passTypeId])
        if (!row) throw gone()
        return row
      },
      async change(tx) {
        const cast = column === 'level' ? 'text' : 'int'
        // eslint-disable-next-line no-restricted-syntax -- the column is one of PASS_DETAIL_FIELDS, never a value from a request
        const [row] = await tx.query<Setting & { id: string }>(`UPDATE session_pass_types SET ${column} = $1::${cast}, updated_at = now() WHERE id = $2::uuid RETURNING id, ${column}`, [value as string | number, passTypeId])
        if (!row) throw new Error('The pass type was held but not updated.')
        const after = { [column]: row[column] }
        if (column !== 'level') return { after, answer: row as PassDetailAnswer }
        // Q52: the count the dialog showed, read again under the lock and kept with the change.
        const holders = await holdersOf(tx, passTypeId)
        return { after, details: { holders }, answer: { ...(row as PassDetailAnswer), holders } }
      },
    },
    options
  )
}

// --- Gift card types and presets

const GIFT_CARD_TYPES_SQL = `SELECT ${itemColumnsSql('gift_card_type', 'gct')}, ${fieldsStampSql('gct', ['custom_amount_enabled', 'custom_amount_min', 'custom_amount_max'])} AS stamp FROM gift_card_types gct ORDER BY gct.name`
const PRESETS_SQL = `SELECT ${itemColumnsSql('gift_card_preset', 'gcp')} FROM gift_card_presets gcp ORDER BY gcp.amount`
/** The shop's columns (G-plan 4.8): gift card types on sale, with their presets on sale, no Stripe ids. */
const CUSTOMER_GIFT_CARD_TYPES_SQL = `SELECT gct.id, gct.sanity_gift_card_type_id, gct.name, gct.thumbnail_url, gct.custom_amount_enabled, gct.custom_amount_min::text AS custom_amount_min,
       gct.custom_amount_max::text AS custom_amount_max, gct.expiry_months
  FROM gift_card_types gct WHERE gct.active = true ORDER BY gct.name`
const CUSTOMER_PRESETS_SQL = 'SELECT gcp.id, gcp.gift_card_type_id, gcp.amount::text AS amount FROM gift_card_presets gcp WHERE gcp.active = true ORDER BY gcp.amount'

/** W54a: what the custom-amounts edit writes back (EditGiftCardTypeDialog sends all three as the page loaded them). */
export const CUSTOM_AMOUNT_COLUMNS = ['custom_amount_enabled', 'custom_amount_min', 'custom_amount_max'] as const
const customAmountsStampSql = (alias: string): string => fieldsStampSql(alias, CUSTOM_AMOUNT_COLUMNS)

/**
 * getGiftCardTypes (`GET catalog/gift-card-types`): every gift card type by name with its presets (by amount), as
 * before, for Catalog → Gift Card Types and New Order's gift card section. Any active staff member (GB14). Each type
 * carries the stamp of its custom amounts (the edit dialog sends it back). On the customer channel: types and presets
 * on sale, the shop's columns.
 */
export async function listGiftCardTypes(db: Queryable, reader: CatalogReader): Promise<Array<Record<string, unknown> & { presets: Array<Record<string, unknown>> }>> {
  const staff = reader.channel === 'staff'
  const run = (name: string, sql: string) => (staff ? adminRead<Record<string, unknown>>(db, { name, needs: 'staff', sql, times: ['created_at', 'updated_at'] }, { actor: reader.actor }) : namedRead<Record<string, unknown>>(db, { name, sql }))
  const types = await run('catalog.gift_card_types', staff ? GIFT_CARD_TYPES_SQL : CUSTOMER_GIFT_CARD_TYPES_SQL)
  const presets = await run('catalog.gift_card_presets', staff ? PRESETS_SQL : CUSTOMER_PRESETS_SQL)
  return types.map((type) => ({ ...type, presets: presets.filter((preset) => preset['gift_card_type_id'] === type['id']) }))
}

const CUSTOM_AMOUNTS_ROW = 'id, custom_amount_enabled, custom_amount_min::text AS custom_amount_min, custom_amount_max::text AS custom_amount_max'
const CUSTOM_AMOUNTS_SQL = `SELECT ${CUSTOM_AMOUNTS_ROW} FROM gift_card_types WHERE id = $1::uuid`
const CUSTOM_AMOUNTS_STAMP_SQL = `SELECT ${customAmountsStampSql('gct')} AS stamp FROM gift_card_types gct WHERE gct.id = $1::uuid`
const CUSTOM_AMOUNTS_UPDATE_SQL = `UPDATE gift_card_types SET custom_amount_enabled = $1::boolean, custom_amount_min = $2::numeric, custom_amount_max = $3::numeric, updated_at = now()
  WHERE id = $4::uuid RETURNING ${CUSTOM_AMOUNTS_ROW}, ${customAmountsStampSql('gift_card_types')} AS stamp`

export interface CustomAmountsInput {
  giftCardTypeId: string
  customAmountEnabled?: unknown
  customAmountMin?: unknown
  customAmountMax?: unknown
  stamp?: unknown
}

/**
 * setGiftCardTypeCustomAmountSettings (`POST catalog/gift-card-types/:giftCardTypeId/details`, `field:
 * 'custom_amounts'`). Manage pricing; with custom amounts on, the old checks in their words and L7's on both amounts
 * (off, both are cleared, as before); one transaction under the type's lock, and a `catalog.details_set` row. W54a:
 * the dialog sends all three as the page loaded them, so the press carries their stamp and is refused `changed_since`
 * when one has changed since. A type that isn't there is refused `gift_card_type_not_found` (the old function answered
 * null, and its wrapper still does). Answers the four fields and the new stamp.
 */
export async function setCustomAmounts(db: Db, input: CustomAmountsInput, options: AdminWriteOptions): Promise<{ id: string; custom_amount_enabled: boolean; custom_amount_min: string | null; custom_amount_max: string | null; stamp: string }> {
  const action: AdminAction = 'catalog.details_set'
  requireAdminPermission(options.actor, 'manage_pricing', action)
  const words = WORDS.setGiftCardTypeCustomAmountSettings
  const enabled = input.customAmountEnabled === true
  const { customAmountMin: min, customAmountMax: max, giftCardTypeId } = input
  if (enabled) {
    const invalid = (message: string, field: string) => adminRefusal('VALIDATION', action, 'invalid_params', message, { field })
    if (typeof min !== 'number' || !Number.isFinite(min) || min < 0) throw invalid(words.customamountminMustNonNegativeNumberWhen, 'customAmountMin')
    if (typeof max !== 'number' || !Number.isFinite(max) || max <= 0) throw invalid(words.customamountmaxMustPositiveNumberWhenCustom, 'customAmountMax')
    if (min > max) throw invalid(words.customamountminCannotGreaterThanCustomamountmax, 'customAmountMin')
    if (!isPoundsAndPence(min)) throw adminRefusal('VALIDATION', action, 'not_pounds_and_pence', NEW_WORDS.notPoundsAndPence('customAmountMin'), { field: 'customAmountMin' })
    if (!isPoundsAndPence(max)) throw adminRefusal('VALIDATION', action, 'not_pounds_and_pence', NEW_WORDS.notPoundsAndPence('customAmountMax'), { field: 'customAmountMax' })
  }
  const gone = () => adminRefusal('NOT_FOUND', action, 'gift_card_type_not_found', NEW_WORDS.giftCardTypeNotFound)
  type Row = { id: string; custom_amount_enabled: boolean; custom_amount_min: string | null; custom_amount_max: string | null }
  return adminWrite<Row, Row, Row & { stamp: string }>(
    db,
    {
      action,
      needs: 'manage_pricing',
      entity: { type: 'gift_card_type', id: giftCardTypeId },
      locks: [{ table: 'gift_card_types', ids: [giftCardTypeId] }],
      unchangedSince: {
        seen: input.stamp,
        now: async (tx) => (await tx.query<{ stamp: string }>(CUSTOM_AMOUNTS_STAMP_SQL, [giftCardTypeId]))[0]?.stamp ?? NO_ROW_STAMP,
      },
      async before(tx, held) {
        if (!held.gift_card_types?.length) throw gone()
        const [row] = await tx.query<Row>(CUSTOM_AMOUNTS_SQL, [giftCardTypeId])
        if (!row) throw gone()
        return row
      },
      async change(tx) {
        const [row] = await tx.query<Row & { stamp: string }>(
          CUSTOM_AMOUNTS_UPDATE_SQL,
          [enabled, enabled ? priceText(min as number) : null, enabled ? priceText(max as number) : null, giftCardTypeId]
        )
        if (!row) throw new Error('The gift card type was held but not updated.')
        const { stamp, ...after } = row
        return { after, answer: { ...after, stamp } }
      },
    },
    options
  )
}

/**
 * setGiftCardTypeExpiry (`POST catalog/gift-card-types/:giftCardTypeId/details`, `field: 'expiry_months'`). Manage
 * pricing; GB10: a whole number of months from 1 to 120, in words; one transaction under the type's lock, and a
 * `catalog.details_set` row. Gift cards already issued keep their own expiry date, as before. A type that isn't there
 * is refused `gift_card_type_not_found` (the old function answered null, and its wrapper still does). One value, so
 * no stamp.
 */
export async function setGiftCardTypeExpiry(db: Db, giftCardTypeId: string, expiryMonths: unknown, options: AdminWriteOptions): Promise<{ id: string; expiry_months: number }> {
  const action: AdminAction = 'catalog.details_set'
  requireAdminPermission(options.actor, 'manage_pricing', action)
  if (!wholeAtLeastOne(expiryMonths, EXPIRY_CAP_MONTHS)) throw adminRefusal('VALIDATION', action, 'invalid_params', NEW_WORDS.expiryWholeMonths, { field: 'expiryMonths' })
  const gone = () => adminRefusal('NOT_FOUND', action, 'gift_card_type_not_found', NEW_WORDS.giftCardTypeNotFound)
  type Row = { id: string; expiry_months: number }
  return adminWrite<Row, Row, Row>(
    db,
    {
      action,
      needs: 'manage_pricing',
      entity: { type: 'gift_card_type', id: giftCardTypeId },
      locks: [{ table: 'gift_card_types', ids: [giftCardTypeId] }],
      unchangedSince: WRITES_ONLY_WHAT_WAS_PRESSED,
      async before(tx, held) {
        if (!held.gift_card_types?.length) throw gone()
        const [row] = await tx.query<Row>('SELECT id, expiry_months FROM gift_card_types WHERE id = $1::uuid', [giftCardTypeId])
        if (!row) throw gone()
        return row
      },
      async change(tx) {
        const [row] = await tx.query<Row>('UPDATE gift_card_types SET expiry_months = $1::int, updated_at = now() WHERE id = $2::uuid RETURNING id, expiry_months', [expiryMonths, giftCardTypeId])
        if (!row) throw new Error('The gift card type was held but not updated.')
        return { after: row, answer: row }
      },
    },
    options
  )
}

/** The old preset amount check ("amount must be a positive number"), then L7's. */
function checkedAmount(action: AdminAction, amount: unknown, words: { amountMustPositiveNumber: string }): number {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) throw adminRefusal('VALIDATION', action, 'invalid_params', words.amountMustPositiveNumber, { field: 'amount' })
  if (!isPoundsAndPence(amount)) throw adminRefusal('VALIDATION', action, 'not_pounds_and_pence', NEW_WORDS.notPoundsAndPence('amount'), { field: 'amount' })
  return amount
}

const presetRow = async (tx: Tx, sql: string, params: readonly unknown[]): Promise<Record<string, unknown> | undefined> => (await tx.query<Record<string, unknown>>(sql, params as never))[0]

/**
 * createGiftCardPreset (`POST catalog/gift-card-types/:giftCardTypeId/presets`). Manage pricing; the old amount check
 * and L7's; one transaction under the type's lock ("Gift card type not found", the legacy route's words): the preset,
 * on sale, with no Stripe price (L2), and a `catalog.preset_created` row. Answers `{ success: true, preset }`: the
 * legacy route's answer without its `stripePriceId`.
 */
export async function createPreset(db: Db, giftCardTypeId: string, amount: unknown, options: AdminWriteOptions): Promise<{ success: true; preset: Record<string, unknown> }> {
  const action: AdminAction = 'catalog.preset_created'
  requireAdminPermission(options.actor, 'manage_pricing', action)
  const value = checkedAmount(action, amount, WORDS.createGiftCardPreset)
  const gone = () => adminRefusal('NOT_FOUND', action, 'gift_card_type_not_found', CATALOG_ADMIN_WORDS.createGiftCardPreset.giftCardTypeNotFound)
  return adminWrite<null, Record<string, unknown>, { success: true; preset: Record<string, unknown> }>(
    db,
    {
      action,
      needs: 'manage_pricing',
      entity: { type: 'gift_card_preset', id: giftCardTypeId },
      locks: [{ table: 'gift_card_types', ids: [giftCardTypeId] }],
      unchangedSince: WRITES_ONLY_WHAT_WAS_PRESSED,
      async before(_tx, held) {
        if (!held.gift_card_types?.length) throw gone()
        return null
      },
      async change(tx) {
        const row = await presetRow(tx, `INSERT INTO gift_card_presets (gift_card_type_id, amount) VALUES ($1::uuid, $2::numeric) RETURNING ${itemColumnsSql('gift_card_preset', 'gift_card_presets')}`, [giftCardTypeId, priceText(value)])
        if (!row) throw new Error('The preset was not written.')
        const preset = withIsoTimes(row)
        return { after: preset, entityId: String(row['id']), answer: { success: true, preset } }
      },
    },
    options
  )
}

/**
 * updateGiftCardPresetPrice (`POST catalog/gift-card-presets/:presetId/price`). Manage pricing; the old amount check
 * and L7's; one transaction under the preset's lock ("Preset not found", the legacy route's words): the amount, and a
 * `catalog.price_set` row with the amount before and after. L2: no Stripe price made or archived (GB2). Gift cards
 * already sold at the old amount keep it: their own rows are not touched. One value, so no stamp. Answers `{ success:
 * true, preset }`: the legacy route's answer without its `stripePriceId`.
 */
export async function setPresetPrice(db: Db, presetId: string, amount: unknown, options: AdminWriteOptions): Promise<{ success: true; preset: Record<string, unknown> }> {
  const action: AdminAction = 'catalog.price_set'
  requireAdminPermission(options.actor, 'manage_pricing', action)
  const value = checkedAmount(action, amount, WORDS.updateGiftCardPresetPrice)
  const gone = () => adminRefusal('NOT_FOUND', action, 'preset_not_found', CATALOG_ADMIN_WORDS.updateGiftCardPresetPrice.presetNotFound)
  type Amount = { amount: string }
  return adminWrite<Amount, Amount, { success: true; preset: Record<string, unknown> }>(
    db,
    {
      action,
      needs: 'manage_pricing',
      entity: { type: 'gift_card_preset', id: presetId },
      locks: [{ table: 'gift_card_presets', ids: [presetId] }],
      unchangedSince: WRITES_ONLY_WHAT_WAS_PRESSED,
      async before(tx, held) {
        if (!held.gift_card_presets?.length) throw gone()
        const [row] = await tx.query<Amount>('SELECT amount::text AS amount FROM gift_card_presets WHERE id = $1::uuid', [presetId])
        if (!row) throw gone()
        return row
      },
      async change(tx) {
        const row = await presetRow(tx, `UPDATE gift_card_presets SET amount = $1::numeric, updated_at = now() WHERE id = $2::uuid RETURNING ${itemColumnsSql('gift_card_preset', 'gift_card_presets')}`, [priceText(value), presetId])
        if (!row) throw new Error('The preset was held but not updated.')
        return { after: { amount: String(row['amount']) }, answer: { success: true, preset: withIsoTimes(row) } }
      },
    },
    options
  )
}
