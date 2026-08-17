# Sanity Webhook Setup

This webhook syncs catalog items from Sanity CMS to Supabase when published.

## What it does

When you publish content in Sanity Studio:
1. **Service Types** → syncs `name`, `thumbnail_url` to `service_types` table
2. **Products** → syncs `name`, `category`, `thumbnail_url` to `products` table
3. **Add-ons** → syncs `name`, `category`, `thumbnail_url` to `addons` table
4. **Membership Plans** → syncs `name`, `thumbnail_url` to `membership_plans` table
5. **Session Pass Types** → syncs `name`, `thumbnail_url` to `session_pass_types` table

**Content-only types** (Page, Blog Post, Gallery Image) are **not synced** - they stay Sanity-only.

## Setup Instructions

### 1. Deploy your Next.js app first

The webhook endpoint needs to be live before you configure it in Sanity.

```bash
cd web
npm run deploy  # Deploy to Cloudflare Pages
```

Your webhook URL will be:
```
https://thepaddockwellnessclub.co.uk/api/sanity/webhook
```

### 2. Configure webhook in Sanity

1. Go to https://sanity.io/manage
2. Select your project: **qx4gqx7t**
3. Click **API** → **Webhooks**
4. Click **Create webhook**

**Configuration:**
- **Name**: `Supabase Sync`
- **URL**: `https://thepaddockwellnessclub.co.uk/api/sanity/webhook`
- **Trigger on**:
  - ✅ Create
  - ✅ Update
  - ✅ Delete (optional - currently not handled but safe to enable)
- **Filter**: Leave empty (all document types)
- **HTTP method**: `POST`
- **HTTP Headers**:
  - Add header: `x-sanity-signature`
  - Value: Use the HMAC SHA256 signature
- **Secret**: `fS9Ge4qBkVUhOlF7vxvpLMQpNgmqPD3fsooVRImxbLQ=`
  - ⚠️ **IMPORTANT**: This must match `SANITY_WEBHOOK_SECRET` in `.env.local`
- **Projection**: Leave as default (full document)
- **Dataset**: `production`

5. Click **Save**

### 3. Test the webhook

1. Go to Sanity Studio: https://thepaddockwellnessclub.sanity.studio/
2. Create a new **Product**:
   - Name: "Test Product"
   - Category: "Apparel"
   - Add an image
   - Fill in description
   - Click **Publish**

3. Check Sanity webhook logs:
   - Go to https://sanity.io/manage → API → Webhooks
   - Click on your webhook
   - Check **History** tab - should show 200 response

4. Verify in Retool:
   - Open your Retool app
   - Query: `SELECT * FROM products WHERE name = 'Test Product'`
   - Should show the new product with name, category, thumbnail_url

## How mirror fields work

**Sanity → Supabase (one-way sync):**
- `name` - Always synced from Sanity
- `thumbnail_url` - First image from images array
- `category` - Product/addon category only

**Never synced (set in Retool/backend only):**
- All price fields
- All `stripe_price_id` fields
- `stock_quantity`
- `active` status
- `expiry_months`

**Why?** The webhook only touches fields that staff never edit. Prices are managed through Retool → Backend API → Stripe flow to keep Stripe and Supabase in perfect sync.

## Troubleshooting

### Webhook returns 401 "Invalid signature"
- Secret mismatch between Sanity webhook config and `.env.local`
- Regenerate secret: `openssl rand -base64 32`
- Update both Sanity webhook settings AND `.env.local`
- Redeploy app: `cd web && npm run deploy`

### Webhook returns 500 "Internal server error"
- Check Cloudflare Pages logs
- Verify Supabase credentials in `.env.local`
- Check table names match migration schema

### Data not appearing in Supabase
- Check webhook was triggered (Sanity webhook History tab)
- Verify you published (not just saved draft)
- Check RLS policies - webhook uses service role key so should bypass RLS
- Query directly: `SELECT * FROM products WHERE sanity_product_id = 'YOUR_SANITY_ID'`

### Images not showing
- Verify image asset exists in Sanity
- Check thumbnail_url format in Supabase (should be `https://cdn.sanity.io/images/...`)
- Test URL directly in browser

## Future enhancements

Currently marked as `TODO` in code:
- Stripe Product creation on first sync
- Handle document deletion (set `active = false`)
- Batch sync for existing content
