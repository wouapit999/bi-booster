# BI Booster

BI Booster is Bouquet Innovation SA's internal social growth workspace for delivering digital marketing services across TikTok, Facebook, Instagram, LinkedIn, X, YouTube, and Threads.

This repository currently contains the responsive dashboard experience and sample portfolio data. Account connection, secure team authentication, persistent client data, platform publishing, and live analytics require backend services and official platform API credentials before production use.

## Run locally

Open `index.html` in a browser, or serve this folder with any static web server.

## Deploy to Cloudflare Pages

The app is a static site with no build step. In Cloudflare, create a Pages project from the GitHub repository, set the production branch to `main`, leave the build command blank, and set the build output directory to `.`. Pages will automatically deploy pushes and create preview deployments.

Before sharing the Pages hostname, create a Cloudflare Access self-hosted application for that hostname and an Allow policy restricted to the verified `bouquet-innovation.net` email domain. A verified company identity provider is required. Keep this gate in place; the app has no sign-in screen of its own. The `_headers` file applies browser security headers and tells search engines not to index the dashboard.

The GitHub repository is intended to be public, so it contains only frontend code and sample data. Never commit credentials, access tokens, or real client data.

Live publishing requires platform app registrations and a server-side API layer; keep access tokens in Cloudflare secrets and use each network's official OAuth and publishing APIs.

## Product brief and design direction

See [PRODUCT.md](PRODUCT.md) and [DESIGN.md](DESIGN.md).
