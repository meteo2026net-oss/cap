import "dotenv/config";
import { runIsolatedRestoreDrill } from "./backup-utils.js";

const source = process.argv[2];
if (!source) {
  console.error("Usage: npm run restore:drill -- <backup-file>");
  process.exit(2);
}

try {
  const result = await runIsolatedRestoreDrill(source);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error("Isolated restore drill failed:", error.message);
  process.exitCode = 1;
}
