# Cloudflare Workers + Neon setup

BI Booster is served by one Cloudflare Worker: static files in `public/` and authenticated API routes in `src/worker.js`. The Worker uses Neon PostgreSQL for durable data and Resend to deliver one-time login links.

## 1. Prepare Neon

1. Create a Neon project and database.
2. In the Neon SQL Editor, execute `migrations/001_initial.sql`.
3. Copy the pooled connection string from the Neon dashboard. Keep it private.

## 2. Prepare email delivery

1. Create a Resend account and verify a sending domain in Resend. Configure its required DNS records with your DNS provider.
2. Create a Resend API key.
3. Choose an `EMAIL_FROM` value that Resend permits for the verified sender domain. For example, use `BI Booster <support@bouquet-innovation.net>` only after that domain is verified for sending.

The login policy accepts only valid email addresses whose domain is exactly `bouquet-innovation.net`. Sign-in links expire after 15 minutes and can be used once. The app creates `support@bouquet-innovation.net` as an admin on first sign-in; other eligible accounts receive the member role. This is email ownership verification, not a separate manual approval queue.

## 3. Configure and deploy the Worker

From the repository root:

```sh
npm install
npx wrangler login
npx wrangler secret put DATABASE_URL
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put EMAIL_FROM
npx wrangler secret put APP_BASE_URL
npm run deploy
```

Enter each value when Wrangler prompts. `APP_BASE_URL` should be the final HTTPS Worker or custom-domain origin, with no trailing slash (for example, `https://bi-booster.<your-subdomain>.workers.dev`). Set secrets in both production and preview environments if you use previews. For local development, copy `.dev.vars.example` to `.dev.vars` and set local values there.

The static asset binding and API routing are configured in `wrangler.jsonc`. The Worker serves the frontend and `/api/*` from the same origin. Configure a custom domain in the Cloudflare dashboard if desired; update `APP_BASE_URL` to match it and redeploy.

## 4. Verify access

1. Open the deployed origin and request a link for an `@bouquet-innovation.net` address.
2. Confirm the email arrives, the link signs in, and the dashboard loads.
3. Confirm an address from another domain is rejected before an email is sent.
4. Confirm `support@bouquet-innovation.net` shows the workspace admin role and can add a client.
5. Confirm another company-domain user can sign in as a member and cannot add clients.

The app enforces its own email-domain allowlist and session checks on API routes. Cloudflare Access can be added as an additional organization-level gate, but requires an identity provider configured for company accounts.

## Important boundaries

The repository is public by request. Application data and secrets are not included in it; never commit `.dev.vars`, real client data, or provider credentials. Static source and UI are visible to anyone. Only the API data is gated by the sign-in session.

Social OAuth, publishing, incoming-message sync, AI generation, analytics ingestion, and scheduled background jobs need their own official provider integrations and credentials. The current UI saves drafts and workspace records; it does not publish posts or fabricate performance metrics.
