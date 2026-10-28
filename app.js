(() => {
const API = window.FREIBURG_CONFIG.API_BASE_URL.replace(/\/$/, "");
const $ = id => document.getElementById(id);
let user = null, map = null, markers = [];
async function api(path, opts={}) {
  const r = await fetch(API + path, {credentials:"include",headers:{"Content-Type":"application/json",...(opts.headers||{})},...opts});
  if (r.status === 401) { user=null; renderUser(); throw new Error("Bitte zuerst mit Discord anmelden."); }
  const data = await r.json().catch(()=>({error:"Ungültige Serverantwort"}));
  if (!r.ok) throw new Error(data.error || "Anfrage fehlgeschlagen");
  return data;
}
function renderUser(){ $("who").textContent=user?`Angemeldet: ${user.username}`:"Nicht angemeldet"; $("login").hidden=!!user; $("logout").hidden=!user; }
function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function alarmCard(a, historical=false){
 const div=document.createElement("div"); div.className="item "+(a.test?"test":"live");
 const groups=(a.groups||[]).join(", ")||"Keine Gruppe";
 div.innerHTML=`<h3>${a.test?"🧪 TEST · ":"🚨 "}${esc(a.keyword)}</h3><p><b>Status:</b> ${esc(a.status)} · <b>PLZ:</b> ${esc(a.postalCode||"—")}</p><p><b>Adresse:</b> ${esc(a.address)}</p><p>${esc(a.description||"")}</p><p><b>Gruppen:</b> ${esc(groups)}</p><p><b>Erstellt:</b> ${esc(new Date(a.createdAt).toLocaleString("de-DE"))}</p><p><b>Rückmeldungen:</b> ${(a.responses||[]).length}</p>`;
 if(!historical && a.status!=="geschlossen"){
  const actions=document.createElement("div"); actions.className="actions";
  const respond=document.createElement("button"); respond.textContent="Rückmelden"; respond.onclick=async()=>{const status=prompt("Rückmeldung (z. B. Übernommen, Auf Anfahrt, Vor Ort):","Übernommen");if(!status)return;try{await api(`/api/alarms/${a.id}/responses`,{method:"POST",body:JSON.stringify({status})});await loadData();}catch(e){alert(e.message)}};
  const close=document.createElement("button");close.textContent="Alarm schließen";close.onclick=async()=>{if(!confirm("Alarm schließen?"))return;try{await api(`/api/alarms/${a.id}/close`,{method:"POST",body:"{}"});await loadData()}catch(e){alert(e.message)}};
  actions.append(respond,close);div.append(actions);
 }
 return div;
}
function setMap(alarms){
 if(!window.L)return;
 if(!map){map=L.map("map").setView([47.999,7.842],11);L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19,attribution:"© OpenStreetMap contributors"}).addTo(map);}
 markers.forEach(m=>map.removeLayer(m));markers=[];
 // Use coordinates entered by trusted staff in a future extension; do not send addresses to third-party geocoders automatically.
 alarms.forEach(a=>{if(Number.isFinite(a.lat)&&Number.isFinite(a.lng)){const m=L.marker([a.lat,a.lng]).addTo(map).bindPopup(`<b>${esc(a.keyword)}</b><br>${esc(a.address)}`);markers.push(m)}});
}
async function loadData(){
 try{
  const [active,hist,mode]=await Promise.all([api("/api/alarms"),api("/api/history"),api("/api/mode")]);
  $("alarms").replaceChildren(); active.alarms.length?active.alarms.forEach(a=>$("alarms").append(alarmCard(a))):$("alarms").textContent="Keine aktiven Alarme.";
  $("history").replaceChildren(); hist.alarms.length?hist.alarms.forEach(a=>$("history").append(alarmCard(a,true))):$("history").textContent="Noch keine Historieneinträge.";
  $("mode").textContent=mode.testMode?"TESTMODUS AKTIV":"LIVE-MODUS"; $("mode").style.background=mode.testMode?"#633f13":"#6c252b";
  setMap(active.alarms);
 }catch(e){$("alarms").textContent=e.message;}
}
$("login").onclick=()=>location.href=API+"/auth/login";
$("logout").onclick=async()=>{try{await api("/auth/logout",{method:"POST",body:"{}"})}catch{}user=null;renderUser();$("alarms").textContent="Bitte anmelden.";};
$("refresh").onclick=loadData;
$("sound").onclick=()=>{try{const ctx=new (window.AudioContext||window.webkitAudioContext)();[0,0.18,0.36].forEach(t=>{const o=ctx.createOscillator(),g=ctx.createGain();o.frequency.value=880;o.connect(g);g.connect(ctx.destination);g.gain.setValueAtTime(.001,ctx.currentTime+t);g.gain.exponentialRampToValueAtTime(.25,ctx.currentTime+t+.02);g.gain.exponentialRampToValueAtTime(.001,ctx.currentTime+t+.13);o.start(ctx.currentTime+t);o.stop(ctx.currentTime+t+.14)});}catch(e){alert("Sound konnte nicht abgespielt werden.")}};
$("alarmForm").onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target);const groups=f.getAll("groups");const body={keyword:f.get("keyword"),address:f.get("address"),postalCode:f.get("postalCode"),description:f.get("description"),groups,test:f.get("test")==="on",lat:f.get("lat"),lng:f.get("lng")};try{const res=await api("/api/alarms",{method:"POST",body:JSON.stringify(body)});$("formMsg").textContent=res.alarm.test?"Testalarm angelegt – nicht an den Alarmkanal gesendet.":"Alarm angelegt und an den Discord-Kanal gesendet.";e.target.reset();e.target.querySelector('[name="test"]').checked=true;await loadData();}catch(err){$("formMsg").textContent=err.message;}};
(async()=>{try{const x=await api("/api/me");user=x.user;renderUser();await loadData()}catch{renderUser();}})();
})();