import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 22) {
  console.error(`Node.js 22 or newer is required. Detected: ${process.version}`);
  process.exit(1);
}

const root = process.cwd();
const envPath = path.join(root, ".env");
const examplePath = path.join(root, ".env.example");

if (fs.existsSync(envPath)) {
  console.error(".env already exists. It was not changed. Edit it manually if you need to rotate credentials.");
  process.exit(1);
}
if (!fs.existsSync(examplePath)) {
  console.error(".env.example was not found. Run this command from the repository root.");
  process.exit(1);
}

const jwtSecret = randomBytes(48).toString("base64url");
const adminPassword = randomBytes(24).toString("base64url");
const mfaEncryptionKey = randomBytes(32).toString("hex");
let env = fs.readFileSync(examplePath, "utf8");
env = env.replace(/^JWT_SECRET=.*$/m, `JWT_SECRET=${jwtSecret}`);
env = env.replace(/^ADMIN_PASSWORD=.*$/m, `ADMIN_PASSWORD=${adminPassword}`);
env = env.replace(/^# MFA_ENCRYPTION_KEY=.*$/m, `MFA_ENCRYPTION_KEY=${mfaEncryptionKey}`);
env = env.replace(/^HOST=.*$/m, "HOST=127.0.0.1");
fs.writeFileSync(envPath, env, { flag: "wx", mode: 0o600 });
fs.mkdirSync(path.join(root, "storage"), { recursive: true });
fs.mkdirSync(path.join(root, "backups"), { recursive: true });

console.log("\nLocal configuration created successfully.");
console.log("Administrator username: admin");
console.log(`Initial administrator password: ${adminPassword}`);
console.log("JWT secret: generated and saved in .env");
console.log("MFA encryption key: generated and saved in .env");
console.log("\nSave the initial password in a password manager. It is shown only once.");
console.log("Next steps: npm install, npm test, then npm start");
console.log("Open: http://localhost:8095");
