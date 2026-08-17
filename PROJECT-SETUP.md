# Project Setup Guide

This guide explains how to use this minimal template to set up new projects. The template contains **only documentation files** - the agent will scaffold fresh Next.js and Sanity projects with the latest packages.

---

## Template Contents (Prompt Files Only)

Your project folder should contain just these 6 files:
```
your-project/
├── .instructions.md          # AI agent automation instructions
├── README.md                 # Project overview
├── PROJECT-SETUP.md         # This file
├── .env.local.example       # Configuration template
├── optional-packages.json   # Optional package definitions
└── .gitignore              # Git ignore rules
```

**That's it!** No code, no components, no utilities, no pre-existing web/ or studio/ folders.

The agent scaffolds everything fresh with the latest packages.

---

## Prerequisites (Complete Before Setup)

Before running automated setup, ensure you have:

- [ ] **Node.js 18+** and **npm** installed
- [ ] **Sanity account** created at https://www.sanity.io
- [ ] **Sanity project** created (note the Project ID)
- [ ] **Cloudflare account** with Workers enabled  
- [ ] **Cloudflare KV namespace** created: `wrangler kv:namespace create NEXT_INC_CACHE_KV`
- [ ] **Cloudflare D1 database** created: `wrangler d1 create {project-name}-tag-cache`
- [ ] **Domain name** configured in Cloudflare DNS
- [ ] **Google Analytics 4** property created (GA4 Measurement ID)
- [ ] **Sanity webhook secret** generated (random secure string)

---

## Setup Workflow

### Step 1: Verify Template Files

Ensure you're in a folder containing the 6 template files listed above. This folder will become your project root.

### Step 2: Configure Environment

```bash
# Create your configuration file
cp .env.local.example .env.local

# Edit with your values
nano .env.local  # Or use your preferred editor
```

Fill in ALL required fields from your prerequisites.

### Step 3: Run Automated Setup

Tell your AI agent: **"Set up this project"**

The agent will automatically:

#### 3.1 Validate Prerequisites
- Confirm `.env.local` exists with all required values
- Check you've completed manual prerequisites

#### 3.2 Prompt for Optional Packages
```
❓ Install Resend + React Email for email functionality? (yes/no)
❓ Install Storybook for component development? (yes/no)
❓ Install Lenis for smooth scrolling? (yes/no)
❓ Install React Hook Form + Zod for forms? (yes/no)
❓ Install Zustand for state management? (yes/no)
```

#### 3.3 Scaffold Fresh Projects with Latest Packages

⚠️ **Node Version Compatibility Note:**
- Cloudflare Workers runtime uses **Node 20**
- Sanity v6 requires **Node 22.12+**
- We use **Sanity v5** for Cloudflare Workers compatibility

**Next.js:**
```bash
npx create-next-app@latest web --typescript --tailwind --app --eslint
cd web
npm install @sanity/client @sanity/image-url @portabletext/react framer-motion
npm install -D @opennextjs/cloudflare
npm install tailwindcss@next @tailwindcss/postcss@next
# + any optional packages you selected
```

**Sanity Studio (v5 for Node 20 compatibility):**
```bash
# Read project ID from .env.local
SANITY_PROJECT_ID=$(grep NEXT_PUBLIC_SANITY_PROJECT_ID .env.local | cut -d '=' -f2)
npx create-sanity@latest studio --typescript --dataset production --project "$SANITY_PROJECT_ID"
cd studio
# Downgrade to v5 packages for Cloudflare Workers compatibility
npm install sanity@^5 @sanity/vision@^3 sanity-plugin-media@^5 @sanity/orderable-document-list@^1
```

#### 3.4 Configure Sanity & Tailwind

**Disable Sanity auto-updates** (prevents version mismatch warnings):
Update `studio/sanity.config.ts`:
```typescript
export default defineConfig({
  projectId: PROJECT_ID,
  dataset: 'production',
  autoUpdates: false,  // Add this line
  plugins: [structureTool(), visionTool()],
  // ... rest of config
})
```

**Create Tailwind v4 config** (required for content scanning):
Create `web/tailwind.config.ts`:
```typescript
import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
};

export default config;
```

#### 3.5 Create Configuration Files

Agent creates these files using your `.env.local` values:

**`web/wrangler.jsonc`** - Cloudflare Workers configuration
**`web/.env`** - Next.js environment variables
**`studio/.env`** - Sanity Studio environment variables

Updates Sanity config files with your project ID.

#### 3.6 Final Setup
```bash
mkdir -p web/public/fonts
```

#### 3.7 Report Completion

```
✅ Next.js scaffolded (version 16.x.x)
✅ Sanity Studio scaffolded with v5 packages (Node 20 compatible)
   - sanity@^5, @sanity/vision@^3 (Cloudflare Workers requires Node 20)
   - autoUpdates disabled to prevent version mismatch warnings
✅ Tailwind v4 config created (web/tailwind.config.ts)
✅ Optional packages installed: [Resend, Storybook]
✅ Configuration files created
✅ Font folder created

⚠️ MANUAL STEPS REQUIRED - See Step 4 below

🚀 READY TO BUILD - You'll now create all custom code
```

---

### Step 4: Complete Manual Configuration

#### 4.1 Add Custom Fonts

1. Copy font files to `web/public/fonts/`
2. Update `web/app/globals.css` with `@font-face` declarations

#### 4.2 Configure Sanity CORS

1. Go to https://www.sanity.io/manage
2. Select your project → **API** → **CORS Origins**
3. Add origins:
   - `http://localhost:3000`
   - `https://{your-domain}.com`
   - `https://*.pages.dev`

#### 4.3 Create Revalidation API Route

Since agent doesn't create code, you'll need to create:

**`web/app/api/revalidate/route.ts`:**
```typescript
import { revalidatePath } from 'next/cache';
import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  const secret = request.headers.get('x-sanity-webhook-secret');
  
  if (secret !== process.env.SANITY_REVALIDATE_SECRET) {
    return NextResponse.json({ message: 'Invalid secret' }, { status: 401 });
  }

  revalidatePath('/', 'layout');
  return NextResponse.json({ revalidated: true, now: Date.now() });
}
```

#### 4.4 Deploy Sanity Studio

```bash
cd studio
npm run deploy
```

Your Studio will be available at: `https://{your-project-name}.sanity.studio`

#### 4.5 Create Initial Content in Sanity

You'll need to create your own Sanity schemas first, then populate content.

#### 4.6 Deploy to Cloudflare

```bash
cd web
npm run deploy
```

#### 4.7 Configure Custom Domain

1. Cloudflare Dashboard → **Workers & Pages**
2. Select your project → **Settings** → **Domains & Routes**
3. Add custom domain

#### 4.8 Set Up Sanity Webhook

1. Sanity dashboard → **API** → **Webhooks** → **Create webhook**
2. Configure:
   - **URL:** `https://{your-domain}.com/api/revalidate`
   - **Dataset:** `production`
   - **Trigger on:** Create, Update, Delete
   - **HTTP headers:**
     - Name: `x-sanity-webhook-secret`
     - Value: Value from `SANITY_REVALIDATE_SECRET` in .env.local

**Note:** Configure webhook after deployment so the endpoint is live when Sanity starts sending events.

---

### Step 5: Build Your Custom Features

Now you build everything from scratch:

**Pages & Routing** - Create in `web/app/`
**Components** - Create in `web/app/components/`
**Utilities** - Create in `web/app/lib/`
**Sanity Schemas** - Create in `studio/schemaTypes/`
**Queries** - Create in `web/app/queries/` or wherever you prefer
**Styling** - Customize Tailwind in `web/app/globals.css`

---

## Testing

### Local Development

```bash
# Terminal 1 - Sanity Studio
cd studio && npm run dev
# Opens at http://localhost:3333

# Terminal 2 - Next.js
cd web && npm run dev
# Opens at http://localhost:3000
```

### Production Verification

After deployment:
- [ ] Site loads at custom domain
- [ ] Content from Sanity displays
- [ ] Edit content → updates appear within seconds
- [ ] Images load via Sanity CDN
- [ ] Google Analytics tracking works
- [ ] Sitemap accessible: `/sitemap.xml`
- [ ] Core Web Vitals pass (PageSpeed Insights)

---

## Troubleshooting

### npm Permission Errors (macOS)
**Symptom:** `EPERM` errors during `npm install`, "operation not permitted on .npm cache"

**Solution:**
```bash
sudo chown -R $(id -u):$(id -g) "$HOME/.npm"
```
Run this command before npm install if permission errors occur. This is a common macOS issue.

### Sanity Version Warnings
**Symptom:** Engine warnings like "package sanity@5.x.x doesn't satisfy peer dependency sanity@^6"

**This is expected and safe:**
- Cloudflare Workers runtime uses **Node 20**
- Sanity v6 requires **Node 22.12+**
- We intentionally use **Sanity v5** for Cloudflare Workers compatibility
- The warnings are informational only - Sanity v5 works perfectly with Node 20

**Do not upgrade to Sanity v6** - it will break Cloudflare Workers deployment.

### Tailwind Scanner Error
**Symptom:** "Missing field `negated` on ScannerOptions.sources" or similar Tailwind errors

**Solution:** Ensure `web/tailwind.config.ts` exists with content paths:
```typescript
import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
};

export default config;
```

Tailwind v4 requires explicit content path configuration.

### Environment Variables Not Loading
- Verify `.env.local` exists in root
- Check `web/.env` was created by agent
- Restart dev servers after .env changes

### Sanity Content Not Appearing
- Verify CORS configured in Sanity dashboard
- Check Project ID matches in all configs
- Ensure content is published (not draft)

### Cloudflare Deployment Fails
- Verify IDs in `wrangler.jsonc` match .env.local
- Run `wrangler login` to refresh auth
- Check Workers enabled on your account

### Build Errors
- Delete `.next`: `rm -rf web/.next`
- Clear cache: `npm cache clean --force`
- Reinstall: `cd web && rm -rf node_modules && npm install`

---

## Quick Reference Checklist

### Prerequisites Done?
- [ ] Sanity project created
- [ ] Cloudflare KV + D1 created
- [ ] Domain configured
- [ ] GA4 property created
- [ ] Webhook secret generated

### Setup Complete?
- [ ] Template copied to project folder
- [ ] `.env.local` created and filled
- [ ] Told agent "Set up this project"
- [ ] Agent reported success

### Manual Steps Done?
- [ ] Fonts added and configured
- [ ] Sanity CORS configured
- [ ] Revalidation API route created
- [ ] Sanity Studio deployed
- [ ] Initial Sanity schemas created
- [ ] Site deployed to Cloudflare
- [ ] Custom domain configured
- [ ] Sanity webhook created

### Ready to Build?
- [ ] Dev servers running without errors
- [ ] Building your custom pages and components!

---

**Template Version:** 2.0.0 (Pure Infrastructure Approach)  
**Last Updated:** 2026-08-15
