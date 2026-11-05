import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

test("database module opens the configured DB_PATH", { timeout: 10000 }, async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "cap-db-path-test-"));
  const databasePath = path.join(cwd, "custom-storage", "configured.sqlite");
  const moduleUrl = pathToFileURL(path.resolve("src/db.js")).href;
  const script = `const { db } = await import(${JSON.stringify(moduleUrl)}); db.close();`;
  try {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      cwd,
      env: { ...process.env, DB_PATH: databasePath },
      stdio: "pipe"
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { stderr += chunk; });
    const exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    assert.equal(exitCode, 0, "database module should start with DB_PATH: " + stderr);
    await access(databasePath);
    await assert.rejects(access(path.join(cwd, "storage", "cap.sqlite")));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});


test("database module resolves a relative DB_PATH from the process working directory", { timeout: 10000 }, async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "cap-db-relative-path-test-"));
  const relativePath = path.join("custom-storage", "relative.sqlite");
  const expectedPath = path.join(cwd, relativePath);
  const moduleUrl = pathToFileURL(path.resolve("src/db.js")).href;
  const script = `const { db } = await import(${JSON.stringify(moduleUrl)}); db.close();`;
  try {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      cwd,
      env: { ...process.env, DB_PATH: relativePath },
      stdio: "pipe"
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { stderr += chunk; });
    const exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    assert.equal(exitCode, 0, "database module should start with relative DB_PATH: " + stderr);
    await access(expectedPath);
    await assert.rejects(access(path.join(cwd, "storage", "cap.sqlite")));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
