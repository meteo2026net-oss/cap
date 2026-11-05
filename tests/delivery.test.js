import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { enqueueDelivery, claimDelivery, recordDeliveryReceipt, retryDelivery, recoverStaleDeliveries, processDueRetries } from "../src/delivery.js";

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
   last_attempt_at TEXT,delivered_at TEXT,max_attempts INTEGER NOT NULL DEFAULT 5,next_attempt_at TEXT,dead_letter_at TEXT,lease_token TEXT,lease_token_hash TEXT,UNIQUE(alert_id,channel)
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
  const storedLease = db.prepare("SELECT lease_token,lease_token_hash FROM delivery_outbox WHERE id=?").get(queued.id);
  assert.equal(storedLease.lease_token, null);
  assert.equal(storedLease.lease_token_hash, createHash("sha256").update(claimed.lease_token).digest("hex"));
  assert.equal(claimDelivery(db,queued.id),null);
  const delivered=recordDeliveryReceipt(db,queued.id,{status:"delivered",leaseToken:claimed.lease_token,externalId:"provider-123"});
  assert.equal(delivered.status,"delivered");
  assert.equal(delivered.external_id,"provider-123");
  assert.ok(delivered.delivered_at);
  assert.equal(recordDeliveryReceipt(db,queued.id,{status:"delivered",leaseToken:claimed.lease_token}),null);
  assert.equal(retryDelivery(db,queued.id),null);
 } finally { db.close(); }
});

test("failed delivery can be requeued and retains attempt history",()=>{
 const db=fixture();
 try {
  const queued=enqueueDelivery(db,{alertId:1,payload:"<alert/>"});
  const claimed=claimDelivery(db,queued.id);
  const failed=recordDeliveryReceipt(db,queued.id,{status:"failed",leaseToken:claimed.lease_token,details:"Synthetic provider timeout"});
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


test("stale sending leases are safely returned to the queue",()=>{
 const db=fixture();
 try {
  const stale=enqueueDelivery(db,{alertId:1,payload:"<stale/>"});
  claimDelivery(db,stale.id);
  db.prepare("UPDATE delivery_outbox SET last_attempt_at=datetime('now','-30 minutes') WHERE id=?").run(stale.id);
  const recent=enqueueDelivery(db,{alertId:1,channel:"webhook",payload:"<recent/>"});
  claimDelivery(db,recent.id);
  const recovered=recoverStaleDeliveries(db,10);
  assert.deepEqual(recovered.recovered.map(row=>row.id),[stale.id]);
  assert.deepEqual(recovered.deadLettered,[]);
  assert.equal(db.prepare("SELECT status FROM delivery_outbox WHERE id=?").get(stale.id).status,"queued");
  assert.equal(db.prepare("SELECT status FROM delivery_outbox WHERE id=?").get(recent.id).status,"sending");
  assert.match(db.prepare("SELECT last_error FROM delivery_outbox WHERE id=?").get(stale.id).last_error,/Recovered stale sending lease/);
  assert.throws(()=>recoverStaleDeliveries(db,0),/from 1 to 1440/);
 } finally { db.close(); }
});


test("failed deliveries use exponential backoff and are automatically requeued when due",()=>{
 const db=fixture();
 try {
  const queued=enqueueDelivery(db,{alertId:1,payload:"<retry/>",maxAttempts:3});
  const claimed=claimDelivery(db,queued.id);
  const failed=recordDeliveryReceipt(db,queued.id,{status:"failed",leaseToken:claimed.lease_token,details:"Temporary failure"});
  assert.equal(failed.status,"failed");
  assert.ok(failed.next_attempt_at);
  assert.equal(failed.dead_letter_at,null);
  const notDue=processDueRetries(db);
  assert.equal(notDue.requeued.length,0);
  db.prepare("UPDATE delivery_outbox SET next_attempt_at=datetime('now','-1 second') WHERE id=?").run(queued.id);
  const due=processDueRetries(db);
  assert.deepEqual(due.requeued.map(row=>row.id),[queued.id]);
  assert.equal(db.prepare("SELECT status FROM delivery_outbox WHERE id=?").get(queued.id).status,"queued");
  assert.equal(claimDelivery(db,queued.id).attempts,2);
 } finally { db.close(); }
});

test("delivery is dead-lettered at the configured attempt limit and cannot be auto-retried",()=>{
 const db=fixture();
 try {
  const queued=enqueueDelivery(db,{alertId:1,payload:"<terminal/>",maxAttempts:1});
  const claimed=claimDelivery(db,queued.id);
  const failed=recordDeliveryReceipt(db,queued.id,{status:"failed",leaseToken:claimed.lease_token,details:"Permanent synthetic failure"});
  assert.equal(failed.status,"failed");
  assert.equal(failed.attempts,1);
  assert.ok(failed.dead_letter_at);
  assert.equal(failed.next_attempt_at,null);
  assert.equal(retryDelivery(db,queued.id),null);
  assert.equal(processDueRetries(db).deadLettered.length,0);
  assert.equal(claimDelivery(db,queued.id),null);
 } finally { db.close(); }
});

test("delivery retry policy validates max attempts",()=>{
 const db=fixture();
 try {
  assert.throws(()=>enqueueDelivery(db,{alertId:1,payload:"x",maxAttempts:0}),/maxAttempts/);
  assert.throws(()=>enqueueDelivery(db,{alertId:1,payload:"x",maxAttempts:21}),/maxAttempts/);
 } finally { db.close(); }
});

test("stale sending lease at maximum attempts is dead-lettered, not reported as recovered",()=>{
 const db=fixture();
 try {
  const terminal=enqueueDelivery(db,{alertId:1,payload:"<stale-terminal/>",maxAttempts:1});
  claimDelivery(db,terminal.id);
  db.prepare("UPDATE delivery_outbox SET last_attempt_at=datetime('now','-30 minutes') WHERE id=?").run(terminal.id);
  const result=recoverStaleDeliveries(db,10);
  assert.deepEqual(result.recovered,[]);
  assert.deepEqual(result.deadLettered.map(row=>row.id),[terminal.id]);
  const row=db.prepare("SELECT status,dead_letter_at FROM delivery_outbox WHERE id=?").get(terminal.id);
  assert.equal(row.status,"failed");
  assert.ok(row.dead_letter_at);
 } finally { db.close(); }
});


test("delivery receipts reject malformed and incorrect lease tokens",()=>{
 const db=fixture();
 try {
  const queued=enqueueDelivery(db,{alertId:1,payload:"<invalid-token/>"});
  const claimed=claimDelivery(db,queued.id);
  assert.throws(()=>recordDeliveryReceipt(db,queued.id,{status:"delivered",leaseToken:"not-a-uuid"}),/valid delivery lease token/);
  assert.equal(recordDeliveryReceipt(db,queued.id,{status:"delivered",leaseToken:"00000000-0000-4000-8000-000000000000"}),null);
  assert.equal(db.prepare("SELECT status FROM delivery_outbox WHERE id=?").get(queued.id).status,"sending");
  assert.equal(recordDeliveryReceipt(db,queued.id,{status:"delivered",leaseToken:claimed.lease_token}).status,"delivered");
 } finally { db.close(); }
});

test("delivery receipts reject stale workers after lease recovery",()=>{
 const db=fixture();
 try {
  const queued=enqueueDelivery(db,{alertId:1,payload:"<lease/>",maxAttempts:3});
  const firstClaim=claimDelivery(db,queued.id);
  assert.ok(firstClaim.lease_token);
  db.prepare("UPDATE delivery_outbox SET last_attempt_at=datetime('now','-30 minutes') WHERE id=?").run(queued.id);
  assert.deepEqual(recoverStaleDeliveries(db,10).recovered.map(row=>row.id),[queued.id]);
  const secondClaim=claimDelivery(db,queued.id);
  assert.notEqual(secondClaim.lease_token,firstClaim.lease_token);
  assert.equal(recordDeliveryReceipt(db,queued.id,{status:"delivered",leaseToken:firstClaim.lease_token}),null);
  assert.equal(recordDeliveryReceipt(db,queued.id,{status:"delivered",leaseToken:secondClaim.lease_token}).status,"delivered");
 } finally { db.close(); }
});

test("concurrent outbox claims grant exactly one worker the lease", async () => {
 const db=fixture();
 try {
  const queued=enqueueDelivery(db,{alertId:1,payload:"<concurrent-claim/>"});
  const claims=await Promise.all([
   Promise.resolve().then(()=>claimDelivery(db,queued.id)),
   Promise.resolve().then(()=>claimDelivery(db,queued.id))
  ]);
  const winners=claims.filter(Boolean);
  assert.equal(winners.length,1,"only one competing worker may claim a queued delivery");
  assert.equal(winners[0].status,"sending");
  assert.ok(winners[0].lease_token);
  assert.equal(db.prepare("SELECT attempts FROM delivery_outbox WHERE id=?").get(queued.id).attempts,1);
  assert.equal(claimDelivery(db,queued.id),null,"the claimed job must no longer be available");
 } finally { db.close(); }
});


test("queue maintenance processes bounded batches without exceeding SQLite parameter limits", () => {
 const db=fixture();
 try {
  const addAlert=db.prepare("INSERT INTO alerts(id,identifier) VALUES(?,?)");
  const addDelivery=db.prepare("INSERT INTO delivery_outbox(alert_id,channel,payload,status,attempts,max_attempts,last_attempt_at) VALUES(?,'cap_feed','<batch/>','sending',1,1,datetime('now','-30 minutes'))");
  for(let id=2;id<=502;id++){
   addAlert.run(id,"batch-alert-"+id);
   addDelivery.run(id);
  }
  const first=recoverStaleDeliveries(db,10);
  assert.equal(first.deadLettered.length,500,"stale lease recovery must be bounded to 500 rows per pass");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM delivery_outbox WHERE status='sending'").get().count,1);
  const second=recoverStaleDeliveries(db,10);
  assert.equal(second.deadLettered.length,1,"subsequent passes must drain the remaining stale entries");

  const addFailed=db.prepare("INSERT INTO delivery_outbox(alert_id,channel,payload,status,attempts,max_attempts) VALUES(?,'webhook','<due/>','failed',1,1)");
  for(let id=2;id<=502;id++) addFailed.run(id);
  const firstRetryPass=processDueRetries(db);
  assert.equal(firstRetryPass.deadLettered.length,500,"dead-letter maintenance must be bounded to 500 rows per pass");
  const secondRetryPass=processDueRetries(db);
  assert.equal(secondRetryPass.deadLettered.length,1,"subsequent retry passes must drain the remaining dead letters");
  const due=db.prepare("SELECT COUNT(*) AS count FROM delivery_outbox WHERE status='failed' AND dead_letter_at IS NOT NULL").get().count;
  assert.equal(due,1002);
 } finally { db.close(); }
});
