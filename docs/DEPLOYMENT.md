# Deployment (test environments)

1. Install Node.js LTS matching CI.
2. `npm run setup:local` then `npm ci`.
3. Configure secrets in `.env` (never commit): `JWT_SECRET`, `ADMIN_PASSWORD`, `MFA_ENCRYPTION_KEY`.
4. `npm test` and `npm run test:cap-schema` when schema tooling is available.
5. `npm start` and verify `/api/health` shows `external_adapters_enabled: false`.
6. Optional: `npm run worker` for internal queue maintenance only.

Do not enable webhooks or external adapters without institutional approval and a separate change control process.
