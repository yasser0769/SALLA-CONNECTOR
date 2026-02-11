# SALLA-CONNECTOR

واجهة HTML ثابتة + Vercel Serverless API endpoint على `/api/salla` للتكامل مع OAuth وSalla API.

## Quick test
1. بعد النشر، افتح:
   - `/api/salla?action=ping`
2. يجب أن تحصل على JSON مثل:
   - `{ "ok": true, "time": "..." }`

## Vercel deploy
1. ارفع المشروع إلى GitHub.
2. اربط المستودع مع Vercel (Framework Preset: **Other**).
3. أضف Environment Variables (مفضّل للأمان):
   - `SALLA_CLIENT_ID`
   - `SALLA_CLIENT_SECRET`
   - `SALLA_REDIRECT_URI`
4. نفّذ Deploy.

## ملاحظة أمنية
إذا سبق وتم نشر أي Client Secret أو Webhook Secret علناً، قم بعمل **Rotate** لها فوراً من لوحة سلة/مزود الخدمة ثم حدّث القيم في Vercel Environment Variables.
