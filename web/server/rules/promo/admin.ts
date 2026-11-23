// W54 (G-plan 1.6, 4.1, 4.3, 4.6; bugs GB14 and GB18): the Promo Codes page on the Worker. Ported from the staff
// app's getPromoCodes.ts, getPromoCodeRedemptions.ts, createPromoCode.ts and updatePromoCode.ts and the field checks
// of shared/promoCodes.ts (as they were at W48), with their words (./admin-failure-messages.ts).
//
// What GB18 changes. An edit is one transaction under the code's own row lock, which is the lock an order using the
// code takes before it writes its redemption (orders/locks.ts): so "the code's text can't change once used" is
// decided while no order can be using it, where the old function read the uses and then wrote. Create and edit each
// write an audit row (who, the code before and after), where the old functions recorded nothing. A code that is
// already there in another letter case is refused before the write, and by the table's own index behind it.
// What GB14 changes: the two reads refuse an unknown or inactive staff member (the route's own check).
import 'server-only'
import type { AdminAction, AdminCreatePromoCodeOutput, AdminGetPromoCodeRedemptionsOutput, PromoCreateRouteInput, PromoListRouteOutput, PromoUpdateRouteInput, PromoUpdateRouteOutput } from '@/contracts'
import { postgresRefusal, type Db, type Queryable, type Tx } from '@/server/db'
import type { ApiError } from '@/server/http/errors'
import { isUuid } from '@/server/rules/admin/locks'
import { adminRead } from '@/server/rules/admin/read'
import { adminRefusal, requireAdminPermission, type AdminActor } from '@/server/rules/admin/refusal'
import { NO_ROW_STAMP, rowStampSql } from '@/server/rules/admin/stamp'
import { adminWrite, WRITES_ONLY_WHAT_WAS_PRESSED, type AdminWriteOptions } from '@/server/rules/admin/write'
import { PROMO_ADMIN_WORDS } from './admin-failure-messages'

const APPLIES_TO: readonly string[] = ['booking', 'addon', 'product', 'session_pass', 'membership', 'event']
const CODE_UNIQUE_INDEX = 'promo_codes_code_upper_key'
const iso = (value: Date | string): string => (value instanceof Date ? value.toISOString() : String(value))

// --- The reads

// W54a: `stamp` is the row's own stamp (admin/stamp.ts), from the same row as the fields the page shows. The page's
// switch and its edit dialog send it back with the row, and updatePromoCode refuses a row that has changed since.
const PROMO_LIST_SQL = `
SELECT pc.id, pc.code, pc.description, pc.discount_type, pc.discount_value::text AS discount_value, pc.applies_to,
       pc.applies_on_member_prices, pc.expires_on::text AS expires_on, pc.max_total_uses, pc.one_use_per_customer,
       pc.min_spend::text AS min_spend, pc.restricted_customer_id, pc.active, pc.created_by, pc.created_at, pc.updated_at,
       ${rowStampSql('pc')} AS stamp,
       (SELECT count(*) FROM promo_code_redemptions r WHERE r.promo_code_id = pc.id)::text AS used_count,
       CASE WHEN c.id IS NULL THEN NULL ELSE trim(c.first_name || ' ' || c.last_name) END AS restricted_customer_name
  FROM promo_codes pc
  LEFT JOIN customers c ON c.id = pc.restricted_customer_id
 ORDER BY pc.created_at DESC`
// Newest first, and nothing more, exactly as the old read: codes made by staff never share a moment, and the seed
// data that does keeps the order the old read gave it (a second sort key would reorder those, for no gain).

/** getPromoCodes (`GET promo-codes`): every code, newest first, with how often it was used, who a restricted one is for, and its stamp (W54a). Any active staff member. */
export function listPromoCodes(db: Queryable, actor: AdminActor): Promise<PromoListRouteOutput> {
  return adminRead<PromoListRouteOutput[number]>(db, { name: 'promo.list', needs: 'staff', sql: PROMO_LIST_SQL, times: ['created_at', 'updated_at'] }, { actor })
}

/** W54a: one code's stamp as it is now, read under the code's lock by updatePromoCode. */
const PROMO_STAMP_SQL = `SELECT ${rowStampSql('pc')} AS stamp FROM promo_codes pc WHERE pc.id = $1::uuid`

const PROMO_REDEMPTIONS_SQL = `
SELECT r.id, r.order_id, r.customer_id, r.discount_amount::text AS discount_amount, r.created_at,
       o.created_at AS order_created_at, c.first_name AS customer_first_name, c.last_name AS customer_last_name
  FROM promo_code_redemptions r
  JOIN orders o ON o.id = r.order_id
  LEFT JOIN customers c ON c.id = r.customer_id
 WHERE r.promo_code_id = $1::uuid
 ORDER BY r.created_at DESC`

/** getPromoCodeRedemptions (`GET promo-codes/:promoCodeId/redemptions`): one code's uses, newest first. Any active staff member. */
export async function listPromoCodeRedemptions(db: Queryable, promoCodeId: string, actor: AdminActor): Promise<AdminGetPromoCodeRedemptionsOutput> {
  // An id that isn't one names no code: no uses, as for a code that isn't there.
  const read = { name: 'promo.redemptions', needs: 'staff' as const, sql: PROMO_REDEMPTIONS_SQL, params: [isUuid(promoCodeId) ? promoCodeId : null], times: ['created_at', 'order_created_at'] }
  return adminRead<AdminGetPromoCodeRedemptionsOutput[number]>(db, read, { actor })
}

// --- The checks create and edit share (the staff app's shared/promoCodes.ts)

/** The code as stored: trimmed and upper-cased; null when it isn't 4 to 20 letters, digits and dashes. */
function storedCode(raw: unknown): string | null {
  const code = typeof raw === 'string' ? raw.trim().toUpperCase() : ''
  return /^[A-Z0-9-]{4,20}$/.test(code) ? code : null
}

/** YYYY-MM-DD naming a day the calendar has (the old check asked only for the shape, so 30 February reached the database). */
function isRealDate(text: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (!match) return false
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  if (year < 1) return false
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

/** The fields as the row holds them, once checked. */
interface PromoFields {
  description: string | null
  discountType: 'percentage' | 'fixed'
  discountValue: number
  appliesTo: string[]
  appliesOnMemberPrices: boolean
  expiresOn: string | null
  maxTotalUses: number | null
  oneUsePerCustomer: boolean
  minSpend: number | null
  restrictedCustomerId: string | null
}

const empty = (value: unknown): boolean => value === null || value === undefined

/** The old field checks, in their order and words. Throws the first that fails. */
function checkedFields(action: AdminAction, input: PromoCreateRouteInput): PromoFields {
  const words = PROMO_ADMIN_WORDS.promoCodes
  const refuse = (reason: string, message: string, field: string) => adminRefusal('VALIDATION', action, reason, message, { field })
  const { discountType, discountValue, expiresOn, maxTotalUses, minSpend } = input
  const appliesTo = Array.isArray(input.appliesTo) ? (input.appliesTo as unknown[]) : []
  if (discountType !== 'percentage' && discountType !== 'fixed') throw refuse('invalid_discount_type', words.discountTypeMustPercentageOrFixed, 'discountType')
  if (typeof discountValue !== 'number' || !Number.isFinite(discountValue) || discountValue <= 0) throw refuse('invalid_discount_value', words.discountValueMustGreaterThan0, 'discountValue')
  if (discountType === 'percentage' && discountValue > 100) throw refuse('percentage_over_100', words.percentageDiscountCannotExceed100, 'discountValue')
  if (appliesTo.length === 0 || appliesTo.some((part) => typeof part !== 'string' || !APPLIES_TO.includes(part))) throw refuse('invalid_applies_to', words.chooseAtLeastOneValidBasket, 'appliesTo')
  if (!empty(expiresOn) && (typeof expiresOn !== 'string' || !isRealDate(expiresOn))) throw refuse('invalid_expiry', words.expiryMustDateYyyyMmDd, 'expiresOn')
  if (!empty(maxTotalUses) && (typeof maxTotalUses !== 'number' || !Number.isInteger(maxTotalUses) || maxTotalUses < 1)) throw refuse('invalid_max_uses', words.maximumTotalUsesMustWholeNumber, 'maxTotalUses')
  if (!empty(minSpend) && (typeof minSpend !== 'number' || !Number.isFinite(minSpend) || minSpend < 0)) throw refuse('invalid_min_spend', words.minimumSpendMustNonNegativeAmount, 'minSpend')
  return {
    description: (typeof input.description === 'string' ? input.description.trim() : '') || null,
    discountType,
    discountValue,
    appliesTo: appliesTo as string[],
    appliesOnMemberPrices: input.appliesOnMemberPrices === true,
    expiresOn: empty(expiresOn) ? null : (expiresOn as string),
    maxTotalUses: empty(maxTotalUses) ? null : (maxTotalUses as number),
    oneUsePerCustomer: input.oneUsePerCustomer === true,
    minSpend: empty(minSpend) ? null : (minSpend as number),
    restrictedCustomerId: typeof input.restrictedCustomerId === 'string' && input.restrictedCustomerId !== '' ? input.restrictedCustomerId : null,
  }
}

async function requireCustomer(tx: Tx, customerId: string | null, refusal: () => ApiError): Promise<void> {
  if (customerId === null) return
  if (!isUuid(customerId)) throw refusal()
  const [customer] = await tx.query<{ id: string }>('SELECT id FROM customers WHERE id = $1::uuid', [customerId])
  if (!customer) throw refusal()
}

const isCodeUniqueViolation = (err: unknown): boolean => {
  const refused = postgresRefusal(err)
  return refused?.code === '23505' && (refused.constraint === CODE_UNIQUE_INDEX || refused.message.includes(CODE_UNIQUE_INDEX))
}

/** A promo code's row as the old functions answered it: money and the date as the database gives them. */
const PROMO_COLUMNS = `id, code, description, discount_type, discount_value::text AS discount_value, applies_to, applies_on_member_prices,
  expires_on::text AS expires_on, max_total_uses, one_use_per_customer, min_spend::text AS min_spend, restricted_customer_id, active, created_by`
type PromoRow = AdminCreatePromoCodeOutput
type PromoRowWithTimes = PromoRow & { created_at: Date | string; updated_at: Date | string; stamp: string }

// --- Create

const INSERT_PROMO_SQL = `
INSERT INTO promo_codes
  (code, description, discount_type, discount_value, applies_to, applies_on_member_prices,
   expires_on, max_total_uses, one_use_per_customer, min_spend, restricted_customer_id, active, created_by)
VALUES ($1, $2, $3, $4, $5::text[], $6, $7::date, $8, $9, $10, $11::uuid, true, $12)
RETURNING ${PROMO_COLUMNS}`

export type CreatePromoCodeOptions = AdminWriteOptions & {
  /** The staff member's email, kept on the code as `created_by`, as the old function kept the sign-in's. */
  createdBy: string
}

/**
 * createPromoCode (`POST promo-codes`). Manage pricing; the code's text and the fields checked in the old order and
 * words; then one transaction: the restricted customer must exist; a code already there in any letter case is
 * refused in the old words (GB18); the row; a `promo.created` audit row. There is no row to lock before a code
 * exists: two creates of one code at once both pass the check, and the table's own index on the upper-cased code
 * refuses the second, which is answered as the same refusal.
 */
export async function createPromoCode(db: Db, input: PromoCreateRouteInput, options: CreatePromoCodeOptions): Promise<AdminCreatePromoCodeOutput> {
  const action = 'promo.created'
  requireAdminPermission(options.actor, 'manage_pricing', action)
  const code = storedCode(input.code)
  if (code === null) throw adminRefusal('VALIDATION', action, 'invalid_code', PROMO_ADMIN_WORDS.promoCodes.codeMust420CharactersUsing, { field: 'code' })
  const fields = checkedFields(action, input)
  const duplicate = () => adminRefusal('CONFLICT', action, 'duplicate_code', PROMO_ADMIN_WORDS.createPromoCode.promoCodeAlreadyExistsCodesAre(code), { field: 'code' })

  try {
    return await adminWrite<null, PromoRow, AdminCreatePromoCodeOutput>(
      db,
      {
        action,
        needs: 'manage_pricing',
        entity: { type: 'promo_code', id: '' },
        locks: [],
        // W54a: a new row. There is nothing the screen read that this could put back.
        unchangedSince: WRITES_ONLY_WHAT_WAS_PRESSED,
        before: async () => null,
        async change(tx) {
          await requireCustomer(tx, fields.restrictedCustomerId, () => adminRefusal('VALIDATION', action, 'restricted_customer_not_found', PROMO_ADMIN_WORDS.createPromoCode.restrictedCustomerDoesNotExist, { field: 'restrictedCustomerId' }))
          const [taken] = await tx.query<{ taken: number }>('SELECT 1 AS taken FROM promo_codes WHERE upper(code) = $1 LIMIT 1', [code])
          if (taken) throw duplicate()
          const [row] = await tx.query<PromoRow>(INSERT_PROMO_SQL, [
            code,
            fields.description,
            fields.discountType,
            fields.discountValue,
            fields.appliesTo,
            fields.appliesOnMemberPrices,
            fields.expiresOn,
            fields.maxTotalUses,
            fields.oneUsePerCustomer,
            fields.minSpend,
            fields.restrictedCustomerId,
            options.createdBy,
          ])
          if (!row) throw new Error('The promo code was not written.')
          return { after: row, answer: row, entityId: row.id }
        },
      },
      options
    )
  } catch (err) {
    // The transaction has rolled back. Two creates at once: the table's index on the upper-cased code stopped this one.
    if (isCodeUniqueViolation(err)) throw duplicate()
    throw err
  }
}

// --- Edit

const UPDATE_PROMO_SQL = `
UPDATE promo_codes
   SET code = $1, description = $2, discount_type = $3, discount_value = $4, applies_to = $5::text[],
       applies_on_member_prices = $6, expires_on = $7::date, max_total_uses = $8, one_use_per_customer = $9,
       min_spend = $10, restricted_customer_id = $11::uuid, active = $12, updated_at = now()
 WHERE id = $13::uuid
RETURNING ${PROMO_COLUMNS}, created_at, updated_at, ${rowStampSql('promo_codes')} AS stamp`

/**
 * updatePromoCode (`POST promo-codes/:promoCodeId`): every field, and `active` (the page's switch sends the row as
 * it is with the switch changed). Manage pricing; then ONE transaction under the code's row lock (GB18), in the old
 * function's order:
 *  1. a code that isn't there is refused (`not_found`, the old words);
 *  1a. W54a: a code that has changed since the page read it is refused (`changed_since`). The switch and the dialog
 *     both send every field as the page loaded it, so without this a page loaded before someone corrected a
 *     discount would put the old discount back (WELCOME at 100% corrected to 10%, then switched off and on from the
 *     older page: 100% again, and a £25 session sold for £0). The press sends the row's stamp as the list read it;
 *     it is compared under the lock, so nothing can change the row between the check and the write;
 *  2. the code's text is checked;
 *  3. a changed text on a code that has been used is refused (`code_locked`, the old words). Decided under the lock:
 *     an order using the code holds the same row until its redemption is written, so the count can't be out of date.
 *     The old function counted, then wrote, and an order placed between the two had its redemption renamed;
 *  4. the fields, and the restricted customer;
 *  5. a text another code already has, in any letter case, is refused in the old words;
 *  6. the row, and a `promo.updated` audit row with the code before and after.
 */
export async function updatePromoCode(db: Db, input: PromoUpdateRouteInput, options: AdminWriteOptions): Promise<PromoUpdateRouteOutput> {
  const action = 'promo.updated'
  requireAdminPermission(options.actor, 'manage_pricing', action)
  const { promoCodeId } = input
  const words = PROMO_ADMIN_WORDS.updatePromoCode
  const gone = () => adminRefusal('NOT_FOUND', action, 'not_found', words.thatPromoCodeNoLongerExists)
  let codeAsked = ''

  try {
    return await adminWrite<PromoRow, PromoRow, PromoUpdateRouteOutput>(
      db,
      {
        action,
        needs: 'manage_pricing',
        entity: { type: 'promo_code', id: promoCodeId },
        locks: [{ table: 'promo_codes', ids: [promoCodeId] }],
        unchangedSince: {
          seen: input.stamp,
          now: async (tx) => (await tx.query<{ stamp: string }>(PROMO_STAMP_SQL, [promoCodeId]))[0]?.stamp ?? NO_ROW_STAMP,
        },
        async before(tx, held) {
          if (!held.promo_codes?.length) throw gone()
          // eslint-disable-next-line no-restricted-syntax -- the column list is a literal in this file; the id goes in as a parameter
          const [row] = await tx.query<PromoRow>(`SELECT ${PROMO_COLUMNS} FROM promo_codes WHERE id = $1::uuid`, [promoCodeId])
          if (!row) throw gone()
          return row
        },
        async change(tx, before) {
          const code = storedCode(input.code)
          if (code === null) throw adminRefusal('VALIDATION', action, 'invalid_code', PROMO_ADMIN_WORDS.promoCodes.codeMust420CharactersUsing, { field: 'code' })
          codeAsked = code
          if (code !== before.code) {
            const [used] = await tx.query<{ uses: number }>('SELECT count(*)::int AS uses FROM promo_code_redemptions WHERE promo_code_id = $1::uuid', [promoCodeId])
            if ((used?.uses ?? 0) > 0) throw adminRefusal('CONFLICT', action, 'code_locked', words.codeHasBeenRedeemedAtLeast, { field: 'code' })
          }
          const fields = checkedFields(action, input)
          await requireCustomer(tx, fields.restrictedCustomerId, () => adminRefusal('VALIDATION', action, 'restricted_customer_not_found', words.restrictedCustomerDoesNotExist, { field: 'restrictedCustomerId' }))
          const [taken] = await tx.query<{ taken: number }>('SELECT 1 AS taken FROM promo_codes WHERE upper(code) = $1 AND id <> $2::uuid LIMIT 1', [code, promoCodeId])
          if (taken) throw adminRefusal('CONFLICT', action, 'duplicate_code', words.promoCodeAlreadyExistsCodesAre(code), { field: 'code' })
          const [row] = await tx.query<PromoRowWithTimes>(UPDATE_PROMO_SQL, [
            code,
            fields.description,
            fields.discountType,
            fields.discountValue,
            fields.appliesTo,
            fields.appliesOnMemberPrices,
            fields.expiresOn,
            fields.maxTotalUses,
            fields.oneUsePerCustomer,
            fields.minSpend,
            fields.restrictedCustomerId,
            input.active === true,
            promoCodeId,
          ])
          if (!row) throw new Error('The promo code was held but not updated.')
          const { created_at, updated_at, stamp, ...after } = row
          return { after, answer: { updated: true, promo: { ...after, created_at: iso(created_at), updated_at: iso(updated_at) }, stamp } }
        },
      },
      options
    )
  } catch (err) {
    if (isCodeUniqueViolation(err)) throw adminRefusal('CONFLICT', action, 'duplicate_code', words.promoCodeAlreadyExistsCodesAre(codeAsked), { field: 'code' })
    throw err
  }
}
