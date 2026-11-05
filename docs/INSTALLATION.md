# Installation and operating modes

This repository supports two equivalent operating modes. Both use the same application code, SQLite schema, API, dashboard and security checks. Choose either mode; Docker is optional.

## Dependency installation and updates

`package-lock.json` is committed and is the source of truth for the exact dependency tree. Use `npm ci` for clean, repeatable installs; it removes an existing `node_modules` directory and installs only the versions recorded in the lockfile. It also fails if `package.json` and the lockfile are out of sync.

When deliberately changing dependencies, run `npm install <package>@<version>` (or `npm uninstall <package>`) to update both manifest and lockfile, review the diff, then verify with `npm ci`, `npm test`, and `npm audit` before committing both files. Do not hand-edit the lockfile.

## Mode A — Run directly (no Docker)

### Requirements
- Node.js 22 or newer (the CI and Docker image use Node.js 22)
- npm (included with Node.js)
- Windows 10/11, Linux, or macOS

### Windows PowerShell

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

Open http://localhost:8095. Stop the server with Ctrl+C.

### Linux / macOS

Run the same commands from the repository root:

```bash
node --version
npm --version
npm run setup:local
npm ci
npm test
npm start
```

### Normal subsequent starts

After the first setup and dependency installation, use:

```bash
npm start
```

### Optional internal delivery queue worker

The worker performs queue maintenance only; it does not send CAP messages to external systems.

Direct mode (in a second terminal):

```bash
npm run worker
```

Docker Compose (enable the optional profile):

```bash
docker compose --profile worker up -d --build
docker compose logs -f delivery-worker
```

Stop only the worker with `docker compose stop delivery-worker`. The worker shares the same persistent SQLite and backup volumes as the API service. The polling interval defaults to 30 seconds and can be adjusted with `CAP_DELIVERY_WORKER_INTERVAL_MS` (5,000–300,000 milliseconds).

For development with automatic Node.js restart:

```bash
npm run dev
```

### Local data and backups
- SQLite database by default: `storage/cap.sqlite`
- Optional database override: set `DB_PATH` to an absolute path or a path relative to the process working directory. The application, backup helper, and restore helper use the same setting.
- Backups: `backups/`
- Create a verified backup: `npm run backup`
- Restore while the server is stopped: `npm run restore -- backups/<backup-file>.sqlite`

For Docker, keep any custom `DB_PATH` inside the persistent `/app/storage` volume; do not point it at the container's ephemeral filesystem. Keep a separate copy of backups on another device. Do not commit `.env`, database files, or backups to Git.

## Mode B — Run with Docker Compose

### Requirements
- Docker Engine / Docker Desktop
- Docker Compose plugin (`docker compose`)

### First start

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Edit `.env` and replace:
- `JWT_SECRET` with a unique random secret of at least 32 characters.
- `ADMIN_PASSWORD` with a unique password of at least 14 characters.
- `MFA_ENCRYPTION_KEY` with 32 random bytes encoded as 64 hexadecimal characters if you intend to enable MFA. Generate it with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. Keep it stable and protected separately from the database.
- `MFA_REQUIRED_ROLES` with a comma-separated list of roles that must complete MFA before using role-protected operations, for example `admin,approver,publisher`. Leave it empty to keep MFA optional for all roles. Required-role accounts can still sign in and open MFA setup, but their protected operations remain blocked until enrollment is confirmed.

Then run:

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f cap
```

Open http://localhost:8095. The default port binding is loopback-only (127.0.0.1). Do not expose the service directly to the public internet; use HTTPS and a reviewed reverse-proxy configuration for remote access.

### Docker operations

```bash
docker compose stop                 # stop without removing containers
docker compose start                # start again
docker compose down                 # remove container/network; named data volumes remain
docker compose logs -f cap          # follow logs
docker compose exec cap node src/backup.js
```

The named volumes `cap-data` and `cap-backups` persist database and backup data across container recreation. Do not use `docker compose down -v` unless you intentionally want to delete those volumes.

To restore a backup, stop the app container first. SQLite may leave WAL/SHM sidecar files in the persistent volume after shutdown; the restore helper deliberately refuses to proceed while those files exist. Checkpoint the stopped database, close SQLite, and only then remove the sidecars before restoring:

```bash
docker compose stop cap
docker compose run --rm --no-deps cap sh -ec 'node --input-type=module -e "import Database from \"better-sqlite3\"; const db = new Database(\"/app/storage/cap.sqlite\"); try { const checkpoint = db.pragma(\"wal_checkpoint(TRUNCATE)\")[0]; if (checkpoint.busy !== 0) throw new Error(\"SQLite WAL checkpoint remained busy\"); } finally { db.close(); }" && rm -f /app/storage/cap.sqlite-wal /app/storage/cap.sqlite-shm'
docker compose run --rm --no-deps cap node src/restore.js /app/backups/<backup-file>.sqlite --force
docker compose up -d
```

Do not remove SQLite sidecars while the application or another database process is running. If the checkpoint command fails or reports a busy database, do not continue with the restore; investigate the active process first. The restore utility independently validates SQLite integrity, foreign keys, and the audit hash chain before replacing the database.

## Important differences

| Item | Direct / no Docker | Docker Compose |
|---|---|---|
| Runtime | Node.js installed on host | Node.js inside image |
| Start | `npm start` | `docker compose up -d` |
| Database | `storage/cap.sqlite` | Named volume `cap-data` |
| Backups | Local `backups/` folder | Named volume `cap-backups` |
| Health check | `GET /api/health` | Docker healthcheck + same endpoint |
| Docker required | No | Yes |

Both modes currently use the same application and database format. The delivery worker is optional in both modes and is not needed for ordinary dashboard/API use. Do not run both modes against the same SQLite file at the same time. Keep the two data stores separate unless you deliberately perform a verified backup/restore migration.

## Troubleshooting

- **Server refuses to start:** verify that `.env` exists and that `JWT_SECRET` is at least 32 characters and `ADMIN_PASSWORD` is at least 14 characters; neither may be a placeholder.
- **Port 8095 is busy:** change `PORT` in `.env` for direct mode. For Docker mode change `CAP_PORT` (the internal container port remains 8095).
- **better-sqlite3 installation fails:** use a supported Node.js LTS release (Node 22+) and install the platform's native build tools if npm requests them.
- **Map tiles do not load:** the dashboard map requires internet access to the OpenStreetMap tile service.
- **A privileged operation returns `403` with `MFA_REQUIRED`:** the account's role is listed in `MFA_REQUIRED_ROLES`; sign in, open the account-security/MFA panel, complete enrollment, and save the one-time recovery codes. Do not remove the role from the policy just to bypass enrollment.
- **MFA enrollment reports encryption is not configured:** set a unique 32-byte `MFA_ENCRYPTION_KEY` in `.env`, restart the server, and retain a secure backup of the key. Do not replace an existing key if users have already enrolled.
- **Forgot the generated initial password:** if no users/data have been created yet, stop the service, back up the database, and follow a reviewed administrator recovery procedure; do not delete the database as a routine password reset.

## Operational warning

This is a development foundation, not a certified operational public-warning service. No external CAP, email, SMS, push, or government gateway transport is implemented. Keep it private until institutional security, CAP interoperability, HTTPS, monitoring, backup recovery, and approval procedures have been independently reviewed.
