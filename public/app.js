let token = "";
let currentRole = "";
const $ = s => document.querySelector(s);
const loginPanel=$("#loginPanel"), appPanel=$("#appPanel");
function headers(){return {"Content-Type":"application/json","Authorization":`Bearer ${token}`}}
async function api(url,opts={}){const r=await fetch(url,{...opts,headers:{...headers(),...(opts.headers||{})}});const data=await r.json().catch(()=>({}));if(!r.ok)throw new Error(data.error||"Request failed");return data}
function showApp(on){loginPanel.hidden=on;appPanel.hidden=!on}
$("#loginForm").addEventListener("submit",async e=>{e.preventDefault();const f=new FormData(e.target);try{const d=await fetch("/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(Object.fromEntries(f))}).then(r=>r.json());if(!d.token)throw new Error(d.error||"تعذر تسجيل الدخول");token=d.token;currentRole=d.user.role;$("#userBadge").textContent=`${d.user.username} • ${d.user.role}`;$("#deliveryMonitor").hidden=!["admin","publisher"].includes(currentRole);$("#webhookInboxMonitor").hidden=!["admin","reviewer"].includes(currentRole);$("#userAdmin").hidden=d.user.role!=="admin";const canVerifyAudit=["admin","reviewer","approver"].includes(d.user.role);$("#auditIntegrity").hidden=!canVerifyAudit;$("#auditHistoryPanel").hidden=!canVerifyAudit;showApp(true);await loadAlerts();initWarningMap();await refreshWarningMap();if(d.user.role==="admin")await loadUsers();if(canVerifyAudit){await loadAuditIntegrity();await loadAuditHistory();}if(["admin","publisher"].includes(currentRole))await loadDeliveryOutbox();if(["admin","reviewer"].includes(currentRole))await loadWebhookInbox()}catch(err){$("#loginError").textContent=err.message}});
let warningMap=null, publishedGeoLayer=null, importedGeoLayer=null, drawnGeoLayer=null, drawControl=null;
$("#logoutBtn").onclick=()=>{token="";currentRole="";showApp(false);$("#userAdmin").hidden=true;$("#auditIntegrity").hidden=true;$("#auditHistoryPanel").hidden=true;$("#deliveryMonitor").hidden=true;$("#webhookInboxMonitor").hidden=true};
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
  status.textContent="تم تحديث كلمة المرور وإلغاء الجلسات السابقة. هذه الجلسة مستمرة بأمان.";
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

$("#refreshBtn").onclick=loadAlerts;
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
 auditHistoryLoading=true;
 if(more)more.disabled=true;
 if(refresh)refresh.disabled=true;
 status.textContent=append?"جارٍ تحميل السجلات الأقدم...":"جارٍ تحميل سجل التدقيق...";
 try{
  const params=new URLSearchParams({limit:"50"});
  const requestedCursor=append?auditHistoryCursor:null;
  if(requestedCursor!==null)params.set("before_id",String(requestedCursor));
  const result=await api("/api/audit?"+params.toString());
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
    const code=document.createElement("code");code.className="auditHash";code.textContent="SHA-256: "+entry.entry_hash+"\\nالسابق: "+(entry.previous_hash||"غير متاح");
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
  status.textContent="تعذر تحميل سجل التدقيق: "+error.message;
 }finally{
  auditHistoryLoading=false;
  if(more)more.disabled=false;
  if(refresh)refresh.disabled=false;
 }
}
$("#auditHistoryRefreshBtn")?.addEventListener("click",()=>loadAuditHistory());
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
   const save=document.createElement("button");save.type="button";save.textContent="حفظ الدور";save.onclick=()=>changeUserRole(user.id,user.role,select.value);
   const toggle=document.createElement("button");toggle.type="button";toggle.className="secondary";toggle.textContent=user.active?"إيقاف الحساب":"إعادة تفعيل الحساب";toggle.onclick=()=>toggleUser(user.id,!user.active);
   actions.append(save,toggle);controls.append(label,actions);card.append(heading,lastLogin,controls);return card;
  });
  const container=$("#usersList");container.replaceChildren(...cards);
  if(!users.length){const empty=document.createElement("p");empty.className="muted";empty.textContent="لا توجد حسابات.";container.append(empty)}
 }catch(e){$("#usersList").textContent=e.message}
}
async function changeUserRole(id,currentRole,selectedRole){
 const role=selectedRole||$("#user-role-"+id)?.value;
 if(!role||role===currentRole)return;
 const labels={admin:"مدير نظام",forecaster:"متنبئ جوي",reviewer:"مراجع",approver:"معتمد",publisher:"ناشر",viewer:"مشاهد"};
 if(!confirm("تغيير دور هذا الحساب إلى "+(labels[role]||role)+"؟ سيتم إلغاء جلساته الحالية."))return;
 try{await api("/api/users/"+id+"/role",{method:"PATCH",body:JSON.stringify({role})});await loadUsers()}
 catch(error){alert(error.message);await loadUsers()}
}
$("#alertForm").addEventListener("submit",async e=>{e.preventDefault();const obj=Object.fromEntries(new FormData(e.target));const jsonBlocks=obj.info_blocks_json?.trim();delete obj.info_blocks_json;if(jsonBlocks){try{obj.info_blocks=JSON.parse(jsonBlocks)}catch{alert("صيغة JSON غير صحيحة في كتل اللغات المتعددة.");return}}const hasInfoArea=obj.info_blocks?.some(b=>b.area||b.areas?.length);if(!obj.polygon?.trim()&&!obj.circle?.trim()&&!hasInfoArea){alert("أدخل مضلعاً أو دائرة أو منطقة جغرافية ضمن كتل المعلومات.");return}for(const k of ["onset","expires"])if(obj[k])obj[k]=new Date(obj[k]).toISOString();else obj[k]="";try{const d=await api("/api/alerts",{method:"POST",body:JSON.stringify(obj)});e.target.reset();alert(`تم حفظ المسودة: ${d.identifier}`);await loadAlerts()}catch(err){alert(err.message)}});
async function act(id,action){try{await api(`/api/alerts/${id}/${action}`,{method:"POST",body:"{}"});await loadAlerts()}catch(e){alert(e.message)}}
async function derive(id,msgType){const label=msgType==='Cancel'?'إلغاء التحذير':'إنشاء تحديث';if(!confirm(label+'؟ ستنشأ مسودة CAP بحالة Test وتحتاج إلى مراجعة واعتماد مستقلين.'))return;try{const result=await api('/api/alerts/'+id+'/derive',{method:'POST',body:JSON.stringify({msg_type:msgType})});alert('تم إنشاء المسودة: '+result.identifier+' (Test)');await loadAlerts()}catch(e){alert(e.message)}}
async function loadAlerts(){try{const {alerts}=await api("/api/alerts");$("#total").textContent=alerts.length;$("#drafts").textContent=alerts.filter(a=>a.workflow==="draft").length;$("#pending").textContent=alerts.filter(a=>a.workflow==="pending").length;$("#published").textContent=alerts.filter(a=>a.workflow==="published").length;$("#alertsList").innerHTML=alerts.map(a=>`<article class="alertItem"><b>${esc(a.headline)}</b><div class="alertMeta"><span>${esc(a.event)}</span><span class="pill">${esc(a.workflow)}</span><span class="pill ${a.severity==="Extreme"||a.severity==="Severe"?"red":"orange"}">${esc(a.severity)}</span><span>${esc(a.area_desc)}</span></div><div class="actions">${a.workflow==="draft"?`<button onclick="act(${a.id},'submit')">إرسال للمراجعة</button>`:""}${a.workflow==="pending"?`<button onclick="act(${a.id},'approve')">اعتماد</button>`:""}${a.workflow==="approved"?`<button onclick="act(${a.id},'publish')">نشر داخلي</button>`:""}${(a.workflow==="approved"||a.workflow==="published") ? "<button class=\"secondary\" onclick=\"derive(" + a.id + ", &quot;Update&quot;)\">إنشاء تحديث</button>" + "<button class=\"secondary\" onclick=\"derive(" + a.id + ", &quot;Cancel&quot;)\">إلغاء التحذير</button>" : ""}<button class="secondary" onclick="downloadXml(${a.id})">CAP XML</button></div></article>`).join("")||'<p class="muted">لا توجد تحذيرات حتى الآن.</p>'}catch(e){if(e.message.includes("Authentication")){token="";showApp(false);$("#userAdmin").hidden=true;}else $("#alertsList").textContent=e.message}}
function esc(s=""){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
async function downloadXml(id){try{const r=await fetch(`/api/alerts/${id}/cap.xml`,{headers:headers()});if(!r.ok)throw new Error("تعذر إنشاء XML");const blob=await r.blob(),url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=`cap-alert-${id}.xml`;a.click();URL.revokeObjectURL(url)}catch(e){alert(e.message)}}
window.act=act;window.derive=derive;window.toggleUser=toggleUser;window.downloadXml=downloadXml;
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
   return '<article class="alertItem"><b>'+esc(row.headline||row.identifier||("مهمة #"+row.id))+'</b><div class="alertMeta"><span class="pill">'+esc(label)+'</span><span>القناة: '+esc(row.channel)+'</span><span>المحاولات: '+row.attempts+'/'+row.max_attempts+'</span><span>المعرف: #'+row.id+'</span>'+next+'</div>'+error+'</article>';
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
   const actions=row.status==="pending"?'<div class="actions"><button type="button" onclick="reviewWebhook('+row.id+',\'reviewed\')">تأكيد المراجعة</button><button class="secondary" type="button" onclick="reviewWebhook('+row.id+',\'rejected\')">رفض الرسالة</button></div>':"";
   return '<article class="alertItem"><b>رسالة واردة #'+row.id+'</b><div class="alertMeta"><span class="pill">'+esc(label)+'</span><span>وقت الاستلام: '+esc(row.received_at)+'</span><span>وقت المصدر: '+esc(new Date(row.source_timestamp*1000).toISOString())+'</span></div>'+reviewer+note+'<details><summary>عرض محتوى JSON</summary><pre class="webhookPayload">'+payload+'</pre></details>'+actions+'</article>';
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
