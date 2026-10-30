# BI Booster

BI Booster is Bouquet Innovation SA's internal social growth workspace for delivering digital marketing services across TikTok, Facebook, Instagram, LinkedIn, X, YouTube, and Threads.

The app is a Cloudflare Worker that serves the frontend and API from one origin. Neon PostgreSQL stores the internal workspace data. Team access is invite-only: the workspace admin invites `@bouquet-innovation.net` addresses, gives each a role (Admin, Manager, Editor or Viewer) and assigns the clients they work on; everyone signs in with one-time email links. `support@bouquet-innovation.net` is always the workspace admin.

## Local setup

1. Install Node.js 20 or newer.
2. Create a Neon PostgreSQL project and copy its pooled connection string.
3. Run [`migrations/001_initial.sql`](migrations/001_initial.sql) in the Neon SQL Editor.
4. Create a Resend account, verify a sender domain you control, and create an API key. The configured `EMAIL_FROM` address must be an allowed sender for that verified domain.
5. Copy `.dev.vars.example` to `.dev.vars`; set `DATABASE_URL`, `RESEND_API_KEY`, `EMAIL_FROM`, and `APP_BASE_URL=http://localhost:8787`. Keep `.dev.vars` private.
6. Install dependencies with `npm install`, then run `npm run dev`.
7. Open `http://localhost:8787`, enter a company email address, and follow the link delivered to that inbox.

The admin adds clients, connects their Facebook Pages, Instagram, TikTok and YouTube accounts through each platform’s official sign-in, and invites the team from **Settings**. Database migrations in `migrations/` apply automatically on the first request after a deploy.

## Deploy to Cloudflare Workers

See [`CLOUDFLARE_SETUP.md`](CLOUDFLARE_SETUP.md) for deployment, secrets, and domain setup. Do not put Neon, Resend, or social-platform credentials in frontend code or commit them to Git.

## Current scope

Working end to end: invite-only team access with roles and per-client assignments; OAuth connections for Facebook Pages, Instagram professional accounts, TikTok and YouTube (tokens encrypted with `TOKEN_ENCRYPTION_KEY`); a Hootsuite-style workflow (draft → approval → scheduled → published, with comments, an activity log and email notifications); and a once-a-minute scheduler that publishes due posts and records each platform’s result. See [`SOCIAL_SETUP.md`](SOCIAL_SETUP.md) for the platform developer apps and secrets each network needs. Not yet built: the engagement inbox, analytics import, LinkedIn/X/Threads publishing and AI caption generation.

This is a public source repository for an internal tool. Do not put real client data or credentials in commits. Application login gates access to the data API; source code and frontend assets remain public.

## Product brief and design direction

See [PRODUCT.md](PRODUCT.md) and [DESIGN.md](DESIGN.md).
