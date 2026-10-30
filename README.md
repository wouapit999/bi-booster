# BI Booster

BI Booster is Bouquet Innovation SA's internal social growth workspace for delivering digital marketing services across TikTok, Facebook, Instagram, LinkedIn, X, YouTube, and Threads.

The app is a Cloudflare Worker that serves the frontend and API from one origin. Neon PostgreSQL stores the internal workspace data. Team access uses one-time email sign-in links; only addresses ending in `@bouquet-innovation.net` can request access. `support@bouquet-innovation.net` receives the admin role automatically on first sign-in.

## Local setup

1. Install Node.js 20 or newer.
2. Create a Neon PostgreSQL project and copy its pooled connection string.
3. Run [`migrations/001_initial.sql`](migrations/001_initial.sql) in the Neon SQL Editor.
4. Create a Resend account, verify a sender domain you control, and create an API key. The configured `EMAIL_FROM` address must be an allowed sender for that verified domain.
5. Copy `.dev.vars.example` to `.dev.vars`; set `DATABASE_URL`, `RESEND_API_KEY`, `EMAIL_FROM`, and `APP_BASE_URL=http://localhost:8787`. Keep `.dev.vars` private.
6. Install dependencies with `npm install`, then run `npm run dev`.
7. Open `http://localhost:8787`, enter a company email address, and follow the link delivered to that inbox.

The first signed-in user with the admin email becomes the workspace admin. Admins can add client records; all signed-in team members can create posts and tasks.

## Deploy to Cloudflare Workers

See [`CLOUDFLARE_SETUP.md`](CLOUDFLARE_SETUP.md) for deployment, secrets, and domain setup. Do not put Neon, Resend, or social-platform credentials in frontend code or commit them to Git.

## Current scope

The database-backed login, client list, draft posts, tasks, and analytics data model are wired up. Analytics remain empty until an official channel integration imports metrics. Social account OAuth, actual publishing, unified message retrieval, AI-provider generation, and background jobs still need platform/provider configuration and implementation. Drafts are saved in Neon; they are not automatically published.

This is a public source repository for an internal tool. Do not put real client data or credentials in commits. Application login gates access to the data API; source code and frontend assets remain public.

## Product brief and design direction

See [PRODUCT.md](PRODUCT.md) and [DESIGN.md](DESIGN.md).
