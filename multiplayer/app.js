import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/* ===================== Config ===================== */
const SUPABASE_URL = "https://jlbpbizelvnrzadyztfz.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpsYnBiaXplbHZucnphZHl6dGZ6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg0MzgzMjEsImV4cCI6MjA3NDAxNDMyMX0.DgsIreHYbd6ynUIFlAk8U-j2i0W3qkT9hm41toFFBxI";

// Colors
const MY_COLOR     = "#60a5fa";  // you = blue
const OTHER_COLOR  = "#ffffff";  // others = white
const MOB_COLOR    = "#ef4444";  // mobs = red
const COIN_COLOR   = "#ffc83d";  // coins = yellow

// Movement smoothing
let SMOOTH = 12;

// Idle cleanup
const IDLE_MOVE_EPS = 2;
const IDLE_SECS     = 60;
const GHOST_SECS    = 20;

// HP
const HP_MAX = 100;
let hp = HP_MAX;
const CONTACT_DAMAGE = 20;
const INVULN_MS = 700;
let lastHitAt = -1;

// Coins
const COIN_R = 8;
const PICKUP_RADIUS = 42;
const COIN_HEAL = 8;
const MAX_COINS = 25;

// Mobs
const MOB_R = 10;
const MAX_MOBS = 12;
const MOB_SPEED = 120;
const MOB_MAX_SPEED = 140;
const SEP_RADIUS = 36;
const SEP_FORCE = 220;
const HOST_BROADCAST_MS = 150;
const NO_FEED_MS = 2500;

// 🔀 New: randomized spawning & lifetimes
const MOB_SPAWN_MIN_MS = 400;   // fastest spawn gap
const MOB_SPAWN_MAX_MS = 2000;  // slowest spawn gap
const MOB_DESPAWN_MIN_MS = 3500; // shortest lifetime
const MOB_DESPAWN_MAX_MS = 8000; // longest lifetime

/* ===================== Setup ===================== */
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const uid = crypto.randomUUID();
let name = "guest" + Math.floor(Math.random()*9999);

// DOM
const cvs = document.getElementById("c");
const ctx = cvs.getContext("2d");
document.getElementById("me").textContent = name;

const nameInput = document.getElementById("nameInput");
const nameBtn = document.getElementById("nameBtn");
nameInput.value = name;

// HUD slider
const smoothRange = document.getElementById("smoothRange");
const smoothVal = document.getElementById("smoothVal");
smoothRange.addEventListener("input", () => {
  SMOOTH = parseInt(smoothRange.value,10);
  smoothVal.textContent = SMOOTH;
});

// Entities
const me = { id: uid, name, color: MY_COLOR, x: cvs.width/2, y: cvs.height/2 };
const others = new Map();
const coins = [];
let score = 0;
const coinHud = document.getElementById("coinVal");

// Mobs state
let mobs = [];
let isHost = false;
let lastMobsBroadcast = 0;
let lastMobsSeq = 0;
let lastMobsHeard = 0;

// 🔀 New: spawn scheduler
let nextMobSpawnAt = performance.now() + randRange(MOB_SPAWN_MIN_MS, MOB_SPAWN_MAX_MS);

/* ===================== Visibility heartbeats ===================== */
let isVisible = !document.hidden;
const visMap = new Map(); // id -> { visible, ts }
const VIS_TTL = 4000;
const VIS_PING_MS = 1500;

function sendVisibility(){
  room.send({ type:"broadcast", event:"vis", payload:{ id: uid, visible: isVisible, ts: Date.now() } });
}
setInterval(sendVisibility, VIS_PING_MS);
document.addEventListener("visibilitychange", () => {
  isVisible = !document.hidden;
  sendVisibility();
  recomputeHost();
});

/* ===================== Realtime ===================== */
const room = supabase.channel("dots-room", {
  config: { broadcast: { self: true }, presence: { key: uid } }
});

function smallestVisibleId() {
  const state = room.presenceState();
  const allIds = Object.keys(state);
  const now = Date.now();
  const visibleIds = allIds.filter(id => {
    const v = visMap.get(id);
    return v && v.visible && (now - v.ts) < VIS_TTL;
  });
  const pool = visibleIds.length ? visibleIds : allIds;
  pool.sort();
  return pool[0];
}

function recomputeHost(){
  const current = isHost;
  const chosen = smallestVisibleId();
  const nextIsHost = (chosen === uid);
  if (nextIsHost !== current) {
    isHost = nextIsHost;
    if (isHost) lastMobsSeq = 0;
  }
}

room.on("presence", { event:"sync" }, () => {
  const state = room.presenceState();
  document.getElementById("cnt").textContent = Object.keys(state).length;
  recomputeHost();
  sendState();
});
room.on("presence", { event:"join" }, recomputeHost);
room.on("presence", { event:"leave" }, recomputeHost);

room.subscribe((status) => {
  if (status === "SUBSCRIBED") {
    room.track({ id: uid, name, color: MY_COLOR });
    addSysMsg("Joined the room.");
    sendState();
    setTimeout(recomputeHost, 300);
  }
});

// player state
room.on("broadcast", { event:"state" }, (payload) => {
  const p = payload.payload;
  if (!p || p.id === uid) return;
  const nowTs = performance.now();
  const prev = others.get(p.id);
  if (!prev) {
    others.set(p.id, { id:p.id, name:p.name, color:OTHER_COLOR, x:p.x, y:p.y, tx:p.x, ty:p.y, lastHeardTs:nowTs, lastActiveTs:nowTs });
    return;
  }
  const moved = Math.hypot((p.x-prev.tx),(p.y-prev.ty)) > IDLE_MOVE_EPS;
  prev.tx=p.x; prev.ty=p.y;
  prev.name=p.name; prev.color=OTHER_COLOR;
  prev.lastHeardTs=nowTs; if (moved) prev.lastActiveTs=nowTs;
});

// mobs sync
room.on("broadcast",{ event:"mobs" }, (payload)=>{
  if (isHost) return;
  lastMobsHeard = performance.now();
  const data = payload.payload;
  if (!data || typeof data.seq!=="number" || !Array.isArray(data.mobs)) return;
  if (data.seq <= lastMobsSeq) return;
  lastMobsSeq = data.seq;
  if (mobs.length < data.mobs.length) {
    for (let i=mobs.length;i<data.mobs.length;i++) mobs.push({x:data.mobs[i][0],y:data.mobs[i][1],vx:0,vy:0,tx:data.mobs[i][0],ty:data.mobs[i][1]});
  } else if (mobs.length > data.mobs.length) {
    mobs.length = data.mobs.length;
  }
  for (let i=0;i<data.mobs.length;i++) {
    const [nx,ny] = data.mobs[i]; const m=mobs[i]; if(!m)continue;
    m.tx=nx; m.ty=ny; if(m.x===undefined){m.x=nx;m.y=ny;}
  }
});

// visibility sync
room.on("broadcast",{ event:"vis" }, (payload)=>{
  const d = payload.payload;
  if (!d||!d.id) return;
  visMap.set(d.id,{ visible:!!d.visible, ts:d.ts||Date.now() });
  recomputeHost();
});

/* ===================== Chat ===================== */
const shownMsgIds=new Set();
room.on("broadcast",{event:"chat"},(payload)=>{
  const m=payload.payload;
  if(!m||!m.mid||shownMsgIds.has(m.mid))return;
  shownMsgIds.add(m.mid);
  addChatMsg(m.name,m.text,m.id===uid?"#60a5fa":"#e5e7eb");
});
const chatInput=document.getElementById("chatInput");
chatInput.addEventListener("keydown",(e)=>{
  if(e.key!=="Enter")return;
  const text=chatInput.value.trim(); if(!text)return;
  const mid=(crypto?.randomUUID?.()||Math.random().toString(36).slice(2))+"-"+Date.now();
  const msg={mid,id:uid,name,text,ts:Date.now()};
  if(!shownMsgIds.has(mid)){shownMsgIds.add(mid);addChatMsg(name,text,"#60a5fa");}
  room.send({type:"broadcast",event:"chat",payload:msg});
  chatInput.value=""; e.preventDefault();
});
function addChatMsg(sender,text,color="#e5e7eb"){
  const box=document.getElementById("messages");
  const div=document.createElement("div");
  div.className="msg"; div.innerHTML=`<span class="name" style="color:${color}">${escapeHtml(sender)}:</span> ${escapeHtml(text)}`;
  box.appendChild(div); div.scrollIntoView({block:"end"});
}
function addSysMsg(text){
  const box=document.getElementById("messages");
  const div=document.createElement("div"); div.className="sys"; div.textContent=text;
  box.appendChild(div); div.scrollIntoView({block:"end"});
}
function escapeHtml(s){return s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c]));}

/* ===================== Name change ===================== */
function applyName(){
  const newName=nameInput.value.trim(); if(!newName)return;
  name=newName; me.name=name;
  document.getElementById("me").textContent=name;
  addSysMsg("You are now known as "+name);
  sendState();
}
nameBtn.addEventListener("click",applyName);
nameInput.addEventListener("keydown",e=>{if(e.key==="Enter")applyName();});

/* ===================== Input ===================== */
const keys=new Set();
addEventListener("keydown",e=>{
  if(document.activeElement===chatInput||document.activeElement===nameInput)return;
  if(["ArrowUp","ArrowDown","ArrowLeft","ArrowRight","w","a","s","d"].includes(e.key)){keys.add(e.key.toLowerCase());e.preventDefault();}
});
addEventListener("keyup",e=>{
  if(document.activeElement===chatInput||document.activeElement===nameInput)return;
  keys.delete(e.key.toLowerCase());
});

// Joystick
const joy=document.getElementById("joy"); const thumb=document.getElementById("thumb");
const mobile={dx:0,dy:0,active:false};
function getPoint(e){const rect=joy.getBoundingClientRect();const p=(e.touches&&e.touches[0])||e;
let x=p.clientX-(rect.left+rect.width/2);let y=p.clientY-(rect.top+rect.height/2);
const max=44;const len=Math.hypot(x,y)||1;if(len>max){x=x/len*max;y=y/len*max;}return {x,y,max};}
function setThumb(pt){thumb.style.transform=`translate(${pt.x}px,${pt.y}px)`;}
function updateMobile(pt){mobile.dx=+(pt.x/pt.max).toFixed(3);mobile.dy=+(pt.y/pt.max).toFixed(3);}
function joyStart(e){e.preventDefault();mobile.active=true;const pt=getPoint(e);setThumb(pt);updateMobile(pt);}
function joyMove(e){if(!mobile.active)return;e.preventDefault();const pt=getPoint(e);setThumb(pt);updateMobile(pt);}
function joyEnd(){mobile.active=false;mobile.dx=0;mobile.dy=0;setThumb({x:0,y:0});}
joy.addEventListener("touchstart",joyStart,{passive:false});joy.addEventListener("touchmove",joyMove,{passive:false});
joy.addEventListener("touchend",joyEnd,{passive:false});joy.addEventListener("mousedown",joyStart);
window.addEventListener("mousemove",joyMove);window.addEventListener("mouseup",joyEnd);

/* ===================== Coins ===================== */
function spawnCoin(){coins.push({x:Math.random()*cvs.width,y:Math.random()*cvs.height,born:performance.now()});}
setInterval(()=>{if(coins.length<MAX_COINS)spawnCoin();},1500);

/* ===================== Host: Mobs simulation ===================== */
// 🔀 Updated to include born/lifeMs for despawn + randomized spawn timing
function spawnMob(){
  const side=Math.floor(Math.random()*4);let x=0,y=0;
  if(side===0){x=Math.random()*cvs.width;y=-20;}
  if(side===1){x=cvs.width+20;y=Math.random()*cvs.height;}
  if(side===2){x=Math.random()*cvs.width;y=cvs.height+20;}
  if(side===3){x=-20;y=Math.random()*cvs.height;}
  mobs.push({
    x, y,
    vx:(Math.random()-0.5)*40,
    vy:(Math.random()-0.5)*40,
    born: performance.now(),
    lifeMs: randRange(MOB_DESPAWN_MIN_MS, MOB_DESPAWN_MAX_MS)
  });
}

// 🔀 Randomized spawn cadence + despawn of expired mobs on the host
function hostUpdateMobs(dt,t){
  if(!isVisible) return;

  let dirty = false; // track changes to broadcast immediately

  // Randomized spawn schedule: as long as it's time (and under cap), spawn and schedule next
  while (t >= nextMobSpawnAt && mobs.length < MAX_MOBS) {
    spawnMob();
    nextMobSpawnAt += randRange(MOB_SPAWN_MIN_MS, MOB_SPAWN_MAX_MS);
    dirty = true;
  }

  // Physics + separation
  for(let i=0;i<mobs.length;i++){
    const m=mobs[i];
    let target={x:cvs.width/2,y:cvs.height/2};
    const players=[{x:me.x,y:me.y}]; for(const o of others.values())players.push({x:o.tx??o.x,y:o.ty??o.y});
    if(players.length>0){
      if(Math.random()<0.7){
        let best=players[0],bestD2=Infinity;
        for(const p of players){const dx=p.x-m.x,dy=p.y-m.y,d2=dx*dx+dy*dy;if(d2<bestD2){bestD2=d2;best=p;}}
        target=best;
      }else{target=players[Math.floor(Math.random()*players.length)];}
    }
    let dx=target.x-m.x,dy=target.y-m.y,len=Math.hypot(dx,dy)||1;
    let cx=(dx/len)*MOB_SPEED,cy=(dy/len)*MOB_SPEED;
    let sx=0,sy=0;
    for(let j=0;j<mobs.length;j++)if(j!==i){
      const n=mobs[j];const rx=m.x-n.x,ry=m.y-n.y,d2=rx*rx+ry*ry;
      if(d2>0&&d2<SEP_RADIUS*SEP_RADIUS){const d=Math.sqrt(d2);const w=(SEP_RADIUS-d)/SEP_RADIUS;
        sx+=(rx/(d||1))*(SEP_FORCE*w);sy+=(ry/(d||1))*(SEP_FORCE*w);}
    }
    m.vx=cx+sx+m.vx*0.05;m.vy=cy+sy+m.vy*0.05;
    const sp=Math.hypot(m.vx,m.vy);if(sp>MOB_MAX_SPEED){m.vx=m.vx/sp*MOB_MAX_SPEED;m.vy=m.vy/sp*MOB_MAX_SPEED;}
    m.x+=m.vx*dt;m.y+=m.vy*dt;
  }

  // 🔥 Despawn expired mobs
  const now = performance.now();
  for (let i = mobs.length - 1; i >= 0; i--) {
    const m = mobs[i];
    if (now - m.born >= m.lifeMs) { mobs.splice(i, 1); dirty = true; }
  }

  // Broadcast (on cadence OR immediately if list changed)
  if (dirty || (t - lastMobsBroadcast > HOST_BROADCAST_MS)) {
    lastMobsBroadcast=t; lastMobsSeq++;
    room.send({type:"broadcast",event:"mobs",payload:{seq:lastMobsSeq,mobs:mobs.map(m => [m.x, m.y])}});
  }
}

function clientFollowMobs(dt){
  for(const m of mobs){if(m.tx===undefined)continue;
    const k=Math.min(1,12*dt);m.x=(m.x??m.tx)+(m.tx-(m.x??m.tx))*k;m.y=(m.y??m.ty)+(m.ty-(m.y??m.ty))*k;}
}

/* ===================== Drawing ===================== */
function drawEntity(x,y,color){ctx.beginPath();ctx.arc(x,y,8,0,Math.PI*2);ctx.fillStyle=color;ctx.fill();}
function drawName(x,y,name){ctx.fillStyle="rgba(255,255,255,.9)";ctx.font="12px system-ui";ctx.textAlign="center";ctx.fillText(name,x,y-14);}
function drawRing(x,y){ctx.strokeStyle="rgba(255,255,255,.6)";ctx.lineWidth=2;ctx.beginPath();ctx.arc(x,y,12,0,Math.PI*2);ctx.stroke();}
function drawHPBar(x,y,w=42,h=6){
  const pad=16,pct=hp/HP_MAX,left=x-w/2,top=y-20-pad;
  ctx.fillStyle="rgba(0,0,0,0.45)";ctx.fillRect(left,top,w,h);
  ctx.fillStyle=pct>0.5?"#22c55e":(pct>0.25?"#f59e0b":"#ef4444");
  ctx.fillRect(left,top,Math.max(0,w*pct),h);
  ctx.strokeStyle="rgba(255,255,255,0.6)";ctx.lineWidth=1;ctx.strokeRect(left+.5,top+.5,w-1,h-1);
}
function drawMobs(){
  for(const m of mobs){
    ctx.beginPath();ctx.globalAlpha=0.22;ctx.arc(m.x,m.y,MOB_R*2.1,0,Math.PI*2);ctx.fillStyle=MOB_COLOR;ctx.fill();
    ctx.globalAlpha=1;ctx.beginPath();ctx.arc(m.x,m.y,MOB_R,0,Math.PI*2);ctx.fillStyle=MOB_COLOR;ctx.fill();
  }
}

/* ===================== Game Loop ===================== */
let last=performance.now(),acc=0;
function loop(t){
  const dt=Math.min(0.05,(t-last)/1000);last=t;
  const up=keys.has("arrowup")||keys.has("w"),dn=keys.has("arrowdown")||keys.has("s");
  const lf=keys.has("arrowleft")||keys.has("a"),rt=keys.has("arrowright")||keys.has("d");
  const speed=240;
  let kx=(rt?1:0)-(lf?1:0),ky=(dn?1:0)-(up?1:0);
  let ax=kx+mobile.dx,ay=ky+mobile.dy;
  const mag=Math.hypot(ax,ay);if(mag>1){ax/=mag;ay/=mag;}
  me.x=Math.max(0,Math.min(cvs.width,me.x+ax*speed*dt));
  me.y=Math.max(0,Math.min(cvs.height,me.y+ay*speed*dt));

  acc+=dt;if(acc>0.1){acc=0;sendState();}
  for(const o of others.values()){
    if(SMOOTH===0){o.x=o.tx;o.y=o.ty;continue;}
    const f=Math.min(1,SMOOTH*dt);o.x+=(o.tx-o.x)*f;o.y+=(o.ty-o.y)*f;
  }

  if(isHost){hostUpdateMobs(dt,t);} else {clientFollowMobs(dt);}
  // watchdog
  const now=performance.now();const expectedHost=smallestVisibleId();
  const shouldBeHost=(expectedHost===uid)&&isVisible;
  if(!isHost&&shouldBeHost&&(now-lastMobsHeard>NO_FEED_MS)){
    isHost=true;addSysMsg("No visible host feeding. Promoted to host.");lastMobsSeq=0;
  }

  // Collisions
  const nowms=performance.now();
  for(let i=0;i<mobs.length;i++){
    const m=mobs[i];const dx=me.x-m.x,dy=me.y-m.y;
    if(dx*dx+dy*dy<(MOB_R+10)*(MOB_R+10)&&nowms-lastHitAt>INVULN_MS){
      hp-=CONTACT_DAMAGE;lastHitAt=nowms;if(hp<0)hp=0;
    }
  }
  for(let i=coins.length-1;i>=0;i--){
    const c=coins[i];const dx=me.x-c.x,dy=me.y-c.y;
    if(dx*dx+dy*dy<PICKUP_RADIUS*PICKUP_RADIUS){coins.splice(i,1);score++;coinHud.textContent=score;hp=Math.min(HP_MAX,hp+COIN_HEAL);}
  }

  // Idle prune
  for(const [id,o] of others){
    const idle=(now-o.lastActiveTs)/1000;
    const ghost=(now-o.lastHeardTs)/1000;
    if(idle>IDLE_SECS&&ghost>GHOST_SECS){others.delete(id);}
  }

  // Draw
  ctx.clearRect(0,0,cvs.width,cvs.height);
  for(const c of coins){ctx.beginPath();ctx.arc(c.x,c.y,COIN_R,0,Math.PI*2);ctx.fillStyle=COIN_COLOR;ctx.fill();}
  drawMobs();
  for(const o of others.values()){drawEntity(o.x,o.y,o.color);drawName(o.x,o.y,o.name);}
  drawEntity(me.x,me.y,MY_COLOR);drawName(me.x,me.y,me.name);drawRing(me.x,me.y);drawHPBar(me.x,me.y);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

/* ===================== Utils ===================== */
function sendState(){room.send({type:"broadcast",event:"state",payload:{id:uid,name,color:MY_COLOR,x:Math.round(me.x),y:Math.round(me.y),ts:Date.now()}});}

// 🔀 helper
function randRange(min, max){ return min + Math.random()*(max-min); }
