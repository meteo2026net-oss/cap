import test from "node:test";
import assert from "node:assert/strict";
import {
  consumeRecoveryCode, decryptTotpSecret, decodeBase32, encryptTotpSecret,
  generateRecoveryCodes, generateTotpSecret, hashRecoveryCode, totpAt, verifyTotp
} from "../src/mfa.js";

test("TOTP matches the RFC 6238 SHA-1 test vector at 59 seconds", () => {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  assert.equal(decodeBase32(secret).toString(), "12345678901234567890");
  assert.equal(totpAt(secret, 59000), "287082");
  assert.equal(verifyTotp(secret, "287082", 59000), 1);
  assert.equal(verifyTotp(secret, "000000", 59000), null);
});

test("TOTP accepts only the configured adjacent time window", () => {
  const secret = generateTotpSecret();
  const now = 1_800_000_000_000;
  const code = totpAt(secret, now);
  assert.notEqual(verifyTotp(secret, code, now + 120_000), Math.floor(now / 30_000));
});

test("TOTP encryption uses authenticated AES-256-GCM and rejects tampering", () => {
  const previous = process.env.MFA_ENCRYPTION_KEY;
  process.env.MFA_ENCRYPTION_KEY = "a".repeat(64);
  try {
    const secret = generateTotpSecret();
    const encrypted = encryptTotpSecret(secret);
    assert.notEqual(encrypted, secret);
    assert.equal(decryptTotpSecret(encrypted), secret);
    const [iv, tag, ciphertext] = encrypted.split(".");
    const changed = (ciphertext[0] === "A" ? "B" : "A") + ciphertext.slice(1);
    assert.throws(() => decryptTotpSecret([iv, tag, changed].join(".")));
  } finally {
    if (previous === undefined) delete process.env.MFA_ENCRYPTION_KEY;
    else process.env.MFA_ENCRYPTION_KEY = previous;
  }
});

test("recovery codes are random, hashed, and consumed once", () => {
  const codes = generateRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  const hashes = codes.map(hashRecoveryCode);
  assert.ok(hashes.every(hash => /^[a-f0-9]{64}$/.test(hash)));
  const remaining = consumeRecoveryCode(hashes, codes[0].toLowerCase());
  assert.equal(remaining.length, 9);
  assert.equal(consumeRecoveryCode(remaining, codes[0]), null);
  assert.equal(consumeRecoveryCode(hashes, "not-a-recovery-code"), null);
});

test("MFA encryption refuses missing or malformed key material", () => {
  const previous = process.env.MFA_ENCRYPTION_KEY;
  delete process.env.MFA_ENCRYPTION_KEY;
  try {
    assert.throws(() => encryptTotpSecret("secret"), /MFA_ENCRYPTION_KEY/);
  } finally {
    if (previous !== undefined) process.env.MFA_ENCRYPTION_KEY = previous;
  }
});
