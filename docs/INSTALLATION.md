# Installation and operating guide

This project runs directly on the host with Node.js and an embedded SQLite database.

## Dependency installation and updates

`package-lock.json` is committed and is the source of truth for the exact dependency tree. Use `npm ci` for clean, repeatable installs; it removes an existing `node_modules` directory and installs only the versions recorded in the lockfile. It also fails if `package.json` and the lockfile are out of sync.

When deliberately changing dependencies, run `npm install <package>@<version>` (or `npm uninstall <package>`) to update both manifest and lockfile, review the diff, then verify with `npm ci`, `npm test`, and `npm audit` before committing both files. Do not hand-edit the lockfile.

## Requirements

- Node.js 22 or newer.
- npm (included with Node.js).
- Windows 10/11, Linux, or macOS.
- Internet access for the first dependency installation and OpenStreetMap map tiles.

SQLite is embedded through `better-sqlite3`; no separate database server is required.

## Windows PowerShell

From the repository folder:

```powershell
node --version
npm --version
npm run setup:local
npm ci
npm test
npm start
```

The setup command creates a local `.env` file only if one does not already exist, generates a strong JWT secret, initial administrator password, and persistent 32-byte MFA encryption key, and creates the `storage` and `backups` folders. Keep the MFA key backed up separately and do not rotate it while accounts have enrolled MFA secrets. Save the generated administrator password when it is displayed. The setup command never overwrites an existing `.env`.

Alternatively, run `powershell -NoProfile -ExecutionPolicy Bypass -File .\\scripts\\setup-local.ps1` and then `npm start`, or double-click `start-local.bat`. Both Windows startup paths run `npm ci` so an incomplete or stale `node_modules` directory cannot silently bypass the lockfile.

When using `start-local.bat`, the dashboard opens automatically after the health endpoint responds. The server remains in its own console window; stop it with Ctrl+C in that window. For manual startup, open http://localhost:8095 after `npm start`.

## Linux / macOS

From the repository root:

```bash
npm run setup:local
npm ci
npm test
npm start
```

The setup command generates local secrets and creates the data folders. Open http://localhost:8095.

## Normal subsequent starts

After the first setup, use `npm start` for a fast start that does not reinstall dependencies. The Windows `start-local.bat` convenience launcher intentionally runs `npm ci` on each launch to verify and repair the exact locked dependency tree.

```bash
npm start
```

For development with automatic Node.js restart:

```bash
npm run dev
```

## Optional internal delivery queue worker

The worker performs queue maintenance only; it does not send CAP messages to external systems. Run it in a second terminal:

```bash
npm run worker
```

The polling interval defaults to 30 seconds and can be adjusted with `CAP_DELIVERY_WORKER_INTERVAL_MS` (5,000–300,000 milliseconds).

## Local data and backups

- SQLite database by default: `storage/cap.sqlite`
- Optional database override: set `DB_PATH` to an absolute path or a path relative to the process working directory. The application, backup helper, and restore helper use the same setting.
- Backups: `backups/`
- Create a verified backup: `npm run backup`
- Restore while every application process is stopped: `npm run restore -- backups/<backup-file>.sqlite`

Each new backup includes a private `.sha256` sidecar manifest. Restore verifies the manifest before validating or replacing the target database; missing or mismatched manifests block restoration. Older timestamp-only backups remain supported for backward compatibility. Pruning an expired backup also removes its matching manifest. The restore command refuses to overwrite an existing database unless `--force` is supplied. With `--force`, the previous database is retained beside the restored file as a pre-restore copy. Confirm the restored service and its data before removing that copy. Restore refuses to proceed while SQLite WAL/SHM sidecars exist; stop all application and worker processes and follow the troubleshooting guidance before retrying.

The backup and restore command-line tools load `.env` before opening the database, so a custom `DB_PATH` is respected consistently. On Windows, use `run-backup-now.bat` for a one-time backup, `install-daily-backup.bat` to register a per-user Task Scheduler job at 02:00, and `remove-daily-backup.bat` to remove that job. The scheduled job runs when the configured Windows user is signed in, catches up after the computer was unavailable, and writes logs to `logs/`. It stores backups locally only; copy verified backups to encrypted off-device storage separately. `restore-backup.bat <backup-file> [--force]` is a wrapper for the restore command; stop the server and delivery worker before using it.

Keep a separate encrypted copy of backups on another device or off-host storage. Keep `.env`, `storage/`, and `backups/` private. Do not commit credentials, database files, or live warning data to Git.

## Troubleshooting

- **Server refuses to start:** verify that `.env` exists and that `JWT_SECRET` is at least 32 characters and `ADMIN_PASSWORD` is at least 14 characters; neither may be a placeholder.
- **Port 8095 is busy:** change `PORT` in `.env` and open the matching localhost URL.
- **better-sqlite3 installation fails:** use a supported Node.js LTS release (Node 22+) and install the platform's native build tools if npm requests them.
- **Map tiles do not load:** the dashboard map requires internet access to the OpenStreetMap tile service.
- **A newly created account cannot access the dashboard after login:** this is intentional. Newly provisioned users must replace the initial temporary password before the application unlocks; the password-change and account-security panels remain available during this step.
- **An account needs a password reset:** another administrator can use the account-management panel's password-reset action. The temporary password is shown once, invalidates the account's existing sessions, and requires the user to set a new password before accessing application data. Transfer it only through a separate, institution-approved secure channel. Administrators cannot reset their own password through this action; self-service email recovery is not configured.
- **A privileged operation returns `403` with `MFA_REQUIRED`:** the account's role is listed in `MFA_REQUIRED_ROLES`; sign in, open the account-security/MFA panel, complete enrollment, and save the one-time recovery codes. Do not remove the role from the policy just to bypass enrollment.
- **MFA enrollment reports encryption is not configured:** set a unique 32-byte `MFA_ENCRYPTION_KEY` in `.env`, restart the server, and retain a secure backup of the key. Do not replace an existing key if users have already enrolled.
- **Forgot the generated initial password:** if no users/data have been created yet, stop the service, back up the database, and follow a reviewed administrator recovery procedure; do not delete the database as a routine password reset.

## Operational warning

This is a development foundation, not a certified operational public-warning service. No external CAP, email, SMS, push, or government gateway transport is implemented. Keep it private until institutional security, CAP interoperability, HTTPS, monitoring, backup recovery, and approval procedures have been independently reviewed.
