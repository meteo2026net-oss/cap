import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SECONDS = 30;
const CODE_DIGITS = 6;

function encryptionKey() {
  const value = process.env.MFA_ENCRYPTION_KEY || "";
  let key;
  if (/^[a-f0-9]{64}$/i.test(value)) key = Buffer.from(value, "hex");
  else if (/^[A-Za-z0-9+/]{43}=$/.test(value)) key = Buffer.from(value, "base64");
  if (!key || key.length !== 32) throw new Error("MFA_ENCRYPTION_KEY must be a 32-byte hex or base64 key");
  return key;
}

export function generateTotpSecret() {
  return encodeBase32(randomBytes(20));
}

export function encodeBase32(buffer) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

export function decodeBase32(input) {
  if (typeof input !== "string" || !/^[A-Z2-7]+$/i.test(input)) throw new Error("Invalid Base32 secret");
  let bits = 0;
  let value = 0;
  const output = [];
  for (const char of input.toUpperCase()) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

export function totpAt(secret, timestamp = Date.now()) {
  const counter = Math.floor(timestamp / 1000 / STEP_SECONDS);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", decodeBase32(secret)).update(message).digest();
  const offset = digest[digest.length - 1] & 15;
  const binary = ((digest[offset] & 127) << 24) |
    ((digest[offset + 1] & 255) << 16) |
    ((digest[offset + 2] & 255) << 8) |
    (digest[offset + 3] & 255);
  return String(binary % (10 ** CODE_DIGITS)).padStart(CODE_DIGITS, "0");
}

export function verifyTotp(secret, code, now = Date.now(), window = 1) {
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) return null;
  const currentStep = Math.floor(now / 1000 / STEP_SECONDS);
  const supplied = Buffer.from(code, "utf8");
  for (let offset = -window; offset <= window; offset++) {
    const step = currentStep + offset;
    if (step < 0) continue;
    const expected = Buffer.from(totpAt(secret, step * STEP_SECONDS * 1000), "utf8");
    if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) return step;
  }
  return null;
}

export function encryptTotpSecret(secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map(part => part.toString("base64")).join(".");
}

export function decryptTotpSecret(payload) {
  if (typeof payload !== "string") throw new Error("Encrypted MFA secret is missing");
  const parts = payload.split(".");
  if (parts.length !== 3) throw new Error("Encrypted MFA secret has an invalid format");
  const [iv, tag, ciphertext] = parts.map(part => Buffer.from(part, "base64"));
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length < 1) throw new Error("Encrypted MFA secret has invalid lengths");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function generateRecoveryCodes(count = 10) {
  if (!Number.isInteger(count) || count < 1 || count > 20) throw new Error("Recovery code count must be between 1 and 20");
  return Array.from({ length: count }, () => {
    const raw = randomBytes(10).toString("hex").toUpperCase();
    return raw.match(/.{1,5}/g).join("-");
  });
}

export function hashRecoveryCode(code) {
  if (typeof code !== "string") return "";
  return createHash("sha256").update(code.replace(/-/g, "").toUpperCase(), "utf8").digest("hex");
}

export function consumeRecoveryCode(hashes, suppliedCode) {
  if (!Array.isArray(hashes) || typeof suppliedCode !== "string" || suppliedCode.length > 64) return null;
  const candidate = Buffer.from(hashRecoveryCode(suppliedCode), "hex");
  const index = hashes.findIndex(hash => {
    if (typeof hash !== "string" || !/^[a-f0-9]{64}$/i.test(hash)) return false;
    return timingSafeEqual(candidate, Buffer.from(hash, "hex"));
  });
  if (index < 0) return null;
  const remaining = hashes.slice();
  remaining.splice(index, 1);
  return remaining;
}
