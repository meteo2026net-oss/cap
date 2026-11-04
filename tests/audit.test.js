import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { installAuditLogGuards } from "../src/audit.js";

test("audit log records cannot be updated or deleted", () => {
  const database = new Database(":memory:");
  try {
    database.exec("CREATE TABLE audit_log (id INTEGER PRIMARY KEY, action TEXT NOT NULL)");
    installAuditLogGuards(database);
    database.prepare("INSERT INTO audit_log(action) VALUES (?)").run("created");
    assert.throws(() => database.prepare("UPDATE audit_log SET action=? WHERE id=1").run("rewritten"), /append-only/);
    assert.throws(() => database.prepare("DELETE FROM audit_log WHERE id=1").run(), /append-only/);
    assert.equal(database.prepare("SELECT action FROM audit_log WHERE id=1").get().action, "created");
  } finally {
    database.close();
  }
});
