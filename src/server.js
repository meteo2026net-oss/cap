import "dotenv/config";
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

const app = express();
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
app.use(helmet({ contentSecurityPolicy: false }));
const origins = (process.env.CORS_ORIGINS || "").split(",").map(s=>s.trim()).filter(Boolean);
app.use(cors({ origin: origins.length ? origins : false }));
app.use(express.json({ limit: "1mb" }));
app.use("/api", rateLimit({ windowMs: 15*60*1000, limit: 300, standardHeaders: true, legacyHeaders: false }));
app.use("/api/auth", rateLimit({ windowMs: 15*60*1000, limit: 30, standardHeaders: true, legacyHeaders: false }));
app.use(express.static("public"));

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
   const user = db.prepare("SELECT id,username,role,active,token_version FROM users WHERE id=?").get(req.user.id);
   if (!user || !user.active) return res.status(401).json({error:"Account unavailable"});
   if (req.user.token_version !== user.token_version) return res.status(401).json({error:"Session expired; please sign in again"});
   req.user = user; next();
 } catch { return res.status(401).json({error:"Authentication required"}); }
}
const roles = (...allowed) => (req,res,next) => allowed.includes(req.user.role) ? next() : res.status(403).json({error:"Insufficient permissions"});
function audit(userId, alertId, action, details="") {
 appendAuditLog(db, { userId, alertId, action, details });
}
function rowToCap(r) {
 return {...r, msg_type:r.msg_type, area_desc:r.area_desc, response_type:r.response_type, info_blocks:r.info_json ? JSON.parse(r.info_json) : undefined};
}

app.get("/api/health", (_req,res)=>res.json({ok:true,service:"Meteo CAP Warning System",cap:"1.2"}));
app.post("/api/auth/login", (req,res)=>{
 const {username,password} = req.body || {};
 const user = db.prepare("SELECT * FROM users WHERE username=? AND active=1").get(username);
 if (!user || !bcrypt.compareSync(password || "", user.password_hash)) return res.status(401).json({error:"Invalid credentials"});
 const token = jwt.sign({id:user.id,token_version:user.token_version}, secret, {expiresIn:"8h"});
 res.json({token,user:{id:user.id,username:user.username,role:user.role}});
});
app.post("/api/auth/change-password",auth,rateLimit({windowMs:15*60*1000,limit:5}),(req,res)=>{
 const {currentPassword,newPassword}=req.body || {};
 if(typeof newPassword!=="string" || newPassword.length<14 || newPassword.length>200) return res.status(400).json({error:"New password must contain 14 to 200 characters"});
 const row=db.prepare("SELECT password_hash FROM users WHERE id=?").get(req.user.id);
 if(!row || !bcrypt.compareSync(currentPassword || "",row.password_hash)) return res.status(401).json({error:"Current password is incorrect"});
 const hash=bcrypt.hashSync(newPassword,12);
 db.prepare("UPDATE users SET password_hash=?,token_version=token_version+1 WHERE id=?").run(hash,req.user.id);
 const tokenVersion=db.prepare("SELECT token_version FROM users WHERE id=?").get(req.user.id).token_version;
 const token=jwt.sign({id:req.user.id,token_version:tokenVersion},secret,{expiresIn:"8h"});
 audit(req.user.id,null,"password_changed","Password changed; all previous sessions revoked");
 res.json({ok:true,token,session_revoked_for_other_devices:true});
});
app.get("/api/me",auth,(req,res)=>res.json({user:req.user}));

const userSchema = z.object({
 username: z.string().min(3).max(64).regex(/^[a-zA-Z0-9._-]+$/),
 password: z.string().min(14).max(200),
 role: z.enum(["admin","forecaster","reviewer","approver","publisher","viewer"])
});
app.get("/api/users",auth,roles("admin"),(_req,res)=>{
 const users=db.prepare("SELECT id,username,role,active,created_at FROM users ORDER BY id").all();
 res.json({users});
});
app.post("/api/users",auth,roles("admin"),(req,res)=>{
 try {
  const data=userSchema.parse(req.body);
  const hash=bcrypt.hashSync(data.password,12);
  const result=db.prepare("INSERT INTO users(username,password_hash,role) VALUES(?,?,?)").run(data.username,hash,data.role);
  audit(req.user.id,null,"user_created",`Created user ${data.username} with role ${data.role}`);
  res.status(201).json({id:result.lastInsertRowid,username:data.username,role:data.role});
 } catch(e) {
  if(e.code==="SQLITE_CONSTRAINT_UNIQUE") return res.status(409).json({error:"Username already exists"});
  res.status(400).json({error:e.message});
 }
});

app.patch("/api/users/:id/status",auth,roles("admin"),(req,res)=>{
 const active=req.body?.active;
 if(typeof active!=="boolean") return res.status(400).json({error:"active must be a boolean"});
 const target=db.prepare("SELECT id,username,role,active FROM users WHERE id=?").get(req.params.id);
 if(!target) return res.status(404).json({error:"User not found"});
 if(target.id===req.user.id && !active) return res.status(409).json({error:"You cannot deactivate your own administrator account"});
 if(!active && target.role==="admin") {
  const activeAdmins=db.prepare("SELECT COUNT(*) AS count FROM users WHERE role='admin' AND active=1").get().count;
  if(activeAdmins<=1) return res.status(409).json({error:"At least one active administrator must remain"});
 }
 db.prepare("UPDATE users SET active=? WHERE id=?").run(active?1:0,target.id);
 audit(req.user.id,null,active?"user_activated":"user_deactivated",`${active?"Activated":"Deactivated"} user ${target.username}`);
 res.json({ok:true,id:target.id,active});
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
 const original=db.prepare("SELECT * FROM alerts WHERE id=?").get(req.params.id);
 if(!original) return res.status(404).json({error:"Source alert not found"});
 if(!["approved","published"].includes(original.workflow)) return res.status(409).json({error:"Only reviewed alerts can be used as the source of an update or cancellation"});
 const msgType=req.body?.msg_type;
 if(!["Update","Cancel"].includes(msgType)) return res.status(400).json({error:"msg_type must be Update or Cancel"});
 const sent=new Date().toISOString();
 const {id:_id,approved_by:_approvedBy,published_at:_publishedAt,created_at:_createdAt,updated_at:_updatedAt,...sourceFields}=original;
 const alert={...sourceFields,identifier:makeIdentifier(),sent,status:"Test",msg_type:msgType,
  references_text:`${original.sender},${original.identifier},${original.sent.replace(/\.\d{3}Z$/, "-00:00")}`,
  info_json:msgType==="Cancel"?null:original.info_json,workflow:"draft",created_by:req.user.id};
 const result=db.prepare(`INSERT INTO alerts
 (identifier,sender,sent,status,msg_type,scope,references_text,event,category,response_type,urgency,severity,certainty,effective,onset,expires,headline,description,instruction,area_desc,polygon,circle,language,info_json,workflow,created_by)
 VALUES (@identifier,@sender,@sent,@status,@msg_type,@scope,@references_text,@event,@category,@response_type,@urgency,@severity,@certainty,@effective,@onset,@expires,@headline,@description,@instruction,@area_desc,@polygon,@circle,@language,@info_json,@workflow,@created_by)`).run(alert);
 audit(req.user.id,result.lastInsertRowid,msgType.toLowerCase(),`Created ${msgType} referencing ${original.identifier}; held as Test pending review`);
 res.status(201).json({id:result.lastInsertRowid,identifier:alert.identifier,msg_type:msgType,status:"Test",workflow:"draft",references:alert.references_text});
});

app.post("/api/alerts/:id/submit",auth,roles("admin","forecaster"),(req,res)=>{
 const a=db.prepare("SELECT * FROM alerts WHERE id=?").get(req.params.id);
 if(!a) return res.status(404).json({error:"Alert not found"});
 if(a.workflow!=="draft") return res.status(409).json({error:"Only drafts can be submitted"});
 db.prepare("UPDATE alerts SET workflow='pending',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(a.id);
 audit(req.user.id,a.id,"submitted","Sent for review");
 res.json({ok:true,workflow:"pending"});
});
app.post("/api/alerts/:id/approve",auth,roles("admin","reviewer","approver"),(req,res)=>{
 const a=db.prepare("SELECT * FROM alerts WHERE id=?").get(req.params.id);
 if(!a) return res.status(404).json({error:"Alert not found"});
 if(a.workflow!=="pending") return res.status(409).json({error:"Only pending alerts can be approved"});
 if(a.created_by===req.user.id) return res.status(403).json({error:"A warning creator cannot approve their own warning; an independent reviewer is required."});
 db.prepare("UPDATE alerts SET workflow='approved',approved_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(req.user.id,a.id);
 audit(req.user.id,a.id,"approved","Approved by authorized reviewer");
 res.json({ok:true,workflow:"approved"});
});
app.post("/api/alerts/:id/publish",auth,roles("admin","publisher"),(req,res)=>{
 const a=db.prepare("SELECT * FROM alerts WHERE id=?").get(req.params.id);
 if(!a) return res.status(404).json({error:"Alert not found"});
 if(a.workflow!=="approved") return res.status(409).json({error:"Approval is required before publishing"});
 if(a.approved_by===req.user.id) return res.status(403).json({error:"The approving user cannot publish the same warning; a separate publisher is required."});
 const publishedStatus = a.status;
 const delivery = db.transaction(() => {
  db.prepare("UPDATE alerts SET workflow='published',status=?,published_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(publishedStatus,a.id);
  const published = db.prepare("SELECT * FROM alerts WHERE id=?").get(a.id);
  return enqueueDelivery(db,{alertId:a.id,channel:"cap_feed",payload:buildCapXml(rowToCap(published))});
 })();
 audit(req.user.id,a.id,"published","Published to internal CAP feed; distribution outbox entry "+delivery.id+" queued");
 res.json({ok:true,workflow:"published",delivery:{id:delivery.id,status:delivery.status,channel:delivery.channel},note:"Internal publication only. External delivery adapters remain disabled; the outbox entry is queued for controlled processing."});
});
app.get("/api/delivery/outbox",auth,roles("admin","publisher"),(req,res)=>{
 const status=req.query.status;
 if(status!==undefined && !["queued","sending","delivered","failed","dead_letter"].includes(status)) return res.status(400).json({error:"Invalid delivery status filter"});
 const rows=db.prepare(`SELECT d.id,d.alert_id,d.channel,CASE WHEN d.dead_letter_at IS NOT NULL THEN 'dead_letter' ELSE d.status END AS status,d.attempts,d.max_attempts,d.next_attempt_at,d.dead_letter_at,d.external_id,d.last_error,d.created_at,d.updated_at,d.last_attempt_at,d.delivered_at,a.identifier,a.headline
  FROM delivery_outbox d JOIN alerts a ON a.id=d.alert_id
  WHERE (? IS NULL OR (?='dead_letter' AND d.dead_letter_at IS NOT NULL) OR (?<>'dead_letter' AND d.status=? AND d.dead_letter_at IS NULL)) ORDER BY d.created_at DESC LIMIT 500`).all(status ?? null,status ?? null,status ?? null,status ?? null);
 res.json({deliveries:rows,external_adapters_enabled:false});
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
 res.json({delivery:{id:delivery.id,alert_id:delivery.alert_id,channel:delivery.channel,status:delivery.status,attempts:delivery.attempts,payload:delivery.payload},external_adapters_enabled:false});
});
app.post("/api/delivery/outbox/:id/receipt",auth,roles("admin","publisher"),(req,res)=>{
 const deliveryId=Number(req.params.id);
 if(!Number.isSafeInteger(deliveryId) || deliveryId<1) return res.status(400).json({error:"Invalid delivery id"});
 try {
  const receiptSchema=z.object({status:z.enum(["delivered","failed"]),externalId:z.string().max(256).optional(),details:z.string().max(2000).optional()});
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

app.get("/api/audit",auth,roles("admin","reviewer","approver"),(_req,res)=>{
 res.json({entries:db.prepare(`SELECT l.*,u.username FROM audit_log l LEFT JOIN users u ON u.id=l.user_id ORDER BY l.id DESC LIMIT 500`).all()});
});

app.get("*",(req,res)=>res.sendFile(process.cwd()+"/public/index.html"));
app.listen(port,process.env.HOST || "127.0.0.1",()=>console.log(`Meteo CAP Warning System running at http://${process.env.HOST || "127.0.0.1"}:${port}`));
