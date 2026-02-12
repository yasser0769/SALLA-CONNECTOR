# salla-connector

Static frontend (`index.html`) + Vercel serverless functions under `/api` for Salla OAuth + Merchant API.

## File structure

```
index.html                  — UI (Connect / Test Token / Fetch Products / CSV Match / XLSX Export)
vercel.json                 — Vercel function config (maxDuration, headers)
api/
  salla.js                  — Main router: ping + paginated products proxy
  _lib/salla.js             — Shared OAuth, session/cookie, helpers
  oauth/
    start.js                — Initiates OAuth redirect to Salla
    callback.js             — Handles OAuth callback, exchanges code for tokens
  salla/
    test-token.js           — Verifies token against Merchant API
    products.js             — (Legacy) single-page products fetch
    logout.js               — Clears session cookies
```

## Required Environment Variables

Set these in **Vercel Project Settings > Environment Variables**:

| Variable | Required | Default | Description |
|---|---|---|---|
| `SALLA_CLIENT_ID` | Yes | — | OAuth client ID from Salla Partner Portal |
| `SALLA_CLIENT_SECRET` | Yes | — | OAuth client secret (server-side only, never exposed to browser) |
| `SALLA_REDIRECT_URI` | Yes | — | Must **exactly** match the Callback URL in Salla Partner Portal |
| `APP_SESSION_SECRET` | Yes | — | Long random string used to HMAC-sign session cookies |
| `SALLA_API_BASE` | No | `https://api.salla.dev` | Salla Merchant API base URL |
| `SALLA_ACCOUNTS_BASE` | No | `https://accounts.salla.sa` | Salla OAuth/Accounts base URL |

## Callback and Webhook URLs

### OAuth Callback URL (required)

Set in **Salla Partner Portal > App Settings > Callback URL**:

```
https://YOUR_DOMAIN/api/oauth/callback
```

This must match `SALLA_REDIRECT_URI` exactly (including protocol and path).

### Webhook URL (optional)

Not currently used. If you add webhook handling later, configure it as:

```
https://YOUR_DOMAIN/api/webhooks/salla
```

## How OAuth Works

1. User clicks **Connect with Salla**.
2. Browser redirects to `/api/oauth/start`, which generates CSRF state and redirects to Salla's OAuth page.
3. User authorizes on Salla.
4. Salla redirects to `/api/oauth/callback?code=...&state=...`.
5. Backend validates CSRF state, exchanges code for tokens via `x-www-form-urlencoded` POST.
6. Backend stores `access_token` + `refresh_token` in signed **HttpOnly** cookie (30-day expiry).
7. Browser redirects to `/?oauth=success`.

No `client_secret` is ever exposed to frontend JS.

## Token Refresh

When Merchant API returns 401/403, backend automatically:
1. Exchanges `refresh_token` for new tokens
2. Updates session cookie
3. Retries the original request once

## Product Pagination

- Frontend drives pagination: calls `GET /api/salla?action=products_page&page=N&per_page=100` per page.
- Loops until `total_pages` is reached, or items returned < per_page (no metadata fallback).
- 200ms delay between page requests to respect rate limits.
- Retry on 429/5xx: up to 2 retries with 300ms * attempt backoff.
- Optional UI limits: `maxPages` and `maxItems` inputs.
- Progress bar and per-page log shown during fetch.

Response shape from `/api/salla?action=products_page`:
```json
{
  "items": [],
  "page": 1,
  "per_page": 100,
  "next_page": 2,
  "total_pages": 9,
  "pagination": {},
  "upstream_status": 200,
  "body": {},
  "debug_id": "a1b2c3d4"
}
```

## Supplier CSV Upload and SKU Matching

1. Upload supplier CSV (browser-only, file never sent to backend).
2. Select encoding (UTF-8 or Windows-1256 for Arabic Excel files).
3. Choose which column represents SKU (e.g., "Item#").
4. Optionally select Price and Quantity columns for export.
5. Click **Match** to see grouped preview:
   - Product header row (name, ID)
   - Variant rows below with SKU match status
6. Click **Export XLSX** to download grouped results.

### XLSX Export Format

| Row Type | Product ID | Product Name | Variant ID | Variant Name | SKU | Matched | Supplier Price | Supplier Qty |
|---|---|---|---|---|---|---|---|---|
| PRODUCT | 123 | Widget | | | | | | |
| VARIANT | 123 | Widget | 456 | Red/Large | W-R-L | YES | 15.99 | 50 |
| VARIANT | 123 | Widget | 457 | Blue/Small | W-B-S | NO | | |
| PRODUCT | 124 | Gadget | | | G-1 | YES | 25.00 | 100 |

- **Variable products**: PRODUCT row is a group header (no SKU), VARIANT rows have SKU + match data.
- **Simple products**: PRODUCT row has its own SKU + match data directly.

### SKU Normalization

Keys are normalized before matching: `trim → UPPERCASE → remove spaces and dashes`.

Example: `"sku-123 456"` → `"SKU123456"`

## API Endpoints

| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/api/salla?action=ping` | GET | No | Health check |
| `/api/salla?action=products_page&page=N&per_page=100` | GET | Cookie | Paginated products proxy |
| `/api/salla/test-token` | GET | Cookie | Verify token against Merchant API |
| `/api/oauth/start` | GET | No | Start OAuth redirect |
| `/api/oauth/callback` | GET | No | OAuth callback handler |
| `/api/salla/logout` | GET | Cookie | Clear session |

All error responses include `debug_id` for cross-referencing with Vercel Runtime Logs.

## UI Diagnostics

- Header badge shows **App loaded** after JS boot completes.
- Runtime errors captured via `window.onerror` and `unhandledrejection`, displayed in-page.

## Security Notes

- `APP_SESSION_SECRET` must be long (32+ chars) and kept private.
- Rotate Salla secrets immediately if they were ever exposed.
- Cookies are `HttpOnly`, `SameSite=Lax`, `Secure` in production.
