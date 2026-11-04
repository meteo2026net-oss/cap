import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { enqueueDelivery, claimDelivery, recordDeliveryReceipt, retryDelivery } from "../src/delivery.js";

function fixture() {
 const database=new Database(":memory:");
 database.exec(`
  CREATE TABLE alerts(id INTEGER PRIMARY KEY, identifier TEXT NOT NULL);
  INSERT INTO alerts(id,identifier) VALUES(1,'test-alert-1');
  CREATE TABLE delivery_outbox(
   id INTEGER PRIMARY KEY AUTOINCREMENT,
   alert_id INTEGER NOT NULL REFERENCES alerts(id),
   channel TEXT NOT NULL CHECK(channel IN ('cap_feed','webhook','email','sms','push')),
   payload TEXT NOT NULL,
   status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sending','delivered','failed')),
   attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
   external_id TEXT NOT NULL DEFAULT '',last_error TEXT NOT NULL DEFAULT '',
   created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
   last_attempt_at TEXT,delivered_at TEXT,UNIQUE(alert_id,channel)
  );
 `);
 return database;
}

test("outbox enqueue is idempotent for an alert and channel",()=>{
 const db=fixture();
 try {
  const first=enqueueDelivery(db,{alertId:1,channel:"cap_feed",payload:"<alert/>"});
  const second=enqueueDelivery(db,{alertId:1,channel:"cap_feed",payload:"<alert/>"});
  assert.equal(first.id,second.id);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM delivery_outbox").get().count,1);
  assert.equal(first.status,"queued");
 } finally { db.close(); }
});

test("delivery state machine claims once, records receipt and rejects duplicate receipt",()=>{
 const db=fixture();
 try {
  const queued=enqueueDelivery(db,{alertId:1,payload:"<alert/>"});
  const claimed=claimDelivery(db,queued.id);
  assert.equal(claimed.status,"sending");
  assert.equal(claimed.attempts,1);
  assert.equal(claimDelivery(db,queued.id),null);
  const delivered=recordDeliveryReceipt(db,queued.id,{status:"delivered",externalId:"provider-123"});
  assert.equal(delivered.status,"delivered");
  assert.equal(delivered.external_id,"provider-123");
  assert.ok(delivered.delivered_at);
  assert.equal(recordDeliveryReceipt(db,queued.id,{status:"delivered"}),null);
  assert.equal(retryDelivery(db,queued.id),null);
 } finally { db.close(); }
});

test("failed delivery can be requeued and retains attempt history",()=>{
 const db=fixture();
 try {
  const queued=enqueueDelivery(db,{alertId:1,payload:"<alert/>"});
  claimDelivery(db,queued.id);
  const failed=recordDeliveryReceipt(db,queued.id,{status:"failed",details:"Synthetic provider timeout"});
  assert.equal(failed.status,"failed");
  assert.equal(failed.last_error,"Synthetic provider timeout");
  const retried=retryDelivery(db,queued.id);
  assert.equal(retried.status,"queued");
  assert.equal(retried.attempts,1);
  const secondClaim=claimDelivery(db,queued.id);
  assert.equal(secondClaim.attempts,2);
 } finally { db.close(); }
});

test("outbox validates payload size and channel",()=>{
 const db=fixture();
 try {
  assert.throws(()=>enqueueDelivery(db,{alertId:1,channel:"unknown",payload:"x"}),/Unsupported delivery channel/);
  assert.throws(()=>enqueueDelivery(db,{alertId:1,payload:""}),/non-empty string/);
 } finally { db.close(); }
});
