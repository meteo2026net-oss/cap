let token = "";
const $ = s => document.querySelector(s);
const loginPanel=$("#loginPanel"), appPanel=$("#appPanel");
function headers(){return {"Content-Type":"application/json","Authorization":`Bearer ${token}`}}
async function api(url,opts={}){const r=await fetch(url,{...opts,headers:{...headers(),...(opts.headers||{})}});const data=await r.json().catch(()=>({}));if(!r.ok)throw new Error(data.error||"Request failed");return data}
function showApp(on){loginPanel.hidden=on;appPanel.hidden=!on}
$("#loginForm").addEventListener("submit",async e=>{e.preventDefault();const f=new FormData(e.target);try{const d=await fetch("/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(Object.fromEntries(f))}).then(r=>r.json());if(!d.token)throw new Error(d.error||"تعذر تسجيل الدخول");token=d.token;$("#userBadge").textContent=`${d.user.username} • ${d.user.role}`;$("#userAdmin").hidden=d.user.role!=="admin";showApp(true);await loadAlerts();initWarningMap();await refreshWarningMap();if(d.user.role==="admin")await loadUsers()}catch(err){$("#loginError").textContent=err.message}});
$("#logoutBtn").onclick=()=>{token="";
let warningMap=null, publishedGeoLayer=null, importedGeoLayer=null;
function initWarningMap(){
 if(warningMap||!window.L)return;
 warningMap=L.map("warningMap").setView([34.8,38.5],5);
 L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:18,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'}).addTo(warningMap);
 publishedGeoLayer=L.featureGroup().addTo(warningMap);
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
  const data=JSON.parse(await file.text());
  if(data.type!=="FeatureCollection"||!Array.isArray(data.features))throw new Error("يجب أن يكون الملف GeoJSON من نوع FeatureCollection.");
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

showApp(false);$("#userAdmin").hidden=true};
$("#refreshBtn").onclick=loadAlerts;
$("#userForm").addEventListener("submit",async e=>{e.preventDefault();const data=Object.fromEntries(new FormData(e.target));try{await api("/api/users",{method:"POST",body:JSON.stringify(data)});e.target.reset();await loadUsers();alert("تم إنشاء الحساب بنجاح.")}catch(err){alert(err.message)}});
async function toggleUser(id,active){const action=active?'تفعيل':'إيقاف';if(!confirm('هل تريد '+action+' هذا الحساب؟'))return;try{await api('/api/users/'+id+'/status',{method:'PATCH',body:JSON.stringify({active:!!active})});await loadUsers()}catch(e){alert(e.message)}}
async function loadUsers(){try{const {users}=await api("/api/users");$("#usersList").innerHTML=users.map(u=>`<article class="alertItem"><b>${esc(u.username)}</b><div class="alertMeta"><span class="pill">${esc(u.role)}</span><span>${u.active?"نشط":"موقوف"}</span></div><button class="secondary" onclick="toggleUser(${u.id},${u.active?0:1})">${u.active?"إيقاف الحساب":"إعادة تفعيل الحساب"}</button></article>`).join("")||'<p class="muted">لا توجد حسابات.</p>'}catch(e){$("#usersList").textContent=e.message}}
$("#alertForm").addEventListener("submit",async e=>{e.preventDefault();const obj=Object.fromEntries(new FormData(e.target));const jsonBlocks=obj.info_blocks_json?.trim();delete obj.info_blocks_json;if(jsonBlocks){try{obj.info_blocks=JSON.parse(jsonBlocks)}catch{alert("صيغة JSON غير صحيحة في كتل اللغات المتعددة.");return}}const hasInfoArea=obj.info_blocks?.some(b=>b.area||b.areas?.length);if(!obj.polygon?.trim()&&!obj.circle?.trim()&&!hasInfoArea){alert("أدخل مضلعاً أو دائرة أو منطقة جغرافية ضمن كتل المعلومات.");return}for(const k of ["onset","expires"])if(obj[k])obj[k]=new Date(obj[k]).toISOString();else obj[k]="";try{const d=await api("/api/alerts",{method:"POST",body:JSON.stringify(obj)});e.target.reset();alert(`تم حفظ المسودة: ${d.identifier}`);await loadAlerts()}catch(err){alert(err.message)}});
async function act(id,action){try{await api(`/api/alerts/${id}/${action}`,{method:"POST",body:"{}"});await loadAlerts()}catch(e){alert(e.message)}}
async function derive(id,msgType){const label=msgType==='Cancel'?'إلغاء التحذير':'إنشاء تحديث';if(!confirm(label+'؟ ستنشأ مسودة CAP بحالة Test وتحتاج إلى مراجعة واعتماد مستقلين.'))return;try{const result=await api('/api/alerts/'+id+'/derive',{method:'POST',body:JSON.stringify({msg_type:msgType})});alert('تم إنشاء المسودة: '+result.identifier+' (Test)');await loadAlerts()}catch(e){alert(e.message)}}
async function loadAlerts(){try{const {alerts}=await api("/api/alerts");$("#total").textContent=alerts.length;$("#drafts").textContent=alerts.filter(a=>a.workflow==="draft").length;$("#pending").textContent=alerts.filter(a=>a.workflow==="pending").length;$("#published").textContent=alerts.filter(a=>a.workflow==="published").length;$("#alertsList").innerHTML=alerts.map(a=>`<article class="alertItem"><b>${esc(a.headline)}</b><div class="alertMeta"><span>${esc(a.event)}</span><span class="pill">${esc(a.workflow)}</span><span class="pill ${a.severity==="Extreme"||a.severity==="Severe"?"red":"orange"}">${esc(a.severity)}</span><span>${esc(a.area_desc)}</span></div><div class="actions">${a.workflow==="draft"?`<button onclick="act(${a.id},'submit')">إرسال للمراجعة</button>`:""}${a.workflow==="pending"?`<button onclick="act(${a.id},'approve')">اعتماد</button>`:""}${a.workflow==="approved"?`<button onclick="act(${a.id},'publish')">نشر داخلي</button>`:""}${(a.workflow==="approved"||a.workflow==="published") ? "<button class=\"secondary\" onclick=\"derive(" + a.id + ", &quot;Update&quot;)\">إنشاء تحديث</button>" + "<button class=\"secondary\" onclick=\"derive(" + a.id + ", &quot;Cancel&quot;)\">إلغاء التحذير</button>" : ""}<button class="secondary" onclick="downloadXml(${a.id})">CAP XML</button></div></article>`).join("")||'<p class="muted">لا توجد تحذيرات حتى الآن.</p>'}catch(e){if(e.message.includes("Authentication")){token="";showApp(false);$("#userAdmin").hidden=true;}else $("#alertsList").textContent=e.message}}
function esc(s=""){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
async function downloadXml(id){try{const r=await fetch(`/api/alerts/${id}/cap.xml`,{headers:headers()});if(!r.ok)throw new Error("تعذر إنشاء XML");const blob=await r.blob(),url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=`cap-alert-${id}.xml`;a.click();URL.revokeObjectURL(url)}catch(e){alert(e.message)}}
window.act=act;window.derive=derive;window.toggleUser=toggleUser;window.downloadXml=downloadXml;
showApp(false);