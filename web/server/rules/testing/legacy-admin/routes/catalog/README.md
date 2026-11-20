# Catalog API Endpoints

This directory contains API endpoints for managing the Paddock catalog system, integrating Sanity CMS, Supabase, and Stripe.

## Architecture Overview

The system follows a **single-writer pattern** where the backend (Next.js API routes on Cloudflare Workers) is the only system that writes to Stripe. This ensures data consistency across all platforms.

### Data Flow

```
Sanity (Content) → Backend API → Postgres + Stripe
Retool (Prices)  → Backend API → Postgres + Stripe
```

## Endpoints

### 1. POST `/api/catalog/update-price`

Updates prices for catalog items. Called by Retool when staff changes prices.

**Note:** For private service type price tiers, use `/api/catalog/update-tier-price` instead.

**Authentication:** Bearer token (RETOOL_API_KEY)

**Request Body:**
```json
{
  "itemType": "product",
  "itemId": "uuid-here",
  "basePrice": 29.99,
  "memberPrice": 24.99,
  "salePrice": 19.99
}
```

**Item Types:**
- `service_type` - Only PUBLIC sessions; has single `price` field (private sessions use tiers)
- `product`, `addon`, `membership_plan`, `session_pass_type` - Have all three price tiers

**Response:**
```json
{
  "success": true,
  "item": { /* updated item */ },
  "pricesUpdated": {
    "price": 15.00  // for service_type
    // OR
    "base_price": 29.99,
    "member_price": 24.99,
    "sale_price": 19.99
  }
}
```

**What It Does:**
1. Validates authentication
2. For service_type: checks it's public (rejects private - those use tiers)
3. Fetches current item from Supabase
4. Archives old Stripe prices (they're immutable)
5. Creates new Stripe prices
6. Updates Supabase with new prices and Stripe price IDs

---

### 2. POST `/api/catalog/update-tier-price`

Updates a single price tier for private service types (e.g., updating the 7-adult tier from NULL to £120).

**Authentication:** Bearer token (RETOOL_API_KEY)

**Request Body:**
```json
{
  "tierId": "uuid-here",
  "price": 120.00
}
```

**Response:**
```json
{
  "success": true,
  "tier": { /* updated tier */ },
  "stripePriceId": "price_xxx"
}
```

**What It Does:**
1. Validates authentication
2. Fetches the tier and parent service type
3. Archives old Stripe price (if exists)
4. Creates new Stripe price
5. Updates tier with new price and Stripe price ID

---

### 3. POST `/api/catalog/create-variant`

Creates a new product variant (e.g., adding a "Large" size). Creates Stripe Price first, then inserts Supabase row.

**Authentication:** Bearer token (RETOOL_API_KEY)

**Request Body:**
```json
{
  "productId": "uuid-here",
  "size": "Large",
  "sku": "CLASSIC-TEE-L",
  "priceOverride": 35.00,  // Optional - if omitted, inherits product's base_price
  "stockQuantity": 50      // Optional - defaults to 0
}
```

**Response:**
```json
{
  "success": true,
  "variant": { /* created variant */ },
  "stripePriceId": "price_xxx"
}
```

**What It Does:**
1. Validates authentication and required fields (productId, size, sku)
2. Fetches parent product and verifies it has a Stripe product
3. Checks SKU is unique
4. Creates Stripe Price (uses priceOverride or inherits product's base_price)
5. Inserts variant into Supabase with Stripe price ID
6. If Supabase insert fails, archives the Stripe price (cleanup)

---

### 4. POST `/api/catalog/toggle-active`

Activates or deactivates catalog items (removes from customer-facing interfaces).

**Authentication:** Bearer token (RETOOL_API_KEY)

**Request Body:**
```json
{
  "itemType": "product",
  "itemId": "uuid-here",
  "active": false
}
```

**Response:**
```json
{
  "success": true,
  "item": { /* updated item */ }
}
```

**What It Does:**
1. Updates Stripe product `active` status
2. Updates Supabase `active` field

---

### 5. POST `/api/catalog/sync-stripe`

Manually creates Stripe products for items that don't have them yet. Useful for backfilling or fixing sync issues.

**Authentication:** Bearer token (RETOOL_API_KEY)

**Request Body:**
```json
{
  "itemType": "product",
  "itemId": "uuid-here"
}
```

**Response:**
```json
{
  "success": true,
  "item": { /* updated item */ },
  "stripeProductId": "prod_xxx"
}
```

**What It Does:**
1. Validates item exists and has no Stripe product
2. Creates Stripe product with name, image, metadata
3. Creates Stripe prices if prices exist in database
4. Updates Supabase with Stripe product and price IDs

---

### 6. POST `/api/sanity/webhook` (existing, now updated)

Receives webhooks from Sanity when content is published.

**Authentication:** HMAC signature verification (SANITY_WEBHOOK_SECRET)

**What It Does:**
1. Verifies Sanity webhook signature
2. Updates Supabase mirror fields (name, thumbnail_url, category)
3. **NEW:** Creates Stripe products for new items
4. Never touches operational fields (prices, stock, active status)

## Environment Variables Required

Add these to your root `.env.local`:

```bash
# Stripe
STRIPE_SECRET_KEY=sk_test_xxx  # Get from Stripe Dashboard

# Retool
RETOOL_API_KEY=xxx  # Generate a random secure key: openssl rand -base64 32

# Existing (already configured)
SANITY_WEBHOOK_SECRET=xxx
NEXT_PUBLIC_SUPABASE_URL=xxx
SUPABASE_SERVICE_ROLE_KEY=xxx
```

## Currency

All prices are in **GBP (£)** and Stripe prices are created with `currency: 'gbp'`.

## Setup Instructions

### 1. Install Dependencies

```bash
cd web
npm install stripe
```

### 2. Configure Environment Variables

Create or update `web/.env.local`:

```bash
STRIPE_SECRET_KEY=sk_test_your_key_here
RETOOL_API_KEY=$(openssl rand -base64 32)
```

### 3. Deploy to Cloudflare Workers

```bash
npm run deploy
```

### 4. Configure Retool

In your Retool app, create API calls to these endpoints:

**Resource Setup:**
- Type: REST API
- Base URL: `https://your-worker.workers.dev`
- Headers: 
  - `Authorization: Bearer {{retoolApiKey}}`
  - `Content-Type: application/json`

**Example: Update Price Query**
```javascript
{
  method: 'POST',
  url: '/api/catalog/update-price',
  body: {
    itemType: selectItemType.value,
    itemId: tableItems.selectedRow.data.id,
    basePrice: inputBasePrice.value,
    memberPrice: inputMemberPrice.value,
    salePrice: inputSalePrice.value
  }
}
```

**Example: Update Tier Price Query** (for private session tiers)
```javascript
{
  method: 'POST',
  url: '/api/catalog/update-tier-price',
  body: {
    tierId: tableTiers.selectedRow.data.id,
    price: inputTierPrice.value
  }
}
```

**Example: Create Variant Query**
```javascript
{
  method: 'POST',
  url: '/api/catalog/create-variant',
  body: {
    productId: tableProducts.selectedRow.data.id,
    size: inputSize.value,
    sku: inputSku.value,
    priceOverride: inputPrice.value || null,
    stockQuantity: inputStock.value || 0
  }
}
```

## Testing

Test the endpoints with curl:

```bash
# Update price
curl -X POST https://your-worker.workers.dev/api/catalog/update-price \
  -H "Authorization: Bearer YOUR_RETOOL_API_KEY" \
  -H "Content-Type: application/json" \

# Create variant
curl -X POST https://your-worker.workers.dev/api/catalog/create-variant \
  -H "Authorization: Bearer YOUR_RETOOL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "productId": "uuid-here",
    "size": "Large",
    "sku": "CLASSIC-TEE-L",
    "stockQuantity": 50
  }'
  -d '{
    "itemType": "product",
    "itemId": "uuid-here",
    "basePrice": 29.99
  }'

# Toggle active status
curl -X POST https://your-worker.workers.dev/api/catalog/toggle-active \
  -H "Authorization: Bearer YOUR_RETOOL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "itemType": "product",
    "itemId": "uuid-here",
    "active": false
  }'For price changes, variant creation, deactivation, and any Stripe-related operations, Retool must call these backend APIs** - never write prices or Stripe IDs directly to Supabase, and never call Stripe directly from Retool
4. **Direct Supabase writes from Retool are correct for operational fields** (stock updates, booking check-ins, membership/session pass credit tracking, blocking slots, etc.) - those don't involve Stripe and should continue writing directly to Supabase as they do now
5``

## Error Handling

All endpoints return:
- `401 Unauthorized` - Invalid or missing API key
- `400 Bad Request` - Missing required fields or validation errors
- `404 Not Found` - Item doesn't exist
- `500 Internal Server Error` - Database or Stripe API errors

## Security Notes

1. **Never expose RETOOL_API_KEY in frontend code**
2. **Use service role key only in backend** (these endpoints use it correctly)
3. **Retool should never write directly to Stripe or Supabase** - always call these APIs
4. Stripe webhook signature verification coming in future update

## Next Steps

1. Create Stripe webhook endpoint for handling payment events
2. Add rate limiting to prevent abuse
3. Add audit logging for price changes
4. Build Retool interface that calls these endpoints
