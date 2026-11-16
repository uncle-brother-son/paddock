// New in W36 (F-plan 4.1, brief W36 item 1): every word staff see from a customer action, moved here word for word
// from the staff app's functions (adjustCustomerStoreCredit, createCustomer) and their dialogs (AdjustStoreCreditDialog,
// NewCustomerDialog, SaveCardOnReaderButton), ahead of the slices that use them (W37 store credit, W39 customers, W42
// replace card). W37 uses the store credit words and W39 the create words. The test beside this file holds each to its source (the frozen copy,
// legacy-account/, and the dialogs) until the old code goes. The saved card's own refusals are already the Worker's
// (server/rules/payments/terminal.ts, W11).
import 'server-only'

export { INACTIVE_STAFF_MESSAGE, ISSUE_REFUNDS_NEEDED_MESSAGE } from '@/server/rules/bookings/failure-messages'

// --- Store credit (adjustCustomerStoreCredit.ts, shared/storeCredit.ts, AdjustStoreCreditDialog)

/** adjustCustomerStoreCredit's reasons, as its result's `reason` (the database function's three). The test holds this list to the old function's own. */
export const STORE_CREDIT_REASONS = ['insufficient_store_credit', 'customer_not_found', 'amount_required'] as const
export type StoreCreditReason = (typeof STORE_CREDIT_REASONS)[number]

/** A reason must be at least this long (MIN_REASON_LENGTH in the function and the dialog). */
export const STORE_CREDIT_MIN_REASON_LENGTH = 5

export const STORE_CREDIT_WORDS = {
  customerRequired: 'Customer id is required.',
  modeInvalid: 'Mode must be "add" or "remove".',
  amountInvalid: 'Amount must be greater than 0.',
  reasonRequired: 'A reason of at least 5 characters is required.',
  /** `insufficient_store_credit`. */
  belowZero: 'Removing that much would take the balance below zero — the adjustment was refused.',
  /** `customer_not_found`. */
  customerGone: 'That customer no longer exists.',
  /** Any other refusal of the database's store_credit_apply. */
  refused: 'The adjustment was refused.',
} as const

/** AdjustStoreCreditDialog's own words, shown before the press. */
export const STORE_CREDIT_DIALOG_WORDS = {
  amountInvalid: 'Enter an amount greater than 0.',
  belowZero: 'Removing that much would take the balance below zero.',
  failed: 'Failed to adjust store credit.',
} as const

// --- Creating a customer (createCustomer.ts, NewCustomerDialog)

export const CREATE_CUSTOMER_WORDS = {
  firstNameRequired: 'First name is required',
  lastNameRequired: 'Last name is required',
  emailInvalid: 'A valid email address is required',
  dateOfBirthInvalid: 'A valid date of birth is required',
  dateOfBirthInFuture: 'Date of birth cannot be in the future',
  under18: 'Customers must be 18 or over.',
  duplicateEmail: 'A customer with this email address already exists',
} as const

/**
 * W39: createCustomer's reasons. The old function threw its words with no reason; the Worker's refusal carries one
 * beside the same words, so the dialog can tell a duplicate from a mistyped field.
 */
export const CREATE_CUSTOMER_REASONS = ['first_name_required', 'last_name_required', 'email_invalid', 'date_of_birth_invalid', 'date_of_birth_in_future', 'under_18', 'duplicate_email'] as const
export type CreateCustomerReason = (typeof CREATE_CUSTOMER_REASONS)[number]

/**
 * W39 (FB21, lead call L10): the database's unique rules on a customer's email: the key on `email` as written, and
 * migration 027's index on `lower(email)`. A violation of either is the duplicate refusal, never a fault.
 */
export const CUSTOMER_EMAIL_UNIQUE_RULES = ['customers_email_key', 'customers_email_lower_key'] as const

/** NewCustomerDialog's own words, shown before the press (each ends with a full stop, which the function's don't). */
export const CREATE_CUSTOMER_DIALOG_WORDS = {
  firstNameRequired: 'First name is required.',
  lastNameRequired: 'Last name is required.',
  emailInvalid: 'A valid email address is required.',
  dateOfBirthRequired: 'Date of birth is required.',
  under18: 'Customers must be 18 or over.',
  failed: 'Failed to create customer.',
} as const

// --- The saved card (SaveCardOnReaderButton, utils/saveCardViaReader): the screen's own words

export const SAVED_CARD_DIALOG_WORDS = {
  failed: 'Failed to save the card via the reader.',
  notSaved: 'The card was read but could not be saved to the customer.',
} as const
