/* KOPENG cinematic demo — 100% synthetic data, zero API wiring.
 *
 * A scripted "director" plays a 5-beat storyboard over a fabricated memory
 * corpus whose type ratios mirror the real /api/stats shape (discovery 40%,
 * reference 24%, feedback 20%, project 15%, user <1%) but whose scopes and
 * labels are entirely made up — safe to record and share.
 *
 * Beats: 1 genesis · 2 first links · 3 cluster · 4 growth (small connections
 * become the backbone) · 5 full-system reveal.
 */
'use strict';

// ---------------------------------------------------------------- tuning ---
const W = 1600, H = 1000;                 // world coords (viewBox)
const NODE_APPEAR_MS = 420;               // node fade/scale-in (deliberate, for camera)
const LINK_DRAW_MS = 700;                 // link draw duration
const PULSE_MS = 1200;                    // genesis ring pulse
const T = {                               // beat start times, seconds @ 1×
  genesis: 0,
  links: 2.5,
  cluster: 6.5,
  growth: 10.5,
  reveal: 20.5,
  inspect: 25.5,
  end: 34,
};

const BEATS = [
  { key: 'genesis', n: 'I',   cap: 'a memory is stored' },
  { key: 'links',   n: 'II',  cap: 'related memories connect' },
  { key: 'cluster', n: 'III', cap: 'knowledge clusters form' },
  { key: 'growth',  n: 'IV',  cap: 'small connections become the backbone' },
  { key: 'reveal',  n: 'V',   cap: 'KOPENG — persistent memory, recalled when it matters' },
  { key: 'inspect', n: 'VI',  cap: 'every memory carries its own evidence' },
];

// accent from the active theme (re-read on toggle)
let ACCENT = '14 100% 57%';
function refreshAccent() {
  const v = getComputedStyle(document.body).getPropertyValue('--accent').trim();
  if (v) ACCENT = v;
}
const accent = (a = 1) => (a >= 1 ? `hsl(${ACCENT})` : `hsl(${ACCENT} / ${a})`);

// type palette (muted, matches the real viz legend hues)
const TYPE_COLOR = {
  discovery: 'hsl(266 45% 62%)',
  reference: 'hsl(150 30% 55%)',
  feedback:  'hsl(38 70% 58%)',
  project:   'hsl(205 55% 58%)',
  user:      'hsl(0 55% 62%)',
};
// ratios from the real /api/stats shape (fabricated everything else)
const TYPE_POOL = [
  ...Array(40).fill('discovery'),
  ...Array(24).fill('reference'),
  ...Array(20).fill('feedback'),
  ...Array(15).fill('project'),
  'user',
];

// fabricated scopes — no real client/project names
const SCOPES = [
  'project:atlas', 'project:helios', 'project:corvid', 'client:northwind',
  'project:lattice', 'client:brightline', 'project:ember', 'global',
];

// ------------------------------------------------------------- synth data ---
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(0x6d6e656d); // "mnem"

const easeOut = (t) => 1 - (1 - t) * (1 - t);
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// cluster centers — hand-scattered so the full reveal composes nicely
const CLUSTERS = [
  { x: 560, y: 480 }, { x: 980, y: 340 }, { x: 1210, y: 620 }, { x: 330, y: 260 },
  { x: 820, y: 760 }, { x: 1330, y: 260 }, { x: 260, y: 700 }, { x: 1060, y: 880 },
].map((c, i) => ({ ...c, scope: SCOPES[i] }));

// build the synthetic corpus: nodes assigned to clusters, links mostly intra-cluster
const nodes = []; // {id,x,y,r,type,scope,cluster,birth}
const links = []; // {a,b,birth,dur,w,bridge}

function addNode(cluster, spreadMin, spreadMax) {
  const c = CLUSTERS[cluster];
  const ang = rnd() * Math.PI * 2;
  const rad = spreadMin + rnd() * (spreadMax - spreadMin);
  const n = {
    id: nodes.length,
    x: c.x + Math.cos(ang) * rad,
    y: c.y + Math.sin(ang) * rad * 0.78,
    r: 4 + rnd() * 3.4,
    type: TYPE_POOL[Math.floor(rnd() * TYPE_POOL.length)],
    scope: c.scope,
    cluster,
    birth: 0,
  };
  nodes.push(n);
  return n;
}
function linkToNearest(n, k, birth, dur = LINK_DRAW_MS, w = 0.9) {
  const peers = nodes.filter((p) => p.cluster === n.cluster && p.id !== n.id && p.birth <= n.birth);
  peers.sort((p, q) => ((p.x - n.x) ** 2 + (p.y - n.y) ** 2) - ((q.x - n.x) ** 2 + (q.y - n.y) ** 2));
  for (const p of peers.slice(0, k)) links.push({ a: p.id, b: n.id, birth, dur, w, bridge: false });
}

// --- beat 1: genesis — the seed node of cluster 0
const seed = addNode(0, 0, 1);
seed.r = 7;
seed.birth = 0.7;

// --- beat 2: first links — three related memories, deliberately paced
[2.8, 4.0, 5.2].forEach((t) => {
  const n = addNode(0, 40, 95);
  n.birth = t;
  linkToNearest(n, 1, t + 0.3, 750);
});

// --- beat 3: the first cluster settles (6 more, quicker cadence)
let inspectTarget = null; // the node the scripted cursor will click in beat VI
for (let i = 0; i < 6; i++) {
  const n = addNode(0, 35, 130);
  n.birth = 6.8 + i * 0.55;
  linkToNearest(n, 2, n.birth + 0.2);
  if (i === 2) { n.type = 'discovery'; n.r = 6; inspectTarget = n; }
}

// --- beat 4: growth — remaining clusters bloom in staggered waves
const HUBS = [seed.id];
for (let c = 1; c < CLUSTERS.length; c++) {
  const wave = 10.8 + (c - 1) * 1.15;
  const hub = addNode(c, 0, 8);
  hub.r = 6.5;
  hub.birth = wave;
  HUBS.push(hub.id);
  const size = 10 + Math.floor(rnd() * 8);
  for (let i = 0; i < size; i++) {
    const n = addNode(c, 30, 140);
    n.birth = wave + 0.2 + i * (0.24 - Math.min(0.14, (c - 1) * 0.025)); // accelerating cadence
    linkToNearest(n, 2, n.birth + 0.15, 450);
  }
}
// the "small→big" moment: a thin bridge appears early in growth, then THICKENS
const BRIDGE = { a: HUBS[0], b: HUBS[1], birth: 12.5, dur: 1200, w: 0.7, bridge: true };
links.push(BRIDGE);
const GROW_AT = 16.5, GROW_MS = 2000, BRIDGE_W_FINAL = 3.0;
// more backbone bridges fan out from the hub as the moment lands
for (let c = 2; c < CLUSTERS.length; c++) {
  links.push({ a: HUBS[0], b: HUBS[c], birth: GROW_AT + 0.4 + (c - 2) * 0.4, dur: 800, w: 1.6, bridge: true });
}

// --- beat 5: reveal — rapid infill everywhere while the camera pulls out
for (let i = 0; i < 70; i++) {
  const n = addNode(Math.floor(rnd() * CLUSTERS.length), 40, 170);
  n.birth = 20.7 + rnd() * 3.5;
  linkToNearest(n, 1, n.birth + 0.15, 380, 0.7);
}

// --- beat 6: inspect — scripted cursor clicks a memory, its detail slides in.
// Synthetic values, but field-for-field the REAL memory schema.
const INSPECT = {
  camAt: 25.5, camDur: 2.2,   // camera pushes toward the target
  cursorAt: 27.0, cursorDur: 1.4,
  clickAt: 28.6, panelAt: 29.0,
  data: {
    id: 'mem #0142',
    type: 'discovery',
    scope: 'project:atlas',
    source: 'auto-discovery',
    confidence: 0.72,
    observations: 6,
    lastSeen: '2 days ago',
    tags: ['auto-discovered', 'error-pattern', 'build'],
    content: 'Build failures in atlas resolve after regenerating the lockfile — observed 6× across 4 sessions. Fix: rm lockfile → reinstall → rebuild.',
  },
};

// ------------------------------------------------------------- camera ------
// keyframes: {t, x, y, k, dur} — camera eases to (x,y,k) starting at t over dur
const c0 = CLUSTERS[0];
const CAMERA = [
  { t: 0,    x: c0.x, y: c0.y, k: 3.4, dur: 0 },
  { t: 5.8,  x: c0.x, y: c0.y, k: 2.6, dur: 2.2 },   // gentle pull as links form
  { t: 8.8,  x: (c0.x + CLUSTERS[1].x) / 2, y: (c0.y + CLUSTERS[1].y) / 2, k: 1.9, dur: 2.4 }, // reveal neighbors
  { t: 14.5, x: 800, y: 520, k: 1.35, dur: 3.0 },    // growth wide-ish
  { t: 20.5, x: W / 2, y: H / 2, k: 1.0, dur: 3.8 }, // the money shot
  { t: 25.5, x: 0, y: 0, k: 2.3, dur: 2.2 },         // (x,y patched to the inspect target below)
];
CAMERA[CAMERA.length - 1].x = inspectTarget.x + 60; // offset so the detail card doesn't cover it
CAMERA[CAMERA.length - 1].y = inspectTarget.y;
function cameraAt(t) {
  let prev = CAMERA[0], next = null;
  for (const kf of CAMERA) { if (kf.t <= t) prev = kf; else { next = kf; break; } }
  // interpolate INTO prev from the keyframe before it
  const i = CAMERA.indexOf(prev);
  const from = i > 0 ? CAMERA[i - 1] : prev;
  const p = prev.dur > 0 ? clamp01((t - prev.t) / prev.dur) : 1;
  const e = easeInOut(p);
  const cam = {
    x: from.x + (prev.x - from.x) * e,
    y: from.y + (prev.y - from.y) * e,
    k: from.k + (prev.k - from.k) * e,
  };
  void next;
  return cam;
}

// ------------------------------------------------------------- rendering ---
const svg = d3.select('#demo-canvas').attr('viewBox', `0 0 ${W} ${H}`);
const root = svg.append('g');
const linkLayer = root.append('g');
const nodeLayer = root.append('g');
const fxLayer = root.append('g');

const nodeEls = new Map(), linkEls = new Map();
let genesisRing = null, genesisLabel = null;
let cursorEl = null, clickRing = null, selectRing = null;

function ensureNode(n) {
  if (nodeEls.has(n.id)) return nodeEls.get(n.id);
  const el = nodeLayer.append('circle')
    .attr('cx', n.x).attr('cy', n.y).attr('r', 0)
    .attr('fill', TYPE_COLOR[n.type]).attr('opacity', 0);
  nodeEls.set(n.id, el);
  return el;
}
function ensureLink(l, i) {
  if (linkEls.has(i)) return linkEls.get(i);
  const a = nodes[l.a], b = nodes[l.b];
  const el = linkLayer.append('line')
    .attr('x1', a.x).attr('y1', a.y).attr('x2', a.x).attr('y2', a.y)
    .attr('stroke', l.bridge ? accent(0.55) : 'currentColor')
    .attr('opacity', 0).attr('stroke-width', l.w)
    .style('color', 'hsl(0 0% 55% / 0.35)');
  linkEls.set(i, el);
  return el;
}
function resetStage() {
  nodeEls.clear(); linkEls.clear();
  linkLayer.selectAll('*').remove();
  nodeLayer.selectAll('*').remove();
  fxLayer.selectAll('*').remove();
  genesisRing = genesisLabel = null;
  cursorEl = clickRing = selectRing = null;
  detailCard.classList.remove('on');
  detailFilled = false;
}

function render(t) {
  // camera
  const cam = cameraAt(t);
  const tx = W / 2 - cam.x * cam.k, ty = H / 2 - cam.y * cam.k;
  root.attr('transform', `translate(${tx},${ty}) scale(${cam.k})`);

  // links
  for (let i = 0; i < links.length; i++) {
    const l = links[i];
    const age = t - l.birth;
    if (age < 0) { if (linkEls.has(i)) { linkEls.get(i).remove(); linkEls.delete(i); } continue; }
    const el = ensureLink(l, i);
    const p = easeOut(clamp01((age * 1000) / l.dur));
    const a = nodes[l.a], b = nodes[l.b];
    el.attr('x2', a.x + (b.x - a.x) * p).attr('y2', a.y + (b.y - a.y) * p)
      .attr('opacity', (l.bridge ? 0.85 : 0.55) * p);
    if (l === BRIDGE) {
      const g = easeInOut(clamp01(((t - GROW_AT) * 1000) / GROW_MS));
      el.attr('stroke-width', l.w + (BRIDGE_W_FINAL - l.w) * g)
        .attr('stroke', accent(0.55 + 0.35 * g));
    }
  }

  // nodes
  for (const n of nodes) {
    const age = t - n.birth;
    if (age < 0) { if (nodeEls.has(n.id)) { nodeEls.get(n.id).remove(); nodeEls.delete(n.id); } continue; }
    const el = ensureNode(n);
    const p = easeOut(clamp01((age * 1000) / NODE_APPEAR_MS));
    let r = n.r * (0.35 + 0.65 * p);
    // hub emphasis during the small→big moment
    if (n.id === HUBS[0] && t > GROW_AT) {
      r += 3.5 * easeInOut(clamp01(((t - GROW_AT) * 1000) / GROW_MS));
    }
    el.attr('r', r).attr('opacity', 0.92 * p);
  }

  // genesis FX: expanding ring + label on the seed node
  const seedAge = t - seed.birth;
  if (seedAge >= 0 && seedAge < PULSE_MS / 1000 + 2.2) {
    if (!genesisRing) {
      genesisRing = fxLayer.append('circle')
        .attr('cx', seed.x).attr('cy', seed.y)
        .attr('fill', 'none').attr('stroke', accent());
      genesisLabel = fxLayer.append('text')
        .attr('x', seed.x + 16).attr('y', seed.y - 14)
        .attr('fill', accent())
        .attr('font-size', 9).attr('letter-spacing', '0.08em')
        .text('mem #0001 · stored');
    }
    const rp = clamp01(seedAge / (PULSE_MS / 1000));
    genesisRing.attr('r', seed.r + 4 + 26 * easeOut(rp))
      .attr('stroke-width', 1.4 * (1 - rp))
      .attr('opacity', 0.9 * (1 - rp));
    genesisLabel.attr('opacity', clamp01(seedAge / 0.4) * clamp01((3.0 - seedAge) / 0.8));
  } else if (genesisRing) {
    genesisRing.attr('opacity', 0);
    genesisLabel.attr('opacity', 0);
  }

  renderInspect(t);
}

// beat VI: cursor glides to the target node, clicks, detail card slides in
function renderInspect(t) {
  const tgt = inspectTarget;
  if (t < INSPECT.cursorAt) {
    if (cursorEl) { cursorEl.attr('opacity', 0); clickRing?.attr('opacity', 0); selectRing?.attr('opacity', 0); }
    if (t < INSPECT.panelAt) detailCard.classList.remove('on');
    return;
  }
  if (!cursorEl) {
    cursorEl = fxLayer.append('path') // simple arrow cursor, world coords
      .attr('d', 'M0 0 L0 13 L3.5 10 L6 15 L8 14 L5.6 9.2 L10 9 Z')
      .attr('fill', 'hsl(0 0% 98%)').attr('stroke', 'hsl(0 0% 10%)').attr('stroke-width', 0.6);
    clickRing = fxLayer.append('circle')
      .attr('cx', tgt.x).attr('cy', tgt.y)
      .attr('fill', 'none').attr('stroke', accent()).attr('opacity', 0);
    selectRing = fxLayer.append('circle')
      .attr('cx', tgt.x).attr('cy', tgt.y)
      .attr('fill', 'none').attr('stroke', accent()).attr('stroke-width', 1.4).attr('opacity', 0);
  }
  // glide in from below-right
  const gp = easeInOut(clamp01((t - INSPECT.cursorAt) / INSPECT.cursorDur));
  const sx = tgt.x + 190, sy = tgt.y + 150;
  const cx = sx + (tgt.x + 2 - sx) * gp, cy = sy + (tgt.y + 2 - sy) * gp;
  cursorEl.attr('transform', `translate(${cx},${cy}) scale(1.15)`).attr('opacity', clamp01((t - INSPECT.cursorAt) / 0.3));
  // click pulse
  const ca = t - INSPECT.clickAt;
  if (ca >= 0 && ca < 0.9) {
    const p = clamp01(ca / 0.9);
    clickRing.attr('r', tgt.r + 3 + 20 * easeOut(p)).attr('stroke-width', 1.6 * (1 - p)).attr('opacity', 0.9 * (1 - p));
  } else clickRing.attr('opacity', 0);
  // persistent selection ring once clicked
  selectRing.attr('opacity', ca >= 0.15 ? 0.9 : 0).attr('r', tgt.r + 3.5);
  // detail card
  if (t >= INSPECT.panelAt) {
    fillDetailCard();
    detailCard.classList.add('on');
  } else {
    detailCard.classList.remove('on');
  }
}

const detailCard = document.getElementById('detail-card');
let detailFilled = false;
function fillDetailCard() {
  if (detailFilled) return;
  detailFilled = true;
  const d = INSPECT.data;
  const set = (id, v) => { document.getElementById(id).textContent = v; };
  set('dc-id', d.id); set('dc-type', d.type); set('dc-scope', d.scope);
  set('dc-source', d.source); set('dc-conf', d.confidence.toFixed(2));
  set('dc-obs', String(d.observations)); set('dc-seen', d.lastSeen);
  set('dc-content', d.content);
  const tagsEl = document.getElementById('dc-tags');
  tagsEl.replaceChildren(...d.tags.map((tg) => {
    const s = document.createElement('span');
    s.className = 'demo-tagchip';
    s.textContent = tg;
    return s;
  }));
  requestAnimationFrame(() => {
    document.getElementById('dc-conf-bar').style.width = `${d.confidence * 100}%`;
  });
}

// ------------------------------------------------------------- director ----
const capEl = document.getElementById('caption');
const capBeat = document.getElementById('cap-beat');
const capText = document.getElementById('cap-text');
const clockEl = document.getElementById('clock');
const playBtn = document.getElementById('btn-play');
const dotsEl = document.getElementById('beat-dots');

let clock = 0, playing = false, speed = 1, raf = 0, lastTs = 0;

const beatStarts = BEATS.map((b) => T[b.key]);
BEATS.forEach((b, i) => {
  const d = document.createElement('button');
  d.className = 'demo-beat-dot';
  d.title = `beat ${b.n} — ${b.cap}`;
  d.addEventListener('click', () => seek(beatStarts[i]));
  dotsEl.appendChild(d);
});
const dots = [...dotsEl.children];

function currentBeat(t) {
  let i = 0;
  for (let k = 0; k < beatStarts.length; k++) if (t >= beatStarts[k]) i = k;
  return i;
}
function updateChrome(t) {
  const bi = currentBeat(t);
  const b = BEATS[bi];
  capBeat.textContent = b.n;
  capText.textContent = b.cap;
  capEl.classList.toggle('on', t > 0.3 && t < T.end - 0.2);
  dots.forEach((d, i) => {
    d.classList.toggle('now', i === bi);
    d.classList.toggle('done', i < bi);
  });
  clockEl.textContent = `${t.toFixed(1)}s`;
}

function frame(ts) {
  if (!playing) return;
  if (lastTs) clock += ((ts - lastTs) / 1000) * speed;
  lastTs = ts;
  if (clock >= T.end) { clock = T.end; pause(); }
  render(clock);
  updateChrome(clock);
  if (playing) raf = requestAnimationFrame(frame);
}
function play() {
  if (clock >= T.end) seek(0);
  playing = true; lastTs = 0;
  playBtn.textContent = 'pause';
  document.body.classList.add('playing');
  raf = requestAnimationFrame(frame);
}
function pause() {
  playing = false;
  cancelAnimationFrame(raf);
  playBtn.textContent = clock >= T.end ? 'replay' : 'play';
  document.body.classList.remove('playing');
}

// chrome peeks back in on mouse movement while playing, then fades again
let peekTimer = 0;
document.addEventListener('mousemove', () => {
  document.body.classList.add('peek');
  clearTimeout(peekTimer);
  peekTimer = setTimeout(() => document.body.classList.remove('peek'), 1800);
});
function seek(t) {
  clock = t;
  resetStage();
  render(clock);
  updateChrome(clock);
  if (playing) { lastTs = 0; }
}

playBtn.addEventListener('click', () => (playing ? pause() : play()));
document.getElementById('btn-restart').addEventListener('click', () => { seek(0); if (!playing) play(); });
const speedEl = document.getElementById('speed');
speedEl.addEventListener('input', () => {
  speed = parseFloat(speedEl.value);
  document.getElementById('speed-val').textContent = `${speed.toFixed(2).replace(/0+$/, '').replace(/\.$/, '.0')}×`;
});

// theme toggle (same body-dataset + localStorage key as the real viz)
const themeBtn = document.getElementById('theme-toggle');
try {
  document.body.dataset.theme = localStorage.getItem('kopeng-viz-theme') || 'void';
} catch { document.body.dataset.theme = 'void'; }
refreshAccent();
themeBtn.addEventListener('click', () => {
  const next = document.body.dataset.theme === 'linen' ? 'void' : 'linen';
  document.body.dataset.theme = next;
  try { localStorage.setItem('kopeng-viz-theme', next); } catch {}
  refreshAccent();
  resetStage();
  render(clock);
});

// initial paint (paused at 0 — press play, or it autoplays after a beat)
render(0);
updateChrome(0);
setTimeout(() => { if (!playing && clock === 0) play(); }, 800);
