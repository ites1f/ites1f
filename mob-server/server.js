// server.js
import { createClient } from "@supabase/supabase-js";

// env (never put the service key in client code!)
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY; // service role
const CHANNEL       = process.env.CHANNEL_NAME || "dots-room";

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY"); process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
const room = supabase.channel(CHANNEL, { config: { broadcast: { self: true } } });

// --- world config (mirror client) ---
const W = 1200, H = 600;
const MOB_R = 10, MAX_MOBS = 12;
const MOB_SPEED = 120, MOB_MAX_SPEED = 140;
const SEP_RADIUS = 36, SEP_FORCE = 220;
const TICK_MS = 50;           // 20 FPS
const BROADCAST_MS = 150;

const players = new Map();    // id -> {x,y,ts}
let mobs = [];                // {x,y,vx,vy}
let lastBroadcast = 0;
let seq = 0;

// receive player states
room.on("broadcast", { event: "state" }, (payload) => {
  const p = payload.payload;
  if (!p || typeof p.x !== "number") return;
  players.set(p.id, { x: p.x, y: p.y, ts: Date.now(), name: p.name });
});

// housekeeping: drop stale players (tab closed)
setInterval(() => {
  const now = Date.now();
  for (const [id, p] of players) {
    if (now - p.ts > 5000) players.delete(id);
  }
}, 2000);

await room.subscribe((status) => {
  if (status === "SUBSCRIBED") {
    console.log("[server] joined realtime channel:", CHANNEL);
  }
});

// spawn utility
function spawnMob() {
  const side = Math.floor(Math.random() * 4);
  let x=0, y=0;
  if (side === 0) { x = Math.random()*W; y = -20; }
  if (side === 1) { x = W+20; y = Math.random()*H; }
  if (side === 2) { x = Math.random()*W; y = H+20; }
  if (side === 3) { x = -20; y = Math.random()*H; }
  mobs.push({ x, y, vx: 0, vy: 0 });
}

function nearestPlayer(mx, my) {
  let best = null, bestD2 = Infinity;
  for (const p of players.values()) {
    const dx = p.x - mx, dy = p.y - my;
    const d2 = dx*dx + dy*dy;
    if (d2 < bestD2) { bestD2 = d2; best = p; }
  }
  return best;
}

// main loop
let lastTick = Date.now();
setInterval(async () => {
  const now = Date.now();
  const dt = Math.min(0.1, (now - lastTick) / 1000);
  lastTick = now;

  // spawn up to cap
  if (mobs.length < MAX_MOBS && Math.random() < dt * 0.8) spawnMob();

  // integrate
  for (let i=0;i<mobs.length;i++){
    const m = mobs[i];

    // chase nearest player (if any); otherwise drift to center
    let tx = W/2, ty = H/2;
    const target = nearestPlayer(m.x, m.y);
    if (target) { tx = target.x; ty = target.y; }

    // chase component
    let dx = tx - m.x, dy = ty - m.y;
    let len = Math.hypot(dx, dy) || 1;
    let cx = (dx/len) * MOB_SPEED;
    let cy = (dy/len) * MOB_SPEED;

    // separation
    let sx = 0, sy = 0;
    for (let j=0;j<mobs.length;j++) if (j!==i) {
      const n = mobs[j]; const rx = m.x - n.x, ry = m.y - n.y;
      const d2 = rx*rx + ry*ry;
      if (d2 > 0 && d2 < SEP_RADIUS*SEP_RADIUS) {
        const d = Math.sqrt(d2);
        const w = (SEP_RADIUS - d) / SEP_RADIUS;
        sx += (rx / (d || 1)) * (SEP_FORCE * w);
        sy += (ry / (d || 1)) * (SEP_FORCE * w);
      }
    }

    // combine & clamp
    m.vx = cx + sx; m.vy = cy + sy;
    const sp = Math.hypot(m.vx, m.vy);
    if (sp > MOB_MAX_SPEED) { m.vx = m.vx/sp*MOB_MAX_SPEED; m.vy = m.vy/sp*MOB_MAX_SPEED; }

    m.x += m.vx * dt;
    m.y += m.vy * dt;

    // (optional) keep within bounds a bit
    m.x = Math.max(-40, Math.min(W+40, m.x));
    m.y = Math.max(-40, Math.min(H+40, m.y));
  }

  // broadcast periodically
  if (now - lastBroadcast > BROADCAST_MS) {
    lastBroadcast = now; seq++;
    const payload = { seq, mobs: mobs.map(m => [Math.round(m.x), Math.round(m.y)]) };
    room.send({ type: "broadcast", event: "mobs", payload });
  }
}, TICK_MS);
