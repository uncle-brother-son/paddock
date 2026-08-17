# Next.js + Sanity CMS + Cloudflare Workers Template

A minimal, prompt-only template that scaffolds fresh Next.js and Sanity projects with the latest packages. Contains zero code - just documentation and automation instructions for AI agents.

## Philosophy

**Pure Infrastructure Setup**

This template doesn't include any code. Instead, it provides:
- AI agent automation instructions
- Configuration templates
- Development standards documentation

When you run setup, the agent:
- Scaffolds fresh Next.js and Sanity with latest versions
- Installs dependencies and optional packages
- Creates configuration files
- **Leaves you with a clean slate to build custom features**

**Why this approach?**
- ✅ Always latest packages (no outdated dependencies)
- ✅ No bespoke code to clean out
- ✅ Minimal template size (~10KB vs 500MB)
- ✅ Maximum flexibility

## What You Get

### From the Agent (Infrastructure)
- Fresh Next.js 16+ project (scaffolded with `create-next-app`)
- Fresh Sanity Studio (scaffolded with `create-sanity`)
- Latest package versions
- Configuration files (wrangler.jsonc, .env files)
- Optional packages (Resend, Storybook, Lenis, etc.)

### What You Build (Everything Else)
- All pages and routes
- All components
- All utilities and helpers
- All Sanity schemas
- All styling
- All business logic

**Result:** Clean foundation, latest tech, zero cruft.

## Tech Stack

- **Frontend:** Next.js 16+ (App Router, React 19+) - scaffolded fresh each time
- **CMS:** Sanity CMS v5 (Node 20 compatible for Cloudflare Workers)
- **Styling:** Tailwind CSS v4
- **Deployment:** Cloudflare Workers + Pages (Node 20 runtime)
- **Caching:** Cloudflare KV + D1
- **Package Manager:** npm

**Note:** Sanity v5 is used instead of v6 because Cloudflare Workers uses Node 20 runtime, and Sanity v6 requires Node 22.12+. This is the correct approach for Cloudflare deployments.

## Quick Start

### 1. Start with Template Files

You should have a folder containing just these 6 template files:
- `.instructions.md`
- `README.md`  
- `PROJECT-SETUP.md`
- `.env.local.example`
- `optional-packages.json`
- `.gitignore`

### 2. Configure

```bash
cp .env.local.example .env.local
# Edit .env.local with your Sanity, Cloudflare, and GA IDs
```

### 3. Run Setup

Tell your AI agent:
```
"Set up this project"
```

Agent will:
1. Prompt for optional packages
2. Scaffold fresh Next.js and Sanity
3. Install latest dependencies
4. Create configuration files
5. Report what needs manual completion

### 4. Complete Manual Steps

- Add custom fonts
- Configure Sanity CORS
- Create revalidation API route
- Deploy Sanity Studio
- Deploy to Cloudflare

### 5. Build Your Features!

Start creating your custom pages, components, schemas, and styling.

## Template Contents

```
your-project/
├── .instructions.md          # AI agent instructions (the brain)
├── README.md                 # This file
├── PROJECT-SETUP.md         # Detailed setup guide
├── .env.local.example       # Configuration template
├── optional-packages.json   # Optional package definitions
└── .gitignore              # Git ignore rules
```

**Total size:** ~10KB

## Optional Packages

During setup, choose which to install:
- **Resend + React Email** - Email sending
- **Storybook** - Component development
- **Lenis** - Smooth scrolling
- **React Hook Form + Zod** - Form validation
- **Zustand** - State management

See [optional-packages.json](./optional-packages.json) for details.

## Development Standards

High-performance best practices enforced by this template:

### Performance Targets
- **LCP:** < 2.5s | **INP:** < 200ms | **TTFB:** < 0.6s | **CLS:** < 0.1

### Key Principles
- **Content freshness:** Updates visible within seconds via direct API + webhook revalidation
- **React optimization:** memo() on pure components, memoized callbacks
- **Event handlers:** Throttle scroll (16ms), debounce resize (150ms)
- **Animations:** 60fps target, hardware-accelerated only
- **Images:** Sanity CDN with responsive sizes, lazy loading
- **Data fetching:** Parallelize independent queries

Full standards in [.instructions.md](./.instructions.md).

## Architecture

- **Content:** Direct Sanity API queries + webhook revalidation for instant updates
- **Caching:** Cloudflare KV (incremental) + D1 (tag-based)
- **Rendering:** Dynamic with `revalidate=0` for freshness
- **Distribution:** Cloudflare edge network

## Why Prompt-Only?

| Static Template | Prompt-Only Template |
|----------------|---------------------|
| Outdated packages within months | Always latest via npx |
| Bespoke code to clean | Zero code to clean |
| 500MB+ with node_modules | ~10KB total |
| Breaking changes accumulate | Fresh start each time |

## Using This Template for Multiple Projects

To reuse this template:

1. **Copy the entire folder** to your new project location
2. **Rename the folder** to your new project name
3. Follow the Quick Start steps above

Or keep a master copy and duplicate it:

```bash
# Keep master template
cp -r ~/Templates/base-template ~/Projects/new-project-name
cd ~/Projects/new-project-name
# Now follow Quick Start steps
```

## Common Issues & Solutions

### Sanity Version Warnings
If you see engine warnings about Sanity v6 peer dependencies:
- **This is expected** - Cloudflare Workers uses Node 20, Sanity v6 requires Node 22.12+
- We intentionally use Sanity v5 for compatibility
- Warnings are informational only - everything works correctly

### npm Permission Errors (macOS)
```bash
sudo chown -R $(id -u):$(id -g) "$HOME/.npm"
```

### Tailwind Scanner Errors
Ensure `web/tailwind.config.ts` exists with content paths - Tailwind v4 requires explicit configuration.

See [PROJECT-SETUP.md](./PROJECT-SETUP.md) for detailed troubleshooting.

## License

ISC

---

**Template Version:** 2.0.0 (Pure Infrastructure)  
**Updated:** 2026-08-15
