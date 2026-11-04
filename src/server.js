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

ensureAdmin();
const app = express();
const port = Number(process.env.PORT || 8095);
const secret = process.env.JWT_SECRET;
if (!secret || secret.length < 32) {
 console.warn("WARNING: Set JWT_SECRET to a unique random value of at least 32 characters.");
}
app.use(helmet({ contentSecurityPolicy: false }));
const origins = (process.env.CORS_ORIGINS || "").split(",").map(s=>s.trim()).filter(Boolean);
app.use(cors({ origin: origins.length ? origins : false }));
app.use(express.json({ limit: "1mb" }));
app.use("/api/auth", rateLimit({ windowMs: 15*60*1000, limit: 30 }));
app.use(express.static("public"));

const schema = z.object({
 event:z.string().min(2), category:z.string().default("Met"),
 urgency:z.enum(["Immediate","Expected","Future","Past","Unknown"]).default("Unknown"),
 severity:z.enum(["Extreme","Severe","Moderate","Minor","Unknown"]).default("Unknown"),
 certainty:z.enum(["Observed","Likely","Possible","Unlikely","Unknown"]).default("Unknown"),
 scope:z.enum(["Public","Restricted","Private"]).default("Public"),
 headline:z.string().min(3), description:z.string().min(3),
 instruction:z.string().optional().default(""), area_desc:z.string().min(2),
 polygon:z.string().optional().default(""), circle:z.string().optional().default(""),
 effective:z.string().optional().default(""), onset:z.string().optional().default(""),
 expires:z.string().optional().default(""), language:z.string().default("en-US"),
 response_type:z.string().optional().default(""),
 status:z.enum(["Actual","Exercise","System","Test"]).default("Test")
});

function auth(req,res,next) {
 const token = (req.headers.authorization || "").replace(/^Bearer\\s+/i,"");
 try {
   req.user = jwt.verify(token, secret);
   const user = db.prepare("SELECT id,username,role,active FROM users WHERE id=?").get(req.user.id);
   if (!user || !user.active) return res.status(401).json({error:"Account unavailable"});
   req.user = user; next();
 } catch { return res.status(401).json({error:"Authentication required"}); }
}
const roles = (...allowed) => (req,res,next) => allowed.includes(req.user.role) ? next() : res.status(403).json({error:"Insufficient permissions"});
function audit(userId, alertId, action, details="") {
 db.prepare("INSERT INTO audit_log(user_id,alert_id,action,details) VALUES(?,?,?,?)").run(userId,alertId,action,details);
}
function rowToCap(r) {
 return {...r, msg_type:r.msg_type, area_desc:r.area_desc, response_type:r.response_type};
}

app.get("/api/health", (_req,res)=>res.json({ok:true,service:"Meteo CAP Warning System",cap:"1.2"}));
app.post("/api/auth/login", (req,res)=>{
 const {username,password} = req.body || {};
 const user = db.prepare("SELECT * FROM users WHERE username=? AND active=1").get(username);
 if (!user || !bcrypt.compareSync(password || "", user.password_hash)) return res.status(401).json({error:"Invalid credentials"});
 const token = jwt.sign({id:user.id}, secret, {expiresIn:"8h"});
 res.json({token,user:{id:user.id,username:user.username,role:user.role}});
});
app.get("/api/me",auth,(req,res)=>res.json({user:req.user}));

app.get("/api/alerts",auth,(req,res)=>{
 const rows = db.prepare("SELECT id,identifier,event,urgency,severity,certainty,headline,area_desc,workflow,sent,expires,status,msg_type FROM alerts ORDER BY sent DESC LIMIT 500").all();
 res.json({alerts:rows});
});
app.get("/api/alerts/:id",auth,(req,res)=>{
 const row = db.prepare("SELECT * FROM alerts WHERE id=?").get(req.params.id);
 if (!row) return res.status(404).json({error:"Alert not found"});
 res.json({alert:row});
});
app.post("/api/alerts",auth,roles("admin","forecaster"),(req,res)=>{
 try {
  const data = schema.parse(req.body);
  const sent = new Date().toISOString();
  const alert = {
   ...data, identifier:makeIdentifier(), sender:process.env.CAP_SENDER || "alerts@example.org",
   sent, msg_type:"Alert", status:data.status, workflow:"draft",
   references_text:"", created_by:req.user.id
  };
  validateAlert(alert);
  const result = db.prepare(`INSERT INTO alerts
   (identifier,sender,sent,status,msg_type,scope,references_text,event,category,response_type,urgency,severity,certainty,effective,onset,expires,headline,description,instruction,area_desc,polygon,circle,language,workflow,created_by)
   VALUES (@identifier,@sender,@sent,@status,@msg_type,@scope,@references_text,@event,@category,@response_type,@urgency,@severity,@certainty,@effective,@onset,@expires,@headline,@description,@instruction,@area_desc,@polygon,@circle,@language,@workflow,@created_by)`).run(alert);
  audit(req.user.id,result.lastInsertRowid,"created","Draft created");
  res.status(201).json({id:result.lastInsertRowid,identifier:alert.identifier});
 } catch(e) { res.status(400).json({error:e.message}); }
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
 db.prepare("UPDATE alerts SET workflow='approved',approved_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(req.user.id,a.id);
 audit(req.user.id,a.id,"approved","Approved by authorized reviewer");
 res.json({ok:true,workflow:"approved"});
});
app.post("/api/alerts/:id/publish",auth,roles("admin","publisher"),(req,res)=>{
 const a=db.prepare("SELECT * FROM alerts WHERE id=?").get(req.params.id);
 if(!a) return res.status(404).json({error:"Alert not found"});
 if(a.workflow!=="approved") return res.status(409).json({error:"Approval is required before publishing"});
 const publishedStatus = a.status === "Test" ? "Test" : "Actual";
 db.prepare("UPDATE alerts SET workflow='published',status=?,published_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(publishedStatus,a.id);
 audit(req.user.id,a.id,"published","Published to internal CAP feed");
 res.json({ok:true,workflow:"published",note:"Internal publication only; external distribution connectors are not configured."});
});
app.get("/api/alerts/:id/cap.xml",auth,(req,res)=>{
 const a=db.prepare("SELECT * FROM alerts WHERE id=?").get(req.params.id);
 if(!a) return res.status(404).json({error:"Alert not found"});
 try {
  const xml=buildCapXml(rowToCap(a));
  res.type("application/xml").attachment(`${a.identifier.replace(/[^a-z0-9-]/gi,"_")}.xml`).send(xml);
 } catch(e) { res.status(400).json({error:e.message}); }
});
app.get("/api/public/alerts", (req,res)=>{
 const rows=db.prepare("SELECT identifier,sender,sent,status,msg_type,scope,event,urgency,severity,certainty,headline,description,area_desc,onset,expires FROM alerts WHERE workflow='published' AND scope='Public' ORDER BY sent DESC LIMIT 100").all();
 res.json({alerts:rows});
});
app.get("/api/audit",auth,roles("admin","reviewer","approver"),(_req,res)=>{
 res.json({entries:db.prepare(`SELECT l.*,u.username FROM audit_log l LEFT JOIN users u ON u.id=l.user_id ORDER BY l.id DESC LIMIT 500`).all()});
});

app.get("*",(req,res)=>res.sendFile(process.cwd()+"/public/index.html"));
app.listen(port,process.env.HOST || "127.0.0.1",()=>console.log(`Meteo CAP Warning System running at http://${process.env.HOST || "127.0.0.1"}:${port}`));
