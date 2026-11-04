# Installation and operating modes

This repository supports two equivalent operating modes. Both use the same application code, SQLite schema, API, dashboard and security checks. Choose either mode; Docker is optional.

## Mode A — Run directly (no Docker)

### Requirements
- Node.js 20 or newer (Node.js 24 is used in CI)
- npm (included with Node.js)
- Windows 10/11, Linux, or macOS

### Windows PowerShell

From the repository folder:

```powershell
node --version
npm --version
npm run setup:local
npm install
npm test
npm start
```

The setup command creates a local `.env` file only if one does not already exist, generates a strong JWT secret and initial administrator password, and creates the `storage` and `backups` folders. Save the generated administrator password when it is displayed. The setup command never overwrites an existing `.env`.

Open http://localhost:8095. Stop the server with Ctrl+C.

### Linux / macOS

Run the same commands from the repository root:

```bash
node --version
npm --version
npm run setup:local
npm install
npm test
npm start
```

### Normal subsequent starts

After the first setup and dependency installation, use:

```bash
npm start
```

For development with automatic Node.js restart:

```bash
npm run dev
```

### Local data and backups
- SQLite database: `storage/cap.sqlite`
- Backups: `backups/`
- Create a verified backup: `npm run backup`
- Restore while the server is stopped: `npm run restore -- backups/<backup-file>.sqlite`

Keep a separate copy of backups on another device. Do not commit `.env`, database files, or backups to Git.

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

To restore a backup, stop the app container first:

```bash
docker compose stop cap
docker compose run --rm --no-deps cap node src/restore.js /app/backups/<backup-file>.sqlite --force
docker compose up -d
```

## Important differences

| Item | Direct / no Docker | Docker Compose |
|---|---|---|
| Runtime | Node.js installed on host | Node.js inside image |
| Start | `npm start` | `docker compose up -d` |
| Database | `storage/cap.sqlite` | Named volume `cap-data` |
| Backups | Local `backups/` folder | Named volume `cap-backups` |
| Health check | `GET /api/health` | Docker healthcheck + same endpoint |
| Docker required | No | Yes |

Both modes currently use the same application and database format. Do not run both modes against the same SQLite file at the same time. Keep the two data stores separate unless you deliberately perform a verified backup/restore migration.

## Troubleshooting

- **Server refuses to start:** verify that `.env` exists and that `JWT_SECRET` is at least 32 characters and `ADMIN_PASSWORD` is at least 14 characters; neither may be a placeholder.
- **Port 8095 is busy:** change `PORT` in `.env` for direct mode. For Docker mode change `CAP_PORT` (the internal container port remains 8095).
- **better-sqlite3 installation fails:** use a supported Node.js LTS release (Node 20+) and install the platform's native build tools if npm requests them.
- **Map tiles do not load:** the dashboard map requires internet access to the OpenStreetMap tile service.
- **Forgot the generated initial password:** if no users/data have been created yet, stop the service, back up the database, and follow a reviewed administrator recovery procedure; do not delete the database as a routine password reset.

## Operational warning

This is a development foundation, not a certified operational public-warning service. No external CAP, email, SMS, push, or government gateway transport is implemented. Keep it private until institutional security, CAP interoperability, HTTPS, monitoring, backup recovery, and approval procedures have been independently reviewed.
