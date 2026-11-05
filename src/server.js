import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { db, ensureAdmin } from "./db.js";
import { buildCapXml, makeIdentifier, validateAlert } from "./cap.js";
import { alertsToGeoJSON } from "./geojson.js";
import { appendAuditLog, verifyAuditChain } from "./audit.js";
import { enqueueDelivery, claimDelivery, recordDeliveryReceipt, retryDelivery, recoverStaleDeliveries, processDueRetries } from "./delivery.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { consumeRecoveryCode, decryptTotpSecret, encryptTotpSecret, generateRecoveryCodes, generateTotpSecret, hashRecoveryCode, verifyTotp } from "./mfa.js";
import { verifyAndConsumeWebhook } from "./webhook-replay.js";

const app = express();
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Use a real bcrypt hash for unknown/inactive accounts to reduce username-enumeration timing differences.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync("CAP-login-timing-equalization-only-not-a-user-password", 12);
const validMfaRoles = new Set(["admin","forecaster","reviewer","approver","publisher","viewer"]);
const configuredMfaRoles = (process.env.MFA_REQUIRED_ROLES || "").split(",").map(value=>value.trim()).filter(Boolean);
if (configuredMfaRoles.some(role=>!validMfaRoles.has(role)) || new Set(configuredMfaRoles).size!==configuredMfaRoles.length) {
 console.error("FATAL: MFA_REQUIRED_ROLES must be a comma-separated list of unique supported roles.");
 process.exit(1);
}
const mfaRequiredRoles = new Set(configuredMfaRoles);
const port = Number(process.env.PORT || 8095);
const secret = process.env.JWT_SECRET;
if (!secret || secret.length < 32 || /^REPLACE_WITH_/i.test(secret)) {
 console.error("FATAL: Set JWT_SECRET to a unique random value of at least 32 characters before starting the server.");
 process.exit(1);
}
if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 14 || /^REPLACE_WITH_/i.test(process.env.ADMIN_PASSWORD || "") || process.env.ADMIN_PASSWORD === "ChangeThisImmediately!123") {
 console.error("FATAL: Set ADMIN_PASSWORD to a unique password of at least 14 characters.");
 process.exit(1);
}
ensureAdmin();
app.use(helmet({
 contentSecurityPolicy: {
  directives: {
   defaultSrc: ["'self'"],
   baseUri: ["'self'"],
   connectSrc: ["'self'"],
   fontSrc: ["'self'", "data:"],
   formAction: ["'self'"],
   frameAncestors: ["'none'"],
   imgSrc: ["'self'", "data:", "blob:", "https://*.tile.openstreetmap.org", "https://unpkg.com"],
   objectSrc: ["'none'"],
   scriptSrc: ["'self'", "https://unpkg.com"],
   scriptSrcAttr: ["'none'"],
   styleSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com"]
  }
 }
}));
const origins = (process.env.CORS_ORIGINS || "").split(",").map(s=>s.trim()).filter(Boolean);
app.use(cors({ origin: origins.length ? origins : false }));
app.use("/api", rateLimit({ windowMs: 15*60*1000, limit: 300, standardHeaders: true, legacyHeaders: false }));
app.use("/api/auth", rateLimit({ windowMs: 15*60*1000, limit: 60, standardHeaders: true, legacyHeaders: false }));

const webhookIngressEnabled = process.env.CAP_WEBHOOK_INGRESS_ENABLED === "true";
const webhookSecret = process.env.CAP_WEBHOOK_SECRET || "";
if (webhookIngressEnabled && (Buffer.byteLength(webhookSecret, "utf8") < 32 || /^REPLACE_WITH_/i.test(webhookSecret))) {
 console.error("FATAL: CAP_WEBHOOK_INGRESS_ENABLED requires a unique CAP_WEBHOOK_SECRET of at least 32 bytes.");
 process.exit(1);
}
const webhookIngressLimiter = rateLimit({ windowMs: 60*1000, limit: 30, standardHeaders: true, legacyHeaders: false });
app.post("/api/webhooks/inbound", webhookIngressLimiter, express.raw({ type: "application/json", limit: "64kb" }), (req,res) => {
 if (!webhookIngressEnabled) return res.status(404).json({ error: "Webhook ingress is disabled" });
 if (!Buffer.isBuffer(req.body)) return res.status(415).json({ error: "Content-Type must be application/json" });
 let payload;
 try {
  payload = JSON.parse(req.body.toString("utf8"));
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("JSON object required");
 } catch {
  return res.status(400).json({ error: "A valid JSON object is required" });
 }
 const timestampHeader = req.get("x-webhook-timestamp") || "";
 if (!/^[0-9]{1,12}$/.test(timestampHeader)) return res.status(400).json({ error: "A valid X-Webhook-Timestamp header is required" });
 const timestamp = Number(timestampHeader);
 const signature = req.get("x-webhook-signature") || "";
 try {
  const receive = db.transaction(() => {
   if (!verifyAndConsumeWebhook(db, webhookSecret, timestamp, req.body, signature)) return null;
   const signatureHash = createHash("sha256").update(signature, "utf8").digest("hex");
   const result = db.prepare("INSERT INTO webhook_inbox(source_timestamp,signature_hash,payload_json) VALUES(?,?,?)")
    .run(timestamp, signatureHash, JSON.stringify(payload));
   return Number(result.lastInsertRowid);
  });
  const inboxId = receive.immediate();
  if (inboxId === null) return res.status(401).json({ error: "Webhook signature is invalid, expired, or has already been used" });
  return res.status(202).json({ accepted: true, inbox_id: inboxId, status: "pending", action: "manual_review_required" });
 } catch (error) {
  console.error("Webhook ingress failed:", error);
  return res.status(500).json({ error: "Unable to safely store webhook message" });
 }
});
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(appRoot, "public")));

const areaSchema = z.object({
 areaDesc:z.string().min(2), polygon:z.string().optional(), circle:z.string().optional(),
 polygons:z.array(z.string()).optional(), circles:z.array(z.string()).optional(),
 geocodes:z.array(z.object({valueName:z.string().min(1),value:z.string().min(1)})).optional(),
 altitude:z.number().optional(), ceiling:z.number().optional()
});
const resourceSchema = z.object({
 resourceDesc:z.string().min(1), mimeType:z.string().min(1), size:z.number().int().nonnegative().optional(),
 uri:z.string().url().optional(), derefUri:z.string().optional(), digest:z.string().optional()
});
const infoBlockSchema = z.object({
 language:z.string().optional(), category:z.string().optional(), categories:z.array(z.string()).optional(),
 event:z.string().min(2), response_type:z.string().optional(), response_types:z.array(z.string()).optional(),
 urgency:z.enum(["Immediate","Expected","Future","Past","Unknown"]).default("Unknown"),
 severity:z.enum(["Extreme","Severe","Moderate","Minor","Unknown"]).default("Unknown"),
 certainty:z.enum(["Observed","Likely","Possible","Unlikely","Unknown"]).default("Unknown"),
 effective:z.string().optional(), onset:z.string().optional(), expires:z.string().optional(),
 senderName:z.string().optional(), headline:z.string().optional(), description:z.string().optional(),
 instruction:z.string().optional(), web:z.string().url().optional(), contact:z.string().optional(),
 area:areaSchema.optional(), areas:z.array(areaSchema).optional(),
 resources:z.array(resourceSchema).optional(),
 parameters:z.array(z.object({valueName:z.string().min(1),value:z.string()})).optional()
});
const schema = z.object({
 event:z.string().min(2).optional(), category:z.string().default("Met"),
 urgency:z.enum(["Immediate","Expected","Future","Past","Unknown"]).default("Unknown"),
 severity:z.enum(["Extreme","Severe","Moderate","Minor","Unknown"]).default("Unknown"),
 certainty:z.enum(["Observed","Likely","Possible","Unlikely","Unknown"]).default("Unknown"),
 scope:z.enum(["Public","Restricted","Private"]).default("Public"),
 headline:z.string().min(3).optional(), description:z.string().min(3).optional(),
 instruction:z.string().optional().default(""), area_desc:z.string().min(2).optional(),
 polygon:z.string().optional().default(""), circle:z.string().optional().default(""),
 effective:z.string().optional().default(""), onset:z.string().optional().default(""),
 expires:z.string().optional().default(""), language:z.string().default("en-US"),
 response_type:z.string().optional().default(""),
 info_blocks:z.array(infoBlockSchema).min(1).max(10).optional(),
 status:z.enum(["Actual","Exercise","System","Test"]).default("Test")
});

function auth(req,res,next) {
 const token = (req.headers.authorization || "").replace(/^Bearer\s+/i,"");
 try {
   req.user = jwt.verify(token, secret);
   const user = db.prepare("SELECT id,username,role,active,token_version,mfa_enabled,must_change_password FROM users WHERE id=?").get(req.user.id);
   if (!user || !user.active) return res.status(401).json({error:"Account unavailable"});
   if (req.user.token_version !== user.token_version) return res.status(401).json({error:"Session expired; please sign in again"});
   if(user.must_change_password===1) {
    const allowedPaths=new Set(["GET /api/me","POST /api/auth/change-password","GET /api/auth/mfa/status","POST /api/auth/mfa/enroll","POST /api/auth/mfa/confirm"]);
    if(!allowedPaths.has(req.method+" "+req.path))
     return res.status(403).json({error:"A temporary password must be changed before using this operation",code:"PASSWORD_CHANGE_REQUIRED"});
   }
   req.user = user; next();
 } catch { return res.status(401).json({error:"Authentication required"}); }
}
const roles = (...allowed) => (req,res,next) => {
 if(!allowed.includes(req.user.role)) return res.status(403).json({error:"Insufficient permissions"});
 if(mfaRequiredRoles.has(req.user.role) && req.user.mfa_enabled!==1)
  return res.status(403).json({error:"MFA enrollment is required for this role before accessing protected operations",code:"MFA_REQUIRED"});
 return next();
};
function audit(userId, alertId, action, details="") {
 appendAuditLog(db, { userId, alertId, action, details });
}
function rowToCap(r) {
 return {...r, msg_type:r.msg_type, area_desc:r.area_desc, response_type:r.response_type, info_blocks:r.info_json ? JSON.parse(r.info_json) : undefined};
}

app.get("/api/health", (_req,res)=>res.json({ok:true,service:"Meteo CAP Warning System",cap:"1.2"}));
const loginLimiter = rateLimit({windowMs:15*60*1000,limit:10,skipSuccessfulRequests:true,standardHeaders:true,legacyHeaders:false});
app.post("/api/auth/login",loginLimiter,(req,res)=>{
 const {username,password} = req.body || {};
 if (typeof username !== "string" || username.length < 1 || username.length > 64 ||
     typeof password !== "string" || password.length > 200) {
  return res.status(401).json({error:"Invalid credentials"});
 }
 const user = db.prepare("SELECT * FROM users WHERE username=?").get(username);
 const passwordHash = user?.active ? user.password_hash : DUMMY_PASSWORD_HASH;
 const passwordMatches = bcrypt.compareSync(password, passwordHash);
 if (!user || !user.active || !passwordMatches) return res.status(401).json({error:"Invalid credentials"});
 if (user.mfa_enabled) {
  const challengeId = randomUUID();
  const expiresAt = Date.now() + 5 * 60 * 1000;
  db.prepare("DELETE FROM mfa_login_challenges WHERE expires_at < ? OR consumed_at IS NOT NULL").run(Date.now());
  db.prepare("INSERT INTO mfa_login_challenges(id,user_id,expires_at) VALUES(?,?,?)").run(challengeId,user.id,expiresAt);
  const challengeToken = jwt.sign(
   {id:user.id,token_version:user.token_version,purpose:"mfa-login",jti:challengeId},
   secret,{expiresIn:"5m"}
  );
  audit(user.id,null,"mfa_login_challenge_created","Password accepted; second factor required");
  return res.json({mfa_required:true,password_change_required:user.must_change_password===1,challenge_token:challengeToken,expires_in:300});
 }
 db.prepare("UPDATE users SET last_login_at=CURRENT_TIMESTAMP WHERE id=?").run(user.id);
 audit(user.id,null,"login_succeeded","Successful password authentication; MFA not enabled");
 const token = jwt.sign({id:user.id,token_version:user.token_version}, secret, {expiresIn:"8h"});
 res.json({token,password_change_required:user.must_change_password===1,user:{id:user.id,username:user.username,role:user.role}});
});
const mfaLoginLimiter = rateLimit({windowMs:15*60*1000,limit:10,standardHeaders:true,legacyHeaders:false});
const mfaEnrollLimiter = rateLimit({windowMs:15*60*1000,limit:10,standardHeaders:true,legacyHeaders:false});
const mfaConfirmLimiter = rateLimit({windowMs:15*60*1000,limit:10,standardHeaders:true,legacyHeaders:false});
const mfaDisableLimiter = rateLimit({windowMs:15*60*1000,limit:10,standardHeaders:true,legacyHeaders:false});
app.post("/api/auth/mfa/challenge",mfaLoginLimiter,(req,res)=>{
 const {challenge_token:challengeToken,code}=req.body || {};
 if(typeof challengeToken!=="string" || challengeToken.length>4096 || typeof code!=="string" || code.length>64)
  return res.status(401).json({error:"Invalid or expired MFA challenge"});
 let claims;
 try {
  claims=jwt.verify(challengeToken,secret);
  if(claims.purpose!=="mfa-login" || typeof claims.jti!=="string") throw new Error("Invalid challenge purpose");
 } catch { return res.status(401).json({error:"Invalid or expired MFA challenge"}); }
 const user=db.prepare("SELECT id,username,role,active,token_version,mfa_secret_enc,mfa_last_used_step,mfa_recovery_hashes,must_change_password FROM users WHERE id=?").get(claims.id);
 if(!user || !user.active || user.token_version!==claims.token_version || !user.mfa_secret_enc)
  return res.status(401).json({error:"Invalid or expired MFA challenge"});
 try {
  const complete=db.transaction(()=>{
   const challenge=db.prepare("SELECT id FROM mfa_login_challenges WHERE id=? AND user_id=? AND expires_at>? AND consumed_at IS NULL").get(claims.jti,user.id,Date.now());
   if(!challenge) return null;
   const currentUser=db.prepare("SELECT active,token_version,mfa_enabled,mfa_secret_enc,mfa_last_used_step,mfa_recovery_hashes FROM users WHERE id=?").get(user.id);
   if(!currentUser || !currentUser.active || currentUser.token_version!==claims.token_version || currentUser.mfa_enabled!==1 || !currentUser.mfa_secret_enc) return null;
   const now=Date.now();
   let nextRecovery=null;
   let acceptedStep=null;
   const secretValue=decryptTotpSecret(currentUser.mfa_secret_enc);
   acceptedStep=verifyTotp(secretValue,code,now,1);
   if(acceptedStep!==null) {
    if(currentUser.mfa_last_used_step!==null && acceptedStep<=currentUser.mfa_last_used_step) return null;
   } else {
    let hashes;
    try { hashes=JSON.parse(currentUser.mfa_recovery_hashes||"[]"); } catch { hashes=[]; }
    nextRecovery=consumeRecoveryCode(hashes,code);
    if(nextRecovery===null) return null;
   }
   db.prepare("UPDATE mfa_login_challenges SET consumed_at=CURRENT_TIMESTAMP WHERE id=? AND consumed_at IS NULL").run(claims.jti);
   if(acceptedStep!==null) db.prepare("UPDATE users SET mfa_last_used_step=? WHERE id=?").run(acceptedStep,user.id);
   else db.prepare("UPDATE users SET mfa_recovery_hashes=? WHERE id=?").run(JSON.stringify(nextRecovery),user.id);
   db.prepare("UPDATE users SET last_login_at=CURRENT_TIMESTAMP WHERE id=?").run(user.id);
   audit(user.id,null,"mfa_login_succeeded",acceptedStep!==null?"TOTP challenge completed":"Recovery code consumed for login");
   return true;
  }).immediate();
  if(!complete) return res.status(401).json({error:"Invalid, expired, or already-used MFA challenge or code"});
  const token=jwt.sign({id:user.id,token_version:user.token_version},secret,{expiresIn:"8h"});
  return res.json({token,password_change_required:user.must_change_password===1,user:{id:user.id,username:user.username,role:user.role}});
 } catch(error) {
  console.error("MFA challenge failed:",error);
  return res.status(500).json({error:"Unable to complete MFA challenge"});
 }
});
app.get("/api/auth/mfa/status",auth,(req,res)=>{
 const row=db.prepare("SELECT mfa_enabled,mfa_pending_expires_at,mfa_recovery_hashes FROM users WHERE id=?").get(req.user.id);
 let count=0;try{count=JSON.parse(row.mfa_recovery_hashes||"[]").length}catch{}
 res.json({enabled:row.mfa_enabled===1,required:mfaRequiredRoles.has(req.user.role),required_roles:[...mfaRequiredRoles],pending:!!row.mfa_pending_expires_at && Date.parse(row.mfa_pending_expires_at)>Date.now(),recovery_codes_remaining:count});
});
app.post("/api/auth/mfa/enroll",auth,mfaEnrollLimiter,(req,res)=>{
 const {password}=req.body||{};
 if(typeof password!=="string" || password.length>200) return res.status(401).json({error:"Current password is incorrect"});
 const row=db.prepare("SELECT password_hash,mfa_enabled FROM users WHERE id=?").get(req.user.id);
 if(!row || !bcrypt.compareSync(password,row.password_hash)) return res.status(401).json({error:"Current password is incorrect"});
 if(row.mfa_enabled) return res.status(409).json({error:"MFA is already enabled; disable it before enrolling again"});
 try {
  const secretValue=generateTotpSecret();
  const expiresAt=new Date(Date.now()+10*60*1000).toISOString();
  db.prepare("UPDATE users SET mfa_pending_secret_enc=?,mfa_pending_expires_at=? WHERE id=?")
   .run(encryptTotpSecret(secretValue),expiresAt,req.user.id);
  audit(req.user.id,null,"mfa_enrollment_started","Pending TOTP enrollment created; confirmation required");
  const issuer="Meteo CAP";
  const label=encodeURIComponent(issuer+":"+req.user.username);
  const otpauthUrl="otpauth://totp/"+label+"?secret="+secretValue+"&issuer="+encodeURIComponent(issuer)+"&algorithm=SHA1&digits=6&period=30";
  res.json({secret:secretValue,otpauth_url:otpauthUrl,expires_at:expiresAt,algorithm:"SHA1",digits:6,period:30});
 } catch(error) {
  console.error("MFA enrollment failed:",error);
  res.status(503).json({error:"MFA encryption is not configured correctly"});
 }
});
app.post("/api/auth/mfa/confirm",auth,mfaConfirmLimiter,(req,res)=>{
 const {password,code}=req.body||{};
 if(typeof password!=="string" || password.length>200 || typeof code!=="string" || !/^\d{6}$/.test(code))
  return res.status(400).json({error:"A current password and six-digit authenticator code are required"});
 const row=db.prepare("SELECT password_hash,mfa_enabled,mfa_pending_secret_enc,mfa_pending_expires_at FROM users WHERE id=?").get(req.user.id);
 if(!row || !bcrypt.compareSync(password,row.password_hash)) return res.status(401).json({error:"Current password is incorrect"});
 if(row.mfa_enabled) return res.status(409).json({error:"MFA is already enabled"});
 if(!row.mfa_pending_secret_enc || !row.mfa_pending_expires_at || Date.parse(row.mfa_pending_expires_at)<=Date.now())
  return res.status(409).json({error:"MFA enrollment is missing or expired; start enrollment again"});
 try {
  const secretValue=decryptTotpSecret(row.mfa_pending_secret_enc);
  const step=verifyTotp(secretValue,code,Date.now(),1);
  if(step===null) return res.status(401).json({error:"Authenticator code is invalid"});
  const recoveryCodes=generateRecoveryCodes();
  const hashes=JSON.stringify(recoveryCodes.map(hashRecoveryCode));
  const enable=db.transaction(()=>{
   const current=db.prepare("SELECT mfa_enabled,mfa_pending_secret_enc,mfa_pending_expires_at FROM users WHERE id=?").get(req.user.id);
   if(!current || current.mfa_enabled || current.mfa_pending_secret_enc!==row.mfa_pending_secret_enc ||
      !current.mfa_pending_expires_at || Date.parse(current.mfa_pending_expires_at)<=Date.now()) return false;
   db.prepare("UPDATE users SET mfa_enabled=1,mfa_secret_enc=?,mfa_pending_secret_enc=NULL,mfa_pending_expires_at=NULL,mfa_last_used_step=?,mfa_recovery_hashes=?,token_version=token_version+1 WHERE id=?")
    .run(row.mfa_pending_secret_enc,step,hashes,req.user.id);
   audit(req.user.id,null,"mfa_enabled","TOTP enabled; one-time recovery codes generated");
   return true;
  }).immediate();
  if(!enable) return res.status(409).json({error:"MFA enrollment changed or expired; start again"});
  const tokenVersion=db.prepare("SELECT token_version FROM users WHERE id=?").get(req.user.id).token_version;
  const replacementToken=jwt.sign({id:req.user.id,token_version:tokenVersion},secret,{expiresIn:"8h"});
  res.json({enabled:true,token:replacementToken,recovery_codes:recoveryCodes,warning:"Store these recovery codes securely. They are shown only once."});
 } catch(error) {
  console.error("MFA confirmation failed:",error);
  res.status(503).json({error:"Unable to verify MFA enrollment"});
 }
});
app.post("/api/auth/mfa/disable",auth,mfaDisableLimiter,(req,res)=>{
 const {password,code}=req.body||{};
 if(typeof password!=="string" || password.length>200 || typeof code!=="string" || code.length>64)
  return res.status(400).json({error:"Current password and an authenticator or recovery code are required"});
 const row=db.prepare("SELECT password_hash,mfa_enabled,mfa_secret_enc,mfa_last_used_step,mfa_recovery_hashes FROM users WHERE id=?").get(req.user.id);
 if(!row || !bcrypt.compareSync(password,row.password_hash)) return res.status(401).json({error:"Current password is incorrect"});
 if(!row.mfa_enabled || !row.mfa_secret_enc) return res.status(409).json({error:"MFA is not enabled"});
 try {
  const result=db.transaction(()=>{
   const current=db.prepare("SELECT token_version,mfa_enabled,mfa_secret_enc,mfa_last_used_step,mfa_recovery_hashes FROM users WHERE id=?").get(req.user.id);
   if(!current || current.token_version!==req.user.token_version || current.mfa_enabled!==1 || !current.mfa_secret_enc) return false;
   const secretValue=decryptTotpSecret(current.mfa_secret_enc);
   const step=verifyTotp(secretValue,code,Date.now(),1);
   let recoveryRemaining=null;
   if(step!==null) {
    if(current.mfa_last_used_step!==null && step<=current.mfa_last_used_step) return false;
   } else {
    let hashes;try{hashes=JSON.parse(current.mfa_recovery_hashes||"[]")}catch{hashes=[]}
    recoveryRemaining=consumeRecoveryCode(hashes,code);
    if(recoveryRemaining===null) return false;
   }
   db.prepare("UPDATE users SET mfa_enabled=0,mfa_secret_enc=NULL,mfa_pending_secret_enc=NULL,mfa_pending_expires_at=NULL,mfa_last_used_step=NULL,mfa_recovery_hashes='[]',token_version=token_version+1 WHERE id=?").run(req.user.id);
   db.prepare("UPDATE mfa_login_challenges SET consumed_at=CURRENT_TIMESTAMP WHERE user_id=? AND consumed_at IS NULL").run(req.user.id);
   audit(req.user.id,null,"mfa_disabled","MFA disabled after password and second-factor verification; sessions revoked");
   return true;
  }).immediate();
  if(!result) return res.status(401).json({error:"Authenticator or recovery code is invalid or already used"});
  res.json({enabled:false,sessions_revoked:true});
 } catch(error) {
  console.error("MFA disable failed:",error);
  res.status(503).json({error:"Unable to safely disable MFA"});
 }
});
const passwordChangeLimiter=rateLimit({windowMs:15*60*1000,limit:5,skipSuccessfulRequests:true,keyGenerator:req=>String(req.user.id),standardHeaders:true,legacyHeaders:false});
app.post("/api/auth/change-password",auth,passwordChangeLimiter,(req,res)=>{
 const {currentPassword,newPassword}=req.body || {};
 if(typeof newPassword!=="string" || newPassword.length<14 || newPassword.length>200) return res.status(400).json({error:"New password must contain 14 to 200 characters"});
 if(typeof currentPassword!=="string" || currentPassword.length>200) return res.status(401).json({error:"Current password is incorrect"});
 if(currentPassword===newPassword) return res.status(400).json({error:"New password must be different from the current password"});
 const row=db.prepare("SELECT password_hash FROM users WHERE id=?").get(req.user.id);
 if(!row || !bcrypt.compareSync(currentPassword,row.password_hash)) return res.status(401).json({error:"Current password is incorrect"});
 const hash=bcrypt.hashSync(newPassword,12);
 db.prepare("UPDATE users SET password_hash=?,must_change_password=0,token_version=token_version+1 WHERE id=?").run(hash,req.user.id);
 const tokenVersion=db.prepare("SELECT token_version FROM users WHERE id=?").get(req.user.id).token_version;
 const token=jwt.sign({id:req.user.id,token_version:tokenVersion},secret,{expiresIn:"8h"});
 audit(req.user.id,null,"password_changed","Password changed; all previous sessions revoked");
 res.json({ok:true,token,password_change_required:false,user:{id:req.user.id,username:req.user.username,role:req.user.role},session_revoked_for_other_devices:true});
});
app.get("/api/me",auth,(req,res)=>res.json({user:req.user}));

const userSchema = z.object({
 username: z.string().min(3).max(64).regex(/^[a-zA-Z0-9._-]+$/),
 password: z.string().min(14).max(200),
 role: z.enum(["admin","forecaster","reviewer","approver","publisher","viewer"])
});
app.get("/api/users",auth,roles("admin"),(_req,res)=>{
 const users=db.prepare("SELECT id,username,role,active,mfa_enabled,must_change_password,created_at,last_login_at FROM users ORDER BY id").all();
 res.json({users:users.map(user=>({...user,mfa_required:mfaRequiredRoles.has(user.role)}))});
});
app.post("/api/users",auth,roles("admin"),(req,res)=>{
 try {
  const data=userSchema.parse(req.body);
  const hash=bcrypt.hashSync(data.password,12);
  const result=db.prepare("INSERT INTO users(username,password_hash,role,must_change_password) VALUES(?,?,?,1)").run(data.username,hash,data.role);
  audit(req.user.id,null,"user_created",`Created user ${data.username} with role ${data.role}`);
  res.status(201).json({id:result.lastInsertRowid,username:data.username,role:data.role,must_change_password:true});
 } catch(e) {
  if(e.code==="SQLITE_CONSTRAINT_UNIQUE") return res.status(409).json({error:"Username already exists"});
  res.status(400).json({error:e.message});
 }
});

const adminPasswordResetLimiter=rateLimit({windowMs:15*60*1000,limit:5,standardHeaders:true,legacyHeaders:false});
app.post("/api/users/:id/password-reset",auth,roles("admin"),adminPasswordResetLimiter,(req,res)=>{
 const id=Number(req.params.id);
 if(!Number.isSafeInteger(id) || id<1) return res.status(400).json({error:"Invalid user id"});
 if(id===req.user.id) return res.status(409).json({error:"Administrators cannot reset their own password through this workflow"});
 const temporaryPassword=randomBytes(24).toString("base64url");
 const passwordHash=bcrypt.hashSync(temporaryPassword,12);
 try {
  const reset=db.transaction(()=>{
   const target=db.prepare("SELECT id,username,active FROM users WHERE id=?").get(id);
   if(!target) return {kind:"missing"};
   if(!target.active) return {kind:"inactive"};
   db.prepare("UPDATE users SET password_hash=?,must_change_password=1,token_version=token_version+1,mfa_pending_secret_enc=NULL,mfa_pending_expires_at=NULL WHERE id=?").run(passwordHash,id);
   db.prepare("UPDATE mfa_login_challenges SET consumed_at=CURRENT_TIMESTAMP WHERE user_id=? AND consumed_at IS NULL").run(id);
   audit(req.user.id,null,"user_password_reset",`Issued one-time temporary password for ${target.username}; forced change on next authenticated session`);
   return {kind:"reset",username:target.username};
  }).immediate();
  if(reset.kind==="missing") return res.status(404).json({error:"User not found"});
  if(reset.kind==="inactive") return res.status(409).json({error:"Reactivate the account before resetting its password"});
  return res.json({ok:true,id,username:reset.username,temporary_password:temporaryPassword,must_change_password:true,sessions_revoked:true});
 } catch(error) {
  console.error("Administrator password reset failed:",error);
  return res.status(500).json({error:"Unable to reset account password"});
 }
});
app.patch("/api/users/:id/role",auth,roles("admin"),(req,res)=>{
 const id=Number(req.params.id);
 if(!Number.isSafeInteger(id) || id<1) return res.status(400).json({error:"Invalid user id"});
 if(id===req.user.id) return res.status(409).json({error:"You cannot change your own role; ask another administrator"});
 try {
  const data=z.object({role:z.enum(["admin","forecaster","reviewer","approver","publisher","viewer"])}).parse(req.body);
  const changeRole=db.transaction(()=>{
   const target=db.prepare("SELECT id,username,role,active FROM users WHERE id=?").get(id);
   if(!target) return {kind:"missing"};
   if(target.role===data.role) return {kind:"unchanged",target};
   if(target.active && target.role==="admin" && data.role!=="admin") {
    const activeAdmins=db.prepare("SELECT COUNT(*) AS count FROM users WHERE role='admin' AND active=1").get().count;
    if(activeAdmins<=1) return {kind:"last_admin"};
   }
   db.prepare("UPDATE users SET role=?,token_version=token_version+1 WHERE id=?").run(data.role,id);
   audit(req.user.id,null,"user_role_changed",`Changed role for ${target.username} from ${target.role} to ${data.role}; existing sessions revoked`);
   return {kind:"updated",target:{...target,role:data.role}};
  });
  const result=changeRole.immediate();
  if(result.kind==="missing") return res.status(404).json({error:"User not found"});
  if(result.kind==="last_admin") return res.status(409).json({error:"At least one active administrator must remain"});
  res.json({ok:true,id,role:result.target.role,changed:result.kind==="updated",sessions_revoked:result.kind==="updated"});
 } catch(error) { res.status(400).json({error:error.message}); }
});

app.patch("/api/users/:id/status",auth,roles("admin"),(req,res)=>{
 const id=Number(req.params.id);
 if(!Number.isSafeInteger(id) || id<1) return res.status(400).json({error:"Invalid user id"});
 const active=req.body?.active;
 if(typeof active!=="boolean") return res.status(400).json({error:"active must be a boolean"});
 const updateStatus=db.transaction(()=>{
  const target=db.prepare("SELECT id,username,role,active FROM users WHERE id=?").get(id);
  if(!target) return {kind:"missing"};
  if(target.active===(active?1:0)) return {kind:"unchanged",target};
  if(target.id===req.user.id && !active) return {kind:"self"};
  if(!active && target.role==="admin") {
   const activeAdmins=db.prepare("SELECT COUNT(*) AS count FROM users WHERE role='admin' AND active=1").get().count;
   if(activeAdmins<=1) return {kind:"last_admin"};
  }
  db.prepare("UPDATE users SET active=?,token_version=token_version+1 WHERE id=?").run(active?1:0,target.id);
  audit(req.user.id,null,active?"user_activated":"user_deactivated",`${active?"Activated":"Deactivated"} user ${target.username}; existing sessions revoked`);
  return {kind:"updated",target};
 });
 const result=updateStatus.immediate();
 if(result.kind==="missing") return res.status(404).json({error:"User not found"});
 if(result.kind==="self") return res.status(409).json({error:"You cannot deactivate your own administrator account"});
 if(result.kind==="last_admin") return res.status(409).json({error:"At least one active administrator must remain"});
 res.json({ok:true,id,active,changed:result.kind==="updated",sessions_revoked:result.kind==="updated"});
});

app.get("/api/alerts",auth,(req,res)=>{
 const rows = db.prepare("SELECT id,identifier,event,urgency,severity,certainty,headline,area_desc,workflow,sent,expires,status,msg_type FROM alerts ORDER BY sent DESC LIMIT 500").all();
 res.json({alerts:rows});
});
app.get("/api/alerts/:id",auth,(req,res)=>{
 const row = db.prepare("SELECT * FROM alerts WHERE id=?").get(req.params.id);
 if (!row) return res.status(404).json({error:"Alert not found"});
 const {info_json,...alert}=row;
 res.json({alert:{...alert,info_blocks:info_json?JSON.parse(info_json):[]}});
});
app.post("/api/alerts",auth,roles("admin","forecaster"),(req,res)=>{
 try {
  const data = schema.parse(req.body);
  const sent = new Date().toISOString();
  const alert = {
   ...data, event:data.event || data.info_blocks?.[0]?.event || "Weather event", headline:data.headline || data.info_blocks?.[0]?.headline || data.info_blocks?.[0]?.event || "Weather alert", description:data.description || data.info_blocks?.[0]?.description || data.info_blocks?.[0]?.event || "Weather alert details", area_desc:data.area_desc || data.info_blocks?.[0]?.areas?.[0]?.areaDesc || data.info_blocks?.[0]?.area?.areaDesc || "Affected area", category:data.info_blocks?.[0]?.categories?.[0] || data.info_blocks?.[0]?.category || data.category || "Met", urgency:data.info_blocks?.[0]?.urgency || data.urgency, severity:data.info_blocks?.[0]?.severity || data.severity, certainty:data.info_blocks?.[0]?.certainty || data.certainty, response_type:data.info_blocks?.[0]?.response_type || data.response_type, effective:data.info_blocks?.[0]?.effective || data.effective, onset:data.info_blocks?.[0]?.onset || data.onset, expires:data.info_blocks?.[0]?.expires || data.expires, instruction:data.info_blocks?.[0]?.instruction || data.instruction, language:data.info_blocks?.[0]?.language || data.language, identifier:makeIdentifier(), sender:process.env.CAP_SENDER || "alerts@example.org",
   sent, msg_type:"Alert", status:data.status, workflow:"draft",
   references_text:"", info_json:data.info_blocks ? JSON.stringify(data.info_blocks) : null, created_by:req.user.id
  };
  validateAlert(alert);
  const { info_blocks: _infoBlocks, ...alertParams } = alert;
  const result = db.prepare(`INSERT INTO alerts
   (identifier,sender,sent,status,msg_type,scope,references_text,event,category,response_type,urgency,severity,certainty,effective,onset,expires,headline,description,instruction,area_desc,polygon,circle,language,info_json,workflow,created_by)
   VALUES (@identifier,@sender,@sent,@status,@msg_type,@scope,@references_text,@event,@category,@response_type,@urgency,@severity,@certainty,@effective,@onset,@expires,@headline,@description,@instruction,@area_desc,@polygon,@circle,@language,@info_json,@workflow,@created_by )`).run(alertParams);
  audit(req.user.id,result.lastInsertRowid,"created","Draft created");
  res.status(201).json({id:result.lastInsertRowid,identifier:alert.identifier});
 } catch(e) { res.status(400).json({error:e.message}); }
});
app.post("/api/alerts/:id/derive",auth,roles("admin","forecaster"),(req,res)=>{
 const msgType=req.body?.msg_type;
 if(!["Update","Cancel"].includes(msgType)) return res.status(400).json({error:"msg_type must be Update or Cancel"});
 const createDerived=db.transaction(()=>{
  const original=db.prepare("SELECT * FROM alerts WHERE id=?").get(req.params.id);
  if(!original) return {kind:"missing"};
  if(original.workflow!=="published") return {kind:"source_not_reviewed"};
  const sent=new Date().toISOString();
  const references=`${original.sender},${original.identifier},${original.sent.replace(/\.\d{3}Z$/, "-00:00")}`;
  if(msgType==="Cancel") {
   const existing=db.prepare("SELECT id FROM alerts WHERE msg_type='Cancel' AND references_text=? LIMIT 1").get(references);
   if(existing) return {kind:"already_cancelled",existingId:existing.id};
  }
  const {id:_id,approved_by:_approvedBy,published_at:_publishedAt,created_at:_createdAt,updated_at:_updatedAt,...sourceFields}=original;
  const alert={...sourceFields,identifier:makeIdentifier(),sent,status:"Test",msg_type:msgType,
   references_text:references,info_json:msgType==="Cancel"?null:original.info_json,workflow:"draft",created_by:req.user.id};
  const result=db.prepare(`INSERT INTO alerts
   (identifier,sender,sent,status,msg_type,scope,references_text,event,category,response_type,urgency,severity,certainty,effective,onset,expires,headline,description,instruction,area_desc,polygon,circle,language,info_json,workflow,created_by)
   VALUES (@identifier,@sender,@sent,@status,@msg_type,@scope,@references_text,@event,@category,@response_type,@urgency,@severity,@certainty,@effective,@onset,@expires,@headline,@description,@instruction,@area_desc,@polygon,@circle,@language,@info_json,@workflow,@created_by)`).run(alert);
  audit(req.user.id,result.lastInsertRowid,msgType.toLowerCase(),`Created ${msgType} referencing ${original.identifier}; held as Test pending review`);
  return {kind:"created",id:Number(result.lastInsertRowid),identifier:alert.identifier,references};
 });
 const result=createDerived.immediate();
 if(result.kind==="missing") return res.status(404).json({error:"Source alert not found"});
 if(result.kind==="source_not_reviewed") return res.status(409).json({error:"Only published CAP messages can be used as the source of an update or cancellation"});
 if(result.kind==="already_cancelled") return res.status(409).json({error:"A cancellation for this CAP message already exists",existing_cancel_id:result.existingId});
 res.status(201).json({id:result.id,identifier:result.identifier,msg_type:msgType,status:"Test",workflow:"draft",references:result.references});
});

app.post("/api/alerts/:id/submit",auth,roles("admin","forecaster"),(req,res)=>{
 const transition=db.transaction(()=>{
  const a=db.prepare("SELECT id,workflow FROM alerts WHERE id=?").get(req.params.id);
  if(!a) return {kind:"missing"};
  if(a.workflow!=="draft") return {kind:"conflict"};
  const changed=db.prepare("UPDATE alerts SET workflow='pending',updated_at=CURRENT_TIMESTAMP WHERE id=? AND workflow='draft'").run(a.id);
  if(changed.changes!==1) return {kind:"conflict"};
  audit(req.user.id,a.id,"submitted","Sent for review");
  return {kind:"updated"};
 });
 const result=transition.immediate();
 if(result.kind==="missing") return res.status(404).json({error:"Alert not found"});
 if(result.kind==="conflict") return res.status(409).json({error:"Only drafts can be submitted"});
 res.json({ok:true,workflow:"pending"});
});
app.post("/api/alerts/:id/approve",auth,roles("admin","reviewer","approver"),(req,res)=>{
 const transition=db.transaction(()=>{
  const a=db.prepare("SELECT id,workflow,created_by FROM alerts WHERE id=?").get(req.params.id);
  if(!a) return {kind:"missing"};
  if(a.workflow!=="pending") return {kind:"conflict"};
  if(a.created_by===req.user.id) return {kind:"forbidden"};
  const changed=db.prepare("UPDATE alerts SET workflow='approved',approved_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND workflow='pending'").run(req.user.id,a.id);
  if(changed.changes!==1) return {kind:"conflict"};
  audit(req.user.id,a.id,"approved","Approved by authorized reviewer");
  return {kind:"updated"};
 });
 const result=transition.immediate();
 if(result.kind==="missing") return res.status(404).json({error:"Alert not found"});
 if(result.kind==="forbidden") return res.status(403).json({error:"A warning creator cannot approve their own warning; an independent reviewer is required."});
 if(result.kind==="conflict") return res.status(409).json({error:"Only pending alerts can be approved"});
 res.json({ok:true,workflow:"approved"});
});
app.post("/api/alerts/:id/publish",auth,roles("admin","publisher"),(req,res)=>{
 const transition=db.transaction(()=>{
  const a=db.prepare("SELECT * FROM alerts WHERE id=?").get(req.params.id);
  if(!a) return {kind:"missing"};
  if(a.workflow!=="approved") return {kind:"conflict"};
  if(a.approved_by===req.user.id) return {kind:"forbidden"};
  let cancellationSource=null;
  if(["Update","Cancel"].includes(a.msg_type)) {
   const references=(a.references_text || "").trim().split(/\s+/);
   if(references.length!==1) return {kind:"invalid_reference"};
   const parts=references[0].split(",");
   if(parts.length!==3 || parts.some(part=>!part)) return {kind:"invalid_reference"};
   cancellationSource=db.prepare("SELECT id,workflow,sent FROM alerts WHERE sender=? AND identifier=?").get(parts[0],parts[1]);
   if(!cancellationSource) return {kind:"source_missing"};
   const referenceTime=Date.parse(parts[2]);
   const sourceTime=Date.parse(cancellationSource.sent);
   if(!Number.isFinite(referenceTime) || !Number.isFinite(sourceTime) ||
      Math.floor(referenceTime/1000)!==Math.floor(sourceTime/1000)) return {kind:"invalid_reference"};
   if(cancellationSource.workflow!=="published") return {kind:"source_not_active"};
  }
  const changed=db.prepare("UPDATE alerts SET workflow='published',status=?,published_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND workflow='approved'").run(a.status,a.id);
  if(changed.changes!==1) return {kind:"conflict"};
  const sourceCancelled=a.msg_type==="Cancel" && a.status===cancellationSource?.status && a.status!=="Test";
  if(sourceCancelled) {
   const cancelled=db.prepare("UPDATE alerts SET workflow='cancelled',updated_at=CURRENT_TIMESTAMP WHERE id=? AND workflow='published'").run(cancellationSource.id);
   if(cancelled.changes!==1) return {kind:"source_not_active"};
  }
  const published=db.prepare("SELECT * FROM alerts WHERE id=?").get(a.id);
  const delivery=enqueueDelivery(db,{alertId:a.id,channel:"cap_feed",payload:buildCapXml(rowToCap(published))});
  audit(req.user.id,a.id,"published",a.msg_type==="Cancel"
   ? (sourceCancelled
      ? "Published CAP cancellation; matching-status source warning moved to cancelled; internal CAP feed entry "+delivery.id+" queued"
      : "Published non-operational CAP cancellation message; source warning state unchanged; internal CAP feed entry "+delivery.id+" queued")
   : "Published to internal CAP feed; distribution outbox entry "+delivery.id+" queued");
  return {kind:"updated",delivery};
 });
 const result=transition.immediate();
 if(result.kind==="missing") return res.status(404).json({error:"Alert not found"});
 if(result.kind==="forbidden") return res.status(403).json({error:"The approving user cannot publish the same warning; a separate publisher is required."});
 if(result.kind==="invalid_reference") return res.status(409).json({error:"Derived CAP messages must reference exactly one valid prior message"});
 if(result.kind==="source_missing") return res.status(409).json({error:"The referenced source message is not present in the local alert history"});
 if(result.kind==="source_not_active") return res.status(409).json({error:"The referenced source message is no longer active and cannot be updated or cancelled"});
 if(result.kind==="conflict") return res.status(409).json({error:"Approval is required before publishing"});
 const delivery=result.delivery;
 res.json({ok:true,workflow:"published",delivery:{id:delivery.id,status:delivery.status,channel:delivery.channel},note:"Internal publication only. External delivery adapters remain disabled; the outbox entry is queued for controlled processing."});
});
app.get("/api/webhooks/inbox",auth,roles("admin","reviewer"),(req,res)=>{
 const status=req.query.status;
 if(status!==undefined && !["pending","reviewed","rejected"].includes(status)) return res.status(400).json({error:"Invalid webhook inbox status"});
 const beforeRaw=req.query.before_id;
 let beforeId=null;
 if(beforeRaw!==undefined) {
  if(!/^[1-9]\d*$/.test(beforeRaw) || !Number.isSafeInteger(Number(beforeRaw))) return res.status(400).json({error:"Invalid webhook inbox cursor"});
  beforeId=Number(beforeRaw);
 }
 const rows=db.prepare(`SELECT w.id,w.received_at,w.source_timestamp,w.payload_json,w.status,w.reviewed_at,w.review_note,w.reviewed_by,u.username AS reviewer_username FROM webhook_inbox w LEFT JOIN users u ON u.id=w.reviewed_by WHERE (? IS NULL OR w.status=?) AND (? IS NULL OR w.id < ?) ORDER BY w.id DESC LIMIT 101`).all(status ?? null,status ?? null,beforeId,beforeId);
 const hasMore=rows.length>100;
 const page=rows.slice(0,100);
 res.json({
  messages:page.map(row=>({...row,payload:JSON.parse(row.payload_json),payload_json:undefined})),
  has_more:hasMore,
  next_before_id:hasMore?page[page.length-1].id:null
 });
});
app.patch("/api/webhooks/inbox/:id/review",auth,roles("admin","reviewer"),(req,res)=>{
 const id=Number(req.params.id);
 if(!Number.isSafeInteger(id) || id<1) return res.status(400).json({error:"Invalid inbox id"});
 try {
  const data=z.object({status:z.enum(["reviewed","rejected"]),note:z.string().max(2000).optional().default("")}).parse(req.body);
  const result=db.prepare("UPDATE webhook_inbox SET status=?,reviewed_at=CURRENT_TIMESTAMP,reviewed_by=?,review_note=? WHERE id=? AND status='pending'").run(data.status,req.user.id,data.note,id);
  if(!result.changes) return res.status(409).json({error:"Webhook message is missing or no longer pending"});
  audit(req.user.id,null,"webhook_inbox_"+data.status,`Reviewed inbound webhook message ${id}`);
  res.json({ok:true,id,status:data.status,reviewed_by:req.user.id,reviewer_username:req.user.username});
 } catch(error) { res.status(400).json({error:error.message}); }
});

app.get("/api/delivery/outbox",auth,roles("admin","publisher"),(req,res)=>{
 const status=req.query.status;
 if(status!==undefined && !["queued","sending","delivered","failed","dead_letter"].includes(status)) return res.status(400).json({error:"Invalid delivery status filter"});
 const rows=db.prepare(`SELECT d.id,d.alert_id,d.channel,CASE WHEN d.dead_letter_at IS NOT NULL THEN 'dead_letter' ELSE d.status END AS status,d.attempts,d.max_attempts,d.next_attempt_at,d.dead_letter_at,d.external_id,d.last_error,d.created_at,d.updated_at,d.last_attempt_at,d.delivered_at,a.identifier,a.headline
  FROM delivery_outbox d JOIN alerts a ON a.id=d.alert_id
  WHERE (? IS NULL OR (?='dead_letter' AND d.dead_letter_at IS NOT NULL) OR (?<>'dead_letter' AND d.status=? AND d.dead_letter_at IS NULL)) ORDER BY d.created_at DESC LIMIT 500`).all(status ?? null,status ?? null,status ?? null,status ?? null);
 const counts=db.prepare(`SELECT
  COALESCE(SUM(CASE WHEN dead_letter_at IS NOT NULL THEN 1 ELSE 0 END),0) AS dead_letter,
  COALESCE(SUM(CASE WHEN dead_letter_at IS NULL AND status='queued' THEN 1 ELSE 0 END),0) AS queued,
  COALESCE(SUM(CASE WHEN dead_letter_at IS NULL AND status='sending' THEN 1 ELSE 0 END),0) AS sending,
  COALESCE(SUM(CASE WHEN dead_letter_at IS NULL AND status='failed' THEN 1 ELSE 0 END),0) AS failed,
  COALESCE(SUM(CASE WHEN dead_letter_at IS NULL AND status='delivered' THEN 1 ELSE 0 END),0) AS delivered
  FROM delivery_outbox`).get();
 res.json({deliveries:rows,counts,external_adapters_enabled:false});
});
app.post("/api/delivery/process-retries",auth,roles("admin","publisher"),(req,res)=>{
 const result=processDueRetries(db);
 for(const item of result.requeued) audit(req.user.id,item.alert_id,"delivery_auto_retry_queued",`Automatically requeued outbox entry ${item.id}`);
 for(const item of result.deadLettered) audit(req.user.id,item.alert_id,"delivery_dead_lettered",`Moved outbox entry ${item.id} to dead-letter state`);
 res.json({ok:true,requeued_count:result.requeued.length,requeued_ids:result.requeued.map(item=>item.id),dead_lettered_count:result.deadLettered.length,dead_letter_ids:result.deadLettered.map(item=>item.id)});
});

app.post("/api/delivery/recover-stale",auth,roles("admin","publisher"),(req,res)=>{
 const staleMinutes=req.body?.staleMinutes ?? 10;
 if(!Number.isInteger(staleMinutes) || staleMinutes<1 || staleMinutes>1440) return res.status(400).json({error:"staleMinutes must be an integer from 1 to 1440"});
 const result=recoverStaleDeliveries(db,staleMinutes);
 for(const item of result.recovered) audit(req.user.id,item.alert_id,"delivery_lease_recovered",`Recovered stale sending lease for outbox entry ${item.id}`);
 for(const item of result.deadLettered) audit(req.user.id,item.alert_id,"delivery_lease_dead_lettered",`Dead-lettered stale sending lease after maximum attempts for outbox entry ${item.id}`);
 res.json({ok:true,recovered_count:result.recovered.length,recovered_ids:result.recovered.map(item=>item.id),dead_lettered_count:result.deadLettered.length,dead_letter_ids:result.deadLettered.map(item=>item.id),stale_minutes:staleMinutes});
});

app.post("/api/delivery/outbox/:id/claim",auth,roles("admin","publisher"),(req,res)=>{
 const deliveryId=Number(req.params.id);
 if(!Number.isSafeInteger(deliveryId) || deliveryId<1) return res.status(400).json({error:"Invalid delivery id"});
 const delivery=claimDelivery(db,deliveryId);
 if(!delivery) return res.status(409).json({error:"Delivery is not queued or has already been claimed"});
 audit(req.user.id,delivery.alert_id,"delivery_claimed",`Claimed outbox entry ${delivery.id}; no external transmission is performed by this endpoint`);
 res.json({delivery:{id:delivery.id,alert_id:delivery.alert_id,channel:delivery.channel,status:delivery.status,attempts:delivery.attempts,payload:delivery.payload,lease_token:delivery.lease_token},external_adapters_enabled:false});
});
app.post("/api/delivery/outbox/:id/receipt",auth,roles("admin","publisher"),(req,res)=>{
 const deliveryId=Number(req.params.id);
 if(!Number.isSafeInteger(deliveryId) || deliveryId<1) return res.status(400).json({error:"Invalid delivery id"});
 try {
  const receiptSchema=z.object({status:z.enum(["delivered","failed"]),leaseToken:z.string().uuid(),externalId:z.string().max(256).optional(),details:z.string().max(2000).optional()});
  const data=receiptSchema.parse(req.body);
  const delivery=recordDeliveryReceipt(db,deliveryId,data);
  if(!delivery) return res.status(409).json({error:"A receipt can only be recorded for a sending delivery"});
  audit(req.user.id,delivery.alert_id,"delivery_"+delivery.status,`Receipt recorded for outbox entry ${delivery.id}`);
  res.json({ok:true,delivery:{id:delivery.id,status:delivery.status,attempts:delivery.attempts,external_id:delivery.external_id}});
 } catch(error) { res.status(400).json({error:error.message}); }
});
app.post("/api/delivery/outbox/:id/retry",auth,roles("admin","publisher"),(req,res)=>{
 const deliveryId=Number(req.params.id);
 if(!Number.isSafeInteger(deliveryId) || deliveryId<1) return res.status(400).json({error:"Invalid delivery id"});
 const delivery=retryDelivery(db,deliveryId);
 if(!delivery) return res.status(409).json({error:"Only failed deliveries can be retried"});
 audit(req.user.id,delivery.alert_id,"delivery_retry_queued",`Requeued outbox entry ${delivery.id}`);
 res.json({ok:true,delivery:{id:delivery.id,status:delivery.status,attempts:delivery.attempts}});
});

app.get("/api/alerts/:id/cap.xml",auth,(req,res)=>{
 const a=db.prepare("SELECT * FROM alerts WHERE id=?").get(req.params.id);
 if(!a) return res.status(404).json({error:"Alert not found"});
 try {
  const xml=buildCapXml(rowToCap(a));
  res.type("application/xml").attachment(`${a.identifier.replace(/[^a-z0-9-]/gi,"_")}.xml`).send(xml);
 } catch(e) { res.status(400).json({error:e.message}); }
});
app.get("/api/public/alerts.geojson", (req,res)=>{
 try {
  const rows=db.prepare("SELECT identifier,sender,sent,status,msg_type,scope,references_text,event,category,response_type,urgency,severity,certainty,effective,onset,expires,headline,description,instruction,area_desc,polygon,circle,language,info_json FROM alerts WHERE workflow='published' AND scope='Public' AND status='Actual' AND (expires IS NULL OR expires='' OR julianday(expires)>julianday('now')) ORDER BY sent DESC LIMIT 100").all();
  res.type("application/geo+json").json(alertsToGeoJSON(rows));
 } catch(error) {
  console.error("Public GeoJSON export failed:",error);
  res.status(500).json({error:"Unable to generate the public GeoJSON feed"});
 }
});
app.get("/api/public/alerts", (req,res)=>{
 const rows=db.prepare("SELECT identifier,sender,sent,status,msg_type,scope,references_text,event,category,response_type,urgency,severity,certainty,effective,onset,expires,headline,description,instruction,area_desc,polygon,circle,language,info_json FROM alerts WHERE workflow='published' AND scope='Public' AND status='Actual' AND (expires IS NULL OR expires='' OR julianday(expires)>julianday('now')) ORDER BY sent DESC LIMIT 100").all();
 res.json({alerts:rows.map(row=>{const {info_json,...alert}=row;return {...alert,info_blocks:info_json?JSON.parse(info_json):[]};})});
});
app.get("/api/audit/verify",auth,roles("admin","reviewer","approver"),(_req,res)=>{
 res.json(verifyAuditChain(db));
});

app.get("/api/audit",auth,roles("admin","reviewer","approver"),(req,res)=>{
 const rawLimit=req.query.limit===undefined?"500":req.query.limit;
 const limit=Number(rawLimit);
 if(!/^[0-9]+$/.test(String(rawLimit)) || !Number.isSafeInteger(limit) || limit<1 || limit>500) {
  return res.status(400).json({error:"limit must be an integer between 1 and 500"});
 }
 let beforeId=null;
 if(req.query.before_id!==undefined) {
  const rawCursor=String(req.query.before_id);
  beforeId=Number(rawCursor);
  if(!/^[0-9]+$/.test(rawCursor) || !Number.isSafeInteger(beforeId) || beforeId<1) {
   return res.status(400).json({error:"before_id must be a positive safe integer"});
  }
 }
 const rows=beforeId===null
  ? db.prepare(`SELECT l.*,u.username FROM audit_log l LEFT JOIN users u ON u.id=l.user_id ORDER BY l.id DESC LIMIT ?`).all(limit+1)
  : db.prepare(`SELECT l.*,u.username FROM audit_log l LEFT JOIN users u ON u.id=l.user_id WHERE l.id<? ORDER BY l.id DESC LIMIT ?`).all(beforeId,limit+1);
 const hasMore=rows.length>limit;
 const entries=rows.slice(0,limit);
 res.json({entries,has_more:hasMore,next_before_id:hasMore?entries.at(-1).id:null});
});

app.get("*",(req,res)=>res.sendFile(path.join(appRoot, "public", "index.html")));
app.listen(port,process.env.HOST || "127.0.0.1",()=>console.log(`Meteo CAP Warning System running at http://${process.env.HOST || "127.0.0.1"}:${port}`));
