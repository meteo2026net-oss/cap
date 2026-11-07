import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { createWebhookSignature } from "../src/webhook-signature.js";
import { appendAuditLog } from "../src/audit.js";
import { totpAt } from "../src/mfa.js";

const serverEntry = fileURLToPath(new URL("../src/server.js", import.meta.url));

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test("API enforces role separation, public-feed filtering and account deactivation", { timeout: 120000 }, async t => {
  const cwd = await mkdtemp(path.join(tmpdir(), "meteo-cap-api-"));
  const port = await reservePort();
  const base = "http://127.0.0.1:" + port;
  const child = spawn(process.execPath, [serverEntry], {
    cwd,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      JWT_SECRET: "integration-test-secret-that-is-at-least-32-characters",
      ADMIN_PASSWORD: "Integration-Test-Admin-Password-2026",
      CAP_DELIVERY_ENABLED: "true",
      CAP_WEBHOOK_INGRESS_ENABLED: "true",
      CAP_WEBHOOK_SECRET: "integration-webhook-secret-that-is-at-least-32-bytes",
      MFA_ENCRYPTION_KEY: "a".repeat(64),
      MFA_REQUIRED_ROLES: "admin,approver,publisher",
      API_RATE_LIMIT: "2000"
    },
    stdio: "ignore"
  });

  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise(resolve => {
        child.once("exit", resolve);
        setTimeout(resolve, 2000);
      });
    }
    await rm(cwd, { recursive: true, force: true });
  });

  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error("API server exited before becoming ready.");
    try {
      const response = await fetch(base + "/api/health");
      if (response.ok) { ready = true; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, "API server should become ready");

  const readinessResponse = await fetch(base + "/api/health/ready");
  assert.equal(readinessResponse.status, 200, "readiness must verify the database before reporting ready");
  const readiness = await readinessResponse.json();
  assert.equal(readiness.ok, true);
  assert.deepEqual(readiness.checks, { database: "ok", foreign_keys: "ok" });
  const unauthenticatedAlerts = await fetch(base + "/api/alerts");
  assert.equal(unauthenticatedAlerts.status, 401);
  assert.equal(unauthenticatedAlerts.headers.get("cache-control"), "no-store",
    "unauthenticated warning API errors must not be cached");
  assert.equal(unauthenticatedAlerts.headers.get("pragma"), "no-cache",
    "unauthenticated warning API errors must carry a legacy no-cache directive");

  const dashboard = await fetch(base + "/");
  assert.equal(dashboard.status, 200, "dashboard should be served independently of process.cwd()");
  const csp = dashboard.headers.get("content-security-policy") || "";
  assert.ok(csp.includes("frame-ancestors"));
  assert.ok(csp.includes("object-src"));
  assert.ok(csp.includes("script-src"));
  assert.ok(csp.includes("script-src-attr 'none'"), "inline event handler attributes must be blocked");
  assert.equal(dashboard.headers.get("x-content-type-options"), "nosniff",
    "responses should prevent MIME type sniffing");
  assert.ok(dashboard.headers.get("referrer-policy"),
    "responses should include a referrer policy");
  const crossOriginDashboard = await fetch(base + "/", {
    headers: { Origin: "https://untrusted.example" }
  });
  assert.equal(crossOriginDashboard.headers.get("access-control-allow-origin"), null,
    "cross-origin browser access must remain disabled unless an explicit CORS allowlist is configured");
  const dashboardScriptResponse = await fetch(base + "/app.js");
  assert.equal(dashboardScriptResponse.status, 200);
  const dashboardScript = await dashboardScriptResponse.text();
  assert.doesNotMatch(dashboardScript, /<[^>]+\sonclick\s*=/i, "dashboard must not render inline HTML event handlers");
  assert.match(dashboardScript, /data-alert-action/);
  assert.match(dashboardScript, /data-webhook-review/);

  const webhookTimestamp = Math.floor(Date.now() / 1000);
  const webhookBody = JSON.stringify({ provider: "synthetic-test", event: "inbound-test", alert: { headline: "Not an operational alert" } });
  const webhookSecret = "integration-webhook-secret-that-is-at-least-32-bytes";
  const webhookSignature = createWebhookSignature(webhookSecret, webhookTimestamp, webhookBody);
  const sendWebhook = (body, timestamp = webhookTimestamp, signature = webhookSignature, contentType = "application/json") =>
    fetch(base + "/api/webhooks/inbound", {
      method: "POST",
      headers: { "Content-Type": contentType, "X-Webhook-Timestamp": String(timestamp), "X-Webhook-Signature": signature },
      body
    });
  const acceptedWebhook = await sendWebhook(webhookBody);
  assert.equal(acceptedWebhook.status, 202, "valid signed webhook should be accepted into the inbox");
  const acceptedWebhookData = await acceptedWebhook.json();
  assert.equal(acceptedWebhookData.accepted, true);
  assert.equal(acceptedWebhookData.status, "pending");
  assert.equal(acceptedWebhookData.action, "manual_review_required");
  assert.ok(Number.isInteger(acceptedWebhookData.inbox_id));
  const duplicateWebhook = await sendWebhook(webhookBody);
  assert.equal(duplicateWebhook.status, 401, "a replayed signed webhook must be rejected");
  const tamperedBody = await sendWebhook(webhookBody + " ");
  assert.equal(tamperedBody.status, 401, "body tampering must invalidate the signature");
  const staleTimestamp = webhookTimestamp - 301;
  const staleSignature = createWebhookSignature(webhookSecret, staleTimestamp, webhookBody);
  const staleWebhook = await sendWebhook(webhookBody, staleTimestamp, staleSignature);
  assert.equal(staleWebhook.status, 401, "stale signed webhooks must be rejected");
  const malformedTimestamp = await sendWebhook(webhookBody, "not-a-time", webhookSignature);
  assert.equal(malformedTimestamp.status, 400, "malformed timestamps must be rejected");
  const malformedJsonBody = "{invalid-json";
  const malformedJsonSignature = createWebhookSignature(webhookSecret, webhookTimestamp, malformedJsonBody);
  const malformedJson = await sendWebhook(malformedJsonBody, webhookTimestamp, malformedJsonSignature);
  assert.equal(malformedJson.status, 400, "signed non-JSON payloads must be rejected");
  const unsupportedContentType = await sendWebhook(webhookBody, webhookTimestamp, webhookSignature, "text/plain");
  assert.equal(unsupportedContentType.status, 415, "webhook ingress must require JSON content type");
  const oversizedWebhook = await sendWebhook(JSON.stringify({ data: "x".repeat(65 * 1024) }));
  assert.equal(oversizedWebhook.status, 413, "webhook payloads larger than the 64 KB ingress limit must be rejected");

  const request = async (url, { token, method = "GET", body } = {}) => {
    const response = await fetch(base + url, {
      method,
      headers: {
        ...(token ? { Authorization: "Bearer " + token } : {}),
        ...(body ? { "Content-Type": "application/json" } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    return { status: response.status, headers: response.headers, data: await response.json().catch(() => ({})) };
  };

  const login = async (username, password) => {
    const result = await request("/api/auth/login", {
      method: "POST", body: { username, password }
    });
    assert.equal(result.status, 200, "login should succeed for " + username);
    assert.equal(result.headers.get("cache-control"), "no-store",
      "authentication responses must not be stored by browsers or shared caches");
    assert.equal(result.headers.get("pragma"), "no-cache",
      "authentication responses must carry a legacy no-cache directive");
    return result.data.token;
  };

  const enrollMfa = async (token, password) => {
    const enrollment = await request("/api/auth/mfa/enroll", {
      token, method: "POST", body: { password }
    });
    assert.equal(enrollment.status, 200, "required-role account should be able to start MFA enrollment");
    assert.equal(enrollment.headers.get("cache-control"), "no-store",
      "MFA enrollment secrets must not be cached");
    assert.equal(enrollment.headers.get("pragma"), "no-cache",
      "MFA enrollment responses must carry a legacy no-cache directive");
    const confirmation = await request("/api/auth/mfa/confirm", {
      token, method: "POST", body: { password, code: totpAt(enrollment.data.secret) }
    });
    assert.equal(confirmation.status, 200, "required-role account should be able to confirm MFA enrollment");
    return confirmation.data.token;
  };

  const malformedLogin = await request("/api/auth/login", {
    method: "POST", body: { username: { malformed: true }, password: "anything" }
  });
  assert.equal(malformedLogin.status, 401, "malformed usernames should receive a generic authentication failure");
  assert.equal(malformedLogin.headers.get("cache-control"), "no-store",
    "failed authentication responses must not be cached");
  assert.equal((await request("/api/auth/login", {
    method: "POST", body: { username: "admin", password: "x".repeat(201) }
  })).status, 401, "oversized login passwords should be rejected before password hashing");

  assert.equal((await request("/api/auth/login", {
    method: "POST", body: { username: "account-that-does-not-exist", password: "Wrong-Password-2026!" }
  })).status, 401, "unknown accounts must receive the same generic authentication failure");

  let admin = await login("admin", "Integration-Test-Admin-Password-2026");
  assert.equal((await request("/api/users", { token: admin })).status, 403,
    "an administrator without required MFA must not access protected administrator operations");
  const adminMfaStatus = await request("/api/auth/mfa/status", { token: admin });
  assert.equal(adminMfaStatus.data.required, true);
  assert.equal(adminMfaStatus.headers.get("cache-control"), "no-store",
    "MFA status responses must not be cached");
  const adminEnrollment = await request("/api/auth/mfa/enroll", {
    token: admin, method: "POST", body: { password: "Integration-Test-Admin-Password-2026" }
  });
  assert.equal(adminEnrollment.status, 200, "required-role users must be able to enroll while privileged operations are blocked");
  const adminMfaConfirmed = await request("/api/auth/mfa/confirm", {
    token: admin, method: "POST", body: {
      password: "Integration-Test-Admin-Password-2026", code: totpAt(adminEnrollment.data.secret)
    }
  });
  assert.equal(adminMfaConfirmed.status, 200);
  admin = adminMfaConfirmed.data.token;
  const initialUsers = await request("/api/users", { token: admin });
  assert.equal(initialUsers.status, 200);
  assert.equal(initialUsers.headers.get("cache-control"), "no-store",
    "administrator user-directory responses must not be cached");
  assert.equal(initialUsers.headers.get("pragma"), "no-cache",
    "administrator user-directory responses must carry a legacy no-cache directive");
  const adminProfile = await request("/api/me", { token: admin });
  assert.equal(adminProfile.status, 200);
  assert.equal(adminProfile.headers.get("cache-control"), "no-store",
    "authenticated profile responses must not be cached");
  assert.equal(adminProfile.headers.get("pragma"), "no-cache",
    "authenticated profile responses must carry a legacy no-cache directive");
  const adminUserId = adminProfile.data.user.id;
  assert.ok(Number.isSafeInteger(adminUserId));
  assert.ok(initialUsers.data.users.find(user => user.username === "admin")?.last_login_at,
    "successful login should persist the administrator last-login timestamp");
  assert.equal((await request(`/api/users/${adminUserId}/password-reset`, {
    token: admin, method: "POST", body: {}
  })).status, 409, "an administrator must not reset their own password through the assisted workflow");
  assert.equal((await request("/api/users/999999/password-reset", {
    token: admin, method: "POST", body: {}
  })).status, 404, "password reset must report an unknown account without changing any credentials");
  const userAuditDb = new Database(path.join(cwd, "storage", "cap.sqlite"));
  try {
    userAuditDb.exec(`CREATE TRIGGER fail_user_create_audit BEFORE INSERT ON audit_log
      WHEN NEW.action='user_created' BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END;`);
  } finally {
    userAuditDb.close();
  }
  const failedAuditedUser = await request("/api/users", {
    token: admin, method: "POST",
    body: { username: "audit-rollback-user", role: "viewer", password: "Initial-Temporary-Password-2026!" }
  });
  assert.equal(failedAuditedUser.status, 400);
  const verifyUserRollback = new Database(path.join(cwd, "storage", "cap.sqlite"));
  try {
    assert.equal(verifyUserRollback.prepare("SELECT COUNT(*) AS count FROM users WHERE username=?")
      .get("audit-rollback-user").count, 0,
      "user creation must roll back when its audit event cannot be stored");
    verifyUserRollback.exec("DROP TRIGGER fail_user_create_audit");
  } finally {
    verifyUserRollback.close();
  }

  const createUser = async (username, role) => {
    const result = await request("/api/users", {
      token: admin, method: "POST",
      body: { username, role, password: "Initial-Temporary-Password-2026!" }
    });
    assert.equal(result.status, 201, "user should be created: " + username);
    assert.equal(result.data.must_change_password, true, "new accounts must require a password change");
    const initialLogin = await request("/api/auth/login", {
      method: "POST", body: { username, password: "Initial-Temporary-Password-2026!" }
    });
    assert.equal(initialLogin.status, 200);
    assert.equal(initialLogin.data.password_change_required, true);
    assert.equal((await request("/api/auth/change-password", {
      token: initialLogin.data.token, method: "POST",
      body: { currentPassword: "Initial-Temporary-Password-2026!", newPassword: "Initial-Temporary-Password-2026!" }
    })).status, 400, "the initial temporary password must not be reused as the replacement");
    assert.equal((await request("/api/alerts", { token: initialLogin.data.token })).status, 403,
      "newly provisioned accounts must not access application data before changing the initial password");
    const initialPasswordChange = await request("/api/auth/change-password", {
      token: initialLogin.data.token, method: "POST",
      body: {
        currentPassword: "Initial-Temporary-Password-2026!",
        newPassword: "Temporary-Password-2026!"
      }
    });
    assert.equal(initialPasswordChange.status, 200, "new users must be able to replace their initial password");
    return result.data.id;
  };

  const inactiveResetUserId = await createUser("inactive-reset-user", "viewer");
  assert.equal((await request(`/api/users/${inactiveResetUserId}/status`, {
    token: admin, method: "PATCH", body: {active:false}
  })).status, 200);
  assert.equal((await request(`/api/users/${inactiveResetUserId}/password-reset`, {
    token: admin, method: "POST", body: {}
  })).status, 409, "inactive accounts must be reactivated through the approved process before password reset");

  const resetUserId = await createUser("resetuser", "viewer");
  const resetOldSession = await login("resetuser", "Temporary-Password-2026!");
  const resetResult = await request(`/api/users/${resetUserId}/password-reset`, {
    token: admin, method: "POST", body: {}
  });
  assert.equal(resetResult.status, 200, "an MFA-authenticated administrator should reset another active user's password");
  assert.equal(resetResult.headers.get("cache-control"), "no-store",
    "one-time temporary passwords must not be cached");
  assert.equal(resetResult.headers.get("pragma"), "no-cache",
    "password reset responses must carry a legacy no-cache directive");
  assert.equal(resetResult.data.must_change_password, true);
  assert.equal(resetResult.data.sessions_revoked, true);
  assert.ok(resetResult.data.temporary_password.length >= 32);
  assert.equal(resetResult.data.password_hash, undefined, "password hashes must never be returned by reset APIs");
  assert.equal((await request("/api/me", { token: resetOldSession })).status, 401,
    "administrator password reset must revoke all existing sessions");
  assert.equal((await request("/api/auth/login", {
    method: "POST", body: { username: "resetuser", password: "Temporary-Password-2026!" }
  })).status, 401, "the previous password must stop working immediately after reset");
  const temporaryLogin = await request("/api/auth/login", {
    method: "POST", body: { username: "resetuser", password: resetResult.data.temporary_password }
  });
  assert.equal(temporaryLogin.status, 200);
  assert.equal(temporaryLogin.data.password_change_required, true);
  assert.equal((await request("/api/alerts", { token: temporaryLogin.data.token })).status, 403,
    "temporary-password sessions must not access application data");
  const temporarySessionProfile = await request("/api/me", { token: temporaryLogin.data.token });
  assert.equal(temporarySessionProfile.data.user.must_change_password, 1);
  assert.equal((await request("/api/auth/mfa/status", { token: temporaryLogin.data.token })).status, 200,
    "temporary-password sessions may access account security setup");
  const passwordReplacement = await request("/api/auth/change-password", {
    token: temporaryLogin.data.token, method: "POST",
    body: {
      currentPassword: resetResult.data.temporary_password,
      newPassword: "Reset-User-New-Password-2026!"
    }
  });
  assert.equal(passwordReplacement.status, 200);
  assert.equal(passwordReplacement.data.password_change_required, false);
  const accessibleAlerts = await request("/api/alerts", { token: passwordReplacement.data.token });
  assert.equal(accessibleAlerts.status, 200,
    "normal application access should resume only after the forced password change");
  assert.equal(accessibleAlerts.headers.get("cache-control"), "no-store",
    "authenticated warning records must not be cached");
  assert.equal(accessibleAlerts.headers.get("pragma"), "no-cache",
    "authenticated warning records must carry a legacy no-cache directive");
  assert.equal((await request("/api/me", { token: temporaryLogin.data.token })).status, 401,
    "changing the temporary password must revoke its prior session");

  const mfaResetUserId = await createUser("mfaresetuser", "viewer");
  const mfaResetPassword = "Temporary-Password-2026!";
  const mfaResetInitialSession = await login("mfaresetuser", mfaResetPassword);
  const mfaResetEnrollment = await request("/api/auth/mfa/enroll", {
    token: mfaResetInitialSession, method: "POST", body: { password: mfaResetPassword }
  });
  assert.equal(mfaResetEnrollment.status, 200);
  const mfaResetConfirmation = await request("/api/auth/mfa/confirm", {
    token: mfaResetInitialSession, method: "POST",
    body: { password: mfaResetPassword, code: totpAt(mfaResetEnrollment.data.secret) }
  });
  assert.equal(mfaResetConfirmation.status, 200);
  const mfaResetResult = await request(`/api/users/${mfaResetUserId}/password-reset`, {
    token: admin, method: "POST", body: {}
  });
  assert.equal(mfaResetResult.status, 200);
  assert.equal((await request("/api/me", { token: mfaResetConfirmation.data.token })).status, 401,
    "password reset must revoke sessions even when MFA is enabled");
  const mfaTemporaryLogin = await request("/api/auth/login", {
    method: "POST", body: { username: "mfaresetuser", password: mfaResetResult.data.temporary_password }
  });
  assert.equal(mfaTemporaryLogin.data.mfa_required, true,
    "administrator password reset must preserve the account's existing MFA requirement");
  assert.equal(mfaTemporaryLogin.data.password_change_required, true);
  const mfaTemporaryChallenge = await request("/api/auth/mfa/challenge", {
    method: "POST",
    body: {
      challenge_token: mfaTemporaryLogin.data.challenge_token,
      code: mfaResetConfirmation.data.recovery_codes[0]
    }
  });
  assert.equal(mfaTemporaryChallenge.status, 200);
  assert.equal(mfaTemporaryChallenge.data.password_change_required, true);
  assert.equal((await request("/api/alerts", { token: mfaTemporaryChallenge.data.token })).data.code,
    "PASSWORD_CHANGE_REQUIRED");
  const mfaPasswordReplacement = await request("/api/auth/change-password", {
    token: mfaTemporaryChallenge.data.token, method: "POST",
    body: {
      currentPassword: mfaResetResult.data.temporary_password,
      newPassword: "MFA-Reset-New-Password-2026!"
    }
  });
  assert.equal(mfaPasswordReplacement.status, 200);
  assert.equal((await request("/api/auth/mfa/status", { token: mfaPasswordReplacement.data.token })).data.enabled,
    true, "MFA must remain enabled after forced password replacement");

  const mfaUserId = await createUser("mfauser", "forecaster");
  const mfaPassword = "Temporary-Password-2026!";
  const mfaInitialToken = await login("mfauser", mfaPassword);
  const mfaStatusBefore = await request("/api/auth/mfa/status", { token: mfaInitialToken });
  assert.equal(mfaStatusBefore.status, 200);
  assert.equal(mfaStatusBefore.data.enabled, false, "MFA must remain opt-in for existing accounts");
  const enrollment = await request("/api/auth/mfa/enroll", {
    token: mfaInitialToken, method: "POST", body: { password: mfaPassword }
  });
  assert.equal(enrollment.status, 200, "valid password should start pending MFA enrollment");
  assert.match(enrollment.data.otpauth_url, /^otpauth:\/\/totp\//);
  assert.equal((await request("/api/auth/mfa/confirm", {
    token: mfaInitialToken, method: "POST", body: { password: mfaPassword, code: "000000" }
  })).status, 401, "an invalid authenticator code must not enable MFA");
  const enrollmentCode = totpAt(enrollment.data.secret);
  const confirmed = await request("/api/auth/mfa/confirm", {
    token: mfaInitialToken, method: "POST", body: { password: mfaPassword, code: enrollmentCode }
  });
  assert.equal(confirmed.status, 200, "valid TOTP should enable MFA");
  assert.equal(confirmed.data.enabled, true);
  assert.equal(confirmed.data.recovery_codes.length, 10);
  assert.equal((await request("/api/me", { token: mfaInitialToken })).status, 401, "enabling MFA must revoke sessions issued before enrollment");
  const mfaStatusAfter = await request("/api/auth/mfa/status", { token: confirmed.data.token });
  assert.equal(mfaStatusAfter.data.enabled, true);
  assert.equal(mfaStatusAfter.data.recovery_codes_remaining, 10);
  const passwordStage = await request("/api/auth/login", {
    method: "POST", body: { username: "mfauser", password: mfaPassword }
  });
  assert.equal(passwordStage.status, 200);
  assert.equal(passwordStage.data.mfa_required, true, "password stage must not issue a full session when MFA is enabled");
  assert.equal(passwordStage.data.token, undefined);
  assert.equal((await request("/api/alerts", { token: passwordStage.data.challenge_token })).status, 401,
    "an MFA challenge token must never authenticate API requests before the second factor is verified");
  const invalidMfa = await request("/api/auth/mfa/challenge", {
    method: "POST", body: { challenge_token: passwordStage.data.challenge_token, code: "000000" }
  });
  assert.equal(invalidMfa.status, 401, "invalid second factors must not create a session");
  const completedMfa = await request("/api/auth/mfa/challenge", {
    method: "POST", body: { challenge_token: passwordStage.data.challenge_token, code: confirmed.data.recovery_codes[0] }
  });
  assert.equal(completedMfa.status, 200, "a valid one-time recovery code should complete login");
  assert.ok(completedMfa.data.token);
  const replayedChallenge = await request("/api/auth/mfa/challenge", {
    method: "POST", body: { challenge_token: passwordStage.data.challenge_token, code: confirmed.data.recovery_codes[0] }
  });
  assert.equal(replayedChallenge.status, 401, "a login challenge and recovery code must not be reusable");
  const totpLoginStart = await request("/api/auth/login", {
    method: "POST", body: { username: "mfauser", password: mfaPassword }
  });
  assert.equal(totpLoginStart.data.mfa_required, true);
  const untilNextStep = 30_000 - (Date.now() % 30_000) + 150;
  await new Promise(resolve => setTimeout(resolve, untilNextStep));
  const freshTotp = totpAt(enrollment.data.secret);
  const totpLoginComplete = await request("/api/auth/mfa/challenge", {
    method: "POST", body: { challenge_token: totpLoginStart.data.challenge_token, code: freshTotp }
  });
  assert.equal(totpLoginComplete.status, 200, "a fresh TOTP step should complete login");
  const secondTotpChallenge = await request("/api/auth/login", {
    method: "POST", body: { username: "mfauser", password: mfaPassword }
  });
  const replayedTotp = await request("/api/auth/mfa/challenge", {
    method: "POST", body: { challenge_token: secondTotpChallenge.data.challenge_token, code: freshTotp }
  });
  assert.equal(replayedTotp.status, 401, "a TOTP time step must not be reusable across separate login challenges");
  const rotatedCodes = await request("/api/auth/mfa/recovery-codes", {
    token: completedMfa.data.token, method: "POST",
    body: { password: mfaPassword, code: confirmed.data.recovery_codes[3] }
  });
  assert.equal(rotatedCodes.status, 200, "recovery codes should rotate after password and fresh TOTP verification");
  assert.equal(rotatedCodes.data.recovery_codes.length, 10);
  assert.equal(rotatedCodes.data.sessions_revoked, true);
  assert.ok(rotatedCodes.data.token);
  assert.equal((await request("/api/me", { token: completedMfa.data.token })).status, 401,
    "recovery-code rotation must revoke previous sessions");
  const rotatedStatus = await request("/api/auth/mfa/status", { token: rotatedCodes.data.token });
  assert.equal(rotatedStatus.data.recovery_codes_remaining, 10);
  const oldCodeLogin = await request("/api/auth/login", {
    method: "POST", body: { username: "mfauser", password: mfaPassword }
  });
  const oldRecoveryReplay = await request("/api/auth/mfa/challenge", {
    method: "POST", body: { challenge_token: oldCodeLogin.data.challenge_token, code: confirmed.data.recovery_codes[2] }
  });
  assert.equal(oldRecoveryReplay.status, 401, "all recovery codes from the previous set must be invalid after rotation");
  const disabledMfa = await request("/api/auth/mfa/disable", {
    token: rotatedCodes.data.token, method: "POST",
    body: { password: mfaPassword, code: rotatedCodes.data.recovery_codes[1] }
  });
  assert.equal(disabledMfa.status, 200, "MFA can be disabled only after password and second-factor verification");
  assert.equal(disabledMfa.data.sessions_revoked, true);
  assert.equal((await request("/api/me", { token: completedMfa.data.token })).status, 401,
    "disabling MFA must revoke the current and other sessions");
  const mfaDisabledLogin = await request("/api/auth/login", {
    method: "POST", body: { username: "mfauser", password: mfaPassword }
  });
  assert.equal(mfaDisabledLogin.status, 200);
  assert.ok(mfaDisabledLogin.data.token, "users who disable MFA should return to normal password login");
  assert.equal(mfaDisabledLogin.data.mfa_required, undefined);


  await createUser("forecaster1", "forecaster");
  await createUser("reviewer1", "reviewer");
  await createUser("publisher1", "publisher");
  await createUser("approver1", "approver");
  const disabledId = await createUser("disabled1", "viewer");
  const disabledOldSession = await login("disabled1", "Temporary-Password-2026!");
  const roleChangeId = await createUser("rolechange1", "viewer");
  const roleChangeOldSession = await login("rolechange1", "Temporary-Password-2026!");
  const roleChange = await request(`/api/users/${roleChangeId}/role`, {
    token: admin, method: "PATCH", body: { role: "publisher" }
  });
  assert.equal(roleChange.status, 200, "administrator should be able to change a user's role");
  assert.equal(roleChange.data.role, "publisher");
  assert.equal(roleChange.data.sessions_revoked, true, "role changes should revoke existing sessions");
  assert.equal((await request("/api/delivery/outbox", { token: roleChangeOldSession })).status, 401,
    "a session issued before a role change must be revoked");
  const roleChangeNewSession = await login("rolechange1", "Temporary-Password-2026!");
  const blockedPublisherAccess = await request("/api/delivery/outbox", { token: roleChangeNewSession });
  assert.equal(blockedPublisherAccess.status, 403, "publisher operations must be blocked until required MFA is enabled");
  assert.equal(blockedPublisherAccess.data.code, "MFA_REQUIRED");
  const publisherMfaStatus = await request("/api/auth/mfa/status", { token: roleChangeNewSession });
  assert.equal(publisherMfaStatus.data.required, true);
  const publisherEnrollment = await request("/api/auth/mfa/enroll", {
    token: roleChangeNewSession, method: "POST", body: { password: "Temporary-Password-2026!" }
  });
  assert.equal(publisherEnrollment.status, 200);
  const publisherMfaConfirmed = await request("/api/auth/mfa/confirm", {
    token: roleChangeNewSession, method: "POST", body: {
      password: "Temporary-Password-2026!", code: totpAt(publisherEnrollment.data.secret)
    }
  });
  assert.equal(publisherMfaConfirmed.status, 200);
  const publisherMfaToken = publisherMfaConfirmed.data.token;
  assert.equal((await request("/api/delivery/outbox", { token: publisherMfaToken })).status, 200,
    "publisher operations should be available after MFA enrollment is confirmed");
  const usersAfterLogin = await request("/api/users", { token: admin });
  assert.ok(usersAfterLogin.data.users.find(user => user.id === roleChangeId)?.last_login_at,
    "last-login timestamp should be refreshed after a new successful login");
  assert.equal((await request("/api/delivery/outbox", { token: publisherMfaToken })).status, 200,
    "the new role should take effect after required MFA enrollment");
  const unchangedRole = await request(`/api/users/${roleChangeId}/role`, {
    token: admin, method: "PATCH", body: { role: "publisher" }
  });
  assert.equal(unchangedRole.status, 200);
  assert.equal(unchangedRole.data.changed, false, "repeating the current role should be a no-op");
  assert.equal(unchangedRole.data.sessions_revoked, false, "a no-op role update must preserve sessions");
  assert.equal((await request("/api/delivery/outbox", { token: publisherMfaToken })).status, 200,
    "a no-op role update must leave the current MFA-protected session valid");
  assert.equal((await request("/api/users/999999/role", {
    token: admin, method: "PATCH", body: { role: "viewer" }
  })).status, 404, "unknown account ids must return not found");
  assert.equal((await request(`/api/users/${roleChangeId}/role`, {
    token: admin, method: "PATCH", body: {}
  })).status, 400, "missing role values must be rejected");
  assert.equal((await request("/api/users/not-a-number/role", {
    token: admin, method: "PATCH", body: { role: "viewer" }
  })).status, 400, "non-numeric user ids must be rejected");
  assert.equal((await request(`/api/users/${roleChangeId}/role`, {
    token: admin, method: "PATCH", body: { role: "unknown" }
  })).status, 400, "unknown roles must be rejected");
  assert.equal((await request("/api/users/1/role", {
    token: admin, method: "PATCH", body: { role: "viewer" }
  })).status, 409, "an administrator cannot change their own role");


  const forecaster = await login("forecaster1", "Temporary-Password-2026!");
  const reviewer = await login("reviewer1", "Temporary-Password-2026!");
  const publisherInitialSession = await login("publisher1", "Temporary-Password-2026!");
  const publisher = await enrollMfa(publisherInitialSession, "Temporary-Password-2026!");
  const publisherProfile = await request("/api/me", { token: publisher });
  assert.equal(publisherProfile.data.user.role, "publisher");
  assert.equal(publisherProfile.data.user.mfa_enabled, 1, "MFA confirmation should be reflected in authenticated role context");
  const approverInitialSession = await login("approver1", "Temporary-Password-2026!");
  const approver = await enrollMfa(approverInitialSession, "Temporary-Password-2026!");
  const viewer = disabledOldSession;
  for (const [roleName, token] of [["forecaster", forecaster], ["reviewer", reviewer], ["publisher", publisher], ["approver", approver], ["viewer", viewer]]) {
    assert.equal((await request("/api/users", { token })).status, 403,
      roleName + " must not list user accounts");
    assert.equal((await request("/api/users", {
      token, method: "POST",
      body: { username: roleName + "-unauthorized", role: "viewer", password: "Temporary-Password-2026!" }
    })).status, 403, roleName + " must not create user accounts");
    assert.equal((await request(`/api/users/${disabledId}/role`, {
      token, method: "PATCH", body: { role: "publisher" }
    })).status, 403, roleName + " must not change account roles");
    assert.equal((await request(`/api/users/${disabledId}/status`, {
      token, method: "PATCH", body: { active: false }
    })).status, 403, roleName + " must not activate or deactivate accounts");
  }

  assert.equal((await request("/api/webhooks/inbox", { token: forecaster })).status, 403,
    "forecasters must not inspect inbound webhook messages");
  const webhookInbox = await request("/api/webhooks/inbox?status=pending", { token: reviewer });
  assert.equal(webhookInbox.status, 200, "reviewers should inspect pending inbound webhook messages");
  assert.equal(webhookInbox.headers.get("cache-control"), "no-store",
    "restricted webhook payloads must not be stored by browsers or shared caches");
  assert.equal(webhookInbox.headers.get("pragma"), "no-cache",
    "restricted webhook inbox must carry a legacy no-cache directive");
  assert.ok(webhookInbox.data.messages.some(item => item.id === acceptedWebhookData.inbox_id));
  const inboxMessage = webhookInbox.data.messages.find(item => item.id === acceptedWebhookData.inbox_id);
  assert.equal(inboxMessage.payload.provider, "synthetic-test");
  const reviewedInboxMessage = await request(`/api/webhooks/inbox/${acceptedWebhookData.inbox_id}/review`, {
    token: reviewer, method: "PATCH", body: { status: "reviewed", note: "Synthetic integration test reviewed" }
  });
  assert.equal(reviewedInboxMessage.status, 200);
  assert.equal(reviewedInboxMessage.headers.get("cache-control"), "no-store",
    "restricted webhook review responses must not be cached");
  assert.equal(reviewedInboxMessage.headers.get("pragma"), "no-cache",
    "restricted webhook review responses must carry a legacy no-cache directive");
  assert.equal(reviewedInboxMessage.data.status, "reviewed");
  assert.equal(reviewedInboxMessage.data.reviewer_username, "reviewer1", "review response should identify the authenticated reviewer");
  const repeatedReview = await request(`/api/webhooks/inbox/${acceptedWebhookData.inbox_id}/review`, {
    token: reviewer, method: "PATCH", body: { status: "rejected" }
  });
  assert.equal(repeatedReview.status, 409, "reviewed webhook messages must not be silently reclassified");
  const secondWebhookBody = JSON.stringify({ provider: "synthetic-test", event: "second-inbound-test" });
  const secondWebhookSignature = createWebhookSignature(webhookSecret, webhookTimestamp, secondWebhookBody);
  const secondWebhookResponse = await sendWebhook(secondWebhookBody, webhookTimestamp, secondWebhookSignature);
  assert.equal(secondWebhookResponse.status, 202);
  const secondWebhookData = await secondWebhookResponse.json();
  const rejectedInboxMessage = await request(`/api/webhooks/inbox/${secondWebhookData.inbox_id}/review`, {
    token: reviewer, method: "PATCH", body: { status: "rejected", note: "Synthetic test rejection" }
  });
  assert.equal(rejectedInboxMessage.status, 200);
  assert.equal(rejectedInboxMessage.data.status, "rejected");

  const concurrentWebhookBody = JSON.stringify({ provider: "synthetic-test", event: "concurrent-review-test" });
  const concurrentWebhookSignature = createWebhookSignature(webhookSecret, webhookTimestamp, concurrentWebhookBody);
  const concurrentWebhookResponse = await sendWebhook(concurrentWebhookBody, webhookTimestamp, concurrentWebhookSignature);
  assert.equal(concurrentWebhookResponse.status, 202);
  const concurrentWebhookData = await concurrentWebhookResponse.json();
  const concurrentReviews = await Promise.all([
    request(`/api/webhooks/inbox/${concurrentWebhookData.inbox_id}/review`, {
      token: reviewer, method: "PATCH", body: { status: "reviewed", note: "First competing decision" }
    }),
    request(`/api/webhooks/inbox/${concurrentWebhookData.inbox_id}/review`, {
      token: admin, method: "PATCH", body: { status: "rejected", note: "Second competing decision" }
    })
  ]);
  assert.deepEqual(concurrentReviews.map(result => result.status).sort(), [200, 409],
    "only one competing reviewer decision may transition a pending webhook inbox item");
  const finalWebhookReview = await request("/api/webhooks/inbox?status=pending", { token: reviewer });
  assert.equal(finalWebhookReview.data.messages.some(item => item.id === concurrentWebhookData.inbox_id), false,
    "a concurrently reviewed webhook must no longer appear in the pending inbox");

  const alertAuditDb = new Database(path.join(cwd, "storage", "cap.sqlite"));
  try {
    alertAuditDb.exec(`CREATE TRIGGER fail_alert_create_audit BEFORE INSERT ON audit_log
      WHEN NEW.action='created' BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END;`);
  } finally {
    alertAuditDb.close();
  }
  const failedAuditedAlert = await request("/api/alerts", {
    token: forecaster, method: "POST",
    body: {
      event: "Audit rollback synthetic event", headline: "Audit rollback warning",
      description: "Synthetic test only", area_desc: "Synthetic test area",
      circle: "33.5,36.2 8", category: "Met", urgency: "Expected",
      severity: "Moderate", certainty: "Likely", status: "Test"
    }
  });
  assert.equal(failedAuditedAlert.status, 400);
  const verifyAlertRollback = new Database(path.join(cwd, "storage", "cap.sqlite"));
  try {
    assert.equal(verifyAlertRollback.prepare("SELECT COUNT(*) AS count FROM alerts WHERE headline=?")
      .get("Audit rollback warning").count, 0,
      "alert creation must roll back when its audit event cannot be stored");
    verifyAlertRollback.exec("DROP TRIGGER fail_alert_create_audit");
  } finally {
    verifyAlertRollback.close();
  }

  const invalidCapStatus = await request("/api/alerts", {
    token: forecaster, method: "POST",
    body: {
      event: "Invalid draft status", headline: "Invalid CAP status",
      description: "Draft is an internal workflow state, not a CAP status.",
      area_desc: "Synthetic test area", circle: "33.5,36.2 8",
      status: "Draft"
    }
  });
  assert.equal(invalidCapStatus.status, 400,
    "Draft must not be accepted as a CAP status value");

  assert.equal((await request("/api/users", { token: forecaster })).status, 403,
    "forecasters must not administer users");

  const createAndPublish = async (status, expires = "") => {
    const created = await request("/api/alerts", {
      token: forecaster, method: "POST",
      body: {
        event: "Integration test rainfall",
        headline: "Synthetic test warning",
        description: "Synthetic integration test data only",
        area_desc: "Synthetic test area",
        circle: "33.5,36.2 8",
        category: "Met",
        urgency: "Expected",
        severity: "Moderate",
        certainty: "Likely",
        status,
        expires,
        scope: "Public"
      }
    });
    assert.equal(created.status, 201, "forecaster should create a draft");
    const id = created.data.id;

    const filteredAlerts = await request("/api/alerts?q=Synthetic%20test%20warning&workflow=draft&limit=1&offset=0", { token: forecaster });
    assert.equal(filteredAlerts.status, 200, "alert list should support search, workflow filters and pagination");
    assert.equal(filteredAlerts.data.alerts.length, 1);
    assert.equal(filteredAlerts.data.alerts[0].id, id);
    assert.equal(filteredAlerts.data.pagination.limit, 1);
    assert.ok(filteredAlerts.data.pagination.total >= 1);
    assert.equal(filteredAlerts.data.pagination.has_more, filteredAlerts.data.pagination.total > 1);
    const initialVersions = await request(`/api/alerts/${id}/versions`, { token: reviewer });
    assert.equal(initialVersions.status, 200, "reviewers should access immutable alert versions");
    assert.equal(initialVersions.data.count, 1, "new alerts should start with a version-one snapshot");
    assert.equal(initialVersions.data.versions[0].version_no, 1);
    assert.equal((await request(`/api/alerts/${id}/versions`, { token: forecaster })).status, 403,
      "forecasters must not access reviewer version history");
    const draftEdit = await request(`/api/alerts/${id}`, {
      token: forecaster, method: "PATCH", body: { headline: "Synthetic warning revised", severity: "Severe" }
    });
    assert.equal(draftEdit.status, 200, "draft edits should create a new immutable version");
    const comparedVersions = await request(`/api/alerts/${id}/versions`, { token: reviewer });
    assert.equal(comparedVersions.data.count, 2);
    assert.equal(comparedVersions.data.versions[0].version_no, 2);
    assert.ok(comparedVersions.data.changed_fields.includes("headline"));
    assert.ok(comparedVersions.data.changed_fields.includes("severity"));
    assert.equal(comparedVersions.data.versions[1].snapshot.headline, "Synthetic test warning");
    assert.equal(comparedVersions.data.versions[0].snapshot.headline, "Synthetic warning revised");
    const versionDb = new Database(path.join(cwd, "storage", "cap.sqlite"));
    assert.throws(() => versionDb.prepare("UPDATE alert_versions SET snapshot_json='{}' WHERE id=?").run(comparedVersions.data.versions[0].id),
      /immutable/i, "stored alert snapshots must reject updates");
    assert.throws(() => versionDb.prepare("DELETE FROM alert_versions WHERE id=?").run(comparedVersions.data.versions[0].id),
      /immutable/i, "stored alert snapshots must reject deletion");
    versionDb.close();
    const alertStats = await request("/api/alerts/stats", { token: forecaster });
    assert.equal(alertStats.status, 200, "global alert statistics endpoint should be available to authenticated users");
    assert.ok(alertStats.data.stats.total >= 1);
    assert.ok(alertStats.data.stats.drafts >= 1, "draft count should include records beyond the current alert page");
    assert.equal(alertStats.data.stats.total, alertStats.data.stats.drafts + alertStats.data.stats.pending + alertStats.data.stats.approved + alertStats.data.stats.published + alertStats.data.stats.cancelled,
      "workflow totals should reconcile with the total alert count");
    assert.equal((await request("/api/alerts/stats")).status, 401, "global alert statistics must require authentication");
    assert.equal((await request("/api/alerts?workflow=invalid", { token: forecaster })).status, 400, "unknown workflow filters must be rejected");
    assert.equal((await request("/api/alerts?limit=501", { token: forecaster })).status, 400, "page sizes above the hard maximum must be rejected");

    assert.equal((await request(`/api/alerts/${id}/submit`, {
      token: reviewer, method: "POST", body: {}
    })).status, 403, "reviewers must not submit warnings for review");
    assert.equal((await request(`/api/alerts/${id}/submit`, {
      token: publisher, method: "POST", body: {}
    })).status, 403, "publishers must not submit warnings for review");
    assert.equal((await request(`/api/alerts/${id}/submit`, {
      token: viewer, method: "POST", body: {}
    })).status, 403, "viewers must not submit warnings for review");
    const concurrentSubmissions = await Promise.all([
      request(`/api/alerts/${id}/submit`, { token: forecaster, method: "POST", body: {} }),
      request(`/api/alerts/${id}/submit`, { token: forecaster, method: "POST", body: {} })
    ]);
    assert.deepEqual(concurrentSubmissions.map(result => result.status).sort(), [200, 409],
      "concurrent submission attempts must produce exactly one successful transition");
    const reviewQueue = await request("/api/review/queue?limit=20", { token: reviewer });
    assert.equal(reviewQueue.status, 200, "reviewers should access the dedicated review queue");
    const queuedAlert = reviewQueue.data.queue.find(item => item.id === id);
    assert.ok(queuedAlert, "submitted alert should appear in the review queue");
    assert.equal(queuedAlert.creator, "forecaster1");
    assert.ok(Number.isInteger(queuedAlert.waiting_seconds));
    const savedReviewNote = await request(`/api/alerts/${id}/review-notes`, {
      token: reviewer, method: "POST", body: { note: "Verify the affected area boundaries before approval." }
    });
    assert.equal(savedReviewNote.status, 201, "reviewers should be able to record an auditable note");
    assert.equal((await request(`/api/alerts/${id}/review-notes`, {
      token: reviewer, method: "POST", body: { note: "no" }
    })).status, 400, "review notes shorter than five characters must be rejected");
    assert.equal((await request(`/api/alerts/${id}/review-notes`, {
      token: forecaster, method: "POST", body: { note: "Please review this warning" }
    })).status, 403, "forecasters cannot record reviewer notes");
    const reviewHistory = await request(`/api/alerts/${id}/review-history`, { token: reviewer });
    assert.equal(reviewHistory.status, 200);
    assert.ok(reviewHistory.data.entries.some(entry =>
      entry.action === "review_note_added" && entry.details === "Verify the affected area boundaries before approval."
    ), "review history should include the saved note");
    const timeline = await request(`/api/alerts/${id}/timeline`, { token: reviewer });
    assert.equal(timeline.status, 200, "reviewers should access the unified alert timeline");
    assert.ok(timeline.data.timeline.some(item => item.source === "version" && item.version_no === 1),
      "timeline should include immutable content snapshots");
    assert.ok(timeline.data.timeline.some(item => item.source === "audit" && item.event_type === "submitted"),
      "timeline should include workflow transitions");
    assert.ok(timeline.data.timeline.some(item => item.event_type === "review_note_added" &&
      item.details === "Verify the affected area boundaries before approval."),
      "timeline should include review notes");
    assert.equal(timeline.data.truncated, false, "small timelines should not be marked as truncated");
    assert.ok(timeline.data.timeline.filter(item => item.event_type === "created")
      .every(item => item.details === ""), "unapproved audit details must not be exposed in the timeline");
    assert.deepEqual(timeline.data.timeline.map(item => item.created_at),
      [...timeline.data.timeline].map(item => item.created_at).sort(),
      "timeline events should be returned in chronological order");
    assert.equal((await request(`/api/alerts/${id}/timeline`, { token: forecaster })).status, 403,
      "forecasters must not access the reviewer timeline");
    assert.equal((await request(`/api/alerts/${id}/timeline`, { token: admin })).status, 200,
      "administrators should access the unified timeline");
    assert.equal((await request(`/api/alerts/${id}/timeline`)).status, 401,
      "the unified timeline must require authentication");
    assert.equal((await request("/api/alerts/not-a-number/timeline", { token: reviewer })).status, 400,
      "timeline must reject malformed alert ids");
    assert.equal((await request("/api/alerts/999999/timeline", { token: reviewer })).status, 404,
      "timeline must reject unknown alerts");
    assert.equal((await request("/api/review/queue", { token: forecaster })).status, 403,
      "forecasters must not access the reviewer queue");
    assert.equal((await request("/api/review/queue?limit=201", { token: reviewer })).status, 400,
      "review queue must enforce its hard page limit");
    assert.equal((await request(`/api/alerts/${id}/approve`, {
      token: forecaster, method: "POST", body: {}
    })).status, 403, "creator cannot approve their own warning");
    assert.equal((await request(`/api/alerts/${id}/approve`, {
      token: publisher, method: "POST", body: {}
    })).status, 403, "publishers must not approve warnings");
    assert.equal((await request(`/api/alerts/${id}/approve`, {
      token: viewer, method: "POST", body: {}
    })).status, 403, "viewers must not approve warnings");
    assert.equal((await request(`/api/alerts/${id}/return`, { token: forecaster, method: "POST", body: { reason: "Needs correction" } })).status, 403,
      "the creator cannot return their own pending warning");
    assert.equal((await request(`/api/alerts/${id}/return`, { token: reviewer, method: "POST", body: { reason: "no" } })).status, 400,
      "review feedback must include a meaningful reason");
    const returned = await request(`/api/alerts/${id}/return`, { token: reviewer, method: "POST", body: { reason: "Please clarify the affected area and expected timing." } });
    assert.equal(returned.status, 200, "reviewer should be able to return a pending warning to its author");
    assert.equal(returned.data.workflow, "draft");
    assert.equal((await request(`/api/alerts/${id}`, { token: forecaster, method: "PATCH", body: { headline: "x" } })).status, 400,
      "draft edits must still satisfy CAP headline validation");
    const correctedDraft = await request(`/api/alerts/${id}`, { token: forecaster, method: "PATCH", body: {
      event: "Updated integration weather event",
      category: "Met",
      urgency: "Expected",
      severity: "Moderate",
      certainty: "Likely",
      scope: "Public",
      status,
      effective: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      response_type: "Shelter",
      headline: "Corrected integration warning headline",
      description: "Updated description after reviewer feedback.",
      instruction: "Follow official updates and avoid exposed areas.",
      area_desc: "Northern test district",
      polygon: "",
      circle: "",
      onset: expires
        ? new Date(Date.parse(expires) - 2 * 60 * 60 * 1000).toISOString()
        : new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      expires: expires || new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
      language: "ar",
      info_blocks: [{
        language: "ar",
        category: "Met",
        event: "أمطار غزيرة تجريبية",
        urgency: "Expected",
        severity: "Moderate",
        certainty: "Likely",
        headline: "تحذير تجريبي محدث",
        description: "تفاصيل محدثة للاختبار.",
        instruction: "تابع التحديثات الرسمية.",
        area: { areaDesc: "القطاع الشمالي التجريبي", circle: "33.5,36.2 10" }
      }]
    } });
    assert.equal(correctedDraft.status, 200, "the original author should be able to correct all editable CAP draft fields");
    assert.deepEqual(correctedDraft.data.updated_fields.sort(), ["area_desc","category","certainty","circle","description","effective","event","expires","headline","info_json","instruction","language","onset","polygon","response_type","scope","severity","status","urgency"]);
    const correctedReadback = await request(`/api/alerts/${id}`, { token: forecaster });
    assert.equal(correctedReadback.data.alert.event, "Updated integration weather event");
    assert.equal(correctedReadback.data.alert.area_desc, "Northern test district");
    assert.equal(correctedReadback.data.alert.response_type, "Shelter");
    assert.equal(correctedReadback.data.alert.status, status,
      "draft correction must preserve the fixture CAP status requested by the test");
    assert.ok(correctedReadback.data.alert.effective);
    assert.equal(correctedReadback.data.alert.info_blocks[0].headline, "تحذير تجريبي محدث");
    assert.equal(correctedReadback.data.alert.info_blocks[0].area.circle, "33.5,36.2 10");
    assert.equal((await request(`/api/alerts/${id}`, { token: reviewer, method: "PATCH", body: { headline: "Unauthorized reviewer edit" } })).status, 403,
      "reviewers cannot edit another users draft");
    assert.equal((await request(`/api/alerts/${id}/submit`, { token: forecaster, method: "POST", body: {} })).status, 200,
      "the author should be able to resubmit the corrected draft");
    const concurrentApprovals = await Promise.all([
      request(`/api/alerts/${id}/approve`, { token: reviewer, method: "POST", body: {} }),
      request(`/api/alerts/${id}/approve`, { token: reviewer, method: "POST", body: {} })
    ]);
    assert.deepEqual(concurrentApprovals.map(result => result.status).sort(), [200, 409],
      "concurrent approval attempts must produce exactly one successful transition");
    assert.equal((await request(`/api/alerts/${id}/publish`, {
      token: reviewer, method: "POST", body: {}
    })).status, 403, "approver cannot publish the same warning");
    const concurrentPublications = await Promise.all([
      request(`/api/alerts/${id}/publish`, { token: publisher, method: "POST", body: {} }),
      request(`/api/alerts/${id}/publish`, { token: publisher, method: "POST", body: {} })
    ]);
    assert.deepEqual(concurrentPublications.map(result => result.status).sort(), [200, 409],
      "concurrent publication attempts must produce exactly one successful transition");
    const outboxAfterPublish = await request("/api/delivery/outbox", { token: publisher });
    assert.equal(outboxAfterPublish.status, 200);
    assert.equal(outboxAfterPublish.data.deliveries.filter(item => item.alert_id === id && item.channel === "cap_feed").length, 1,
      "publishing the same warning twice must not create duplicate outbox entries");
    return created.data.identifier;
  };

  const separationDraft = await request("/api/alerts", {
    token: forecaster, method: "POST",
    body: {
      event: "Independent publisher test",
      headline: "Synthetic separation-of-duties warning",
      description: "Synthetic test data only",
      area_desc: "Synthetic test area",
      circle: "33.5,36.2 8",
      category: "Met",
      urgency: "Expected",
      severity: "Moderate",
      certainty: "Likely",
      status: "Test",
      scope: "Public"
    }
  });
  assert.equal(separationDraft.status, 201);
  assert.equal((await request(`/api/alerts/${separationDraft.data.id}/submit`, {
    token: forecaster, method: "POST", body: {}
  })).status, 200);
  assert.equal((await request(`/api/alerts/${separationDraft.data.id}/approve`, {
    token: admin, method: "POST", body: {}
  })).status, 200, "an administrator may independently approve a submitted warning");
  assert.equal((await request(`/api/alerts/${separationDraft.data.id}/publish`, {
    token: admin, method: "POST", body: {}
  })).status, 403, "the same administrator who approved a warning must not publish it");
  const independentPublisherResult = await request(`/api/alerts/${separationDraft.data.id}/publish`, {
    token: publisher, method: "POST", body: {}
  });
  assert.equal(independentPublisherResult.status, 200, "a different publisher should be able to publish after the approving administrator is blocked: " + JSON.stringify(independentPublisherResult.data));

  const actualIdentifier = await createAndPublish("Actual");
  const original = await request("/api/alerts", { token: forecaster });
  assert.equal(original.status, 200, "authenticated alert history should be available");
  const actualRow = original.data.alerts.find(alert => alert.identifier === actualIdentifier);
  assert.ok(actualRow, "published warning should remain in authenticated history");
  const initialRelations = await request(`/api/alerts/${actualRow.id}/relations`, { token: forecaster });
  assert.equal(initialRelations.status, 200, "authenticated users should be able to inspect a CAP message relationship chain");
  assert.equal(initialRelations.data.count, 1, "a standalone CAP alert should initially have a one-message chain");
  assert.equal(initialRelations.data.messages[0].identifier, actualIdentifier);
  assert.equal((await request("/api/alerts/999999/relations", { token: forecaster })).status, 404,
    "relationship history should return not found for an unknown alert");
  assert.equal((await request(`/api/alerts/${actualRow.id}/relations`)).status, 401,
    "relationship history must require authentication");

  const unreviewedDraft = await request("/api/alerts", {
    token: forecaster, method: "POST",
    body: {
      event: "Integration test draft",
      headline: "Unreviewed synthetic warning",
      description: "Synthetic test data only",
      area_desc: "Synthetic test area",
      circle: "33.5,36.2 8",
      category: "Met",
      urgency: "Expected",
      severity: "Moderate",
      certainty: "Likely",
      status: "Test",
      scope: "Public"
    }
  });
  assert.equal(unreviewedDraft.status, 201);
  assert.equal((await request(`/api/alerts/${unreviewedDraft.data.id}/derive`, {
    token: forecaster, method: "POST", body: { msg_type: "Update" }
  })).status, 409, "draft alerts must not be used as sources for Update or Cancel messages");

  assert.equal((await request(`/api/alerts/${unreviewedDraft.data.id}/submit`, {
    token: forecaster, method: "POST", body: {}
  })).status, 200);
  assert.equal((await request(`/api/alerts/${unreviewedDraft.data.id}/derive`, {
    token: forecaster, method: "POST", body: { msg_type: "Cancel" }
  })).status, 409, "pending alerts must not be used as sources for Update or Cancel messages");

  assert.equal((await request(`/api/alerts/${actualRow.id}/derive`, {
    token: forecaster, method: "POST", body: { msg_type: "Alert" }
  })).status, 400, "derive endpoint must reject message types other than Update and Cancel");
  assert.equal((await request(`/api/alerts/${actualRow.id}/derive`, {
    token: viewer, method: "POST", body: { msg_type: "Update" }
  })).status, 403, "viewer accounts must not derive CAP messages");

  assert.equal((await request("/api/delivery/outbox", { token: forecaster })).status, 403,
    "forecasters must not access the delivery outbox");
  const outbox = await request("/api/delivery/outbox", { token: publisher });
  assert.equal(outbox.status, 200);
  assert.equal(outbox.data.external_adapters_enabled, false, "external delivery must remain disabled without a real adapter");
  const queuedDelivery = outbox.data.deliveries.find(item => item.alert_id === actualRow.id && item.channel === "cap_feed");
  assert.ok(queuedDelivery, "publishing must atomically enqueue an internal CAP feed delivery");
  assert.equal(queuedDelivery.status, "queued");
  const claimedDelivery = await request(`/api/delivery/outbox/${queuedDelivery.id}/claim`, {
    token: publisher, method: "POST", body: {}
  });
  assert.equal(claimedDelivery.status, 200);
  assert.equal(claimedDelivery.headers.get("cache-control"), "no-store",
    "delivery lease credentials must not be cached");
  assert.equal(claimedDelivery.headers.get("pragma"), "no-cache",
    "delivery lease responses must carry a legacy no-cache directive");
  assert.equal(claimedDelivery.data.delivery.status, "sending");
  assert.equal(claimedDelivery.data.external_adapters_enabled, false);
  assert.match(claimedDelivery.data.delivery.payload, /<alert xmlns=/);
  const missingLeaseReceipt = await request(`/api/delivery/outbox/${queuedDelivery.id}/receipt`, {
    token: publisher, method: "POST", body: { status: "failed", details: "Missing lease token" }
  });
  assert.equal(missingLeaseReceipt.status, 400, "receipt API must require a lease token");
  const malformedLeaseReceipt = await request(`/api/delivery/outbox/${queuedDelivery.id}/receipt`, {
    token: publisher, method: "POST", body: { status: "failed", leaseToken: "not-a-uuid" }
  });
  assert.equal(malformedLeaseReceipt.status, 400, "receipt API must reject malformed lease tokens");
  const wrongLeaseReceipt = await request(`/api/delivery/outbox/${queuedDelivery.id}/receipt`, {
    token: publisher, method: "POST", body: { status: "failed", leaseToken: "00000000-0000-4000-8000-000000000000" }
  });
  assert.equal(wrongLeaseReceipt.status, 409, "receipt API must reject a well-formed but unowned lease token");
  const invalidReceiptStatus = await request(`/api/delivery/outbox/${queuedDelivery.id}/receipt`, {
    token: publisher, method: "POST", body: { status: "accepted", leaseToken: claimedDelivery.data.delivery.lease_token }
  });
  assert.equal(invalidReceiptStatus.status, 400, "receipt API must accept only delivered or failed outcomes");
  const failedReceipt = await request(`/api/delivery/outbox/${queuedDelivery.id}/receipt`, {
    token: publisher, method: "POST", body: { status: "failed", leaseToken: claimedDelivery.data.delivery.lease_token, details: "Synthetic test failure" }
  });
  assert.equal(failedReceipt.status, 200);
  assert.equal(failedReceipt.data.delivery.status, "failed");
  assert.equal((await request(`/api/delivery/outbox/${queuedDelivery.id}/retry`, {
    token: publisher, method: "POST", body: {}
  })).status, 200);
  const retryClaim = await request(`/api/delivery/outbox/${queuedDelivery.id}/claim`, {
    token: publisher, method: "POST", body: {}
  });
  assert.equal(retryClaim.status, 200);
  assert.equal(retryClaim.data.delivery.attempts, 2);
  const staleReceipt = await request(`/api/delivery/outbox/${queuedDelivery.id}/receipt`, {
    token: publisher, method: "POST", body: { status: "delivered", leaseToken: claimedDelivery.data.delivery.lease_token }
  });
  assert.equal(staleReceipt.status, 409, "a receipt from an earlier claim must not affect a later delivery attempt");
  const deliveredReceipt = await request(`/api/delivery/outbox/${queuedDelivery.id}/receipt`, {
    token: publisher, method: "POST", body: { status: "delivered", leaseToken: retryClaim.data.delivery.lease_token, externalId: "synthetic-provider-id" }
  });
  assert.equal(deliveredReceipt.status, 200);
  assert.equal(deliveredReceipt.data.delivery.status, "delivered");
  const duplicateDeliveredReceipt = await request(`/api/delivery/outbox/${queuedDelivery.id}/receipt`, {
    token: publisher, method: "POST", body: { status: "delivered", leaseToken: retryClaim.data.delivery.lease_token }
  });
  assert.equal(duplicateDeliveredReceipt.status, 409,
    "a duplicate receipt must not rewrite a delivery after its lease has been consumed");

  const inboxDatabase = new Database(path.join(cwd, "storage", "cap.sqlite"));
  try {
    const inboxRow = inboxDatabase.prepare("SELECT source_timestamp,payload_json,status,reviewed_by FROM webhook_inbox WHERE id=?").get(acceptedWebhookData.inbox_id);
    assert.ok(inboxRow, "accepted webhook should be persisted in the inbox");
    assert.equal(inboxRow.source_timestamp, webhookTimestamp);
    assert.equal(inboxRow.status, "reviewed", "review decision should be persisted after reviewer action");
    assert.equal(inboxRow.reviewed_by, (await inboxDatabase.prepare("SELECT id FROM users WHERE username=?").get("reviewer1")).id,
      "reviewer identity should be persisted with the inbox decision");
    assert.equal(JSON.parse(inboxRow.payload_json).provider, "synthetic-test");
    assert.equal(inboxDatabase.prepare("SELECT COUNT(*) AS count FROM webhook_inbox").get().count, 3,
      "only the three valid unique webhooks should enter the inbox");
  } finally {
    inboxDatabase.close();
  }

  assert.equal((await request("/api/webhooks/inbox?before_id=0", { token: reviewer })).status, 400,
    "zero is not a valid inbox cursor");
  assert.equal((await request("/api/webhooks/inbox?before_id=1.5", { token: reviewer })).status, 400,
    "fractional inbox cursors must be rejected");
  const paginationDatabase = new Database(path.join(cwd, "storage", "cap.sqlite"));
  try {
    const addInboxRow = paginationDatabase.prepare(
      "INSERT INTO webhook_inbox (source_timestamp,signature_hash,payload_json,status) VALUES (?,?,?,'pending')"
    );
    const addPageRows = paginationDatabase.transaction(() => {
      for (let index = 0; index < 101; index++) {
        addInboxRow.run(webhookTimestamp, "pagination-test-" + index, JSON.stringify({ page_test: index }));
      }
    });
    addPageRows();
  } finally {
    paginationDatabase.close();
  }
  const firstInboxPage = await request("/api/webhooks/inbox?status=pending", { token: reviewer });
  assert.equal(firstInboxPage.status, 200);
  assert.equal(firstInboxPage.data.messages.length, 100);
  assert.equal(firstInboxPage.data.has_more, true);
  assert.ok(Number.isSafeInteger(firstInboxPage.data.next_before_id));
  const secondInboxPage = await request(
    "/api/webhooks/inbox?status=pending&before_id=" + firstInboxPage.data.next_before_id,
    { token: reviewer }
  );
  assert.equal(secondInboxPage.status, 200);
  assert.equal(secondInboxPage.data.messages.length, 1);
  assert.equal(secondInboxPage.data.has_more, false);
  assert.equal(secondInboxPage.data.next_before_id, null);
  assert.ok(secondInboxPage.data.messages[0].id < firstInboxPage.data.messages.at(-1).id,
    "cursor pagination must return only older inbox rows");

  const atomicityDatabase = new Database(path.join(cwd, "storage", "cap.sqlite"));
  let auditFailureDeliveryId;
  let pendingInboxId;
  try {
    const queued = atomicityDatabase.prepare(
      "INSERT INTO delivery_outbox (alert_id,channel,payload,status,max_attempts) VALUES (?,?,?,'queued',3)"
    ).run(actualRow.id, "webhook", "<synthetic-atomicity-test/>");
    auditFailureDeliveryId = Number(queued.lastInsertRowid);
    pendingInboxId = firstInboxPage.data.messages[0].id;
    atomicityDatabase.exec(`
      CREATE TRIGGER fail_delivery_claim_audit
      BEFORE INSERT ON audit_log WHEN NEW.action='delivery_claimed'
      BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END;
      CREATE TRIGGER fail_webhook_review_audit
      BEFORE INSERT ON audit_log WHEN NEW.action='webhook_inbox_reviewed'
      BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END;
    `);
  } finally {
    atomicityDatabase.close();
  }
  const failedAuditedClaim = await request(`/api/delivery/outbox/${auditFailureDeliveryId}/claim`, {
    token: publisher, method: "POST", body: {}
  });
  assert.equal(failedAuditedClaim.status, 500,
    "a failed audit append must fail the claim operation");
  const failedAuditedReview = await request(`/api/webhooks/inbox/${pendingInboxId}/review`, {
    token: reviewer, method: "PATCH", body: { status: "reviewed", note: "synthetic rollback test" }
  });
  assert.equal(failedAuditedReview.status, 500,
    "a failed audit append must fail the inbox review operation without exposing database details");
  const verifyAtomicRollback = new Database(path.join(cwd, "storage", "cap.sqlite"));
  try {
    assert.equal(verifyAtomicRollback.prepare("SELECT status,attempts FROM delivery_outbox WHERE id=?")
      .get(auditFailureDeliveryId).status, "queued",
      "delivery claim must roll back when its audit event cannot be recorded");
    assert.equal(verifyAtomicRollback.prepare("SELECT attempts FROM delivery_outbox WHERE id=?")
      .get(auditFailureDeliveryId).attempts, 0,
      "failed audited claim must not consume an attempt");
    assert.equal(verifyAtomicRollback.prepare("SELECT status FROM webhook_inbox WHERE id=?")
      .get(pendingInboxId).status, "pending",
      "webhook review must roll back when its audit event cannot be recorded");
    verifyAtomicRollback.exec("DROP TRIGGER fail_delivery_claim_audit; DROP TRIGGER fail_webhook_review_audit;");
  } finally {
    verifyAtomicRollback.close();
  }

  const directDatabase = new Database(path.join(cwd, "storage", "cap.sqlite"));
  try {
    assert.throws(() => directDatabase.prepare("UPDATE delivery_outbox SET lease_token='00000000-0000-4000-8000-000000000000' WHERE alert_id=?").run(actualRow.id),
      /Plaintext delivery lease tokens are forbidden/, "database triggers must prevent plaintext lease-token storage");
    assert.throws(() => directDatabase.prepare("UPDATE alerts SET status='Draft' WHERE id=?").run(actualRow.id),
      /Invalid CAP 1.2 status/, "database triggers must reject non-standard CAP status values");
    directDatabase.prepare("UPDATE delivery_outbox SET status='sending',last_attempt_at=datetime('now','-30 minutes') WHERE alert_id=? AND channel='cap_feed'").run(actualRow.id);
  } finally {
    directDatabase.close();
  }
  const recovery = await request("/api/delivery/recover-stale", {
    token: publisher, method: "POST", body: { staleMinutes: 10 }
  });
  assert.equal(recovery.status, 200);
  assert.equal(recovery.data.recovered_count, 1, "stale sending jobs should be recovered to queued");
  const deadLetterDatabase = new Database(path.join(cwd, "storage", "cap.sqlite"));
  try {
    deadLetterDatabase.prepare("UPDATE delivery_outbox SET status='sending',attempts=max_attempts,dead_letter_at=NULL,last_attempt_at=datetime('now','-30 minutes'),next_attempt_at=NULL WHERE alert_id=? AND channel='cap_feed'").run(actualRow.id);
  } finally {
    deadLetterDatabase.close();
  }
  const exhaustedLease = await request("/api/delivery/recover-stale", {
    token: publisher, method: "POST", body: { staleMinutes: 10 }
  });
  assert.equal(exhaustedLease.status, 200);
  assert.equal(exhaustedLease.data.recovered_count, 0);
  assert.equal(exhaustedLease.data.dead_lettered_count, 1,
    "stale leases at their maximum attempt count must be dead-lettered, not counted as recovered");

  assert.equal((await request("/api/delivery/process-retries", {
    token: forecaster, method: "POST", body: {}
  })).status, 403, "forecasters must not process delivery retries");
  const processedRetries = await request("/api/delivery/process-retries", {
    token: publisher, method: "POST", body: {}
  });
  assert.equal(processedRetries.status, 200, "publishers may process due internal retries");
  assert.equal(processedRetries.data.ok, true);
  const deadLetterRow = await request("/api/delivery/outbox?status=dead_letter", { token: publisher });
  assert.equal(deadLetterRow.status, 200);
  assert.ok(Array.isArray(deadLetterRow.data.deliveries));
  assert.ok(deadLetterRow.data.deliveries.some(item => item.alert_id === actualRow.id),
    "dead-letter filter should expose exhausted entries without leaking them into other status filters");
  assert.ok(deadLetterRow.data.counts && Number.isInteger(deadLetterRow.data.counts.dead_letter),
    "outbox API should expose database-wide status counts");
  assert.ok(deadLetterRow.data.counts.dead_letter >= 1,
    "database-wide dead-letter count should include exhausted stale leases");
  const allOutbox = await request("/api/delivery/outbox", { token: publisher });
  assert.equal(allOutbox.status, 200);
  assert.ok(Number.isInteger(allOutbox.data.counts.delivered),
    "outbox summary should include delivered receipts separately");

  assert.equal((await request("/api/delivery/recover-stale", {
    token: forecaster, method: "POST", body: { staleMinutes: 10 }
  })).status, 403, "forecasters must not run delivery recovery");

  const unauthenticatedCapXml = await fetch(base + "/api/alerts/" + actualRow.id + "/cap.xml");
  assert.equal(unauthenticatedCapXml.status, 401,
    "CAP XML exports must not disclose alert details without authentication");

  const capXml = await fetch(base + "/api/alerts/" + actualRow.id + "/cap.xml", {
    headers: { Authorization: "Bearer " + forecaster }
  });
  assert.equal(capXml.status, 200, "authorized CAP XML export should succeed");
  assert.ok((capXml.headers.get("content-type") || "").includes("application/xml"));
  assert.equal(capXml.headers.get("cache-control"), "no-store",
    "authenticated CAP XML exports must not be cacheable");
  assert.match(await capXml.text(), /<alert xmlns=/);

  const restrictedMissing = await request("/api/alerts", {
    token: forecaster, method: "POST", body: {
      event: "Restricted storm", headline: "Internal storm advisory",
      description: "Restricted distribution only", area_desc: "Ops zone",
      circle: "33.5,36.2 10", scope: "Restricted", status: "Test"
    }
  });
  assert.equal(restrictedMissing.status, 400,
    "Restricted scope without restriction text must be rejected");
  assert.match(restrictedMissing.data.error || "", /restriction/i);

  const privateMissing = await request("/api/alerts", {
    token: forecaster, method: "POST", body: {
      event: "Private storm", headline: "Private storm advisory",
      description: "Private recipients only", area_desc: "Duty desk",
      circle: "33.5,36.2 10", scope: "Private", status: "Test"
    }
  });
  assert.equal(privateMissing.status, 400,
    "Private scope without addresses must be rejected");
  assert.match(privateMissing.data.error || "", /addresses/i);

  const restrictedOk = await request("/api/alerts", {
    token: forecaster, method: "POST", body: {
      event: "Restricted storm", headline: "Internal storm advisory",
      description: "Restricted distribution only", area_desc: "Ops zone",
      circle: "33.5,36.2 10", scope: "Restricted",
      restriction: "Internal distribution to authorized agencies only", status: "Test"
    }
  });
  assert.equal(restrictedOk.status, 201, "Restricted scope with restriction text must be accepted");

  const privateOk = await request("/api/alerts", {
    token: forecaster, method: "POST", body: {
      event: "Private storm", headline: "Private storm advisory",
      description: "Private recipients only", area_desc: "Duty desk",
      circle: "33.5,36.2 10", scope: "Private",
      addresses: "ops@example.test duty@example.test", status: "Test"
    }
  });
  assert.equal(privateOk.status, 201, "Private scope with addresses must be accepted");

  const restrictedPublicFeed = await request("/api/public/alerts");
  assert.equal(restrictedPublicFeed.status, 200);
  assert.ok(!(restrictedPublicFeed.data.alerts || []).some(alert =>
    alert.identifier === restrictedOk.data.identifier ||
    alert.identifier === privateOk.data.identifier
  ), "Restricted and Private drafts must never appear on the public feed");

  const scopeFiltered = await request("/api/alerts?scope=Restricted&workflow=draft", { token: forecaster });
  assert.equal(scopeFiltered.status, 200, "alert list should accept a CAP scope filter");
  assert.ok((scopeFiltered.data.alerts || []).length >= 1, "Restricted draft filter should return at least one alert");
  assert.ok((scopeFiltered.data.alerts || []).every(alert => alert.scope === "Restricted"),
    "scope=Restricted filter must return only Restricted alerts");
  assert.ok((scopeFiltered.data.alerts || []).some(alert => alert.id === restrictedOk.data.id),
    "Restricted filter should include the newly created Restricted draft");

  const invalidScopeFilter = await request("/api/alerts?scope=Worldwide", { token: forecaster });
  assert.equal(invalidScopeFilter.status, 400, "invalid CAP scope filter values must be rejected");

  const restrictedPatchDenied = await request(`/api/alerts/${restrictedOk.data.id}`, {
    token: forecaster, method: "PATCH", body: { scope: "Private" }
  });
  assert.equal(restrictedPatchDenied.status, 400,
    "changing a draft to Private without addresses must be rejected");
  assert.match(restrictedPatchDenied.data.error || "", /addresses/i);

  const privatePatchOk = await request(`/api/alerts/${privateOk.data.id}`, {
    token: forecaster, method: "PATCH",
    body: { addresses: "ops@example.test duty@example.test night@example.test", headline: "Private advisory revised" }
  });
  assert.equal(privatePatchOk.status, 200, "Private draft address updates should succeed");

  let publishedUpdate = null;
  for (const msg_type of ["Update", "Cancel"]) {
    let derived;
    if (msg_type === "Cancel") {
      const concurrentCancels = await Promise.all([
        request(`/api/alerts/${actualRow.id}/derive`, {
          token: forecaster, method: "POST", body: { msg_type }
        }),
        request(`/api/alerts/${actualRow.id}/derive`, {
          token: forecaster, method: "POST", body: { msg_type }
        })
      ]);
      assert.deepEqual(concurrentCancels.map(result => result.status).sort(), [201, 409],
        "concurrent cancellation attempts for the same CAP message must create exactly one cancellation");
      derived = concurrentCancels.find(result => result.status === 201);
      const duplicateCancel = concurrentCancels.find(result => result.status === 409);
      assert.match(duplicateCancel.data.error, /cancellation.*already exists/i);
    } else {
      derived = await request(`/api/alerts/${actualRow.id}/derive`, {
        token: forecaster, method: "POST", body: { msg_type }
      });
    }
    assert.equal(derived.status, 201, msg_type + " should create a new draft");
    assert.notEqual(derived.data.identifier, actualIdentifier,
      "each derived CAP message must receive its own unique identifier");
    assert.equal(derived.data.status, "Test", "derived messages must remain in Test status");
    assert.equal(derived.data.workflow, "draft");
    assert.ok(derived.data.references.includes(actualIdentifier),
      msg_type + " must reference the original CAP identifier");
    assert.ok(Number.isSafeInteger(derived.data.id), msg_type + " draft should expose its database id");

    assert.equal((await request(`/api/alerts/${derived.data.id}/submit`, {
      token: forecaster, method: "POST", body: {}
    })).status, 200, msg_type + " should enter the review workflow");
    assert.equal((await request(`/api/alerts/${derived.data.id}/approve`, {
      token: reviewer, method: "POST", body: {}
    })).status, 200, msg_type + " should be independently approved");
    const publishedDerived = await request(`/api/alerts/${derived.data.id}/publish`, {
      token: publisher, method: "POST", body: {}
    });
    assert.equal(publishedDerived.status, 200, msg_type + " should be internally published after approval");
    assert.equal(publishedDerived.data.workflow, "published");
    if (msg_type === "Update") publishedUpdate = { id: derived.data.id, identifier: derived.data.identifier };
    const derivedTimeline = await request(`/api/alerts/${derived.data.id}/timeline`, { token: reviewer });
    assert.equal(derivedTimeline.status, 200);
    assert.ok(derivedTimeline.data.timeline.some(item => item.source === "version" && item.version_no === 1),
      msg_type + " timeline should retain its initial immutable snapshot");
    assert.ok(derivedTimeline.data.timeline.some(item => item.event_type === msg_type.toLowerCase()),
      msg_type + " timeline should identify the derived message type");
    assert.ok(derivedTimeline.data.timeline.some(item => item.event_type === "published"),
      msg_type + " timeline should include publication");
    const relationHistory = await request(`/api/alerts/${actualRow.id}/relations`, { token: forecaster });
    assert.equal(relationHistory.status, 200);
    assert.ok(relationHistory.data.messages.some(message => message.id === derived.data.id),
      msg_type + " should appear in the source alert relationship history");
    assert.ok(relationHistory.data.messages.some(message => message.identifier === actualIdentifier),
      "relationship history should retain the original CAP message");
    assert.ok(relationHistory.data.relations.some(edge =>
      edge.from_id === actualRow.id && edge.to_id === derived.data.id && edge.msg_type === msg_type
    ), msg_type + " relationship history should expose a validated parent-to-derived-message edge");
    assert.equal(relationHistory.data.relation_count, relationHistory.data.relations.length,
      "relationship edge count should match the returned edge list");
    const derivedRelations = await request(`/api/alerts/${derived.data.id}/relations`, { token: forecaster });
    assert.equal(derivedRelations.status, 200);
    assert.ok(derivedRelations.data.messages.some(message => message.id === actualRow.id),
      "a derived message should resolve its CAP parent even when its reference uses a numeric UTC offset");

    const derivedXmlResponse = await fetch(base + `/api/alerts/${derived.data.id}/cap.xml`, {
      headers: { Authorization: "Bearer " + forecaster }
    });
    assert.equal(derivedXmlResponse.status, 200, msg_type + " CAP XML export should succeed");
    const derivedXml = await derivedXmlResponse.text();
    assert.match(derivedXml, new RegExp(`<msgType>${msg_type}</msgType>`),
      msg_type + " export must preserve its CAP message type");
    assert.ok(derivedXml.includes(actualIdentifier),
      msg_type + " CAP XML must preserve the original message reference");
    const derivedOutbox = await request("/api/delivery/outbox", { token: publisher });
    assert.equal(derivedOutbox.data.deliveries.filter(item =>
      item.alert_id === derived.data.id && item.channel === "cap_feed"
    ).length, 1, msg_type + " publication should queue exactly one internal CAP feed entry");
    if (msg_type === "Cancel") {
      const cancelledOriginal = await request(`/api/alerts/${actualRow.id}`, { token: forecaster });
      assert.equal(cancelledOriginal.status, 200);
      assert.equal(cancelledOriginal.data.alert.workflow, "published",
        "a Test-status cancellation must not cancel the referenced Actual warning");
      assert.equal((await request(`/api/alerts/${actualRow.id}/derive`, {
        token: forecaster, method: "POST", body: { msg_type: "Cancel" }
      })).status, 409, "the same source message must not receive a duplicate cancellation");
      assert.equal((await request(`/api/alerts/${actualRow.id}/derive`, {
        token: forecaster, method: "POST", body: { msg_type: "Update" }
      })).status, 201, "a Test-status cancellation must leave the Actual source warning active");
    }
  }

  assert.ok(publishedUpdate, "the first Update should be published before testing a chained Update");
  const chainedUpdate = await request(`/api/alerts/${publishedUpdate.id}/derive`, {
    token: forecaster, method: "POST", body: { msg_type: "Update" }
  });
  assert.equal(chainedUpdate.status, 201,
    "a published Update must be a valid source for a subsequent Update");
  assert.equal(chainedUpdate.data.status, "Test");
  assert.equal(chainedUpdate.data.workflow, "draft");
  assert.ok(chainedUpdate.data.references.includes(publishedUpdate.identifier),
    "the chained Update must reference its immediate published parent");
  assert.equal((await request(`/api/alerts/${chainedUpdate.data.id}/submit`, {
    token: forecaster, method: "POST", body: {}
  })).status, 200);
  assert.equal((await request(`/api/alerts/${chainedUpdate.data.id}/approve`, {
    token: reviewer, method: "POST", body: {}
  })).status, 200);
  assert.equal((await request(`/api/alerts/${chainedUpdate.data.id}/publish`, {
    token: publisher, method: "POST", body: {}
  })).status, 200);
  const lineageDb = new Database(path.join(cwd, "storage", "cap.sqlite"));
  try {
    const parentIdentity = lineageDb.prepare("SELECT sender,identifier,sent FROM alerts WHERE id=?").get(publishedUpdate.id);
    const equivalentUtcReference = new Date(Date.parse(parentIdentity.sent) + 3 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "+03:00");
    lineageDb.prepare("UPDATE alerts SET references_text=? WHERE id=?")
      .run(`${parentIdentity.sender},${parentIdentity.identifier},${equivalentUtcReference}`, chainedUpdate.data.id);
  } finally {
    lineageDb.close();
  }
  const chainedLineage = await request(`/api/alerts/${chainedUpdate.data.id}/relations`, { token: forecaster });
  assert.equal(chainedLineage.status, 200);
  assert.ok(chainedLineage.data.messages.some(message => message.id === actualRow.id),
    "the second-generation Update must retain the original Alert in its complete lineage");
  assert.ok(chainedLineage.data.messages.some(message => message.id === publishedUpdate.id),
    "the second-generation Update must resolve its immediate Update parent");
  assert.ok(chainedLineage.data.relations.some(edge =>
    edge.from_id === actualRow.id && edge.to_id === publishedUpdate.id && edge.msg_type === "Update"
  ), "lineage must retain the original Alert-to-Update edge");
  assert.ok(chainedLineage.data.relations.some(edge =>
    edge.from_id === publishedUpdate.id && edge.to_id === chainedUpdate.data.id && edge.msg_type === "Update"
  ), "lineage must expose the chained Update-to-Update edge");
  assert.ok(chainedLineage.data.relation_count >= 2,
    "the two-generation chain should expose both validated relationship edges");
  const originalLineage = await request(`/api/alerts/${actualRow.id}/relations`, { token: forecaster });
  assert.ok(originalLineage.data.messages.some(message => message.id === chainedUpdate.data.id),
    "opening the original Alert should discover descendants beyond the first generation");

  const relationOverflowDb = new Database(path.join(cwd, "storage", "cap.sqlite"));
  try {
    const rootIdentity = relationOverflowDb.prepare(
      "SELECT sender,identifier,sent,created_by FROM alerts WHERE id=?"
    ).get(actualRow.id);
    const insertSyntheticRelation = relationOverflowDb.prepare(`
      INSERT INTO alerts
        (identifier,sender,sent,status,msg_type,scope,references_text,event,category,
         urgency,severity,certainty,headline,description,area_desc,language,workflow,created_by)
      VALUES
        (@identifier,@sender,@sent,'Test','Update','Private',@references,
         'Synthetic relation test','Met','Unknown','Unknown','Unknown',
         'Synthetic relation test','Synthetic test data only','Synthetic test area',
         'en-US','published',@created_by)
    `);
    const insertBatch = relationOverflowDb.transaction((kind, references) => {
      for (let index = 0; index < 101; index++) {
        insertSyntheticRelation.run({
          identifier: `relation-${kind}-${index}-${Date.now()}`,
          sender: rootIdentity.sender,
          sent: new Date(Date.parse(rootIdentity.sent) + (index + 1) * 1000).toISOString(),
          references,
          created_by: rootIdentity.created_by
        });
      }
    });
    insertBatch("invalid", `${rootIdentity.sender},${rootIdentity.identifier},not-a-valid-time`);
    const invalidCandidatesLineage = await request(
      `/api/alerts/${actualRow.id}/relations`, { token: forecaster }
    );
    assert.equal(invalidCandidatesLineage.status, 200);
    assert.equal(invalidCandidatesLineage.data.truncated, false,
      "more than 100 text candidates with invalid reference timestamps must not falsely mark lineage as truncated");
    insertBatch("valid", `${rootIdentity.sender},${rootIdentity.identifier},${rootIdentity.sent}`);
    const overflowLineage = await request(
      `/api/alerts/${actualRow.id}/relations`, { token: forecaster }
    );
    assert.equal(overflowLineage.status, 200);
    assert.equal(overflowLineage.data.truncated, true,
      "more than 100 valid child references must mark the lineage as truncated");
  } finally {
    relationOverflowDb.close();
  }

  assert.equal((await request("/api/audit", { token: forecaster })).status, 403,
    "forecasters must not read restricted audit history");
  assert.equal((await request("/api/audit", { token: publisher })).status, 403,
    "publishers must not read restricted audit history");
  assert.equal((await request("/api/audit", { token: viewer })).status, 403,
    "viewers must not read restricted audit history");
  assert.equal((await request("/api/audit/verify", { token: publisher })).status, 403,
    "publishers must not verify restricted audit history");
  assert.equal((await request("/api/audit/verify", { token: viewer })).status, 403,
    "viewers must not verify restricted audit history");
  assert.equal((await request("/api/audit", { token: approver })).status, 200,
    "approvers should be able to inspect audit history");
  assert.equal((await request("/api/audit/verify", { token: approver })).status, 200,
    "approvers should be able to verify audit history");
  const auditCsv = await fetch(base + "/api/audit/export.csv", { headers: { Authorization: "Bearer " + reviewer } });
  assert.equal(auditCsv.status, 200, "authorized audit reviewers should be able to export the audit log");
  assert.match(auditCsv.headers.get("content-type") || "", /text\/csv/i);
  const auditCsvBytes = Buffer.from(await auditCsv.arrayBuffer());
  assert.deepEqual([...auditCsvBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf],
    "audit CSV should begin with the UTF-8 BOM bytes");
  const auditCsvText = auditCsvBytes.toString("utf8");
  assert.match(auditCsvText, /"entry_hash"/, "audit export should include integrity hash columns");
  assert.match(auditCsvText, /"login_succeeded"/, "audit export should include recorded actions");
  const filteredAuditCsv = await fetch(base + "/api/audit/export.csv?action=login_succeeded", {
    headers: { Authorization: "Bearer " + reviewer }
  });
  assert.equal(filteredAuditCsv.status, 200);
  const filteredAuditText = await filteredAuditCsv.text();
  assert.match(filteredAuditText, /"login_succeeded"/);
  assert.doesNotMatch(filteredAuditText, /"user_created"/, "action filter should exclude unrelated audit events");
  assert.equal((await fetch(base + "/api/audit/export.csv")).status, 401, "audit export must require authentication");
  assert.equal((await request("/api/audit/export.csv", { token: forecaster })).status, 403, "audit export must preserve restricted audit roles");
  const auditHistory = await request("/api/audit", { token: reviewer });
  assert.equal(auditHistory.status, 200,
    "reviewers should be able to inspect audit history");
  assert.equal(auditHistory.headers.get("cache-control"), "no-store",
    "restricted audit history must not be stored by browsers or shared caches");
  assert.equal(auditHistory.headers.get("pragma"), "no-cache",
    "restricted audit history must carry a legacy no-cache directive");
  assert.ok(auditHistory.data.entries.some(entry => entry.action === "login_succeeded" && entry.username === "admin"),
    "successful administrator sign-ins should be included in the audit history");
  assert.ok(auditHistory.data.entries.some(entry => entry.action === "user_created" && entry.details.includes("approver1")),
    "creating an account should record the target username and assigned role");
  assert.ok(auditHistory.data.entries.some(entry => entry.action === "user_role_changed" && entry.details.includes("rolechange1") && entry.details.includes("viewer") && entry.details.includes("publisher")),
    "role changes should record the target account and old/new roles");
  const filteredAuditAction = await request("/api/audit?action=user_created", { token: reviewer });
  assert.equal(filteredAuditAction.status, 200);
  assert.ok(filteredAuditAction.data.entries.length > 0 && filteredAuditAction.data.entries.every(entry => entry.action === "user_created"),
    "audit action filter should return only the requested event type");
  const filteredAuditSearch = await request("/api/audit?q=approver1", { token: reviewer });
  assert.equal(filteredAuditSearch.status, 200);
  assert.ok(filteredAuditSearch.data.entries.some(entry => entry.details.includes("approver1")),
    "audit text search should match event details");
  const filteredAuditEmpty = await request("/api/audit?action=event_that_does_not_exist", { token: reviewer });
  assert.equal(filteredAuditEmpty.status, 200);
  assert.equal(filteredAuditEmpty.data.entries.length, 0, "unknown event filter should return an empty page");
  const firstAuditPage = await request("/api/audit?limit=1", { token: reviewer });
  assert.equal(firstAuditPage.status, 200);
  assert.equal(firstAuditPage.data.entries.length, 1);
  assert.equal(firstAuditPage.data.has_more, true);
  assert.ok(Number.isSafeInteger(firstAuditPage.data.next_before_id));
  const secondAuditPage = await request("/api/audit?limit=1&before_id=" + firstAuditPage.data.next_before_id, { token: reviewer });
  assert.equal(secondAuditPage.status, 200);
  assert.equal(secondAuditPage.data.entries.length, 1);
  assert.ok(secondAuditPage.data.entries[0].id < firstAuditPage.data.entries[0].id,
    "audit cursor pagination must return strictly older entries without overlap");
  assert.equal((await request("/api/audit", { token: admin })).status, 200,
    "administrators should be able to inspect audit history");
  assert.equal((await request("/api/audit/verify", { token: admin })).status, 200,
    "administrators should be able to verify audit history");
  assert.equal((await request("/api/audit?limit=500", { token: reviewer })).status, 200,
    "the maximum supported audit page size should be accepted");
  for (const invalidLimit of ["0", "-1", "1.5", "abc", "501", "9007199254740992"]) {
    assert.equal((await request("/api/audit?limit=" + encodeURIComponent(invalidLimit), { token: reviewer })).status, 400,
      "invalid audit page size should be rejected: " + invalidLimit);
  }
  for (const invalidCursor of ["0", "-1", "1.5", "abc", "9007199254740992"]) {
    assert.equal((await request("/api/audit?before_id=" + encodeURIComponent(invalidCursor), { token: reviewer })).status, 400,
      "invalid audit cursor should be rejected: " + invalidCursor);
  }
  assert.equal((await request("/api/audit?limit=1&before_id=1", { token: reviewer })).status, 200,
    "the smallest positive audit cursor should be accepted");

  const auditPaginationDatabase = new Database(path.join(cwd, "storage", "cap.sqlite"));
  try {
    for (let index = 0; index < 105; index++) {
      appendAuditLog(auditPaginationDatabase, {
        action: "pagination_fixture",
        details: "cursor fixture " + index
      });
    }
  } finally {
    auditPaginationDatabase.close();
  }
  const auditPageOne = await request("/api/audit?limit=50", { token: reviewer });
  assert.equal(auditPageOne.status, 200);
  assert.equal(auditPageOne.data.entries.length, 50);
  assert.equal(auditPageOne.data.has_more, true);
  const auditPageTwo = await request(
    "/api/audit?limit=50&before_id=" + auditPageOne.data.next_before_id,
    { token: reviewer }
  );
  assert.equal(auditPageTwo.status, 200);
  assert.equal(auditPageTwo.data.entries.length, 50);
  assert.equal(auditPageTwo.data.has_more, true);
  const auditPageThree = await request(
    "/api/audit?limit=50&before_id=" + auditPageTwo.data.next_before_id,
    { token: reviewer }
  );
  assert.equal(auditPageThree.status, 200);
  assert.ok(auditPageThree.data.entries.length > 0);
  const pagedEntries = [
    ...auditPageOne.data.entries,
    ...auditPageTwo.data.entries,
    ...auditPageThree.data.entries
  ];
  const fixtureEntries = pagedEntries.filter(entry => entry.action === "pagination_fixture");
  assert.equal(fixtureEntries.length, 105,
    "three cursor pages must include every inserted pagination fixture");
  const pagedIds = pagedEntries.map(entry => entry.id);
  assert.equal(new Set(pagedIds).size, pagedIds.length, "cursor pages must not overlap");
  assert.ok(pagedIds.every((id, index) => index === 0 || id < pagedIds[index - 1]),
    "audit pages must preserve strict descending ID order");

  const auditStatus = await request("/api/audit/verify", { token: reviewer });
  assert.equal(auditStatus.status, 200);
  assert.equal(auditStatus.data.valid, true, "API should verify the cryptographic audit chain");
  assert.ok(auditStatus.data.verified_entries > 0);

  const geoFeed = await request("/api/public/alerts.geojson");
  assert.equal(geoFeed.status, 200);
  assert.ok(geoFeed.data.features.some(feature => feature.properties?.identifier === actualIdentifier),
    "published Actual/Public warning should appear in public GeoJSON");

  const csvFixture = await request("/api/alerts", {
    token: forecaster, method: "POST",
    body: { event: "CSV export fixture", headline: '=SUM(1,1)', description: "CSV safety fixture", area_desc: "CSV test area", circle: "33.5,36.2 8", status: "Test" }
  });
  assert.equal(csvFixture.status, 201, "CSV fixture alert should be created");
  const csvResponse = await fetch(base + "/api/alerts/export.csv?q=CSV%20export%20fixture&workflow=draft", {
    headers: { Authorization: "Bearer " + forecaster }
  });
  assert.equal(csvResponse.status, 200, "authenticated users should be able to export filtered alerts");
  assert.match(csvResponse.headers.get("content-type") || "", /text\/csv/i);
  assert.match(csvResponse.headers.get("content-disposition") || "", /cap-alerts-export\.csv/);
  const csvBytes = Buffer.from(await csvResponse.arrayBuffer());
  assert.deepEqual([...csvBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf],
    "CSV export should begin with the UTF-8 BOM bytes");
  const csvText = csvBytes.toString("utf8");
  assert.match(csvText, /'=SUM\(1,1\)/, "spreadsheet formula-like cells must be neutralized");
  assert.match(csvText, /"CSV export fixture"/, "CSV fields should be quoted");
  const unauthenticatedCsv = await fetch(base + "/api/alerts/export.csv");
  assert.equal(unauthenticatedCsv.status, 401, "CSV export must require authentication");
  const invalidCsvFilter = await fetch(base + "/api/alerts/export.csv?severity=invalid", {
    headers: { Authorization: "Bearer " + forecaster }
  });
  assert.equal(invalidCsvFilter.status, 400, "CSV export must reject invalid filters");
  const testIdentifier = await createAndPublish("Test");
  const publicFeed = await request("/api/public/alerts");
  assert.equal(publicFeed.status, 200);
  assert.ok(publicFeed.data.alerts.some(alert => alert.identifier === actualIdentifier),
    "published Actual/Public warning should be visible in the public feed");
  assert.ok(!publicFeed.data.alerts.some(alert => alert.identifier === testIdentifier),
    "published Test warning must not appear in the public feed");

  const expiredIdentifier = await createAndPublish("Actual", "2020-01-01T00:00:00Z");
  const feedAfterExpiry = await request("/api/public/alerts");
  assert.ok(!feedAfterExpiry.data.alerts.some(alert => alert.identifier === expiredIdentifier),
    "expired Actual/Public warnings must be excluded from the public JSON feed");
  const geoAfterExpiry = await request("/api/public/alerts.geojson");
  assert.ok(!geoAfterExpiry.data.features.some(feature => feature.properties?.identifier === expiredIdentifier),
    "expired Actual/Public warnings must be excluded from the public GeoJSON feed");

  const deactivated = await request(`/api/users/${disabledId}/status`, {
    token: admin, method: "PATCH", body: { active: false }
  });
  assert.equal(deactivated.status, 200);
  assert.equal(deactivated.data.sessions_revoked, true, "deactivation should revoke all existing sessions");
  assert.equal((await request("/api/me", { token: disabledOldSession })).status, 401,
    "deactivation must invalidate an already-issued session");
  assert.equal((await request("/api/auth/login", {
    method: "POST", body: { username: "disabled1", password: "Temporary-Password-2026!" }
  })).status, 401, "deactivated users cannot log in");
  assert.equal((await request(`/api/users/${disabledId}/status`, {
    token: admin, method: "PATCH", body: { active: true }
  })).status, 200, "administrator should be able to reactivate an account");
  const statusAudit = await request("/api/audit", { token: reviewer });
  assert.equal(statusAudit.status, 200);
  assert.ok(statusAudit.data.entries.some(entry => entry.action === "user_deactivated" && entry.details.includes("disabled1")),
    "account deactivation should be represented in the audit history");
  assert.ok(statusAudit.data.entries.some(entry => entry.action === "user_activated" && entry.details.includes("disabled1")),
    "account reactivation should be represented in the audit history");
  assert.equal((await request("/api/me", { token: disabledOldSession })).status, 401,
    "reactivation must not revive a token issued before deactivation");

  assert.equal((await request("/api/auth/change-password", {
    token: forecaster, method: "POST",
    body: { currentPassword: { malformed: true }, newPassword: "Updated-Temporary-Password-2026!" }
  })).status, 401, "non-string current passwords must fail safely without throwing");
  assert.equal((await request("/api/auth/change-password", {
    token: forecaster, method: "POST",
    body: { currentPassword: "x".repeat(201), newPassword: "Updated-Temporary-Password-2026!" }
  })).status, 401, "oversized current passwords must be rejected before bcrypt comparison");

  const passwordChange = await request("/api/auth/change-password", {
    token: forecaster, method: "POST",
    body: {
      currentPassword: "Temporary-Password-2026!",
      newPassword: "Updated-Temporary-Password-2026!"
    }
  });
  assert.equal(passwordChange.status, 200, "password change should succeed");
  assert.equal(passwordChange.data.session_revoked_for_other_devices, true);
  assert.equal((await request("/api/me", { token: forecaster })).status, 401,
    "password changes must revoke previously issued access tokens");
  assert.equal((await request("/api/me", { token: passwordChange.data.token })).status, 200,
    "password change should return a replacement session token");
  assert.equal((await request("/api/auth/login", {
    method: "POST", body: { username: "forecaster1", password: "Temporary-Password-2026!" }
  })).status, 401, "the previous password must stop working immediately");
  assert.equal((await request("/api/auth/login", {
    method: "POST", body: { username: "forecaster1", password: "Updated-Temporary-Password-2026!" }
  })).status, 200, "the new password should work immediately");

  const users = await request("/api/users", { token: admin });
  const adminUser = users.data.users.find(user => user.username === "admin");
  assert.ok(adminUser);
  assert.equal((await request(`/api/users/${adminUser.id}/status`, {
    token: admin, method: "PATCH", body: { active: false }
  })).status, 409, "the active administrator cannot deactivate itself");
  assert.equal((await request("/api/users/not-a-number/status", {
    token: admin, method: "PATCH", body: { active: false }
  })).status, 400, "non-numeric account status ids must be rejected");
  assert.equal((await request("/api/users/999999/status", {
    token: admin, method: "PATCH", body: { active: false }
  })).status, 404, "unknown account ids must return not found");
  for (const invalidActive of [null, 0, 1, "false", {}]) {
    assert.equal((await request(`/api/users/${disabledId}/status`, {
      token: admin, method: "PATCH", body: { active: invalidActive }
    })).status, 400, "account status must reject non-boolean active values");
  }
  const reactivatedSession = await login("disabled1", "Temporary-Password-2026!");
  const unchangedStatus = await request(`/api/users/${disabledId}/status`, {
    token: admin, method: "PATCH", body: { active: true }
  });
  assert.equal(unchangedStatus.status, 200);
  assert.equal(unchangedStatus.data.changed, false, "repeating the current account status should be a no-op");
  assert.equal(unchangedStatus.data.sessions_revoked, false, "a no-op status update must not revoke sessions");
  assert.equal((await request("/api/me", { token: reactivatedSession })).status, 200,
    "a no-op account status update must preserve the current valid session");
});

test("inbound webhook ingress is disabled by default", { timeout: 15000 }, async t => {
  const cwd = await mkdtemp(path.join(tmpdir(), "meteo-cap-webhook-disabled-"));
  const port = await reservePort();
  const base = "http://127.0.0.1:" + port;
  const env = { ...process.env };
  delete env.CAP_WEBHOOK_INGRESS_ENABLED;
  delete env.CAP_WEBHOOK_SECRET;
  const child = spawn(process.execPath, [serverEntry], {
    cwd,
    env: {
      ...env,
      PORT: String(port),
      HOST: "127.0.0.1",
      JWT_SECRET: "webhook-disabled-test-secret-at-least-32-characters",
      ADMIN_PASSWORD: "Webhook-Disabled-Test-Admin-2026"
    },
    stdio: "ignore"
  });

  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise(resolve => {
        child.once("exit", resolve);
        setTimeout(resolve, 2000);
      });
    }
    await rm(cwd, { recursive: true, force: true });
  });

  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error("API server exited before becoming ready.");
    try {
      const response = await fetch(base + "/api/health");
      if (response.ok) { ready = true; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, "API server should start without webhook ingress configuration");

  const response = await fetch(base + "/api/webhooks/inbound", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "synthetic-test", event: "disabled-ingress-test" })
  });
  assert.equal(response.status, 404,
    "inbound webhook requests must be rejected when the feature flag and secret are not configured");

  for (let attempt = 1; attempt < 30; attempt++) {
    const allowed = await fetch(base + "/api/webhooks/inbound", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "synthetic-test", event: "disabled-rate-limit-" + attempt })
    });
    assert.equal(allowed.status, 404, "requests below the ingress rate limit should retain the disabled response");
  }
  const rateLimited = await fetch(base + "/api/webhooks/inbound", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "synthetic-test", event: "disabled-rate-limit-overflow" })
  });
  assert.equal(rateLimited.status, 429, "inbound webhook ingress must enforce its 30-request per-minute limit");
});
