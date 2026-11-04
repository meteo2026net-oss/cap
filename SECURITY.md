# Security Policy

## Supported branch

Security fixes are applied to the `main` branch.

## Reporting a vulnerability

Please do not publish exploitable vulnerability details in a public issue. Use GitHub's private vulnerability reporting feature for this repository (Security → Advisories → Report a vulnerability), if enabled. Include affected commit, impact, reproduction steps, and a suggested mitigation where possible.

## Deployment requirements

- Never commit `.env`, credentials, JWT secrets, database files, or production warning data.
- Use unique random `JWT_SECRET` and a unique administrator password.
- Keep the service bound to localhost behind a maintained HTTPS reverse proxy; do not expose the application port directly.
- Restrict administrator and publisher accounts to authorized institutional personnel.
- Back up the SQLite volume securely and test restoration before upgrades.
- Keep Test/Exercise messages for non-operational validation.
- Do not use this development project as an official public-warning authority until institutional approval, CAP conformance testing, security review, monitoring, and operational procedures are complete.
