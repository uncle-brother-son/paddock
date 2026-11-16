export interface CustomerRow {
  id: string
  first_name: string
  last_name: string
  email: string
  phone: string | null
  date_of_birth: string
  has_saved_card: boolean
  /** Last 4 digits of the saved card, when known — null if no saved card, or if one exists but its digits were never captured. */
  saved_card_last4: string | null
  saved_card_brand: string | null
  /** Current store credit balance in pounds (customers.store_credit_balance, never negative). */
  store_credit_balance: string
  /** Saved delivery address (used to pre-fill checkout's delivery step). */
  address_line1: string | null
  address_line2: string | null
  city: string | null
  postcode: string | null
  country: string | null
  created_at: string
  updated_at: string
}

export interface GetCustomersParams {
  search?: string
  /** Exact-match lookup for a single known customer id — used when a caller already has an id
   *  (e.g. from a booking) and just needs that customer's current payment/credit fields. */
  customerId?: string
}

export default async function getCustomers(req: { params?: GetCustomersParams }): Promise<CustomerRow[]> {
  const search = req.params?.search?.trim()
  const customerId = req.params?.customerId

  if (customerId) {
    const result = await paddockData.query<CustomerRow>(
      `SELECT id, first_name, last_name, email, phone, date_of_birth, created_at, updated_at,
              (saved_payment_method_id IS NOT NULL) AS has_saved_card,
              saved_card_last4, saved_card_brand, store_credit_balance,
              address_line1, address_line2, city, postcode, country
       FROM customers
       WHERE id = $1`,
      [customerId]
    )
    return result.data
  }

  if (search) {
    // Multi-word match: each whitespace-separated word must hit at least one of first_name /
    // last_name / email / phone (case-insensitive substring) — "Wayne Holland", "Holland Wayne",
    // "wayne hol" and partial words like "holland@" all find the same customer. The whole
    // trimmed search also matches the full "first last" name as one string (names with extra
    // spaces). All values are bound as parameters, with placeholders in ascending first-use
    // order (this driver's requirement).
    const words = search.split(/\s+/).filter((word) => word.length > 0)
    const params: string[] = []
    const clauses: string[] = []
    for (const word of words) {
      const start = params.length + 1
      params.push(`%${word}%`, `%${word}%`, `%${word}%`, `%${word}%`)
      clauses.push(
        `(first_name ILIKE $${start} OR last_name ILIKE $${start + 1} OR email ILIKE $${start + 2} OR phone ILIKE $${start + 3})`
      )
    }
    params.push(`%${search}%`)
    const fullNameClause = `((first_name || ' ' || last_name) ILIKE $${params.length})`
    // The whole-search full-name match is an ALTERNATIVE to the per-word clauses (searching
    // "Holland Wayne" must still find "Wayne Holland" via the words), not an extra AND.
    const whereClause = words.length > 0
      ? `(${clauses.join(' AND ')} OR ${fullNameClause})`
      : fullNameClause
    const result = await paddockData.query<CustomerRow>(
      `SELECT id, first_name, last_name, email, phone, date_of_birth, created_at, updated_at,
              (saved_payment_method_id IS NOT NULL) AS has_saved_card,
              saved_card_last4, saved_card_brand, store_credit_balance,
              address_line1, address_line2, city, postcode, country
       FROM customers
       WHERE ${whereClause}
       ORDER BY created_at DESC
       LIMIT 200`,
      params
    )
    return result.data
  }

  const result = await paddockData.query<CustomerRow>(
    `SELECT id, first_name, last_name, email, phone, date_of_birth, created_at, updated_at,
            (saved_payment_method_id IS NOT NULL) AS has_saved_card,
            saved_card_last4, saved_card_brand, store_credit_balance,
            address_line1, address_line2, city, postcode, country
     FROM customers
     ORDER BY created_at DESC
     LIMIT 200`
  )
  return result.data
}
