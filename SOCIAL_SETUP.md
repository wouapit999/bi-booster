# Social platforms, team and publishing setup

BI Booster connects to each network through that network's **official developer app and OAuth sign-in**. Bouquet Innovation registers one developer app per platform. The workspace admin then connects each client's profiles from **Settings → Social accounts** by signing in to the platform. BI Booster never asks for passwords.

The callback (redirect) URLs below use the live address `https://bi-booster.bouquet-innovation.workers.dev`. If you move to a custom domain, update `APP_BASE_URL` and every redirect URL.

## 1. Required Worker secrets

Run these from the repository folder. Each command prompts for the value.

| Secret | Value |
|---|---|
| `TOKEN_ENCRYPTION_KEY` | A random string of at least 32 characters. It encrypts every platform token in Neon, so keep it safe; changing it later means reconnecting every account. Generate one with `node -e "console.log(crypto.randomBytes(32).toString('base64'))"`. |
| `META_APP_ID`, `META_APP_SECRET` | From the Meta app (Facebook + Instagram) |
| `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` | From the TikTok developer app |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | From the Google Cloud OAuth client (YouTube) |

```sh
npx wrangler secret put TOKEN_ENCRYPTION_KEY
npx wrangler secret put META_APP_ID
npx wrangler secret put META_APP_SECRET
# …and so on for each platform you enable
```

Platforms without keys simply show "Needs the platform's developer app keys" in Settings. You can enable them one at a time.

## 2. Facebook Pages and Instagram (Meta)

1. Go to <https://developers.facebook.com/apps> and choose **Create app**, then **Other** and **Business**. Attach it to the Bouquet Innovation Business portfolio.
2. Add the **Facebook Login for Business** product. Under **Valid OAuth Redirect URIs**, enter:
   `https://bi-booster.bouquet-innovation.workers.dev/api/oauth/meta/callback`
3. Under **App settings → Basic**, set the privacy policy URL, the terms URL and the app domain `bi-booster.bouquet-innovation.workers.dev`. Then copy the **App ID** and **App secret** into the secrets above.
4. Permissions used: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `business_management`, `instagram_basic`, `instagram_content_publish`.
5. **Development mode:** only people with a role on the Meta app (admins, developers, testers) can connect their Pages. To manage client Pages owned by other people, submit the permissions above for **App Review** and complete **Business Verification**.
6. Instagram accounts must be **Business or Creator** accounts **linked to a Facebook Page**. Connect "Instagram" in BI Booster and pick that Page in the Meta dialog.
7. Instagram rules: images must be **JPEG**; carousels allow up to 10 items; Reels need an MP4 video. Media must be at a public URL Meta can download, which is why uploads go to R2 (see section 5).

## 3. TikTok

1. Go to <https://developers.tiktok.com/> and choose **Manage apps → Connect an app**. Add the **Login Kit** and **Content Posting API** products, and enable **Direct Post**.
2. Redirect URI: `https://bi-booster.bouquet-innovation.workers.dev/api/oauth/tiktok/callback`
3. Scopes: `user.info.basic`, `video.publish`, `video.upload`.
4. **Verify the media URL prefix.** TikTok pulls videos and photos from a URL you own. Under the app's URL properties, add the prefix `https://bi-booster.bouquet-innovation.workers.dev/media/`, choose **URL prefix** verification, and download the signature file. Then set two secrets so the Worker serves that file:
   ```sh
   npx wrangler secret put TIKTOK_VERIFY_FILE      # the file name, e.g. tiktokAbC123.txt
   npx wrangler secret put TIKTOK_VERIFY_CONTENT   # the file's text content
   ```
5. **Audit:** until TikTok audits the app, posts can only be published as **Only me** (`SELF_ONLY`). BI Booster shows TikTok's own error message if you choose another visibility. After the audit, Public works.

## 4. YouTube (Google)

1. In <https://console.cloud.google.com/>, create a project and enable **YouTube Data API v3**.
2. Under **OAuth consent screen**, choose External. Add the scopes `youtube.upload` and `youtube.readonly`, and add test users while the app is in Testing.
3. Under **Credentials → Create credentials → OAuth client ID**, choose **Web application**. Authorised redirect URI:
   `https://bi-booster.bouquet-innovation.workers.dev/api/oauth/google/callback`
4. Copy the client ID and secret into the secrets above.
5. **Verification:** until Google verifies the app (an API audit), uploaded videos stay **private** and the daily quota is limited (about 6 uploads per day at the default 10,000 units). Request verification and a quota extension when you go live.

## 5. Media storage (Cloudflare R2, recommended)

Instagram, TikTok and YouTube need image or video files. Without R2, the team can paste **direct public links** (for example `https://…/photo.jpg`). With R2, they upload files straight from the composer:

1. In the Cloudflare dashboard, open **R2** and enable it. The free tier needs a payment method on file.
2. `npx wrangler r2 bucket create bi-booster-media`
3. In `wrangler.jsonc`, add `"r2_buckets": [{ "binding": "MEDIA", "bucket_name": "bi-booster-media" }]` and run `npm run deploy`.

Uploaded files are served publicly at `/media/<random-id>/<file-name>` so the platforms can fetch them.

## 6. Roles and workflow

| Role | Can do |
|---|---|
| **Admin** | Everything: invite and deactivate members, change roles, assign clients, add clients, connect and disconnect social accounts, approve and publish for every client. `support@bouquet-innovation.net` is always admin. |
| **Manager** | For assigned clients: create and edit posts, approve or request changes, schedule, publish now, retry failures, delete. |
| **Editor** | For assigned clients: create drafts, attach media, propose a time, submit for approval, and edit after changes are requested. |
| **Viewer** | Read-only access to assigned clients. |

**Sign-in is invite-only.** The admin invites a `@bouquet-innovation.net` address from **Settings → Team & permissions**. The person receives a 72-hour join link, and afterwards signs in with one-time email links.

**Post lifecycle:**
`Draft → Needs approval → (Changes requested ↺) → Approved → Scheduled → Publishing → Published / Partly published / Failed`

- Editors **submit**, and managers and the admin are emailed.
- Managers **approve** (it becomes Scheduled if it has a future time) or **request changes** with a comment. The author is emailed.
- The scheduler runs every minute and only queries the database when something is due (using a KV marker), so Neon can sleep.
- Each account is published separately. Instagram and TikTok processing is polled until finished. Failures record the platform's exact error, the author and approvers are emailed, and a manager can **Retry failed accounts**.
- Every step, comment and result is kept in the post's **Activity** log.

## 7. Not included yet

Engagement inbox (comments and DMs), analytics import, LinkedIn, X and Threads publishing, and AI caption generation each need further platform permissions and are separate pieces of work.
