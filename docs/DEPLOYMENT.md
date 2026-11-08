# Deployment (test environments)

**Intended deployment scope:** local operations in the **Syrian Arab Republic only** — a local programme for an operations centre / institutional host inside Syria. This is **not** a global warning distribution service. CAP 1.2 is used as the message format; geographic and operational scope remain national/local.

**نطاق التشغيل المقصود:** تشغيل محلي داخل **الجمهورية العربية السورية فقط** — برنامج محلي لمركز عمليات / جهة مستضيفة داخل سوريا. **ليس** خدمة نشر تحذيرات عالمية. يُستخدم CAP 1.2 كصيغة رسالة؛ والنطاق الجغرافي والتشغيلي يبقى وطنياً/محلياً.

1. Install Node.js LTS matching CI.
2. `npm run setup:local` then `npm ci`.
3. Configure secrets in `.env` (never commit): `JWT_SECRET`, `ADMIN_PASSWORD`, `MFA_ENCRYPTION_KEY`.
4. `npm test` and `npm run test:cap-schema` when schema tooling is available.
5. `npm start` and verify `/api/health` shows `external_adapters_enabled: false`.
6. Optional: `npm run worker` for internal queue maintenance only.

Do not enable webhooks or external adapters without institutional approval and a separate change control process.
