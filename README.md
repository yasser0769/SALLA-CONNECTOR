# salla-connector

Static frontend (`index.html`) + Vercel serverless functions under `/api` for Salla OAuth + Merchant API.

## File structure
- `index.html` — UI (Connect / Test Token / Fetch Products).
- `api/oauth/start.js` — starts OAuth redirect.
- `api/oauth/callback.js` — handles callback and stores session cookie.
- `api/salla/test-token.js` — verifies token against Merchant API store endpoint.
- `api/salla/products.js` — fetches paginated products (max 5 pages).
- `api/salla/logout.js` — clears session cookies.
- `api/_lib/salla.js` — shared auth/cookie/helpers.

## 1) Configure Salla Partner Portal
Set Callback URL to **exactly**:

`https://YOUR_DOMAIN/api/oauth/callback`

It must match `SALLA_REDIRECT_URI` exactly.

## 2) Configure Vercel Environment Variables
Set these values in Vercel Project Settings:
- `SALLA_CLIENT_ID`
- `SALLA_CLIENT_SECRET`
- `SALLA_REDIRECT_URI`
- `APP_SESSION_SECRET` (long random value)

Optional:
- `SALLA_API_BASE` (default `https://api.salla.dev`)
- `SALLA_ACCOUNTS_BASE` (default `https://accounts.salla.sa`)

## 3) How OAuth works now
1. Click **Connect with Salla**.
2. Browser goes to `/api/oauth/start`.
3. User authorizes on Salla.
4. Salla redirects to `/api/oauth/callback?code=...&state=...`.
5. Backend exchanges code using `x-www-form-urlencoded`.
6. Backend stores `access_token` + `refresh_token` in signed **HttpOnly** cookie.

No `client_secret` is ever exposed to frontend JS.

## 4) Diagnostics and testing
- Ping: `/api/salla?action=ping`
- Token validity: click **Test Token** (calls `/api/salla/test-token`).
- Products: click **Fetch Products** (calls `/api/salla/products`).

If Merchant API fails, UI displays upstream status + `debug_id` so you can inspect Vercel Runtime Logs.

## 5) Refresh behavior
When Merchant API returns 401/403, backend tries refresh token once, updates session cookie, and retries the request once.

## Security notes
- Keep `APP_SESSION_SECRET` long and private.
- Rotate Salla secrets if they were ever exposed.
