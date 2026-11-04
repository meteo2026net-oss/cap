import "dotenv/config";
import { db } from "./db.js";
import { processDueRetries, recoverStaleDeliveries } from "./delivery.js";

const intervalMs = Number(process.env.CAP_DELIVERY_WORKER_INTERVAL_MS || 30000);
if (!Number.isInteger(intervalMs) || intervalMs < 5000 || intervalMs > 300000) {
  throw new Error("CAP_DELIVERY_WORKER_INTERVAL_MS must be between 5000 and 300000");
}
let running = false;
let stopped = false;

async function tick() {
  if (running || stopped) return;
  running = true;
  try {
    const recovered = recoverStaleDeliveries(db, 10);
    const retries = processDueRetries(db);
    if (recovered.recovered.length || recovered.deadLettered.length || retries.requeued.length || retries.deadLettered.length) {
      console.log(JSON.stringify({
        event: "delivery_queue_maintenance",
        recovered_stale: recovered.recovered.length,
        stale_dead_lettered: recovered.deadLettered.length,
        auto_requeued: retries.requeued.length,
        dead_lettered: retries.deadLettered.length,
        external_adapters_enabled: false
      }));
    }
  } catch (error) {
    console.error("Delivery queue maintenance failed:", error);
  } finally {
    running = false;
  }
}

function shutdown() {
  if (stopped) return;
  stopped = true;
  clearInterval(timer);
  db.close();
  process.exit(0);
}

const timer = setInterval(tick, intervalMs);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
console.log(`CAP internal queue maintenance worker started; interval=${intervalMs}ms; external adapters disabled.`);
tick();
