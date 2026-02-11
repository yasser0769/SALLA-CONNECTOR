# SALLA-CONNECTOR

Static `index.html` + Vercel Function `api/salla.js` for Salla OAuth and product fetching.

## 1) Vercel Environment Variables
Set these in **Vercel → Project Settings → Environment Variables**:
- `SALLA_CLIENT_ID`
- `SALLA_CLIENT_SECRET`
- `SALLA_REDIRECT_URI`

> Important: Configure the callback URL in Salla Partner Portal to match `SALLA_REDIRECT_URI` **exactly**.

## 2) Quick health test
After deploy, open:
- `/api/salla?action=ping`

Expected response (JSON):
```json
{ "ok": true, "time": "..." }
```

## 3) OAuth + Fetch flow
1. Open the app and click **Connect with Salla**.
2. Salla redirects back with `?code=...`.
3. Frontend calls `POST /api/salla?action=token` with `{ code }`.
4. Backend exchanges code using server-side env vars and stores `access_token` + `refresh_token` in browser localStorage.
5. Click **Fetch Products** to load products from `https://api.salla.dev/admin/v2/products?page=1`.
6. If access token expires, refresh is triggered automatically using `refresh_token`.

## Security note
- Do **not** put Client Secret in frontend code.
- If secrets were exposed previously, rotate them immediately and update Vercel env vars.
