let token = "";
let currentRole = "";
let currentUserId = null;
let alertOffset = 0;
let alertHasMore = false;
const alertPageSize = 25;
const $ = s => document.querySelector(s);
const loginPanel=$("#loginPanel"), appPanel=$("#appPanel");
function headers(){return {"Content-Type":"application/json","Authorization":`Bearer ${token}`}}
async function api(url,opts={}){const r=await fetch(url,{...opts,headers:{...headers(),...(opts.headers||{})}});const data=await r.json().catch(()=>({}));if(!r.ok)throw new Error(data.error||"Request failed");return data}
function showApp(on){loginPanel.hidden=on;appPanel.hidden=!on}
let pendingMfaChallenge="";
async function finishLogin(d){
 token=d.token;currentRole=d.user.role;currentUserId=d.user.id;auditHistoryGeneration++;auditHistoryLoading=false;
 $("#userBadge").textContent=d.user.username+" • "+d.user.role;
 $("#deliveryMonitor").hidden=!["admin","publisher"].includes(currentRole);
 $("#webhookInboxMonitor").hidden=!["admin","reviewer"].includes(currentRole);
 $("#userAdmin").hidden=d.user.role!=="admin";
 const canVerifyAudit=["admin","reviewer","approver"].includes(d.user.role);
 $("#auditIntegrity").hidden=!canVerifyAudit;$("#auditHistoryPanel").hidden=!canVerifyAudit;
 showApp(true);
 const forcePasswordChange=d.password_change_required===true;
 appPanel.classList.toggle("password-change-required",forcePasswordChange);
 if(forcePasswordChange){$("#passwordStatus").textContent="أصدر المسؤول كلمة مرور مؤقتة لهذا الحساب. يجب تعيين كلمة مرور شخصية جديدة قبل متابعة أي عملية.";
  await loadMfaStatus();$("#mfaDisableForm").hidden=true;$("#mfaRecoveryRotateForm").hidden=true;return}
 await loadAlerts();initWarningMap();await refreshWarningMap();
 if(d.user.role==="admin")await loadUsers();
 if(canVerifyAudit){await loadAuditIntegrity();await loadAuditHistory();}
 if(["admin","publisher"].includes(currentRole))await loadDeliveryOutbox();
 if(["admin","reviewer"].includes(currentRole))await loadWebhookInbox();
 await loadMfaStatus();
}
$("#loginForm").addEventListener("submit",async e=>{
 e.preventDefault();const form=e.currentTarget;
 try{
  const response=await fetch("/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(Object.fromEntries(new FormData(form)))});
  const d=await response.json();
  if(d.mfa_required){pendingMfaChallenge=d.challenge_token;form.hidden=true;$("#mfaChallengeForm").hidden=false;$("#mfaChallengeError").textContent="أدخل رمز تطبيق المصادقة أو أحد رموز الاسترداد.";return}
  if(!d.token)throw new Error(d.error||"تعذر تسجيل الدخول");
  await finishLogin(d);
 }catch(err){$("#loginError").textContent=err.message}
});
$("#mfaChallengeForm").addEventListener("submit",async e=>{
 e.preventDefault();const code=new FormData(e.currentTarget).get("code");
 try{
  const response=await fetch("/api/auth/mfa/challenge",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({challenge_token:pendingMfaChallenge,code})});
  const d=await response.json();if(!response.ok||!d.token)throw new Error(d.error||"تعذر إكمال التحقق");
  pendingMfaChallenge="";e.currentTarget.reset();$("#mfaChallengeForm").hidden=true;$("#loginForm").hidden=false;await finishLogin(d);
 }catch(err){$("#mfaChallengeError").textContent=err.message}
});
$("#mfaBackToLogin").addEventListener("click",()=>{pendingMfaChallenge="";$("#mfaChallengeForm").hidden=true;$("#loginForm").hidden=false;$("#mfaChallengeError").textContent=""});
let warningMap=null, publishedGeoLayer=null, importedGeoLayer=null, drawnGeoLayer=null, drawControl=null;
$("#logoutBtn").onclick=()=>{token="";currentRole="";currentUserId=null;appPanel.classList.remove("password-change-required");pendingMfaChallenge="";auditHistoryGeneration++;auditHistoryLoading=false;auditHistoryCursor=null;showApp(false);$("#loginForm").hidden=false;$("#mfaChallengeForm").hidden=true;$("#userAdmin").hidden=true;$("#auditIntegrity").hidden=true;$("#auditHistoryPanel").hidden=true;$("#deliveryMonitor").hidden=true;$("#webhookInboxMonitor").hidden=true};
$("#passwordForm").addEventListener("submit",async e=>{
 e.preventDefault();
 const form=e.currentTarget, data=Object.fromEntries(new FormData(form));
 const status=$("#passwordStatus");
 if(data.newPassword!==data.confirmPassword){status.textContent="كلمتا المرور الجديدتان غير متطابقتين.";return}
 delete data.confirmPassword;
 status.textContent="جارٍ تحديث كلمة المرور...";
 try{
  const result=await api("/api/auth/change-password",{method:"POST",body:JSON.stringify(data)});
  token=result.token;
  form.reset();
  if(result.password_change_required===false){await finishLogin(result);status.textContent="تم تغيير كلمة المرور المؤقتة. يمكنك الآن استخدام النظام."}
  else status.textContent="تم تحديث كلمة المرور وإلغاء الجلسات السابقة. هذه الجلسة مستمرة بأمان.";
 }catch(error){status.textContent=error.message}
});
async function loadMfaStatus(){
 const status=$("#mfaStatus");
 try{
  const data=await api("/api/auth/mfa/status");
  status.textContent=data.enabled?"المصادقة متعددة العوامل مفعّلة. رموز الاسترداد المتبقية: "+data.recovery_codes_remaining:(data.required?"المصادقة متعددة العوامل إلزامية لدورك. أكمل إعدادها لفتح العمليات المحمية.":(data.pending?"يوجد إعداد غير مكتمل؛ يمكنك تأكيده قبل انتهاء صلاحيته.":"المصادقة متعددة العوامل غير مفعّلة لهذا الحساب."));
  $("#mfaEnrollForm").hidden=data.enabled;$("#mfaDisableForm").hidden=!data.enabled;$("#mfaRecoveryRotateForm").hidden=!data.enabled;$("#mfaEnrollment").hidden=true;
 }catch(error){status.textContent=error.message}
}
$("#mfaEnrollForm").addEventListener("submit",async e=>{
 e.preventDefault();const status=$("#mfaActionStatus");
 try{const data=await api("/api/auth/mfa/enroll",{method:"POST",body:JSON.stringify(Object.fromEntries(new FormData(e.currentTarget)))});
  $("#mfaSecret").textContent=data.secret;$("#mfaOtpAuth").textContent=data.otpauth_url;$("#mfaEnrollment").hidden=false;status.textContent="أدخل الرمز من تطبيق المصادقة لتأكيد التفعيل خلال 10 دقائق.";
 }catch(error){status.textContent=error.message}
});
$("#mfaConfirmForm").addEventListener("submit",async e=>{
 e.preventDefault();const status=$("#mfaActionStatus");
 try{const data=await api("/api/auth/mfa/confirm",{method:"POST",body:JSON.stringify(Object.fromEntries(new FormData(e.currentTarget)))});
  token=data.token;$("#mfaRecoveryCodes").textContent=data.recovery_codes.join("\n");$("#mfaRecoveryPanel").hidden=false;$("#mfaEnrollment").hidden=true;$("#mfaEnrollForm").reset();e.currentTarget.reset();
  status.textContent="تم تفعيل MFA. احفظ رموز الاسترداد الآن؛ لن تظهر مرة أخرى.";await loadMfaStatus();
 }catch(error){status.textContent=error.message}
});
$("#mfaDisableForm").addEventListener("submit",async e=>{
 e.preventDefault();const status=$("#mfaActionStatus");
 try{await api("/api/auth/mfa/disable",{method:"POST",body:JSON.stringify(Object.fromEntries(new FormData(e.currentTarget)))});
  e.currentTarget.reset();$("#mfaRecoveryPanel").hidden=true;$("#mfaRecoveryCodes").textContent="";status.textContent="تم تعطيل MFA وإلغاء الجلسات السابقة. سجّل الدخول مجدداً.";token="";currentRole="";showApp(false);$("#loginForm").hidden=false;
 }catch(error){status.textContent=error.message}
});
$("#mfaRecoveryRotateForm").addEventListener("submit",async e=>{
  e.preventDefault();const status=$("#mfaActionStatus");
  try{
   const data=await api("/api/auth/mfa/recovery-codes",{method:"POST",body:JSON.stringify(Object.fromEntries(new FormData(e.currentTarget)))});
   token=data.token;e.currentTarget.reset();$("#mfaRecoveryCodes").textContent=data.recovery_codes.join("\n");$("#mfaRecoveryPanel").hidden=false;
   status.textContent="تم إصدار مجموعة جديدة. أُبطلت جميع الرموز القديمة والجلسات السابقة؛ احفظ الرموز الجديدة الآن.";
   await loadMfaStatus();
  }catch(error){status.textContent=error.message}
 });
function initWarningMap(){
 if(warningMap||!window.L)return;
 warningMap=L.map("warningMap").setView([34.8,38.5],5);
 L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:18,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'}).addTo(warningMap);
 publishedGeoLayer=L.featureGroup().addTo(warningMap);
 drawnGeoLayer=L.featureGroup().addTo(warningMap);
 if(L.Control.Draw){
  drawControl=new L.Control.Draw({
   position:"topleft",
   draw:{polyline:false,rectangle:false,marker:false,circlemarker:false,polygon:{allowIntersection:false,showArea:true},circle:{showRadius:true}},
   edit:{featureGroup:drawnGeoLayer,remove:true}
  });
  warningMap.addControl(drawControl);
  warningMap.on(L.Draw.Event.CREATED,event=>{
   drawnGeoLayer.clearLayers();
   const layer=event.layer;drawnGeoLayer.addLayer(layer);
   applyDrawnGeometryToForm(layer);
  });
  warningMap.on(L.Draw.Event.EDITED,event=>{
   event.layers.eachLayer(layer=>applyDrawnGeometryToForm(layer));
  });
  warningMap.on(L.Draw.Event.DELETED,()=>{
   const polygonField=document.querySelector('[name="polygon"]');
   const circleField=document.querySelector('[name="circle"]');
   if(polygonField)polygonField.value="";
   if(circleField)circleField.value="";
   $("#mapStatus").textContent="تم حذف الشكل المرسوم وإزالة هندسته من نموذج التحذير.";
  });
 }
}
function applyDrawnGeometryToForm(layer){
 const polygonField=document.querySelector('[name="polygon"]');
 const circleField=document.querySelector('[name="circle"]');
 if(layer instanceof L.Circle){
  const center=layer.getLatLng();
  if(polygonField)polygonField.value="";
  if(circleField)circleField.value=window.circleToCap(center.lat,center.lng,layer.getRadius());
  $("#mapStatus").textContent="تم نقل مركز الدائرة ونصف قطرها إلى نموذج CAP.";
  return;
 }
 if(layer instanceof L.Polygon){
  const rings=layer.getLatLngs();
  const points=Array.isArray(rings[0])?rings[0]:rings;
  const capPolygon=window.polygonLatLngsToCap(points);
  const coords=capPolygon.split(" ");
  if(polygonField)polygonField.value=capPolygon;
  if(circleField)circleField.value="";
  $("#mapStatus").textContent="تم نقل إحداثيات المضلع إلى نموذج CAP ("+coords.length+" نقطة مع نقطة الإغلاق).";
 }
}
function featureStyle(feature){
 const severity=feature?.properties?.severity;
 return {color:severity==="Extreme"?"#991b1b":severity==="Severe"?"#dc2626":severity==="Moderate"?"#ea580c":"#2563eb",weight:3,fillOpacity:.22};
}
function popupFor(feature){
 const p=feature.properties||{};
 return '<strong>'+esc(p.headline||p.event||"تحذير جوي")+'</strong><br>'+esc(p.area_description||"")+'<br>الشدة: '+esc(p.severity||"غير محددة")+'<br>الاستعجال: '+esc(p.urgency||"غير محدد")+'<br>اللغة: '+esc(p.language||"");
}
function addGeoFeatures(target,data){
 const layer=L.geoJSON(data,{style:featureStyle,pointToLayer:(feature,latlng)=>{
  const p=feature.properties||{};
  if(p.geometry_kind==="circle"&&Number.isFinite(Number(p.radius_km))&&Number(p.radius_km)>0)return L.circle(latlng,{radius:Number(p.radius_km)*1000,...featureStyle(feature)});
  return L.circleMarker(latlng,{radius:8,...featureStyle(feature)});
 },onEachFeature:(feature,layer)=>layer.bindPopup(popupFor(feature))});
 layer.addTo(target);return layer;
}
async function refreshWarningMap(){
 const status=$("#mapStatus");if(!window.L){status.textContent="تعذر تحميل مكتبة الخريطة. تحقق من الاتصال بالإنترنت.";return}
 initWarningMap();
 try{
  const response=await fetch("/api/public/alerts.geojson");
  if(!response.ok)throw new Error("تعذر جلب طبقة التحذيرات العامة");
  const data=await response.json();
  publishedGeoLayer.clearLayers();addGeoFeatures(publishedGeoLayer,data);
  const count=data.features?.length||0;status.textContent="تم تحميل "+count+" معلم جغرافي من التحذيرات العامة المنشورة.";
  const bounds=publishedGeoLayer.getBounds();if(bounds.isValid())warningMap.fitBounds(bounds.pad(.15),{maxZoom:10});
  setTimeout(()=>warningMap.invalidateSize(),100);
 }catch(error){status.textContent=error.message}
}
function clearImportedGeo(){
 if(importedGeoLayer&&warningMap){warningMap.removeLayer(importedGeoLayer);importedGeoLayer=null}
 const input=$("#geoImport");if(input)input.value="";
}
$("#refreshMapBtn")?.addEventListener("click",refreshWarningMap);
$("#clearImportBtn")?.addEventListener("click",()=>{clearImportedGeo();$("#mapStatus").textContent="تمت إزالة طبقة المعاينة المستوردة."});
$("#geoImport")?.addEventListener("change",async event=>{
 const file=event.target.files?.[0];if(!file)return;
 try{
  if(file.size>5*1024*1024)throw new Error("حجم ملف GeoJSON يتجاوز الحد المسموح (5 MB).");
  const parsed=JSON.parse(await file.text());
  const data=window.validateImportedGeoJSON(parsed);
  if(importedGeoLayer)warningMap.removeLayer(importedGeoLayer);
  importedGeoLayer=addGeoFeatures(L.featureGroup(),data);
  importedGeoLayer.addTo(warningMap);
  const bounds=importedGeoLayer.getBounds();if(bounds.isValid())warningMap.fitBounds(bounds.pad(.15),{maxZoom:11});
  $("#mapStatus").textContent="معاينة محلية: "+data.features.length+" معلم. لم يتم حفظ الملف على الخادم.";
 }catch(error){alert("ملف GeoJSON غير صالح: "+error.message);event.target.value=""}
});
$("#exportGeoBtn")?.addEventListener("click",async()=>{
 try{
  const response=await fetch("/api/public/alerts.geojson");if(!response.ok)throw new Error("تعذر تصدير GeoJSON");
  const blob=new Blob([JSON.stringify(await response.json(),null,2)],{type:"application/geo+json"});
  const url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download="meteo-cap-public-alerts.geojson";a.click();URL.revokeObjectURL(url);
 }catch(error){alert(error.message)}
});

$("#exportAlertsCsvBtn").addEventListener("click",async()=>{
 try{
  const params=new URLSearchParams();
  const q=$("#alertSearch").value.trim(),workflow=$("#alertWorkflowFilter").value,severity=$("#alertSeverityFilter").value,status=$("#alertStatusFilter").value;
  if(q)params.set("q",q);if(workflow)params.set("workflow",workflow);if(severity)params.set("severity",severity);if(status)params.set("status",status);
  const response=await fetch("/api/alerts/export.csv?"+params.toString(),{headers:{Authorization:"Bearer "+token}});
  if(!response.ok){const data=await response.json().catch(()=>({}));throw new Error(data.error||"تعذر تصدير التحذيرات");}
  const blob=await response.blob(),url=URL.createObjectURL(blob),a=document.createElement("a");
  a.href=url;a.download="cap-alerts-export.csv";document.body.appendChild(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
 }catch(error){alert(error.message)}
});
$("#refreshBtn").onclick=()=>{alertOffset=0;loadAlerts()};
$("#alertSearch").addEventListener("change",()=>{alertOffset=0;loadAlerts()});
["#alertWorkflowFilter","#alertSeverityFilter","#alertStatusFilter"].forEach(selector=>$(selector).addEventListener("change",()=>{alertOffset=0;loadAlerts()}));
$("#alertPrevPage").addEventListener("click",()=>{alertOffset=Math.max(0,alertOffset-alertPageSize);loadAlerts()});
$("#alertNextPage").addEventListener("click",()=>{if(alertHasMore){alertOffset+=alertPageSize;loadAlerts()}});
$("#userForm").addEventListener("submit",async e=>{e.preventDefault();const data=Object.fromEntries(new FormData(e.target));try{await api("/api/users",{method:"POST",body:JSON.stringify(data)});e.target.reset();await loadUsers();alert("تم إنشاء الحساب بنجاح.")}catch(err){alert(err.message)}});
async function toggleUser(id,active){const action=active?'تفعيل':'إيقاف';if(!confirm('هل تريد '+action+' هذا الحساب؟'))return;try{await api('/api/users/'+id+'/status',{method:'PATCH',body:JSON.stringify({active:!!active})});await loadUsers()}catch(e){alert(e.message)}}
async function loadAuditIntegrity(){
 try{
  const data=await api("/api/audit/verify");
  const status=$("#auditStatus");
  status.className=data.valid?"pill":"pill red";
  if(!data.valid)status.textContent="تحذير: اكتُشف خلل في سلسلة سجل التدقيق.";
  else if(data.legacy_unhashed_entries)status.textContent="سلسلة السجلات الجديدة سليمة، مع وجود سجلات تاريخية غير مجزأة.";
  else status.textContent="سلسلة سجل التدقيق سليمة.";
  $("#auditMeta").textContent="سجلات تم التحقق منها: "+data.verified_entries+" • سجلات تاريخية غير مجزأة: "+data.legacy_unhashed_entries+(data.first_invalid_id?" • أول سجل متأثر: "+data.first_invalid_id:"");
 }catch(error){
  $("#auditStatus").className="pill red";
  $("#auditStatus").textContent="تعذر التحقق من سجل التدقيق.";
  $("#auditMeta").textContent=error.message;
 }
}
$("#auditRefreshBtn")?.addEventListener("click",loadAuditIntegrity);

let auditHistoryCursor=null;
let auditHistoryLoading=false;
let auditHistoryGeneration=0;
function formatAuditTimestamp(value){
 if(!value)return "وقت غير متاح";
 const raw=String(value).trim();
 const normalized=/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw)
  ?raw.replace(" ","T")+"Z"
  :/^\d{4}-\d{2}-\d{2}T.*$/.test(raw)&&!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)
   ?raw+"Z":raw;
 const date=new Date(normalized);
 return Number.isNaN(date.getTime())?"وقت غير متاح":date.toLocaleString("ar");
}
async function loadAuditHistory(append=false){
 const list=$("#auditHistoryList"),status=$("#auditHistoryStatus"),more=$("#auditHistoryLoadMoreBtn");
 const refresh=$("#auditHistoryRefreshBtn");
 if(!list||!status||auditHistoryLoading)return;
 if(append&&!auditHistoryCursor)return;
 const requestGeneration=auditHistoryGeneration;
 auditHistoryLoading=true;
 if(more)more.disabled=true;
 if(refresh)refresh.disabled=true;
 status.textContent=append?"جارٍ تحميل السجلات الأقدم...":"جارٍ تحميل سجل التدقيق...";
 try{
  const params=new URLSearchParams({limit:"50"});
  const auditSearch=$("#auditSearch")?.value.trim()||"";
  const auditAction=$("#auditActionFilter")?.value||"";
  if(auditSearch)params.set("q",auditSearch);
  if(auditAction)params.set("action",auditAction);
  const requestedCursor=append?auditHistoryCursor:null;
  if(requestedCursor!==null)params.set("before_id",String(requestedCursor));
  const result=await api("/api/audit?"+params.toString());
  if(requestGeneration!==auditHistoryGeneration)return;
  const rows=Array.isArray(result.entries)?result.entries:[];
  const cards=rows.map(entry=>{
   const card=document.createElement("article");card.className="alertItem auditEntry";
   const heading=document.createElement("div");heading.className="userHeading";
   const action=document.createElement("b");action.textContent=entry.action||"حدث غير محدد";
   const id=document.createElement("span");id.className="pill";id.textContent="#"+entry.id;
   heading.append(action,id);
   const meta=document.createElement("p");meta.className="small muted";
   meta.textContent=(entry.username||"النظام")+" • "+formatAuditTimestamp(entry.created_at)+(entry.alert_id?" • التحذير #"+entry.alert_id:"");
   const details=document.createElement("p");details.className="small auditDetails";details.textContent=entry.details||"لا توجد تفاصيل إضافية.";
   card.append(heading,meta,details);
   if(entry.entry_hash){
    const hash=document.createElement("details");const summary=document.createElement("summary");summary.textContent="تفاصيل سلامة السجل";
    const code=document.createElement("code");code.className="auditHash";code.textContent="SHA-256: "+entry.entry_hash+"\nالسابق: "+(entry.previous_hash||"غير متاح");
    hash.append(summary,code);card.append(hash);
   }
   return card;
  });
  if(append)list.append(...cards);else list.replaceChildren(...cards);
  auditHistoryCursor=result.next_before_id??null;
  if(more)more.hidden=!result.has_more;
  status.textContent="السجلات المعروضة: "+list.querySelectorAll(".auditEntry").length+(result.has_more?" • توجد سجلات أقدم":" • وصلت إلى نهاية السجل");
  if(!rows.length&&!append){const empty=document.createElement("p");empty.className="muted";empty.textContent="لا توجد أحداث مسجلة بعد.";list.append(empty);}
 }catch(error){
  if(requestGeneration===auditHistoryGeneration)status.textContent="تعذر تحميل سجل التدقيق: "+error.message;
 }finally{
  if(requestGeneration===auditHistoryGeneration){
   auditHistoryLoading=false;
   if(more)more.disabled=false;
   if(refresh)refresh.disabled=false;
  }
 }
}
$("#auditExportCsvBtn")?.addEventListener("click",async()=>{
 try{
  const params=new URLSearchParams();
  const q=$("#auditSearch")?.value.trim()||"",action=$("#auditActionFilter")?.value||"";
  if(q)params.set("q",q);if(action)params.set("action",action);
  const response=await fetch("/api/audit/export.csv?"+params.toString(),{headers:{Authorization:"Bearer "+token}});
  if(!response.ok){const data=await response.json().catch(()=>({}));throw new Error(data.error||"تعذر تصدير سجل التدقيق");}
  const blob=await response.blob(),url=URL.createObjectURL(blob),a=document.createElement("a");
  a.href=url;a.download="cap-audit-export.csv";document.body.appendChild(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
 }catch(error){alert(error.message)}
});
function resetAuditHistoryFilters(){
 auditHistoryGeneration++;auditHistoryCursor=null;auditHistoryLoading=false;
 const list=$("#auditHistoryList");if(list)list.replaceChildren();
 loadAuditHistory();
}
$("#auditSearch")?.addEventListener("change",resetAuditHistoryFilters);
$("#auditSearch")?.addEventListener("keydown",event=>{if(event.key==="Enter"){event.preventDefault();resetAuditHistoryFilters();}});
$("#auditActionFilter")?.addEventListener("change",resetAuditHistoryFilters);
$("#auditHistoryRefreshBtn")?.addEventListener("click",resetAuditHistoryFilters);
$("#auditHistoryLoadMoreBtn")?.addEventListener("click",()=>loadAuditHistory(true));

async function loadUsers(){
 try{
  const {users}=await api("/api/users");
  const labels={admin:"مدير نظام",forecaster:"متنبئ جوي",reviewer:"مراجع",approver:"معتمد",publisher:"ناشر",viewer:"مشاهد"};
  const cards=users.map(user=>{
   const card=document.createElement("article");card.className="alertItem userItem";
   const heading=document.createElement("div");heading.className="userHeading";
   const name=document.createElement("b");name.textContent=user.username;
   const state=document.createElement("span");state.className="pill"+(user.active?"":" red");state.textContent=user.active?"نشط":"موقوف";
   heading.append(name,state);
   const mfaState=document.createElement("p");mfaState.className="small muted";
   mfaState.textContent=user.mfa_enabled?"MFA: مفعّل":(user.mfa_required?"MFA: مطلوب ويحتاج إلى إعداد":"MFA: غير مفعّل");
   const passwordState=document.createElement("p");passwordState.className="small muted";
   passwordState.textContent=user.must_change_password?"كلمة المرور: مؤقتة — يجب تغييرها عند تسجيل الدخول":"كلمة المرور: اعتيادية";
   const lastLogin=document.createElement("p");lastLogin.className="small muted";
   if(user.last_login_at){
    const parsed=new Date(user.last_login_at.replace(" ","T")+"Z");
    lastLogin.textContent="آخر تسجيل دخول: "+(Number.isNaN(parsed.getTime())?user.last_login_at:new Intl.DateTimeFormat("ar",{dateStyle:"medium",timeStyle:"short"}).format(parsed));
   }else lastLogin.textContent="آخر تسجيل دخول: لم يسجل دخول بعد";
   const controls=document.createElement("div");controls.className="userRoleControls";
   const label=document.createElement("label");label.textContent="الدور الوظيفي";
   const select=document.createElement("select");select.id="user-role-"+user.id;select.setAttribute("aria-label","الدور الجديد للمستخدم "+user.username);
   Object.entries(labels).forEach(([role,title])=>{const option=document.createElement("option");option.value=role;option.textContent=title;option.selected=role===user.role;select.append(option)});
   label.append(select);
   const actions=document.createElement("div");actions.className="actions";
   const reset=document.createElement("button");reset.type="button";reset.className="secondary";reset.textContent="إعادة تعيين كلمة المرور";reset.disabled=user.id===currentUserId;reset.onclick=()=>resetUserPassword(user.id,user.username);
   const save=document.createElement("button");save.type="button";save.textContent="حفظ الدور";save.onclick=()=>changeUserRole(user.id,user.role,select.value);
   const toggle=document.createElement("button");toggle.type="button";toggle.className="secondary";toggle.textContent=user.active?"إيقاف الحساب":"إعادة تفعيل الحساب";toggle.onclick=()=>toggleUser(user.id,!user.active);
   actions.append(save,toggle,reset);controls.append(label,actions);card.append(heading,mfaState,passwordState,lastLogin,controls);return card;
  });
  const container=$("#usersList");container.replaceChildren(...cards);
  if(!users.length){const empty=document.createElement("p");empty.className="muted";empty.textContent="لا توجد حسابات.";container.append(empty)}
 }catch(e){$("#usersList").textContent=e.message}
}
async function resetUserPassword(id,username){
 if(!confirm("إصدار كلمة مرور مؤقتة جديدة للحساب "+username+"؟ سيتم إلغاء جميع جلساته الحالية وإجباره على تغيير كلمة المرور عند تسجيل الدخول التالي."))return;
 try{
  const result=await api("/api/users/"+id+"/password-reset",{method:"POST",body:"{}"});
  alert("كلمة المرور المؤقتة للحساب "+result.username+" (تظهر مرة واحدة فقط):\\n\\n"+result.temporary_password+"\\n\\nانقلها إلى صاحب الحساب عبر قناة آمنة. يجب عليه تغييرها فور تسجيل الدخول.");
  await loadUsers();
 }catch(error){alert(error.message)}
}
async function changeUserRole(id,currentRole,selectedRole){
 const role=selectedRole||$("#user-role-"+id)?.value;
 if(!role||role===currentRole)return;
 const labels={admin:"مدير نظام",forecaster:"متنبئ جوي",reviewer:"مراجع",approver:"معتمد",publisher:"ناشر",viewer:"مشاهد"};
 if(!confirm("تغيير دور هذا الحساب إلى "+(labels[role]||role)+"؟ سيتم إلغاء جلساته الحالية."))return;
 try{await api("/api/users/"+id+"/role",{method:"PATCH",body:JSON.stringify({role})});await loadUsers()}
 catch(error){alert(error.message);await loadUsers()}
}
let editingAlertId=null;
function setAlertEditorMode(editing){
 const title=document.querySelector("#alertForm")?.closest(".card")?.querySelector(".sectionHead h2");
 if(title)title.textContent=editing?"تعديل مسودة التحذير":"إنشاء تحذير جديد";
 const submit=$("#alertForm")?.querySelector('button[type="submit"],button:not([type])');
 if(submit)submit.textContent=editing?"حفظ تعديلات المسودة":"حفظ كمسودة";
 const cancel=$("#cancelAlertEditBtn");if(cancel)cancel.hidden=!editing;
}
function dateForLocalInput(value){
 if(!value)return "";
 const date=new Date(value);if(Number.isNaN(date.getTime()))return "";
 const local=new Date(date.getTime()-date.getTimezoneOffset()*60000);
 return local.toISOString().slice(0,16);
}
function resetAlertEditor(){
 editingAlertId=null;$("#alertForm").reset();setAlertEditorMode(false);
}
$("#alertForm").addEventListener("submit",async e=>{
 e.preventDefault();
 const obj=Object.fromEntries(new FormData(e.target));
 const jsonBlocks=obj.info_blocks_json?.trim();delete obj.info_blocks_json;
 if(jsonBlocks){try{obj.info_blocks=JSON.parse(jsonBlocks);if(!Array.isArray(obj.info_blocks)||obj.info_blocks.length<1)throw new Error("يجب إدخال مصفوفة غير فارغة")}catch(error){alert("صيغة JSON غير صحيحة في كتل اللغات المتعددة: "+error.message);return}}
 const hasInfoArea=obj.info_blocks?.some(b=>b.area||b.areas?.length);
 if(!obj.polygon?.trim()&&!obj.circle?.trim()&&!hasInfoArea){alert("أدخل مضلعاً أو دائرة أو منطقة جغرافية ضمن كتل المعلومات.");return}
 for(const k of ["effective","onset","expires"])if(obj[k])obj[k]=new Date(obj[k]).toISOString();else obj[k]="";
 try{
  if(editingAlertId){
   const id=editingAlertId;
   const result=await api("/api/alerts/"+id,{method:"PATCH",body:JSON.stringify(obj)});
   resetAlertEditor();alert("تم حفظ المسودة. الحقول المحدّثة: "+(result.updated_fields||[]).join("، "));await loadAlerts();
  }else{
   const result=await api("/api/alerts",{method:"POST",body:JSON.stringify(obj)});
   e.target.reset();alert("تم حفظ المسودة: "+result.identifier);await loadAlerts();
  }
 }catch(error){alert(error.message)}
});
$("#cancelAlertEditBtn")?.addEventListener("click",resetAlertEditor);
async function editDraft(id){
 try{
  const current=await api("/api/alerts/"+id);
  const alertData=current.alert;
  if(alertData.workflow!=="draft")throw new Error("لا يمكن تعديل تحذير لم يعد مسودة.");
  const form=$("#alertForm");
  const values={event:alertData.event,headline:alertData.headline,category:alertData.category,urgency:alertData.urgency,severity:alertData.severity,certainty:alertData.certainty,status:alertData.status,scope:alertData.scope,effective:dateForLocalInput(alertData.effective),onset:dateForLocalInput(alertData.onset),expires:dateForLocalInput(alertData.expires),response_type:alertData.response_type,language:alertData.language,area_desc:alertData.area_desc,description:alertData.description,instruction:alertData.instruction,polygon:alertData.polygon,circle:alertData.circle,info_blocks_json:alertData.info_blocks?.length?JSON.stringify(alertData.info_blocks,null,2):""};
  for(const [name,value] of Object.entries(values)){const field=form.elements.namedItem(name);if(field)field.value=value??""}
  editingAlertId=id;setAlertEditorMode(true);form.scrollIntoView({behavior:"smooth",block:"start"});
 }catch(error){alert(error.message)}
}
async function act(id,action){try{let body={};if(action==="return"){const reason=prompt("اكتب ملاحظات المراجعة وسبب إعادة التحذير إلى منشئه (5 أحرف على الأقل):");if(reason===null)return;if(reason.trim().length<5){alert("يرجى إدخال سبب واضح لا يقل عن 5 أحرف.");return;}body={reason};}await api(`/api/alerts/${id}/${action}`,{method:"POST",body:JSON.stringify(body)});await loadAlerts()}catch(e){alert(e.message)}}
async function derive(id,msgType){const label=msgType==='Cancel'?'إلغاء التحذير':'إنشاء تحديث';if(!confirm(label+'؟ ستنشأ مسودة CAP بحالة Test وتحتاج إلى مراجعة واعتماد مستقلين.'))return;try{const result=await api('/api/alerts/'+id+'/derive',{method:'POST',body:JSON.stringify({msg_type:msgType})});alert('تم إنشاء المسودة: '+result.identifier+' (Test)');await loadAlerts()}catch(e){alert(e.message)}}
async function loadAlerts(){
 try{
  const params=new URLSearchParams({limit:String(alertPageSize),offset:String(alertOffset)});
  const q=$("#alertSearch").value.trim();
  const workflow=$("#alertWorkflowFilter").value;
  const severity=$("#alertSeverityFilter").value;
  const status=$("#alertStatusFilter").value;
  if(q)params.set("q",q);
  if(workflow)params.set("workflow",workflow);
  if(severity)params.set("severity",severity);
  if(status)params.set("status",status);
  const [result,statsResult]=await Promise.all([api("/api/alerts?"+params.toString()),api("/api/alerts/stats")]);
  const alerts=result.alerts;
  const stats=statsResult.stats;
  const pagination=result.pagination;
  alertHasMore=!!pagination.has_more;
  $("#alertPageStatus").textContent="النتائج "+(pagination.total?alertOffset+1:0)+"–"+(alertOffset+alerts.length)+" من "+pagination.total;
  $("#alertPrevPage").disabled=alertOffset===0;
  $("#alertNextPage").disabled=!alertHasMore;
  $("#total").textContent=stats.total;
  $("#drafts").textContent=stats.drafts;
  $("#pending").textContent=stats.pending;
  $("#approved").textContent=stats.approved;
  $("#published").textContent=stats.published;
  $("#severeAlerts").textContent=stats.extreme+stats.severe;
  $("#alertsList").innerHTML=alerts.map(a=>{
   const actions=[];
   const id=esc(a.id);
   if(a.workflow==="draft")actions.push("<button class='secondary' data-alert-edit='1' data-alert-id='"+id+"'>تعديل المسودة</button>");
   if(a.workflow==="draft")actions.push("<button data-alert-action='submit' data-alert-id='"+id+"'>إرسال للمراجعة</button>");
   if(a.workflow==="pending"){actions.push("<button data-alert-action='approve' data-alert-id='"+id+"'>اعتماد</button>");actions.push("<button class='secondary' data-alert-action='return' data-alert-id='"+id+"'>إعادة للمُنشئ</button>");}
   if(a.workflow==="approved")actions.push("<button data-alert-action='publish' data-alert-id='"+id+"'>نشر داخلي</button>");
   if(a.workflow==="approved"||a.workflow==="published"){
    actions.push("<button class='secondary' data-alert-derive='Update' data-alert-id='"+id+"'>إنشاء تحديث</button>");
    actions.push("<button class='secondary' data-alert-derive='Cancel' data-alert-id='"+id+"'>إلغاء التحذير</button>");
   }
   actions.push("<button class='secondary' data-alert-relations='1' data-alert-id='"+id+"'>سلسلة الرسائل</button>");
   actions.push("<button class='secondary' data-alert-download='"+id+"'>CAP XML</button>");
   const severityClass=a.severity==="Extreme"||a.severity==="Severe"?"red":"orange";
   return "<article class='alertItem'><b>"+esc(a.headline)+"</b><div class='alertMeta'><span>"+esc(a.event)+"</span><span class='pill'>"+esc(a.workflow)+"</span><span class='pill "+severityClass+"'>"+esc(a.severity)+"</span><span>"+esc(a.area_desc)+"</span></div><div class='actions'>"+actions.join("")+"</div></article>";
  }).join("")||'<p class="muted">لا توجد تحذيرات حتى الآن.</p>';
  if(["admin","reviewer","approver"].includes(currentRole))await loadReviewQueue();
 }catch(e){
  if(e.message.includes("Authentication")){token="";showApp(false);$("#userAdmin").hidden=true;}
  else $("#alertsList").textContent=e.message;
 }
}
async function loadReviewQueue(){
 const panel=document.getElementById("reviewQueuePanel");if(!panel)return;
 const allowed=["admin","reviewer","approver"].includes(currentRole);panel.hidden=!allowed;if(!allowed)return;
 const list=document.getElementById("reviewQueueList"),status=document.getElementById("reviewQueueStatus");
 try{
  const params=new URLSearchParams({limit:"200"});
  const severity=document.getElementById("reviewQueueSeverity")?.value;
  if(severity)params.set("severity",severity);
  const data=await api("/api/review/queue?"+params.toString());
  status.textContent="التحذيرات المنتظرة: "+data.count;list.replaceChildren();
  for(const item of data.queue){
   const card=document.createElement("article");card.className="alertItem";
   const title=document.createElement("b");title.textContent=item.headline;card.append(title);
   const meta=document.createElement("p");meta.className="alertMeta";
   meta.textContent=[item.event,item.severity,"المنشئ: "+(item.creator||"غير معروف"),"مدة الانتظار: "+Math.floor(item.waiting_seconds/3600)+" ساعة"].join(" • ");card.append(meta);
   const noteLabel=document.createElement("label");noteLabel.className="small";noteLabel.textContent="ملاحظة المراجعة";
   const note=document.createElement("textarea");note.rows=2;note.maxLength=1000;note.placeholder="اكتب ملاحظة واضحة للمراجعة (5 أحرف على الأقل)";noteLabel.append(note);card.append(noteLabel);
   const actions=document.createElement("div");actions.className="actions";
   const save=document.createElement("button");save.type="button";save.textContent="حفظ الملاحظة";save.addEventListener("click",async()=>{
    save.disabled=true;try{await api("/api/alerts/"+encodeURIComponent(item.id)+"/review-notes",{method:"POST",body:JSON.stringify({note:note.value})});note.value="";history.hidden=false;await loadReviewHistory(item.id,history);status.textContent="تم حفظ ملاحظة التحذير #"+item.id+" في سجل التدقيق.";}catch(error){alert(error.message)}finally{save.disabled=false}
   });
   const historyButton=document.createElement("button");historyButton.type="button";historyButton.className="secondary";historyButton.textContent="سجل قرارات المراجعة";historyButton.addEventListener("click",async()=>{history.hidden=false;await loadReviewHistory(item.id,history)});
   const versionsButton=document.createElement("button");versionsButton.type="button";versionsButton.className="secondary";versionsButton.textContent="مقارنة نسخ التحذير";versionsButton.addEventListener("click",async()=>{versionDiff.hidden=false;await loadAlertVersionDiff(item.id,versionDiff)});
   actions.append(save,historyButton,versionsButton);
   for(const [action,label] of [["approve","اعتماد"],["return","إعادة للمُنشئ"]]){const button=document.createElement("button");button.type="button";button.textContent=label;button.dataset.alertAction=action;button.dataset.alertId=item.id;button.addEventListener("click",()=>act(item.id,action));actions.append(button);}
   card.append(actions);
   const history=document.createElement("div");history.className="reviewHistory small";history.hidden=true;history.textContent="اضغط لعرض سجل المراجعة.";card.append(history);
   const versionDiff=document.createElement("div");versionDiff.className="reviewVersionDiff small";versionDiff.hidden=true;card.append(versionDiff);
   list.append(card);
  }
  if(!data.count)list.textContent="لا توجد تحذيرات بانتظار المراجعة";
 }catch(error){status.textContent=error.message;list.textContent=error.message;}
}
async function loadAlertVersionDiff(id,container){
 container.textContent="جارٍ تحميل نسخ التحذير ومقارنة الحقول...";
 try{
  const data=await api("/api/alerts/"+encodeURIComponent(id)+"/versions");
  container.replaceChildren();
  if(!data.has_comparison){container.textContent="هذه النسخة الأولى؛ لا توجد نسخة سابقة للمقارنة.";return}
  const versions=data.versions;
  const heading=document.createElement("p");heading.textContent="النسخة الحالية #"+versions[0].version_no+" مقارنة بالنسخة #"+versions[1].version_no;container.append(heading);
  const current=versions[0].snapshot,previous=versions[1].snapshot;
  const labels={headline:"العنوان",event:"الحدث",description:"الوصف",instruction:"التعليمات",severity:"الشدة",urgency:"الإلحاح",certainty:"اليقين",status:"حالة CAP",scope:"النطاق",effective:"بداية الفعالية",onset:"بداية الحدث",expires:"انتهاء التحذير",area_desc:"المنطقة",polygon:"المضلع",circle:"الدائرة",language:"اللغة",info_blocks:"معلومات متعددة اللغات"};
  for(const key of data.changed_fields){
   const row=document.createElement("section");row.className="versionChange";
   const label=document.createElement("b");label.textContent=labels[key]||key;row.append(label);
   const before=document.createElement("p");before.textContent="قبل: "+JSON.stringify(previous[key]??null);row.append(before);
   const after=document.createElement("p");after.textContent="بعد: "+JSON.stringify(current[key]??null);row.append(after);
   container.append(row);
  }
  if(!data.changed_fields.length)container.append(document.createTextNode("لا توجد تغييرات في حقول CAP بين آخر نسختين."));
 }catch(error){container.textContent=error.message;}
}
async function loadReviewHistory(id,container){
 container.textContent="جارٍ تحميل سجل المراجعة...";
 try{
  const data=await api("/api/alerts/"+encodeURIComponent(id)+"/review-history");
  container.replaceChildren();
  for(const entry of data.entries){
   const row=document.createElement("p");
   const label=entry.action==="review_note_added"?"ملاحظة مراجعة":entry.action==="approved"?"تم الاعتماد":"أُعيد إلى المنشئ";
   row.textContent=label+" • "+(entry.username||"النظام")+" • "+formatAuditTimestamp(entry.created_at)+"\n"+(entry.details||"");
   container.append(row);
  }
  if(!data.count)container.textContent="لا توجد ملاحظات أو قرارات مراجعة مسجلة لهذا التحذير.";
 }catch(error){container.textContent=error.message;}
}
document.getElementById("reviewQueueRefresh")?.addEventListener("click",loadReviewQueue);
async function loadAlertRelations(id){
 const panel=$("#alertRelationsPanel"),list=$("#alertRelationsList"),meta=$("#alertRelationsMeta");
 panel.hidden=false;list.textContent="جارٍ تحميل سلسلة الرسائل…";meta.textContent="التحقق من روابط CAP references للرسالة المحددة.";
 panel.scrollIntoView({behavior:"smooth",block:"nearest"});
 try{
  const data=await api("/api/alerts/"+encodeURIComponent(id)+"/relations");
  meta.textContent="عدد الرسائل المرتبطة: "+data.count+(data.truncated?" • تم بلوغ حد العرض":"");
  list.innerHTML=data.messages.map(message=>{
   const label=message.msg_type==="Alert"?"رسالة أصلية":message.msg_type==="Update"?"تحديث":message.msg_type==="Cancel"?"إلغاء":message.msg_type;
   return "<article class='alertItem'><b>"+esc(message.headline||message.event||message.identifier)+"</b><div class='alertMeta'><span>"+esc(label)+"</span><span class='pill'>"+esc(message.workflow)+"</span><span class='pill'>"+esc(message.status)+"</span><span>"+esc(message.sent)+"</span><span>"+esc(message.identifier)+"</span></div><div class='muted small'>"+esc(message.references_text||"لا توجد رسالة مرجعية")+"</div></article>";
  }).join("")||"<p class='muted'>لا توجد رسائل مرتبطة.</p>";
 }catch(error){list.textContent=error.message;}
}
$("#alertRelationsClose")?.addEventListener("click",()=>{$("#alertRelationsPanel").hidden=true;});
function esc(s=""){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
async function downloadXml(id){try{const r=await fetch(`/api/alerts/${id}/cap.xml`,{headers:headers()});if(!r.ok)throw new Error("تعذر إنشاء XML");const blob=await r.blob(),url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=`cap-alert-${id}.xml`;a.click();URL.revokeObjectURL(url)}catch(e){alert(e.message)}}
$("#alertsList").addEventListener("click",event=>{
 const button=event.target.closest("button[data-alert-id]");
 if(!button)return;
 const id=Number(button.dataset.alertId);
 if(!Number.isSafeInteger(id)||id<1)return;
 if(button.dataset.alertEdit)editDraft(id);
 if(button.dataset.alertAction)act(id,button.dataset.alertAction);
 else if(button.dataset.alertDerive)derive(id,button.dataset.alertDerive);
 else if(button.dataset.alertDownload)downloadXml(id);
 else if(button.dataset.alertRelations)loadAlertRelations(id);
});
$("#webhookInboxList")?.addEventListener("click",event=>{
 const button=event.target.closest("button[data-webhook-review]");
 if(!button)return;
 const id=Number(button.dataset.webhookId);
 if(Number.isSafeInteger(id)&&id>0)reviewWebhook(id,button.dataset.webhookReview);
});
window.toggleUser=toggleUser;
window.changeUserRole=changeUserRole;
showApp(false);

async function loadDeliveryOutbox(){
 const status=$("#deliveryStatus"),list=$("#deliveryList");
 try{
  const result=await api("/api/delivery/outbox");
  const rows=result.deliveries||[];
  const counts=result.counts||{queued:0,sending:0,failed:0,dead_letter:0,delivered:0};
  $("#deliveryQueued").textContent=counts.queued;
  $("#deliverySending").textContent=counts.sending;
  $("#deliveryFailed").textContent=counts.failed;
  $("#deliveryDead").textContent=counts.dead_letter;
  $("#deliveryDelivered").textContent=counts.delivered;
  list.innerHTML=rows.map(row=>{
   const label={queued:"بانتظار المعالجة",sending:"قيد المعالجة",delivered:"تم التسليم المسجل",failed:"فشل - بانتظار المحاولة",dead_letter:"معزولة نهائياً"}[row.status]||row.status;
   const next=row.next_attempt_at?" • المحاولة التالية: "+esc(row.next_attempt_at):"";
   const error=row.last_error?'<p class="small error">'+esc(row.last_error)+'</p>':"";
   return '<article class="alertItem"><b>'+esc(row.headline||row.identifier||("مهمة #"+row.id))+'</b><div class="alertMeta"><span class="pill">'+esc(label)+'</span><span>القناة: '+esc(row.channel)+'</span><span>المحاولات: '+esc(row.attempts)+'/'+esc(row.max_attempts)+'</span><span>المعرف: #'+esc(row.id)+'</span>'+next+'</div>'+error+'</article>';
  }).join("")||'<p class="muted">قائمة التوزيع فارغة.</p>';
  status.textContent="تم تحديث "+rows.length+" مهمة. الموصلات الخارجية: "+(result.external_adapters_enabled?"مفعّلة":"معطّلة");
 }catch(error){status.textContent=error.message}
}
$("#deliveryRefreshBtn")?.addEventListener("click",loadDeliveryOutbox);
$("#deliveryProcessBtn")?.addEventListener("click",async()=>{
 const status=$("#deliveryStatus");
 try{
  const result=await api("/api/delivery/process-retries",{method:"POST",body:"{}"});
  status.textContent="اكتملت المعالجة: "+result.requeued_count+" أعيدت إلى الانتظار، و"+result.dead_lettered_count+" عُزلت نهائياً.";
  await loadDeliveryOutbox();
 }catch(error){status.textContent=error.message}
});

let webhookInboxNextCursor=null;
async function loadWebhookInbox(append=false){
 const status=$("#webhookInboxStatus"),list=$("#webhookInboxList");
 if(!status||!list)return;
 const moreButton=$("#webhookInboxLoadMoreBtn");
 if(!append){webhookInboxNextCursor=null;if(moreButton)moreButton.hidden=true;}
 if(append&&!webhookInboxNextCursor)return;
 try{
  const params=new URLSearchParams();
  const filter=$("#webhookInboxFilter")?.value||"";
  if(filter)params.set("status",filter);
  if(append&&webhookInboxNextCursor)params.set("before_id",String(webhookInboxNextCursor));
  const query=params.toString();
  const result=await api("/api/webhooks/inbox"+(query?"?"+query:""));
  const rows=result.messages||[];
  const html=rows.map(row=>{
   const label={pending:"بانتظار المراجعة",reviewed:"تمت المراجعة",rejected:"مرفوضة"}[row.status]||row.status;
   const payload=esc(JSON.stringify(row.payload,null,2));
   const reviewer=row.reviewer_username?'<p class="small muted">راجع الرسالة: '+esc(row.reviewer_username)+' • '+esc(row.reviewed_at||"")+"</p>":"";
   const note=row.review_note?'<p class="small muted">ملاحظة المراجعة: '+esc(row.review_note)+'</p>':"";
   const actions=row.status==="pending"?'<div class="actions"><button type="button" data-webhook-review="reviewed" data-webhook-id="'+esc(row.id)+'">تأكيد المراجعة</button><button class="secondary" type="button" data-webhook-review="rejected" data-webhook-id="'+esc(row.id)+'">رفض الرسالة</button></div>':"";
   return '<article class="alertItem"><b>رسالة واردة #'+esc(row.id)+'</b><div class="alertMeta"><span class="pill">'+esc(label)+'</span><span>وقت الاستلام: '+esc(row.received_at)+'</span><span>وقت المصدر: '+esc(new Date(row.source_timestamp*1000).toISOString())+'</span></div>'+reviewer+note+'<details><summary>عرض محتوى JSON</summary><pre class="webhookPayload">'+payload+'</pre></details>'+actions+'</article>';
  }).join("");
  if(append)list.insertAdjacentHTML("beforeend",html);
  else list.innerHTML=html||'<p class="muted">لا توجد رسائل ضمن هذا التصنيف.</p>';
  webhookInboxNextCursor=result.next_before_id;
  if(moreButton)moreButton.hidden=!result.has_more;
  const displayed=list.querySelectorAll(".alertItem").length;
  status.textContent="عدد الرسائل المعروضة: "+displayed+(result.has_more?" • توجد رسائل أقدم":" • وصلت إلى نهاية النتائج");
 }catch(error){status.textContent=error.message}
}
async function reviewWebhook(id,status){
 const label=status==="reviewed"?"تأكيد مراجعة الرسالة؟":"رفض الرسالة الواردة؟";
 if(!confirm(label+" لا ينشئ هذا الإجراء تحذيراً جوياً."))return;
 const note=prompt("ملاحظة المراجعة (اختياري):")??"";
 try{
  await api("/api/webhooks/inbox/"+id+"/review",{method:"PATCH",body:JSON.stringify({status,note})});
  await loadWebhookInbox();
 }catch(error){alert(error.message)}
}
$("#webhookInboxRefreshBtn")?.addEventListener("click",()=>loadWebhookInbox());
$("#webhookInboxLoadMoreBtn")?.addEventListener("click",()=>loadWebhookInbox(true));
$("#webhookInboxFilter")?.addEventListener("change",()=>loadWebhookInbox());
window.reviewWebhook=reviewWebhook;
window.toggleUser=toggleUser;
window.changeUserRole=changeUserRole;
