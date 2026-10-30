# Cloudflare publication checklist

The dashboard is a static prototype. Publish it only after the Pages hostname is protected by Cloudflare Access.

## Cloudflare Pages

1. Create or sign in to the Bouquet Innovation Cloudflare account.
2. Open **Workers & Pages**, choose **Create application**, then **Pages** and **Import an existing Git repository**.
3. Connect the GitHub account and select `BI-Booster`.
4. Set production branch to `main`, leave the build command blank, and set the build output directory to `.`.
5. Deploy and note the generated `*.pages.dev` hostname.

## Restrict access

1. In Cloudflare Zero Trust, add an **Access application** of type **Self-hosted** for the complete Pages hostname.
2. Configure a verified company identity provider, then add an **Allow** policy for the `bouquet-innovation.net` email domain.
3. Confirm that a company account can sign in and that an unrelated email is denied before sharing the URL.

Cloudflare Access gates the static site before it reaches the browser; the frontend itself does not implement authentication. If a custom domain is added later, include that hostname in the Access application too.

## Production app work still required

The current dashboard is a frontend prototype with sample metrics and client names. Before operational use, add authenticated server-side storage, client and role management, official OAuth integrations for each social network, and background publishing/analytics jobs. Keep all API credentials in server-side Cloudflare secrets. Never commit real client data or secrets to this public repository.
