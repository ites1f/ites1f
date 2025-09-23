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
const IDLE_MOVE_EPS = 2;     // px change to count as movement
const IDLE_SECS     = 60;    // remove if no movement for this long
const GHOST_SECS    = 20;    // remove if no packets for this long

// HP / Damage
const HP_MAX = 100;
let hp = HP_MAX;
const CONTACT_DAMAGE = 20;
const INVULN_MS = 700;
let lastHitAt = -1;

// Coins
const COIN_R = 8;
const PICKUP_RADIUS = 22;   // proximity pickup distance
const COIN_HEAL = 8;        // heal per coin
const MAX_COINS = 25;

// Mobs (with anti-merge + mild target variety)
const MOB_R = 10;
const MAX_MOBS = 12;
const MOB_SPEED = 120;      // chase speed
const MOB_MAX_SPEED = 140;  // clamp total speed
const SEP_RADIUS = 36;      // separation
const SEP_FORCE = 220;
const HOST_BROADCAST_MS = 150; // host sends mob positions
const NO_FEED_MS = 2500;       // if no mob packets, watchdog may promote host

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

// Mobs state (peer-hosted)
let mobs = []; // {x,y,vx,vy, tx?, ty?}
let isHost = false;
let lastMobsBroadcast = 0;
let lastMobsSeq = 0;
let lastMobsHeard = 0;

/* ===================== Realtime ===================== */
const room = supabase.channel("dots-room", {
  config: { broadcast: { self: true }, presence: { key: uid } }
});

function iAmSmallest() {
  const state = room.presenceState();
  const keys = Object.keys(state).sort();
  if (keys.length === 0) return true;
  return keys[0] === uid;
}
function recomputeHost() {
  const prev = isHost;
  isHost = iAmSmallest();
  if (isHost && !prev) addSysMsg("You are now host (mobs AI).");
  if (!isHost && prev) addSysMsg("Another player became host.");
}

room.on("presence", { event: "sync" }, () => {
  const state = room.presenceState();
  document.getElementById("cnt").textContent = Object.keys(state).length;
  recomputeHost();
  sendState();
});
room.on("presence", { event: "join"  }, recomputeHost);
room.on("presence", { event: "leave" }, recomputeHost);

room.subscribe((status) => {
  if (status === "SUBSCRIBED") {
    room.track({ id: uid, name, color: MY_COLOR, joinedAt: Date.now() });
    addSysMsg("Joined the room.");
    sendState();
    setTimeout(recomputeHost, 300); // give presence a moment
  }
});

// Track if this tab is visible
let isVisible = !document.hidden;
document.addEventListener("visibilitychange", () => {
  isVisible = !document.hidden;
  if (!isVisible && isHost) {
    // If host goes hidden, immediately give up host role
    isHost = false;
    addSysMsg("Tab hidden → stepping down as host.");
  }
  recomputeHost();
});

// players' positions
room.on("broadcast", { event: "state" }, (payload) => {
  const p = payload.payload;
  if (!p || p.id === uid) return;

  const nowTs = performance.now();
  const prev = others.get(p.id);

  if (!prev) {
    others.set(p.id, {
      id: p.id, name: p.name, color: OTHER_COLOR,
      x: p.x, y: p.y, tx: p.x, ty: p.y,
      lastHeardTs: nowTs, lastActiveTs: nowTs
    });
    return;
  }

  const moved = Math.hypot((p.x - prev.tx), (p.y - prev.ty)) > IDLE_MOVE_EPS;
  prev.tx = p.x; prev.ty = p.y;
  prev.name = p.name;
  prev.color = OTHER_COLOR;
  prev.lastHeardTs = nowTs;
  if (moved) prev.lastActiveTs = nowTs;
});

// mobs sync (from host)
room.on("broadcast", { event: "mobs" }, (payload) => {
  if (isHost) return; // host ignores its own stream
  lastMobsHeard = performance.now();
  const data = payload.payload;
  if (!data || typeof data.seq !== "number" || !Array.isArray(data.mobs)) return;
  if (data.seq <= lastMobsSeq) return;
  lastMobsSeq = data.seq;

  // Resize local array
  if (mobs.length < data.mobs.length) {
    for (let i = mobs.length; i < data.mobs.length; i++)
      mobs.push({ x: data.mobs[i][0], y: data.mobs[i][1], vx:0, vy:0, tx:data.mobs[i][0], ty:data.mobs[i][1] });
  } else if (mobs.length > data.mobs.length) {
    mobs.length = data.mobs.length;
  }
  // Update targets; we lerp to avoid snapping
  for (let i = 0; i < data.mobs.length; i++) {
    const [nx, ny] = data.mobs[i];
    const m = mobs[i];
    if (!m) continue;
    m.tx = nx; m.ty = ny;
    if (m.x === undefined) { m.x = nx; m.y = ny; }
  }
});

/* ===================== Chat ===================== */
const shownMsgIds = new Set();
room.on("broadcast", { event: "chat" }, (payload) => {
  const m = payload.payload;
  if (!m || !m.mid || shownMsgIds.has(m.mid)) return;
  shownMsgIds.add(m.mid);
  addChatMsg(m.name, m.text, m.id === uid ? "#60a5fa" : "#e5e7eb");
});

const chatInput = document.getElementById("chatInput");
chatInput.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const text = chatInput.value.trim();
  if (!text) return;
  const mid = (crypto?.randomUUID?.() || Math.random().toString(36).slice(2)) + "-" + Date.now();
  const msg = { mid, id: uid, name, text, ts: Date.now() };
  if (!shownMsgIds.has(mid)) {
    shownMsgIds.add(mid);
    addChatMsg(name, text, "#60a5fa");
  }
  room.send({ type: "broadcast", event: "chat", payload: msg });
  chatInput.value = "";
  e.preventDefault();
});

function addChatMsg(sender, text, color="#e5e7eb"){
  const box = document.getElementById("messages");
  const div = document.createElement("div");
  div.className = "msg";
  div.innerHTML = `<span class="name" style="color:${color}">${escapeHtml(sender)}:</span> ${escapeHtml(text)}`;
  box.appendChild(div); div.scrollIntoView({ block:"end" });
}
function addSysMsg(text){
  const box = document.getElementById("messages");
  const div = document.createElement("div");
  div.className = "sys"; div.textContent = text;
  box.appendChild(div); div.scrollIntoView({ block:"end" });
}
function escapeHtml(s){
  return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c]));
}

/* ===================== Name change ===================== */
function applyName() {
  const newName = nameInput.value.trim();
  if (!newName) return;
  name = newName;
  me.name = name;
  document.getElementById("me").textContent = name;
  addSysMsg("You are now known as " + name);
  sendState();
}
nameBtn.addEventListener("click", applyName);
nameInput.addEventListener("keydown", e => { if (e.key === "Enter") applyName(); });

/* ===================== Input ===================== */
const keys = new Set();
addEventListener("keydown", e => {
  if (document.activeElement === chatInput || document.activeElement === nameInput) return;
  if (["ArrowUp","ArrowDown","ArrowLeft","ArrowRight","w","a","s","d"].includes(e.key)) {
    keys.add(e.key.toLowerCase()); e.preventDefault();
  }
});
addEventListener("keyup", e => {
  if (document.activeElement === chatInput || document.activeElement === nameInput) return;
  keys.delete(e.key.toLowerCase());
});

// Joystick
const joy = document.getElementById("joy");
const thumb = document.getElementById("thumb");
const mobile = { dx: 0, dy: 0, active: false };
function getPoint(e){
  const rect = joy.getBoundingClientRect();
  const p = (e.touches && e.touches[0]) || e;
  let x = p.clientX - (rect.left + rect.width/2);
  let y = p.clientY - (rect.top  + rect.height/2);
  const max = 44; const len = Math.hypot(x,y) || 1;
  if (len > max){ x = x/len*max; y = y/len*max; }
  return { x,y,max };
}
function setThumb(pt){ thumb.style.transform=`translate(${pt.x}px,${pt.y}px)`; }
function updateMobile(pt){ mobile.dx=+(pt.x/pt.max).toFixed(3); mobile.dy=+(pt.y/pt.max).toFixed(3); }
function joyStart(e){ e.preventDefault(); mobile.active=true; const pt=getPoint(e); setThumb(pt); updateMobile(pt); }
function joyMove(e){ if(!mobile.active) return; e.preventDefault(); const pt=getPoint(e); setThumb(pt); updateMobile(pt); }
function joyEnd(){ mobile.active=false; mobile.dx=0; mobile.dy=0; setThumb({x:0,y:0}); }
joy.addEventListener("touchstart", joyStart, { passive:false });
joy.addEventListener("touchmove", joyMove, { passive:false });
joy.addEventListener("touchend", joyEnd, { passive:false });
joy.addEventListener("mousedown", joyStart);
window.addEventListener("mousemove", joyMove);
window.addEventListener("mouseup", joyEnd);

/* ===================== Coins ===================== */
function spawnCoin(){
  coins.push({ x: Math.random()*cvs.width, y: Math.random()*cvs.height, born: performance.now() });
}
setInterval(()=>{ if (coins.length < MAX_COINS) spawnCoin(); }, 1500);

/* ===================== Host: Mobs simulation ===================== */
function spawnMob(){
  const side = Math.floor(Math.random()*4);
  let x=0,y=0;
  if (side === 0) { x = Math.random()*cvs.width; y = -20; }
  if (side === 1) { x = cvs.width+20; y = Math.random()*cvs.height; }
  if (side === 2) { x = Math.random()*cvs.width; y = cvs.height+20; }
  if (side === 3) { x = -20; y = Math.random()*cvs.height; }
  // add slight velocity jitter so they don't look identical
  mobs.push({ x, y, vx: (Math.random()-0.5)*40, vy: (Math.random()-0.5)*40, flavor: Math.random() });
}

function sampleTargetsForMob(m){
  // small randomness so not all pick the exact same player
  // 70% nearest player, 30% random player (if any)
  const players = [{x:me.x,y:me.y}];
  for (const o of others.values()) players.push({x:o.tx ?? o.x, y:o.ty ?? o.y});
  if (players.length === 0) return { x: cvs.width/2, y: cvs.height/2 };

  if (Math.random() < 0.7) {
    // nearest
    let best = players[0], bestD2 = Infinity;
    for (const p of players) {
      const dx = p.x - m.x, dy = p.y - m.y;
      const d2 = dx*dx + dy*dy;
      if (d2 < bestD2) { bestD2 = d2; best = p; }
    }
    return best;
  } else {
    // random sample
    return players[Math.floor(Math.random()*players.length)];
  }
}

function hostUpdateMobs(dt, t){
  if (!isVisible) return; // don't simulate while hidden
  // Spawn
  if (mobs.length < MAX_MOBS && Math.random() < dt * 0.8) {
    spawnMob();
  }

  // Integrate (chase + separation)
  for (let i = 0; i < mobs.length; i++) {
    const m = mobs[i];

    // pick a target
    const target = sampleTargetsForMob(m);
    let dx = target.x - m.x, dy = target.y - m.y;
    let len = Math.hypot(dx, dy) || 1;
    let cx = (dx/len) * MOB_SPEED;
    let cy = (dy/len) * MOB_SPEED;

    // separation
    let sx = 0, sy = 0;
    for (let j = 0; j < mobs.length; j++) if (j !== i) {
      const n = mobs[j];
      const rx = m.x - n.x, ry = m.y - n.y;
      const d2 = rx*rx + ry*ry;
      if (d2 > 0 && d2 < SEP_RADIUS*SEP_RADIUS) {
        const d = Math.sqrt(d2);
        const w = (SEP_RADIUS - d) / SEP_RADIUS;
        sx += (rx / (d || 1)) * (SEP_FORCE * w);
        sy += (ry / (d || 1)) * (SEP_FORCE * w);
      }
    }

    // combine, clamp, integrate
    m.vx = cx + sx + m.vx*0.05; // tiny inertia
    m.vy = cy + sy + m.vy*0.05;
    const sp = Math.hypot(m.vx, m.vy);
    if (sp > MOB_MAX_SPEED) {
      m.vx = m.vx / sp * MOB_MAX_SPEED;
      m.vy = m.vy / sp * MOB_MAX_SPEED;
    }
    m.x += m.vx * dt;
    m.y += m.vy * dt;
  }

  // Broadcast periodically
  if (t - lastMobsBroadcast > HOST_BROADCAST_MS) {
    lastMobsBroadcast = t;
    lastMobsSeq++;
    room.send({
      type: "broadcast",
      event: "mobs",
      payload: { seq: lastMobsSeq, mobs: mobs.map(m => [Math.round(m.x), Math.round(m.y)]) }
    });
  }
}

/* ===================== Client: follow host mobs ===================== */
function clientFollowMobs(dt){
  for (const m of mobs) {
    if (m.tx === undefined) continue;
    const k = Math.min(1, 12 * dt); // lerp speed
    m.x = (m.x ?? m.tx) + (m.tx - (m.x ?? m.tx)) * k;
    m.y = (m.y ?? m.ty) + (m.ty - (m.y ?? m.ty)) * k;
  }
}

/* ===================== Draw helpers ===================== */
function drawEntity(x,y,color){ ctx.beginPath(); ctx.arc(x,y,8,0,Math.PI*2); ctx.fillStyle=color; ctx.fill(); }
function drawName(x,y,name){
  ctx.fillStyle="rgba(255,255,255,.9)"; ctx.font="12px system-ui"; ctx.textAlign="center";
  ctx.fillText(name, x, y-14);
}
function drawRing(x,y){ ctx.strokeStyle="rgba(255,255,255,.6)"; ctx.lineWidth=2; ctx.beginPath(); ctx.arc(x,y,12,0,Math.PI*2); ctx.stroke(); }
function drawHPBar(x, y, w=42, h=6){
  const pad = 16, pct = hp / HP_MAX;
  const left = x - w/2, top = y - 20 - pad;
  ctx.fillStyle = "rgba(0,0,0,0.45)"; ctx.fillRect(left, top, w, h);
  ctx.fillStyle = pct > 0.5 ? "#22c55e" : (pct > 0.25 ? "#f59e0b" : "#ef4444");
  ctx.fillRect(left, top, Math.max(0, w * pct), h);
  ctx.strokeStyle = "rgba(255,255,255,0.6)"; ctx.lineWidth = 1; ctx.strokeRect(left + .5, top + .5, w - 1, h - 1);
}
function drawMobs(){
  for (const m of mobs) {
    ctx.beginPath(); ctx.globalAlpha = 0.22;
    ctx.arc(m.x, m.y, MOB_R*2.1, 0, Math.PI*2); ctx.fillStyle = MOB_COLOR; ctx.fill();
    ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.arc(m.x, m.y, MOB_R, 0, Math.PI*2); ctx.fillStyle = MOB_COLOR; ctx.fill();
  }
}

/* ===================== Game Loop ===================== */
let last = performance.now(), acc = 0;
function loop(t){
  const dt = Math.min(0.05, (t - last) / 1000); last = t;

  // Movement
  const up = keys.has("arrowup")||keys.has("w");
  const dn = keys.has("arrowdown")||keys.has("s");
  const lf = keys.has("arrowleft")||keys.has("a");
  const rt = keys.has("arrowright")||keys.has("d");
  const speed = 240;

  let kx = (rt?1:0) - (lf?1:0);
  let ky = (dn?1:0) - (up?1:0);
  let ax = kx + mobile.dx, ay = ky + mobile.dy;
  const mag = Math.hypot(ax, ay);
  if (mag > 1){ ax/=mag; ay/=mag; }
  me.x = Math.max(0, Math.min(cvs.width,  me.x + ax*speed*dt));
  me.y = Math.max(0, Math.min(cvs.height, me.y + ay*speed*dt));

  // Broadcast state occasionally
  acc += dt; if (acc > 0.1){ acc=0; sendState(); }

  // Smooth others
  for (const o of others.values()) {
    const factor = SMOOTH === 0 ? 1 : Math.min(1, SMOOTH * dt);
    o.x += (o.tx - o.x) * factor;
    o.y += (o.ty - o.y) * factor;
  }

  // Idle/ghost prune
  {
    const now = performance.now();
    for (const [id, o] of others) {
      const ghosted = (now - o.lastHeardTs) > (GHOST_SECS * 1000);
      const idle    = (now - o.lastActiveTs) > (IDLE_SECS * 1000);
      if (ghosted || idle) others.delete(id);
    }
  }

  // Watchdog: if no mobs feed, self-promote if I should be host
  {
    const now = performance.now();
    if (!isHost && (now - lastMobsHeard > NO_FEED_MS) && iAmSmallest()) {
      isHost = true;
      addSysMsg("No host detected. Promoted to host for mob AI.");
      lastMobsSeq = 0; // reset seq to accept our own stream
    }
  }

  // Mobs
  if (isHost) hostUpdateMobs(dt, t);
  else clientFollowMobs(dt);

  // Rendering
  ctx.clearRect(0,0,cvs.width,cvs.height);

  // Coins (draw + proximity pickup + heal)
  for (let i=coins.length-1;i>=0;i--){
    const c = coins[i];
    const dx = me.x - c.x, dy = me.y - c.y;
    const PR = 8; // player radius used for pickup math
    if (dx*dx + dy*dy < (PR + COIN_R + PICKUP_RADIUS) * (PR + COIN_R + PICKUP_RADIUS)) {
      coins.splice(i,1);
      score++; coinHud.textContent = score;
      hp = Math.min(HP_MAX, hp + COIN_HEAL); // heal on pickup
      continue;
    }
    // glow
    ctx.beginPath(); ctx.globalAlpha = .25; ctx.arc(c.x,c.y,COIN_R*2.2,0,Math.PI*2); ctx.fillStyle=COIN_COLOR; ctx.fill(); ctx.globalAlpha=1;
    // body
    ctx.beginPath(); ctx.arc(c.x,c.y,COIN_R,0,Math.PI*2); ctx.fillStyle=COIN_COLOR; ctx.fill();
    // highlight
    ctx.beginPath(); ctx.globalAlpha=.8; ctx.arc(c.x-COIN_R*0.25,c.y-COIN_R*0.25,COIN_R*0.4,0,Math.PI*2);
    ctx.fillStyle="#fff2b3"; ctx.fill(); ctx.globalAlpha=1;
  }

  // Mobs draw + damage
  drawMobs();
  checkMobDamage(t);

  // Others (white)
  for (const o of others.values()) {
    drawEntity(o.x, o.y, OTHER_COLOR);
    drawName(o.x, o.y, o.name || "player");
  }

  // Me (blue)
  const invuln = (t - lastHitAt) < INVULN_MS;
  if (!invuln || Math.floor(t/80)%2===0) { // blink while invuln
    drawEntity(me.x, me.y, MY_COLOR);
    drawRing(me.x, me.y);
  }
  drawName(me.x, me.y, name);
  drawHPBar(me.x, me.y);

  // Respawn on death
  if (hp <= 0) {
    me.x = cvs.width * 0.5; me.y = cvs.height * 0.5;
    hp = HP_MAX; lastHitAt = t; addSysMsg(`${name} was defeated by a mob… respawned.`);
  }

  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

/* ===================== Utilities ===================== */
function checkMobDamage(now){
  const PR = 10;
  for (const m of mobs) {
    const dx = me.x - m.x, dy = me.y - m.y;
    if (dx*dx + dy*dy <= (PR + MOB_R) * (PR + MOB_R)) {
      if (now - lastHitAt > INVULN_MS) {
        hp = Math.max(0, hp - CONTACT_DAMAGE);
        lastHitAt = now;
      }
    }
  }
}

function sendState(){
  room.send({
    type:"broadcast", event:"state",
    payload:{ id:uid, name, color: MY_COLOR, x:Math.round(me.x), y:Math.round(me.y), ts:Date.now() }
  });
}
