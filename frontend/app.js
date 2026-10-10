const API="https://bot-dashboard-w9zw.onrender.com";
const KEY_NAME="veyron_dashboard_api_key";
let apiKey=localStorage.getItem(KEY_NAME)||"";
let config={presence:"online",activityType:"Playing",activityText:"VEYRON Control",bioNote:"",pronounsNote:""};
let runtime={};
let loading=false;
const $=s=>document.querySelector(s);

function esc(v){
return String(v??"").replace(/[&<>"']/g,c=>({"&":"&","<":"<",">":">",'"':""","'":"'"}[c]));
}

function notify(msg,error=false){
const n=$("#notice");
if(!n)return;
n.textContent=msg;
n.classList.remove("hidden");
n.style.color=error?"#ffbaba":"";
}

async function request(path,options={}){
const headers={"Content-Type":"application/json",...(options.headers||{})};
if(apiKey)headers["x-dashboard-key"]=apiKey;
const r=await fetch(API+path,{...options,headers});
const d=await r.json().catch(()=>({}));
if(r.status===401){
apiKey=prompt("Enter your Render DASHBOARD_API_KEY")||"";
if(!apiKey)throw Error("Dashboard API key required.");
localStorage.setItem(KEY_NAME,apiKey);
return request(path,options);
}
if(!r.ok)throw Error(d.error||"HTTP ${r.status}");
return d;
}

function cleanNavigation(){
const nav=$("#navigation");
if(nav)nav.remove();
document.querySelectorAll(".sidebar-bottom,.nav-group,.nav-heading,.nav-item").forEach(e=>e.remove());
const title=$("#pageTitle");
if(title)title.textContent="Bot Status";
}

function render(){
cleanNavigation();
const b=runtime.bot||{};
const db=runtime.database||{};
const ai=runtime.ai||{};

$("#content").innerHTML=`

<div class="grid four">
<div class="card"><div class="stat-label">Discord Bot</div><div class="stat-value">${b.ready?"Online":"Offline"}</div></div>
<div class="card"><div class="stat-label">Gateway Latency</div><div class="stat-value">${Number.isFinite(b.ping)?Math.round(b.ping)+" ms":"—"}</div></div>
<div class="card"><div class="stat-label">Servers</div><div class="stat-value">${b.guilds??"—"}</div></div>
<div class="card"><div class="stat-label">Database</div><div class="stat-value">${db.connected?"Connected":"Unknown"}</div></div>
</div><div class="section-title"><h2>Bot Presence</h2><p>Manage your bot's Discord presence.</p></div><div class="grid two">
<form id="presenceForm" class="card">
<h2>Presence & Activity</h2>
<div class="field">
<label for="presence">Online Status</label>
<select id="presence">
${[["online","🟢 Online"],["dnd","⛔ Do Not Disturb"],["idle","🌙 Idle"],["invisible","⚫ Invisible"]].map(([v,l])=>`<option value="${v}" ${config.presence===v?"selected":""}>${l}</option>`).join("")}
</select>
</div>
<div class="field">
<label for="activityType">Activity Type</label>
<select id="activityType">
${["Playing","Watching","Listening","Competing"].map(v=>`<option value="${v}" ${config.activityType===v?"selected":""}>${v}</option>`).join("")}
</select>
</div>
<div class="field">
<label for="activityText">Activity Text</label>
<input id="activityText" maxlength="128" value="${esc(config.activityText)}">
</div>
<button class="primary" type="submit">Save & Apply Status</button>
</form><div class="card">
<h2>Bio & Pronouns</h2>
<p class="muted">These are dashboard notes. Discord's bot API does not support editing native About Me or pronouns.</p>
<div class="field">
<label for="bioNote">Bio</label>
<textarea id="bioNote" maxlength="500">${esc(config.bioNote)}</textarea>
</div>
<div class="field">
<label for="pronounsNote">Pronouns</label>
<input id="pronounsNote" maxlength="80" value="${esc(config.pronounsNote)}">
</div>
<button class="secondary" id="saveNotes" type="button">Save Bio & Pronouns</button>
</div>
</div><div class="card">
<h2>AI Status</h2>
<p>Provider: ${esc(ai.provider||"—")}</p>
<p>Model: ${esc(ai.model||"—")}</p>
<p>Configured: ${ai.configured===true?"Yes":ai.configured===false?"No":"Unknown"}</p>
</div>`;$("#presenceForm").onsubmit=async e=>{
e.preventDefault();
const button=e.submitter;
if(button)button.disabled=true;
try{
const patch={
presence:$("#presence").value,
activityType:$("#activityType").value,
activityText:$("#activityText").value.trim()
};
const d=await request("/api/status",{method:"POST",body:JSON.stringify(patch)});
config={...config,...(d.config||{}),...patch};
runtime=d.status||runtime;
notify("Presence update request completed.");
render();
}catch(e){notify(e.message,true);}
};

$("#saveNotes").onclick=async()=>{
const button=$("#saveNotes");
button.disabled=true;
try{
const patch={bioNote:$("#bioNote").value,pronounsNote:$("#pronounsNote").value};
const d=await request("/api/config",{method:"PUT",body:JSON.stringify(patch)});
config={...config,...(d.config||{}),...patch};
notify("Bio and pronouns saved.");
render();
}catch(e){notify(e.message,true);button.disabled=false;}
};
}

async function loadConfig(){
if(loading)return;
loading=true;
try{
const d=await request("/api/config");
config={...config,...(d.config||{})};
runtime=d.status||runtime;
const c=$("#connection");
if(c)c.textContent=runtime.bot?.ready?"Bot connected":"Bot not connected";
const dot=$("#statusDot");
if(dot)dot.className="dot "+(runtime.bot?.ready?"online":"offline");
render();
}catch(e){
const c=$("#connection");
if(c)c.textContent="Connection error";
notify(e.message,true);
}finally{loading=false;}
}

const refresh=$("#refreshButton");
if(refresh)refresh.onclick=loadConfig;
cleanNavigation();
loadConfig();
setInterval(loadConfig,30000);