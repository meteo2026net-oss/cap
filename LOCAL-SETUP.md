# Local installation

The application runs directly on Windows, Linux, or macOS with Node.js and embedded SQLite. The application and its optional maintenance worker run as ordinary Node.js processes.

## Requirements

- Node.js 22 or newer.
- npm (included with Node.js).
- Internet access for the first dependency installation and OpenStreetMap map tiles.

SQLite is embedded through `better-sqlite3`; there is no separate database server to install. The application creates `storage/cap.sqlite` automatically.

## Windows quick start

1. Install Node.js 22+ (preferably Node.js 22 LTS).
2. Extract or clone this repository.
3. Open PowerShell in the project folder.
4. Run:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-local.ps1
   npm start
   ```

   Alternatively, double-click `start-local.bat`. It creates `.env` on first run and runs `npm ci` on every launch to verify and install the exact locked dependencies.

5. Save the generated administrator password printed by the setup script.
6. Open http://127.0.0.1:8095.

The setup script never overwrites an existing `.env`. It requires Node.js 22+, generates the JWT, administrator, and MFA encryption secrets, and installs the lockfile-pinned dependencies with `npm ci` every time it runs. If native dependency installation fails on Windows, install Microsoft C++ Build Tools (Desktop development with C++) and retry `npm ci`.

## Linux / macOS

From the repository root:

```bash
cp .env.example .env
```

Edit `.env` and replace both placeholder secrets with unique random values. Generate values with:

```bash
openssl rand -hex 48
openssl rand -base64 24
```

Use the first value for `JWT_SECRET` and the second for `ADMIN_PASSWORD`. Then run:

```bash
npm ci
npm test
npm start
```

Open http://127.0.0.1:8095.

## Local data and maintenance

- SQLite database: `storage/cap.sqlite`
- Backups: `backups/` by default
- Create a backup: `npm run backup`
- Restore (stop the server first): `npm run restore -- backups/<backup-file>.sqlite`
- Run automated tests: `npm test`

Keep `.env`, `storage/`, and `backups/` private. Do not commit credentials or live warning data.

Run only one application and worker process against a given SQLite database file at a time.
