import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

test("production SQLite connection waits for a concurrent writer within its configured busy timeout", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cap-sqlite-contention-"));
  const databasePath = path.join(root, "contention.sqlite");
  const previousDbPath = process.env.DB_PATH;
  process.env.DB_PATH = databasePath;
  let database;

  try {
    ({ db: database } = await import("../src/db.js"));
    assert.equal(database.pragma("busy_timeout", { simple: true }), 5000);
    database.exec("CREATE TABLE contention_probe (id INTEGER PRIMARY KEY, writer TEXT NOT NULL)");

    const workerSource = `
      import { parentPort, workerData } from "node:worker_threads";
      import Database from "better-sqlite3";
      const db = new Database(workerData.databasePath);
      db.exec("BEGIN IMMEDIATE");
      parentPort.postMessage("lock-acquired");
      setTimeout(() => {
        try {
          db.exec("COMMIT");
          parentPort.postMessage("lock-released");
        } finally {
          db.close();
        }
      }, 350);
    `;
    const worker = new Worker(workerSource, {
      eval: true,
      workerData: { databasePath }
    });

    await new Promise((resolve, reject) => {
      worker.once("message", message => message === "lock-acquired" ? resolve() : reject(new Error("Unexpected worker message")));
      worker.once("error", reject);
      worker.once("exit", code => { if (code !== 0) reject(new Error(`Lock worker exited with code ${code}`)); });
    });

    const started = performance.now();
    database.prepare("INSERT INTO contention_probe(writer) VALUES (?)").run("api");
    const waitedMs = performance.now() - started;

    assert.ok(waitedMs >= 200, `writer should wait for the competing transaction; waited ${waitedMs.toFixed(1)}ms`);
    assert.equal(database.prepare("SELECT writer FROM contention_probe").get().writer, "api");
    await worker.terminate();
  } finally {
    database?.close();
    if (previousDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = previousDbPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
