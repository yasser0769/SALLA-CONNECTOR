# Salla Stock & Price Sync (API)

## Run

```bash
cd /Users/yasseralshihri/Desktop/codex
node server.mjs
```

Open:

- `http://localhost:3000/index.html`

## Setup

Credentials are read from `.env`:

- `SALLA_CLIENT_ID`
- `SALLA_CLIENT_SECRET`
- `SALLA_REDIRECT_URI`

## Flow

1. Click `ربط سلة`.
2. Authorize the app in Salla.
3. Upload supplier file (`items/SKU + stock + price`).
4. Run `معاينة التحديث (Dry Run)`.
5. Run `تنفيذ التحديث الآن`.

## Live progress

- During real update, the UI now shows live progress:
- `تم التنفيذ` (processed count)
- `المتبقي` (remaining count)
- Progress bar + percent until completion

## Sync rules

- Match supplier `items` with Salla `SKU`.
- Update `price` and `stock` for matched SKUs.
- If SKU exists in Salla and is missing from supplier file, stock is set to `0` (when enabled).
