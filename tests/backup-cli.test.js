import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;

function runCli(script, args, cwd) {
  return spawnSync(node, [path.join(projectRoot, script), ...args], {
    cwd,
    encoding: "utf8",
    timeout: 30000,
    env: { ...process.env }
  });
}

test("backup and restore CLIs load DB_PATH and BACKUP_DIR from the local .env file", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cap-backup-cli-env-"));
  const database = path.join(directory, "custom-data", "configured.sqlite");
  const backupDirectory = path.join(directory, "custom-backups");
  const restoredDatabase = path.join(directory, "restored-data", "restored.sqlite");
  try {
    await fs.writeFile(path.join(directory, ".env"), [
      "DB_PATH=" + database,
      "BACKUP_DIR=" + backupDirectory,
      "BACKUP_RETENTION_DAYS=30",
      ""
    ].join("\n"));

    const backupRun = runCli("src/backup.js", [], directory);
    assert.equal(backupRun.status, 0, "backup CLI should succeed: " + backupRun.stderr);
    assert.ok((await fs.stat(database)).isFile(), "backup CLI should initialize the configured database");
    const backups = (await fs.readdir(backupDirectory)).filter(name => name.endsWith(".sqlite"));
    assert.equal(backups.length, 1, "backup CLI should write to BACKUP_DIR from .env");
    const backupPath = path.join(backupDirectory, backups[0]);
    assert.ok((await fs.stat(backupPath + ".sha256")).isFile(), "backup should include its checksum manifest");

    await fs.writeFile(path.join(directory, ".env"), [
      "DB_PATH=" + restoredDatabase,
      "BACKUP_DIR=" + backupDirectory,
      ""
    ].join("\n"));
    const restoreRun = runCli("src/restore.js", [backupPath], directory);
    assert.equal(restoreRun.status, 0, "restore CLI should use DB_PATH from .env: " + restoreRun.stderr);
    assert.ok((await fs.stat(restoredDatabase)).isFile(), "restore CLI should create the configured target database");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
