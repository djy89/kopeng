const TYPES = ['user', 'feedback', 'project', 'reference', 'discovery'];
const ENTITY_TYPES = ['concept', 'technology', 'project', 'organization', 'person'];

// Read color tokens from CSS so the palette stays in one place.
function cssVar(name) {
  return getComputedStyle(document.body).getPropertyValue(name).trim();
}
// COLORS / ENTITY_COLORS are rebuilt on theme change. Don't rely on the const'd
// values across themes.
let COLORS = Object.fromEntries(TYPES.map(t => [t, cssVar(`--type-${t}`)]));
let ENTITY_COLORS = Object.fromEntries(ENTITY_TYPES.map(t => [t, cssVar(`--entity-${t}`)]));
function refreshColors() {
  for (const t of TYPES) COLORS[t] = cssVar(`--type-${t}`);
  for (const t of ENTITY_TYPES) ENTITY_COLORS[t] = cssVar(`--entity-${t}`);
}

// ---------- Theme switcher ----------
const THEMES = ['void', 'ops', 'amber', 'linen'];
function syncThemeButton(name) {
  const label = document.getElementById('theme-name');
  if (label) label.textContent = name.toUpperCase();
  const btn = document.getElementById('theme-toggle');
  if (btn) btn.title = `theme: ${name} — click to cycle`;
}
function setTheme(name) {
  document.body.dataset.theme = name;
  syncThemeButton(name);
  try { localStorage.setItem('kopeng-viz-theme', name); } catch {}
  refreshColors();
  if (typeof lastStats !== 'undefined' && lastStats) {
    renderLegend();
    renderGraph();
  }
}
try {
  document.body.dataset.theme = (localStorage.getItem('kopeng-viz-theme') || 'void');
} catch {
  document.body.dataset.theme = 'void';
}
syncThemeButton(document.body.dataset.theme);

const STORES = [
  {
    key: 'memory.db',
    name: 'sqlite — memory.db',
    desc: 'primary store. memory rows: content, type, scope, tags (FTS5), and a binary embedding column. WAL-mode single file.',
    badge: 'core',
    auto: true,
  },
  {
    key: 'observations.db',
    name: 'sqlite — observations.db',
    desc: 'tool-use observation events from the PreToolUse / PostToolUse hooks. separate file, separate WAL — no lock contention.',
    badge: 'core',
    auto: true,
  },
  {
    key: 'embedding-index',
    name: 'embedding index — RAM',
    desc: 'in-memory float32 vectors loaded from memory.db on startup. all-MiniLM-L6-v2, 384 dims. powers semantic + hybrid search.',
    badge: 'core',
    auto: true,
  },
  {
    key: 'postgres',
    name: 'postgres — pgvector',
    desc: 'optional drop-in for sqlite when DATABASE_TYPE=postgres. same IMemoryStore interface, IVF/HNSW vector index.',
    badge: 'optional',
  },
  {
    key: 'neo4j',
    name: 'neo4j — graph',
    desc: 'optional. entity nodes + edges extracted from memory content. backs the traverse_memory MCP tool.',
    badge: 'optional',
  },
  {
    key: 'redis',
    name: 'redis — cache',
    desc: 'optional. ephemeral key/value scratchpad for set_context / get_context across tool calls.',
    badge: 'optional',
  },
  {
    key: 'minio',
    name: 'minio — object',
    desc: 'optional. S3-compatible artifact storage. used by store_artifact / get_artifact for binary or oversized content.',
    badge: 'optional',
  },
];

const els = {
  health: document.getElementById('health'),
  stores: document.getElementById('stores'),
  legend: document.getElementById('legend'),
  filters: document.getElementById('filters'),
  detail: document.getElementById('detail'),
  svg: document.getElementById('canvas'),
  tooltip: document.getElementById('tooltip'),
};

let allMemories = [];
let bipartite = { entities: [], links: [] };
let useEntityEdges = false; // true when Neo4j is enabled and edges fetched OK
const activeTypes = new Set(TYPES);
const activeEntityTypes = new Set(ENTITY_TYPES);
let activeScopes = new Set();
let searchTerm = '';
let lastStats = null;
let nodeSel, linkSel; // active D3 selections (mixed: memory + entity nodes)
let nodesGroup, linksGroup; // container <g>s — hover dims via one class here, not per node
let adjacency = new Map(); // node id → Set of neighbour ids, rebuilt per render
const layoutCache = new Map(); // node id → {x,y}: warm re-renders reuse positions instead of re-solving
let renderGen = 0; // generation guard — a new render aborts the previous async layout loop
let svgRect = null; // cached canvas rect (renderGraph refreshes it) — avoids per-mousemove reads
let tooltipSize = { w: 0, h: 0 }; // measured once per tooltip show, not per mousemove

// ---------- DOM helpers ----------
function el(tag, attrs, ...kids) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k === 'dataset' && typeof v === 'object') Object.assign(node.dataset, v);
      else node.setAttribute(k, v);
    }
  }
  for (const kid of kids) {
    if (kid == null || kid === false) continue;
    if (Array.isArray(kid)) for (const k of kid) node.append(k);
    else if (kid instanceof Node) node.append(kid);
    else node.append(document.createTextNode(String(kid)));
  }
  return node;
}
const clear = (n) => { while (n.firstChild) n.removeChild(n.firstChild); };

// ---------- API latency (client-measured, /api/* only, 50-sample ring) ----------
const latSamples = [];
function updateP50() {
  const elP = document.getElementById('health-p50');
  if (!elP) return;
  if (latSamples.length < 5) { elP.textContent = ''; return; }
  const s = [...latSamples].sort((a, b) => a - b);
  elP.textContent = ` · p50 ${Math.round(s[Math.floor(s.length / 2)])}ms`;
}
{
  const origFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const p = origFetch(input, init);
    if (url.startsWith('/api/')) {
      const t0 = performance.now();
      p.finally(() => {
        latSamples.push(performance.now() - t0);
        if (latSamples.length > 50) latSamples.shift();
        updateP50();
      }).catch(() => {});
    }
    return p;
  };
}

// Auto-discovery tier buckets — same edges as the ops confidence-distribution.
function tierOf(conf) {
  if (conf <= 0.55) return { name: 'noted', tone: '' };
  if (conf <= 0.65) return { name: 'pattern', tone: 'radyn-pill--info' };
  if (conf <= 0.85) return { name: 'actionable', tone: 'radyn-pill--warning' };
  return { name: 'confirmed', tone: 'radyn-pill--success' };
}
function relTime(iso) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso + (iso.endsWith('Z') || iso.includes('+') ? '' : 'Z')).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ---------- Data ----------
async function fetchAllMemories() {
  // fields=lite: server omits the embedding column (never read here) and
  // allows 1000-row pages — ~5 round-trips for the whole corpus instead of ~41.
  // A server that predates fields=lite rejects limit>100 with a 400; fall back
  // to legacy 100-row paging so the viz survives version skew.
  try {
    return await pageMemories('limit=1000&fields=lite');
  } catch (err) {
    if (!/memories: 400/.test(String(err && err.message))) throw err;
    return pageMemories('limit=100');
  }
}

async function pageMemories(params) {
  const out = [];
  let cursor;
  while (true) {
    const url = `/api/memories?${params}${cursor ? `&cursor=${cursor}` : ''}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`memories: ${r.status}`);
    const j = await r.json();
    for (const m of j.data) {
      m.embedding = null;
      m.tags = Array.isArray(m.tags) ? m.tags : [];
      out.push(m);
    }
    if (!j.meta.has_more) break;
    cursor = j.meta.cursor;
    if (out.length > 5000) break;
  }
  return out;
}

async function fetchStats() {
  const r = await fetch('/api/stats');
  if (!r.ok) throw new Error(`stats: ${r.status}`);
  return (await r.json()).data;
}

async function fetchCapabilities() {
  try {
    const r = await fetch('/viz/capabilities');
    if (!r.ok) return { neo4j: false, redis: false, minio: false };
    return await r.json();
  } catch {
    return { neo4j: false, redis: false, minio: false };
  }
}

// Bipartite memory↔entity payload from Neo4j. Returns null if Neo4j is off
// or the request fails — caller falls back to the tag-edge heuristic.
async function fetchBipartite() {
  try {
    const r = await fetch('/api/graph/edges?min=2&max=50');
    if (!r.ok) return null;
    const j = await r.json();
    if (!j || !j.data) return null;
    return j.data;
  } catch {
    return null;
  }
}

async function load() {
  els.health.textContent = '> loading…';
  try {
    const [stats, memories] = await Promise.all([fetchStats(), fetchAllMemories()]);
    lastStats = stats;
    allMemories = memories;

    const capabilities = await fetchCapabilities();

    // If Neo4j is on, fetch the bipartite payload. Fall back to tag-edges
    // silently if either the capability is off or the call fails.
    if (capabilities.neo4j) {
      const data = await fetchBipartite();
      if (data && Array.isArray(data.entities) && Array.isArray(data.links)) {
        bipartite = data;
        useEntityEdges = true;
      } else {
        bipartite = { entities: [], links: [] };
        useEntityEdges = false;
      }
    } else {
      useEntityEdges = false;
    }

    renderStores(stats, capabilities);
    renderLegend();
    renderFilters(stats);
    renderHealth(stats);
    renderGraph();
  } catch (err) {
    clear(els.health);
    els.health.append('error: ' + err.message);
    console.error(err);
  }
}

// ---------- Header health ----------
function renderHealth(stats) {
  clear(els.health);
  const parts = [
    [stats.active_memories.toLocaleString(), 'memories'],
    [Object.keys(stats.by_type).length, 'types'],
    [Object.keys(stats.by_scope).length, 'scopes'],
    [stats.embedding_index_size.toLocaleString(), 'vectors'],
    [(stats.db_size_bytes / 1048576).toFixed(1) + 'MB', 'sqlite'],
  ];
  if (useEntityEdges) parts.push([bipartite.entities.length.toLocaleString(), 'entities']);
  parts.forEach(([n, label], i) => {
    if (i > 0) els.health.append(' · ');
    els.health.append(el('b', null, String(n)), ' ' + label);
  });
  els.health.append(el('span', { id: 'health-p50', class: 'radyn-value' }, ''));
  updateP50();
}

// ---------- Stores panel ----------
function renderStores(stats, optional) {
  clear(els.stores);
  const counts = {
    'memory.db': stats.active_memories,
    'embedding-index': stats.embedding_index_size,
    'neo4j': useEntityEdges ? bipartite.entities.length : null,
  };
  for (const s of STORES) {
    let active = !!s.auto;
    if (s.key === 'neo4j') active = optional.neo4j;
    if (s.key === 'redis') active = optional.redis;
    if (s.key === 'minio') active = optional.minio;
    const count = counts[s.key];

    const row = el('div', { class: 'store' + (active ? ' active' : '') },
      el('div', { class: 'dot' }),
      el('div', null,
        el('h3', null, s.name, ' ', el('span', { class: 'badge radyn-pill' }, s.badge)),
        el('p', null, s.desc),
        count != null
          ? el('span', { class: 'count' }, count.toLocaleString() + (s.key === 'neo4j' ? ' entities' : ' entries'))
          : null,
        (!active && s.badge === 'optional')
          ? el('span', { class: 'count dim' }, 'disabled')
          : null
      )
    );
    els.stores.append(row);
  }
}

// ---------- Legend ----------
const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(name, attrs) {
  const node = document.createElementNS(SVG_NS, name);
  if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function renderLegend() {
  clear(els.legend);

  // Memory types — circle + icon, colored by type token.
  els.legend.append(el('div', { class: 'legend-section-label' }, 'memory · circles'));
  for (const t of TYPES) {
    const wrap = svgEl('svg', { class: 'legend-icon', viewBox: '0 0 24 24', width: '14', height: '14' });
    const u = svgEl('use'); u.setAttribute('href', '#icon-' + t);
    wrap.appendChild(u);
    wrap.style.color = COLORS[t];

    const row = el('div', { class: 'legend-row' });
    row.append(wrap, ' ', t);
    els.legend.append(row);
  }

  // Entity types only when Neo4j-backed bipartite render is active.
  if (useEntityEdges) {
    els.legend.append(el('div', { class: 'legend-section-label' }, 'entity · diamonds'));
    for (const et of ENTITY_TYPES) {
      // Inline diamond at the entity-type stroke color.
      const wrap = svgEl('svg', { width: '14', height: '14', viewBox: '0 0 14 14' });
      const diamond = svgEl('rect', {
        x: '3.5', y: '3.5', width: '7', height: '7',
        transform: 'rotate(45 7 7)',
        fill: 'transparent',
        stroke: ENTITY_COLORS[et] || cssVar('--muted-foreground'),
        'stroke-width': '1.4',
      });
      wrap.appendChild(diamond);

      const row = el('div', { class: 'legend-row' });
      row.append(wrap, ' ', et);
      els.legend.append(row);
    }
  }

  // Size-encoding row.
  els.legend.append(el('div', { class: 'legend-section-label', style: { marginTop: '0.5rem' } }, 'size'));
  const sizeSvg = svgEl('svg', { width: '50', height: '14', viewBox: '0 0 50 14' });
  for (const [cx, r] of [[6, 3], [20, 4.5], [38, 6.5]]) {
    sizeSvg.appendChild(svgEl('circle', {
      cx, cy: 7, r,
      fill: cssVar('--muted-foreground'),
    }));
  }
  const sizeRow = el('div', { class: 'legend-row' });
  sizeRow.append(sizeSvg, ' ', useEntityEdges ? 'memory · #tags  /  entity · reach' : 'memory · #tags');
  els.legend.append(sizeRow);

  // Edge row.
  const edgeSvg = svgEl('svg', { width: '50', height: '14', viewBox: '0 0 50 14' });
  edgeSvg.appendChild(svgEl('line', {
    x1: '2', y1: '7', x2: '48', y2: '7',
    stroke: cssVar('--border'), 'stroke-width': '1.5',
  }));
  const edgeRow = el('div', { class: 'legend-row' });
  edgeRow.append(edgeSvg, ' edge · ', useEntityEdges ? 'memory→entity (mention)' : 'shared tag(s)');
  els.legend.append(edgeRow);
}

// ---------- Filters ----------
function makeCheck(labelKids, checked, onChange) {
  const btn = el('button', {
    type: 'button', class: 'radyn-check radyn-focus', role: 'checkbox',
    'aria-checked': String(!!checked),
    onclick: () => {
      const next = btn.getAttribute('aria-checked') !== 'true';
      btn.setAttribute('aria-checked', String(next));
      onChange(next);
    },
  }, el('span', { class: 'box', 'aria-hidden': 'true' }));
  for (const kid of labelKids) btn.append(kid);
  return btn;
}

function makeFilterGroup(title) {
  const group = el('div', { class: 'filter-group' });
  const body = el('div', { class: 'group-body' });
  const header = el('button', {
    type: 'button', class: 'group-label', 'aria-expanded': 'true',
    onclick: () => {
      const collapsed = group.classList.toggle('collapsed');
      header.setAttribute('aria-expanded', String(!collapsed));
    },
  },
    el('span', { class: 'group-chevron', 'aria-hidden': 'true' }),
    el('span', { class: 'group-label-text' }, title),
  );
  group.append(header, body);
  return { group, body };
}

function renderFilters(stats) {
  clear(els.filters);

  const { group: typeGroup, body: typeBody } = makeFilterGroup('memory type');
  for (const t of TYPES) {
    typeBody.append(makeCheck(
      [
        el('span', { class: 'swatch', style: { background: COLORS[t] } }),
        el('span', null, t),
        el('span', { class: 'count' }, (stats.by_type[t] || 0).toLocaleString()),
      ],
      activeTypes.has(t),
      next => { next ? activeTypes.add(t) : activeTypes.delete(t); renderGraph(); },
    ));
  }
  els.filters.append(typeGroup);

  if (useEntityEdges) {
    const entityCounts = {};
    for (const e of bipartite.entities) entityCounts[e.type] = (entityCounts[e.type] || 0) + 1;

    const { group: entGroup, body: entBody } = makeFilterGroup('entity type');
    for (const et of ENTITY_TYPES) {
      entBody.append(makeCheck(
        [
          el('span', { class: 'swatch swatch-diamond', style: { borderColor: ENTITY_COLORS[et] || cssVar('--muted-foreground') } }),
          el('span', null, et),
          el('span', { class: 'count' }, (entityCounts[et] || 0).toLocaleString()),
        ],
        activeEntityTypes.has(et),
        next => { next ? activeEntityTypes.add(et) : activeEntityTypes.delete(et); renderGraph(); },
      ));
    }
    els.filters.append(entGroup);
  }

  const { group: scopeGroup, body: scopeBody } = makeFilterGroup('scope');
  const scopeList = el('div', { class: 'scope-list' });
  Object.entries(stats.by_scope).sort((a, b) => b[1] - a[1]).forEach(([s, c]) => {
    scopeList.append(makeCheck(
      [el('span', null, s), el('span', { class: 'count' }, c.toLocaleString())],
      activeScopes.has(s),
      next => { if (next) activeScopes.add(s); else activeScopes.delete(s); renderGraph(); },
    ));
  });
  scopeBody.append(scopeList);
  els.filters.append(scopeGroup);

  const searchGroup = el('div', { class: 'filter-group' });
  searchGroup.append(el('span', { class: 'group-label' }, 'search'));
  const searchInput = el('input', { type: 'search', placeholder: 'content or tag…' });
  let debounce;
  searchInput.addEventListener('input', e => {
    clearTimeout(debounce);
    const v = e.target.value.toLowerCase();
    debounce = setTimeout(() => {
      searchTerm = v;
      renderGraph();
    }, 200);
  });
  searchGroup.append(searchInput);
  els.filters.append(searchGroup);
}

function visibleMemories() {
  return allMemories.filter(m => {
    if (!activeTypes.has(m.type)) return false;
    if (!(activeScopes.size === 0 || activeScopes.has(m.scope))) return false;
    if (searchTerm) {
      const hay = (m.content + ' ' + m.tags.join(' ') + ' ' + m.scope).toLowerCase();
      if (!hay.includes(searchTerm)) return false;
    }
    return true;
  });
}

// Tag-edge heuristic — kept as fallback for when Neo4j is disabled. Memory↔
// memory edges built from shared tags (skipping mega-tags >30 nodes).
function buildTagLinks(mems) {
  const byTag = new Map();
  for (const m of mems) {
    for (const t of m.tags) {
      if (!byTag.has(t)) byTag.set(t, []);
      byTag.get(t).push(m.id);
    }
  }
  const merged = new Map();
  for (const [tag, ids] of byTag) {
    if (ids.length > 30) continue;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i], b = ids[j];
        const key = a < b ? `${a}-${b}` : `${b}-${a}`;
        if (!merged.has(key)) merged.set(key, { source: 'm-' + a, target: 'm-' + b, weight: 0, tags: [], kind: 'tag' });
        const e = merged.get(key);
        e.weight++;
        e.tags.push(tag);
      }
    }
  }
  return [...merged.values()];
}

function memoryRadius(m) {
  const n = (m.tags && m.tags.length) || 0;
  return 3 + Math.min(Math.sqrt(n) * 1, 2.5); // 3–5.5
}
function entityRadius(e) {
  // Reach scales the half-diagonal of the diamond. Range ~3–6 keeps entities
  // visually secondary to the memory dots; hubs are still parseable by size.
  return 3 + Math.min(Math.sqrt(e.memoryCount) * 0.85, 3);
}

// ---------- Graph render ----------
function renderGraph() {
  const gen = ++renderGen; // invalidates any in-flight async layout from a previous render
  const svgRoot = els.svg;
  const svg = d3.select(svgRoot);
  svg.selectAll('*').remove();

  const rect = svgRoot.getBoundingClientRect();
  svgRect = rect;
  const width = rect.width || 800;
  const height = rect.height || 600;

  const mems = visibleMemories();
  const memById = new Map(mems.map(m => [m.id, m]));

  // Build mixed node list and link list. Each node has a unique id ('m-N' or
  // 'e-name'). When useEntityEdges, edges go memory→entity; otherwise we use
  // the tag-co-occurrence fallback (memory↔memory).
  const memNodes = mems.map(m => ({ kind: 'memory', id: 'm-' + m.id, mem: m, _r: memoryRadius(m) }));

  let entNodes = [];
  let links = [];

  if (useEntityEdges) {
    const visibleEntityNames = new Set();
    for (const e of bipartite.entities) {
      if (!activeEntityTypes.has(e.type)) continue;
      visibleEntityNames.add(e.name);
    }

    // Pre-count edges to surviving memories per entity, so we don't render
    // entity nodes that no longer connect to anything visible.
    const entityReach = new Map();
    for (const link of bipartite.links) {
      if (!visibleEntityNames.has(link.entityName)) continue;
      if (!memById.has(link.memoryId)) continue;
      entityReach.set(link.entityName, (entityReach.get(link.entityName) || 0) + 1);
    }

    entNodes = bipartite.entities
      .filter(e => entityReach.has(e.name))
      .map(e => ({
        kind: 'entity',
        id: 'e-' + e.name,
        entity: { ...e, visibleCount: entityReach.get(e.name) || 0 },
        _r: entityRadius(e),
      }));

    const entityIds = new Set(entNodes.map(n => n.id));
    for (const link of bipartite.links) {
      if (!visibleEntityNames.has(link.entityName)) continue;
      if (!memById.has(link.memoryId)) continue;
      const target = 'e-' + link.entityName;
      if (!entityIds.has(target)) continue;
      links.push({ source: 'm-' + link.memoryId, target, weight: 1, kind: 'mention' });
    }
  } else {
    links = buildTagLinks(mems).filter(l => memById.has(parseInt(l.source.slice(2), 10)) && memById.has(parseInt(l.target.slice(2), 10)));
  }

  const allNodes = [...memNodes, ...entNodes];

  // Adjacency for hover highlighting — built once here (link source/target are
  // still string ids at this point), not rescanned on every mouseover.
  adjacency = new Map();
  const addAdj = (a, b) => {
    let s = adjacency.get(a);
    if (!s) { s = new Set(); adjacency.set(a, s); }
    s.add(b);
  };
  for (const l of links) { addAdj(l.source, l.target); addAdj(l.target, l.source); }

  // Seed positions from the previous layout so filter/resize/theme/tab-return
  // re-renders keep the map stable and only need a short settle pass.
  let seeded = 0;
  for (const n of allNodes) {
    const p = layoutCache.get(n.id);
    if (p) { n.x = p.x; n.y = p.y; seeded++; }
  }
  const warm = allNodes.length > 0 && seeded / allNodes.length > 0.9;

  const root = svg.append('g').attr('class', 'root');
  const zoomHud = document.getElementById('zoom-value');
  if (zoomHud) zoomHud.textContent = '100%';

  svg.call(d3.zoom().scaleExtent([0.15, 5]).on('zoom', e => {
    root.attr('transform', e.transform);
    if (zoomHud) zoomHud.textContent = `${Math.round(e.transform.k * 100)}%`;
  }));

  svg.on('click', (e) => {
    if (e.defaultPrevented) return;            // zoom/drag gesture, not a click
    if (e.target !== svg.node()) return;       // hit a node/link, their handler owns it
    selectedNodeId = null;
    clearSelection();
    resetDetailPane();
  });

  linksGroup = root.append('g').attr('class', 'links');
  const linkSelLocal = linksGroup.selectAll('line').data(links).enter().append('line')
    .attr('class', 'link')
    .attr('stroke-width', d => Math.min(0.4 + (d.weight || 1) * 0.4, 2.4));

  nodesGroup = root.append('g').attr('class', 'nodes');
  const node = nodesGroup.selectAll('g').data(allNodes).enter().append('g')
    .attr('class', d => 'node node-' + d.kind)
    .style('color', d => {
      if (d.kind === 'memory') return COLORS[d.mem.type] || cssVar('--muted-foreground');
      return ENTITY_COLORS[d.entity.type] || cssVar('--muted-foreground');
    });

  // Memory: solid circle filled with type color.
  node.filter(d => d.kind === 'memory').append('circle')
    .attr('class', 'dot')
    .attr('r', d => d._r);

  // Entity: hollow rotated square (diamond). Fill = background so links stop at
  // perimeter rather than punching through. Stroke = entity-type color.
  node.filter(d => d.kind === 'entity').append('rect')
    .attr('class', 'diamond')
    .attr('x', d => -d._r)
    .attr('y', d => -d._r)
    .attr('width', d => d._r * 2)
    .attr('height', d => d._r * 2)
    .attr('transform', 'rotate(45)');

  node.on('click', (e, d) => { selectedNodeId = d.id; applySelection(); showDetail(d); });
  node.on('mouseover', (e, d) => { highlight(d.id); showTooltip(e, d); });
  node.on('mousemove', e => moveTooltip(e));
  node.on('mouseout', () => { unhighlight(); hideTooltip(); });

  function paint() {
    // Entity diamonds keep their own constant rotate(45), set once at creation —
    // the group translate here never touches it.
    linkSelLocal
      .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
    node.attr('transform', d => `translate(${d.x},${d.y})`);
  }

  // Charge: entities repel a bit harder so they form natural hubs without the
  // memory points crowding through them.
  const sim = d3.forceSimulation(allNodes)
    .force('link', d3.forceLink(links).id(d => d.id)
      .distance(d => useEntityEdges ? 55 : 70 + 40 / Math.sqrt(d.weight || 1))
      .strength(d => useEntityEdges ? 0.35 : Math.min(0.1 + d.weight * 0.1, 0.7)))
    .force('charge', d3.forceManyBody().strength(d => d.kind === 'entity' ? -340 : -180).distanceMax(450))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('collide', d3.forceCollide().radius(d => d._r + 4).strength(0.85))
    .force('x', d3.forceX(width / 2).strength(0.04))
    .force('y', d3.forceY(height / 2).strength(0.04))
    .stop();

  // Async layout: tick in requestAnimationFrame chunks instead of a blocking
  // loop (300 synchronous ticks measured ~5.8s of frozen main thread on ~4400
  // nodes). The page stays interactive while the graph settles; warm renders
  // start from cached positions and need only a short low-alpha pass.
  sim.alpha(warm ? 0.15 : 1);
  const maxTicks = warm ? 40 : 200;
  let ticked = 0;
  paint();
  const step = () => {
    if (gen !== renderGen) return; // a newer render owns the canvas now
    const frameStart = performance.now();
    while (ticked < maxTicks && sim.alpha() > sim.alphaMin() && performance.now() - frameStart < 12) {
      sim.tick();
      ticked++;
    }
    paint();
    if (ticked < maxTicks && sim.alpha() > sim.alphaMin()) {
      requestAnimationFrame(step);
    } else {
      for (const n of allNodes) layoutCache.set(n.id, { x: n.x, y: n.y });
    }
  };
  requestAnimationFrame(step);

  node.call(
    d3.drag()
      .on('start', (e, d) => { d.fx = d.x; d.fy = d.y; })
      .on('drag', (e, d) => {
        d.fx = e.x; d.fy = e.y;
        d.x = e.x; d.y = e.y;
        paint();
      })
      .on('end', (e, d) => { layoutCache.set(d.id, { x: d.x, y: d.y }); })
  );

  nodeSel = node;
  linkSel = linkSelLocal;

  if (selectedNodeId != null && !allNodes.some(n => n.id === selectedNodeId)) selectedNodeId = null;
  applySelection();
}

// ---------- Highlight ----------
// Dim the whole graph with ONE class on each container <g>, then lift only the
// hovered node, its neighbours (precomputed adjacency), and incident links.
// The old approach wrote dim/highlight classes onto every node and link — ~12k
// DOM writes per hover on a 4k-node graph.
let litNodes = null;
let litLinks = null;
function highlight(id) {
  if (!nodeSel) return;
  const adj = adjacency.get(id) || new Set();
  nodesGroup.classed('dimmed', true);
  linksGroup.classed('dimmed', true);
  litNodes = nodeSel.filter(d => d.id === id || adj.has(d.id)).classed('lit', true);
  litNodes.filter(d => d.id === id).classed('highlight', true);
  litLinks = linkSel.filter(d => {
    const s = typeof d.source === 'object' ? d.source.id : d.source;
    const t = typeof d.target === 'object' ? d.target.id : d.target;
    return s === id || t === id;
  }).classed('lit', true).classed('highlight', true);
}
function unhighlight() {
  if (!nodeSel) return;
  nodesGroup.classed('dimmed', false);
  linksGroup.classed('dimmed', false);
  if (litNodes) litNodes.classed('lit', false).classed('highlight', false);
  if (litLinks) litLinks.classed('lit', false).classed('highlight', false);
  litNodes = litLinks = null;
}

// ---------- Selection ----------
// Persistent selection — parallel class namespace to the hover dim (sel-* vs
// dimmed/lit) so mouseout restores TO the selection state, never to neutral.
let selectedNodeId = null;
let selNodes = null, selLinks = null;
function clearSelection() {
  if (nodeSel) {
    nodesGroup.classed('sel-dimmed', false);
    linksGroup.classed('sel-dimmed', false);
    if (selNodes) selNodes.classed('sel-lit', false).classed('selected', false);
    if (selLinks) selLinks.classed('sel-lit', false);
  }
  selNodes = selLinks = null;
}
function applySelection() {
  clearSelection();
  if (selectedNodeId == null || !nodeSel) return;
  const adj = adjacency.get(selectedNodeId) || new Set();
  nodesGroup.classed('sel-dimmed', true);
  linksGroup.classed('sel-dimmed', true);
  selNodes = nodeSel.filter(d => d.id === selectedNodeId || adj.has(d.id)).classed('sel-lit', true);
  selNodes.filter(d => d.id === selectedNodeId).classed('selected', true);
  selLinks = linkSel.filter(d => {
    const s = typeof d.source === 'object' ? d.source.id : d.source;
    const t = typeof d.target === 'object' ? d.target.id : d.target;
    return s === selectedNodeId || t === selectedNodeId;
  }).classed('sel-lit', true);
}
function resetDetailPane() {
  clear(els.detail);
  els.detail.classList.add('empty');
  els.detail.append('click a memory or entity to view it');
}

// ---------- Tooltip ----------
function showTooltipMemory(event, m) {
  const summary = m.summary || (m.content || '').slice(0, 200) + ((m.content || '').length > 200 ? '…' : '');
  clear(els.tooltip);

  const iconWrap = svgEl('svg', { class: 't-icon', viewBox: '0 0 24 24' });
  iconWrap.style.color = COLORS[m.type];
  const iconUse = svgEl('use'); iconUse.setAttribute('href', '#icon-' + m.type);
  iconWrap.appendChild(iconUse);

  const meta = el('div', { class: 't-meta' },
    iconWrap,
    el('span', { style: { color: COLORS[m.type], fontWeight: '600' } }, m.type),
    el('span', { class: 'sep' }, '·'),
    el('span', null, m.scope),
    el('span', { class: 'sep' }, '·'),
    el('span', null, `${m.tags.length} tag${m.tags.length === 1 ? '' : 's'}`)
  );

  els.tooltip.append(meta, el('div', { class: 't-body' }, summary));
  els.tooltip.style.display = 'block';
  tooltipSize = { w: els.tooltip.offsetWidth, h: els.tooltip.offsetHeight };
  moveTooltip(event);
}

function showTooltipEntity(event, e) {
  const ent = e.entity;
  clear(els.tooltip);

  const meta = el('div', { class: 't-meta' },
    el('span', {
      class: 'swatch-diamond',
      style: { borderColor: ENTITY_COLORS[ent.type] || cssVar('--muted-foreground') },
    }),
    el('span', { style: { color: ENTITY_COLORS[ent.type] || cssVar('--muted-foreground'), fontWeight: '600' } }, ent.type),
    el('span', { class: 'sep' }, '·'),
    el('span', null, `${ent.visibleCount} of ${ent.memoryCount} memories`)
  );

  els.tooltip.append(meta, el('div', { class: 't-body' }, ent.name));
  els.tooltip.style.display = 'block';
  tooltipSize = { w: els.tooltip.offsetWidth, h: els.tooltip.offsetHeight };
  moveTooltip(event);
}

function showTooltip(event, d) {
  if (d.kind === 'memory') showTooltipMemory(event, d.mem);
  else showTooltipEntity(event, d);
}

function moveTooltip(event) {
  // Uses the rect cached by renderGraph and the size measured on tooltip show —
  // no layout reads on the mousemove hot path.
  const pad = 14;
  const tt = els.tooltip;
  const rect = svgRect || els.svg.getBoundingClientRect();
  let x = event.clientX - rect.left + pad;
  let y = event.clientY - rect.top + pad;
  if (x + tooltipSize.w > rect.width) x = event.clientX - rect.left - tooltipSize.w - pad;
  if (y + tooltipSize.h > rect.height) y = event.clientY - rect.top - tooltipSize.h - pad;
  tt.style.left = x + 'px';
  tt.style.top = y + 'px';
}
function hideTooltip() { els.tooltip.style.display = 'none'; }

// ---------- Selection detail ----------
function showDetail(d) {
  if (d.kind === 'memory') showMemoryDetail(d.mem);
  else showEntityDetail(d.entity);
}

function showMemoryDetail(m) {
  els.detail.classList.remove('empty');
  clear(els.detail);

  const meta = el('div', { class: 'meta' },
    el('span', { class: 'pill type', style: { color: COLORS[m.type] } }, m.type),
    el('span', { class: 'pill' }, m.scope),
    el('span', { class: 'pill' }, 'id ' + m.id),
    m.source ? el('span', { class: 'pill' }, m.source) : null,
    (m.confidence != null && m.confidence < 1) ? el('span', { class: 'pill' }, 'conf ' + Number(m.confidence).toFixed(2)) : null,
    (m.confidence != null) ? (() => {
      const t = tierOf(Number(m.confidence));
      return el('span', { class: `pill radyn-pill ${t.tone}` }, t.name);
    })() : null,
    m.created_at ? el('span', { class: 'pill' }, m.created_at) : null
  );

  const body = el('div', { class: 'body' }, m.content || '');
  els.detail.append(meta, body);
  const seen = relTime(m.last_seen ?? m.updated_at);
  if (seen) els.detail.append(el('div', { class: 'meta-line' },
    `${m.observation_count ?? 1} obs · last seen ${seen}`));
  if (m.tags && m.tags.length) {
    const tagBox = el('div', { style: { marginTop: '0.6rem' } });
    for (const t of m.tags) tagBox.append(el('span', { class: 'tag' }, '#' + t));
    els.detail.append(tagBox);
  }
}

function showEntityDetail(ent) {
  els.detail.classList.remove('empty');
  clear(els.detail);

  // Connected memories — gather from the bipartite payload.
  const memIds = new Set();
  for (const link of bipartite.links) {
    if (link.entityName === ent.name) memIds.add(link.memoryId);
  }
  const memById = new Map(allMemories.map(m => [m.id, m]));
  const connected = [...memIds].map(id => memById.get(id)).filter(Boolean);
  const visibleConnected = ent.visibleCount != null ? ent.visibleCount : connected.length;

  const meta = el('div', { class: 'meta' },
    el('span', { class: 'pill type', style: { color: ENTITY_COLORS[ent.type] || cssVar('--muted-foreground') } }, ent.type),
    el('span', { class: 'pill' }, 'entity'),
    el('span', { class: 'pill' }, ent.memoryCount + ' memories'),
    visibleConnected !== ent.memoryCount ? el('span', { class: 'pill' }, visibleConnected + ' visible') : null
  );

  const heading = el('div', { class: 'body entity-name' }, ent.name);
  els.detail.append(meta, heading);

  // Connected-memory list. Click a row to focus that memory in the detail
  // panel.
  if (connected.length) {
    const listLabel = el('div', { class: 'entity-list-label' }, `connected · ${connected.length}`);
    const list = el('div', { class: 'entity-list' });
    // Sort by type priority then by id desc for predictable output.
    const typeOrder = { user: 0, feedback: 1, project: 2, reference: 3, discovery: 4 };
    connected.sort((a, b) => (typeOrder[a.type] ?? 9) - (typeOrder[b.type] ?? 9) || b.id - a.id);
    for (const m of connected.slice(0, 60)) {
      const row = el('button', {
        class: 'entity-list-row',
        onclick: () => showMemoryDetail(m),
      },
        el('span', { class: 'entity-list-pill', style: { color: COLORS[m.type] } }, m.type),
        el('span', { class: 'entity-list-snippet' }, (m.summary || m.content || '').slice(0, 90))
      );
      list.append(row);
    }
    els.detail.append(listLabel, list);
    if (connected.length > 60) {
      els.detail.append(el('div', { class: 'entity-list-more' }, `+ ${connected.length - 60} more`));
    }
  }
}

let resizeTimer;
window.addEventListener('resize', () => {
  // Refresh the tooltip rect immediately — the debounced re-render is 200ms out
  // and moveTooltip would otherwise position against the pre-resize geometry.
  svgRect = els.svg.getBoundingClientRect();
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (lastStats) renderGraph(); }, 200);
});

// Theme toggle button — wired up here, after all let/const declarations are
// initialized, so setTheme() can safely reference lastStats / els / COLORS.
{
  const themeBtn = document.getElementById('theme-toggle');
  if (themeBtn) {
    themeBtn.addEventListener('click', () => {
      const i = THEMES.indexOf(document.body.dataset.theme);
      setTheme(THEMES[(i + 1) % THEMES.length]);
    });
  }
  refreshColors();
}

// ---------- Tabs + live observation stream ----------
{
  const TAB_KEY = 'kopeng-viz-tab';
  const MAX_ROWS = 500;
  const tabBtns = document.querySelectorAll('.tab');
  const panels = document.querySelectorAll('.tab-panel');
  const liveDot = document.getElementById('live-dot');
  const statusEl = document.getElementById('live-status');
  const countEl = document.getElementById('live-count');
  const rateEl = document.getElementById('live-rate');
  const pauseSlot = document.getElementById('live-pause-slot');
  if (pauseSlot) pauseSlot.append(makeCheck(['pause'], false, () => {}));
  const pauseEl = pauseSlot ? pauseSlot.querySelector('.radyn-check') : null;
  if (pauseEl) pauseEl.id = 'live-pause';
  const clearBtn = document.getElementById('live-clear');
  const listEl = document.getElementById('live-list');
  const slotsCountEl = document.getElementById('slots-count');
  const slotsTbodyEl = document.getElementById('slots-tbody');

  let es = null;
  let lastSeq = 0;
  let totalCount = 0;
  let rateBuffer = []; // timestamps of last events for /s calculation
  let activeTab = null;

  function setTab(name) {
    activeTab = name;
    try { localStorage.setItem(TAB_KEY, name); } catch {}
    for (const btn of tabBtns) {
      const on = btn.dataset.tab === name;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    for (const p of panels) {
      const on = p.dataset.panel === name;
      p.hidden = !on;
    }
    if (name === 'live') {
      ensureConnected();
    } else {
      // Keep the stream open so we don't lose events on tab switches —
      // the bus is cheap and stops emitting when listenerCount drops to
      // zero anyway. EventSource also auto-reconnects if it errors.
    }
    if (name === 'ops') {
      startOpsPolling();
    } else {
      stopOpsPolling();
    }
    if (name === 'slots') {
      startSlotsPolling();
    } else {
      stopSlotsPolling();
    }
    if (name === 'replay') {
      ensureReplayInit();
    } else {
      pauseReplay(); // stop the timer when leaving the tab — no background CPU
    }
    if (name === 'review') {
      startReviewPolling();
    } else {
      stopReviewPolling();
    }
    // Recompute graph layout after layout shifts.
    if (name === 'graph' && typeof lastStats !== 'undefined' && lastStats) {
      setTimeout(() => renderGraph(), 50);
    }
  }

  function setStatus(state, label) {
    if (liveDot) liveDot.dataset.state = state;
    if (statusEl) {
      statusEl.dataset.state = state;
      statusEl.textContent = label;
    }
  }

  function ensureConnected() {
    if (es && (es.readyState === 0 || es.readyState === 1)) return;
    setStatus('connecting', 'connecting…');
    try {
      es = new EventSource('/api/observations/stream');
    } catch (err) {
      setStatus('error', 'unsupported');
      console.error('EventSource init failed', err);
      return;
    }
    es.addEventListener('open', () => setStatus('connected', 'live'));
    es.addEventListener('error', () => {
      // Browser will auto-reconnect; readyState flips back to 0.
      setStatus('error', 'reconnecting…');
    });
    es.addEventListener('observation', (e) => {
      if (pauseEl?.getAttribute('aria-checked') === 'true') return;
      let payload;
      try { payload = JSON.parse(e.data); } catch { return; }
      if (!payload || !payload.observation) return;
      // Gap detection — log to console if we missed events on reconnect.
      if (payload.seq && lastSeq && payload.seq > lastSeq + 1) {
        console.warn(`SSE gap: missed ${payload.seq - lastSeq - 1} events (${lastSeq} → ${payload.seq})`);
      }
      lastSeq = payload.seq || lastSeq;
      appendRow(payload);
    });
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString('en-US', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  }

  function appendRow(evt) {
    // First event clears the empty hint.
    const empty = listEl.querySelector('.live-empty');
    if (empty) empty.remove();

    const obs = evt.observation;
    const status = evt.kind || obs.status || 'started';

    // Coalesce: if this is a completion/failure for an existing row in the
    // visible window, update that row in place instead of appending.
    const existing = obs.id != null ? listEl.querySelector(`[data-obs-id="${obs.id}"]`) : null;
    if (existing) {
      const pill = existing.querySelector('.live-pill');
      if (pill) {
        pill.className = 'live-pill radyn-pill'
          + (status === 'completed' ? ' radyn-pill--success' : status === 'failed' ? ' radyn-pill--error' : '');
        pill.dataset.status = status;
        pill.textContent = status;
      }
      const dur = existing.querySelector('.live-dur');
      if (dur && obs.duration_ms != null) dur.textContent = obs.duration_ms + 'ms';
      existing.classList.remove('fresh');
      // Force reflow then re-add for the flash animation.
      void existing.offsetWidth;
      existing.classList.add('fresh');
      bumpStats(evt.ts || Date.now());
      return;
    }

    const row = document.createElement('div');
    row.className = 'live-row fresh';
    if (obs.id != null) row.dataset.obsId = obs.id;

    const time = document.createElement('span');
    time.className = 'live-time';
    time.textContent = fmtTime(evt.ts || Date.parse(obs.started_at) || Date.now());

    const pill = document.createElement('span');
    pill.className = 'live-pill radyn-pill'
      + (status === 'completed' ? ' radyn-pill--success' : status === 'failed' ? ' radyn-pill--error' : '');
    pill.dataset.status = status;
    pill.textContent = status;

    const tool = document.createElement('span');
    tool.className = 'live-tool';
    tool.textContent = obs.tool_name || '—';
    tool.title = obs.tool_name || '';

    const proj = document.createElement('span');
    proj.className = 'live-proj';
    proj.textContent = obs.project_scope || '';
    proj.title = obs.project_scope || '';

    const dur = document.createElement('span');
    dur.className = 'live-dur';
    dur.textContent = obs.duration_ms != null ? obs.duration_ms + 'ms' : '';

    row.append(time, pill, tool, proj, dur);

    // Click to toggle a detail block with input + output snippets.
    row.addEventListener('click', () => {
      const existingDetail = row.querySelector('.live-row-detail');
      if (existingDetail) { existingDetail.remove(); row.classList.remove('expanded'); return; }
      const detail = document.createElement('div');
      detail.className = 'live-row-detail';
      const parts = [];
      if (obs.input_summary) parts.push('input: ' + obs.input_summary);
      if (obs.output_summary) parts.push('output: ' + obs.output_summary);
      detail.textContent = parts.join('\n\n') || '(no summary)';
      row.append(detail);
      row.classList.add('expanded');
    });

    listEl.prepend(row);

    // Cap at MAX_ROWS — trim oldest.
    while (listEl.children.length > MAX_ROWS) {
      listEl.lastElementChild?.remove();
    }

    bumpStats(evt.ts || Date.now());
  }

  function bumpStats(ts) {
    totalCount++;
    countEl.textContent = totalCount.toLocaleString();
    rateBuffer.push(ts);
    const cutoff = ts - 5000;
    while (rateBuffer.length && rateBuffer[0] < cutoff) rateBuffer.shift();
    rateEl.textContent = (rateBuffer.length / 5).toFixed(1) + '/s';
  }

  setInterval(() => {
    if (!rateBuffer.length) return;
    const cutoff = Date.now() - 5000;
    while (rateBuffer.length && rateBuffer[0] < cutoff) rateBuffer.shift();
    rateEl.textContent = (rateBuffer.length / 5).toFixed(1) + '/s';
  }, 1000);

  clearBtn?.addEventListener('click', () => {
    while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
    const empty = el('div', { class: 'live-empty' }, 'cleared. waiting for next event…');
    listEl.append(empty);
  });

  // ── Ops tab — polling-based operational visibility ──
  //
  // Fast endpoints (discovery-status, confidence-distribution, last-promotion,
  // cache-stats) refresh every 10s. top-decaying is heavier (on-demand decay
  // compute over the full memory table — ~4s on 1600 rows) so it gets a
  // 30s cadence. Polls are gated on activeTab === 'ops' so leaving the tab
  // drops the load on the server. setTab() calls startOpsPolling() /
  // stopOpsPolling() — defined below.
  const OPS_FAST_MS = 10_000;
  const OPS_SLOW_MS = 30_000;
  const SLOTS_POLL_MS = 30_000;
  let opsFastTimer = null;
  let opsSlowTimer = null;
  let slotsTimer = null;
  const opsPollStatus = document.getElementById('ops-poll-status');

  function setOpsStatus(text) {
    if (opsPollStatus) opsPollStatus.textContent = text;
  }

  async function fetchOps(path) {
    const r = await fetch(path, { cache: 'no-store' });
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    const j = await r.json();
    return j.data;
  }

  // Sentinel for a failed /api/ops/* fetch. Renderers MUST distinguish this from
  // `enabled: false` — a transient network blip must read "api unreachable", never
  // "feature disabled" (the 2026-07-03 false alarm).
  const UNREACHABLE = { __unreachable: true };

  function fmtAge(iso) {
    if (!iso) return '—';
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + 's ago';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60);
    if (h < 48) return h + 'h ago';
    return Math.floor(h / 24) + 'd ago';
  }

  async function fetchSlots() {
    const r = await fetch('/api/slots', { cache: 'no-store' });
    if (!r.ok) throw new Error(`slots: ${r.status}`);
    const j = await r.json();
    return Array.isArray(j.data) ? j.data : [];
  }

  function renderSlots(rows) {
    if (slotsCountEl) slotsCountEl.textContent = rows.length.toLocaleString();
    if (!slotsTbodyEl) return;
    clear(slotsTbodyEl);

    if (rows.length === 0) {
      slotsTbodyEl.append(el('tr', null, el('td', { colspan: 5, class: 'ops-empty' }, 'no slots pinned')));
      return;
    }

    for (const slot of rows) {
      const row = el('tr', { class: 'slot-row' },
        el('td', null, el('span', { class: 'slot-chevron', 'aria-hidden': 'true' }), slot.slot_key),
        el('td', null, slot.type),
        el('td', { class: 'ops-cell-scope', title: slot.scope }, slot.scope),
        el('td', { class: 'slot-content', title: slot.content }, slot.content.length > 80 ? slot.content.slice(0, 80) + '...' : slot.content),
        el('td', null, fmtAge(slot.updated_at))
      );
      row.addEventListener('click', () => {
        const next = row.nextElementSibling;
        if (next?.classList.contains('slot-expand')) {
          next.remove();
          row.classList.remove('slot-open');
          return;
        }
        const detail = el('tr', { class: 'slot-expand' },
          el('td', { colspan: 5 }, slot.content)
        );
        row.after(detail);
        row.classList.add('slot-open');
      });
      slotsTbodyEl.append(row);
    }
  }

  async function pollSlots() {
    if (activeTab !== 'slots') return;
    try {
      renderSlots(await fetchSlots());
    } catch (err) {
      console.error('slots fetch failed', err);
      if (slotsTbodyEl) {
        clear(slotsTbodyEl);
        slotsTbodyEl.append(el('tr', null, el('td', { colspan: 5, class: 'ops-empty' }, 'error loading slots')));
      }
    }
  }

  function startSlotsPolling() {
    if (slotsTimer) return;
    pollSlots();
    slotsTimer = setInterval(pollSlots, SLOTS_POLL_MS);
  }

  function stopSlotsPolling() {
    if (slotsTimer) { clearInterval(slotsTimer); slotsTimer = null; }
  }

  // T19: map an observation age to a senses-light band (green <1h, amber <24h,
  // red beyond). A null/absent timestamp or a disabled feed reads red — a silent
  // feed must go visibly dark, never just park on stale numbers.
  function setSenses(state, label) {
    const wrap = document.getElementById('ops-senses');
    if (wrap) wrap.dataset.state = state;
    const lbl = document.getElementById('ops-senses-label');
    if (lbl) lbl.textContent = label;
  }
  function sensesBand(iso) {
    if (!iso) return { state: 'red', label: 'senses dark · no observations' };
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms) || ms < 0) return { state: 'unknown', label: 'senses —' };
    if (ms < 3_600_000) return { state: 'green', label: 'senses live · ' + fmtAge(iso) };
    if (ms < 86_400_000) return { state: 'amber', label: 'senses stale · ' + fmtAge(iso) };
    return { state: 'red', label: 'senses dark · ' + fmtAge(iso) };
  }

  function renderDiscoveryStatus(data) {
    if (!data || data.__unreachable) {
      document.getElementById('ops-discovery-lag').textContent = '—';
      document.getElementById('ops-discovery-sub').textContent = 'api unreachable';
      document.getElementById('ops-discovery-foot').textContent = 'could not reach /api/ops/discovery-status — not a config state';
      setSenses('unknown', 'senses —'); // network blip is not a senses judgment
      return;
    }
    if (data.enabled === false) {
      document.getElementById('ops-discovery-lag').textContent = 'off';
      document.getElementById('ops-discovery-sub').textContent = 'ingestion disabled';
      document.getElementById('ops-discovery-foot').textContent = 'OBSERVATION_INGESTION_ENABLED=false';
      setSenses('red', 'senses off · ingestion disabled'); // unplugged = red, not silent
      return;
    }
    const band = sensesBand(data.last_observation_at);
    setSenses(band.state, band.label);
    document.getElementById('ops-discovery-lag').textContent = data.lag.toLocaleString();
    document.getElementById('ops-discovery-sub').textContent =
      `${data.runs_last_hour} runs · last hour`;

    const spark = document.getElementById('ops-discovery-spark');
    if (spark) {
      clear(spark);
      const runs = (data.recent_runs || []).slice().reverse(); // chronological
      const max = Math.max(1, ...runs.map(r => r.observations_analyzed || 0));
      for (const r of runs) {
        const h = Math.max(2, Math.round((r.observations_analyzed / max) * 28));
        const bar = el('span', {
          class: 'spark-bar',
          title: `run #${r.id} · ${r.project_scope} · ${r.observations_analyzed} obs · ${r.patterns_found} patterns`,
          style: { height: h + 'px' },
        });
        if (r.patterns_found > 0) bar.classList.add('spark-hit');
        spark.append(bar);
      }
    }
    document.getElementById('ops-discovery-foot').textContent =
      `watermark ${data.watermark.toLocaleString()} / max ${data.max_observation_id.toLocaleString()} · last run ${fmtAge(data.last_run_at)}`;
  }

  // T21: reasoner liveness card. armed + reachable → green; armed + unreachable
  // → red (the "armed but dark" alarm); disarmed → neutral (NoOp is a valid
  // config, not a fault).
  function renderReasonerStatus(data) {
    const subEl = document.getElementById('ops-reasoner-sub');
    const stateEl = document.getElementById('ops-reasoner-state');
    const modelEl = document.getElementById('ops-reasoner-model');
    const kvEl = document.getElementById('ops-reasoner-kv');
    const footEl = document.getElementById('ops-reasoner-foot');
    const lightEl = document.getElementById('ops-reasoner-light');
    const setLight = (s) => { if (lightEl) lightEl.dataset.state = s; };

    if (!data || data.__unreachable) {
      subEl.textContent = 'api unreachable';
      setLight('unknown');
      stateEl.textContent = '—';
      modelEl.textContent = 'model —';
      clear(kvEl);
      footEl.textContent = 'could not reach /api/ops/reasoner-status — not a config state';
      return;
    }

    if (!data.armed) {
      subEl.textContent = 'disabled';
      setLight('unknown');
      stateEl.textContent = 'disarmed · NoOp';
      modelEl.textContent = 'model —';
      clear(kvEl);
      footEl.textContent = 'DREAM_REASONER_ENABLED=false — Phase-1 (deterministic-only) behavior';
      return;
    }

    const reachable = data.reachable === true;
    setLight(reachable ? 'green' : 'red');
    subEl.textContent = data.provider || 'ollama';
    stateEl.textContent = reachable ? 'armed · reachable' : 'armed · DARK';
    modelEl.textContent = 'model ' + (data.model || '—');

    clear(kvEl);
    const kvs = [
      ['provider', data.provider || '—'],
      ['reachable', reachable ? 'yes' : 'no'],
      ['last classify', fmtAge(data.last_classify_at)],
    ];
    for (const [k, v] of kvs) {
      kvEl.append(el('dt', null, k), el('dd', null, String(v ?? '—')));
    }
    footEl.textContent = data.error
      ? data.error
      : (data.url || '') + (data.last_classify_at ? '' : ' · no classify calls yet');
  }

  function renderLastPromotion(data) {
    const last = data?.last;
    const whenEl = document.getElementById('ops-promotion-when');
    const labelEl = document.getElementById('ops-promotion-when-label');
    const subEl = document.getElementById('ops-promotion-sub');
    const kvEl = document.getElementById('ops-promotion-kv');
    if (data && data.__unreachable) {
      whenEl.textContent = '—';
      labelEl.textContent = 'api unreachable';
      subEl.textContent = '—';
      clear(kvEl);
      return;
    }
    if (!last) {
      whenEl.textContent = 'never';
      labelEl.textContent = 'no promotion runs since logging shipped';
      subEl.textContent = '—';
      clear(kvEl);
      return;
    }
    whenEl.textContent = fmtAge(last.completed_at || last.started_at);
    labelEl.textContent = last.dry_run ? 'last completed (dry run)' : 'last completed';
    subEl.textContent =
      `status: ${last.status}` + (last.duration_ms != null ? ` · ${last.duration_ms}ms` : '');

    clear(kvEl);
    const kvs = [
      ['archived', last.memories_archived],
      ['duplicates', last.consolidation_duplicates],
      ['merge targets', last.consolidation_merge_targets],
      ['decay computed', last.decay_computed],
      ['below threshold', last.decay_below_threshold],
      ['avg decay', last.decay_avg_score != null ? last.decay_avg_score.toFixed(3) : '—'],
    ];
    for (const [k, v] of kvs) {
      kvEl.append(el('dt', null, k), el('dd', null, String(v ?? '—')));
    }
  }

  const TIER_ORDER = ['noted', 'pattern', 'actionable', 'confirmed'];

  function renderConfidence(data) {
    if (data && data.__unreachable) {
      document.getElementById('ops-conf-sub').textContent = 'api unreachable';
      return; // keep the last-known bar/legend/table rather than rendering zeros
    }
    const byTier = data?.by_tier || {};
    const byType = data?.by_type || [];
    const total = Object.values(byTier).reduce((a, b) => a + b, 0);
    document.getElementById('ops-conf-sub').textContent =
      `${total.toLocaleString()} active memories`;

    const bar = document.getElementById('ops-conf-bar');
    clear(bar);
    for (const tier of TIER_ORDER) {
      const n = byTier[tier] || 0;
      if (!n) continue;
      const seg = el('span', {
        class: 'ops-tier-seg',
        dataset: { tier },
        style: { flex: String(n) },
        title: `${tier}: ${n.toLocaleString()}`,
      });
      bar.append(seg);
    }

    const legend = document.getElementById('ops-conf-legend');
    clear(legend);
    for (const tier of TIER_ORDER) {
      const n = byTier[tier] || 0;
      legend.append(
        el('span', { class: 'ops-tier-legend-row' },
          el('span', { class: 'ops-tier-swatch', dataset: { tier } }),
          el('span', null, tier),
          el('span', { class: 'ops-tier-count' }, n.toLocaleString())
        )
      );
    }

    // Per-type table: each row = type, columns = tier counts.
    const table = document.getElementById('ops-conf-table');
    clear(table);
    const types = Array.from(new Set(byType.map(r => r.type))).sort();
    const grid = {};
    for (const row of byType) {
      grid[row.type] = grid[row.type] || {};
      grid[row.type][row.tier] = row.count;
    }
    const thead = el('thead', null,
      el('tr', null,
        el('th', null, 'type'),
        ...TIER_ORDER.map(t => el('th', null, t))
      )
    );
    const tbody = el('tbody');
    for (const t of types) {
      tbody.append(
        el('tr', null,
          el('td', null, t),
          ...TIER_ORDER.map(tier => el('td', null, String(grid[t]?.[tier] ?? 0)))
        )
      );
    }
    table.append(thead, tbody);
  }

  function renderCacheStats(data) {
    if (!data || data.__unreachable) {
      document.getElementById('ops-cache-ratio').textContent = '—';
      document.getElementById('ops-cache-sub').textContent = 'api unreachable';
      clear(document.getElementById('ops-cache-kv'));
      return;
    }
    if (data.enabled === false) {
      document.getElementById('ops-cache-ratio').textContent = 'off';
      document.getElementById('ops-cache-sub').textContent = 'discovery disabled';
      clear(document.getElementById('ops-cache-kv'));
      return;
    }
    const ratio = data.dedup_ratio || 0;
    document.getElementById('ops-cache-ratio').textContent = (ratio * 100).toFixed(1) + '%';
    document.getElementById('ops-cache-sub').textContent =
      `over last ${data.sample_size || 0} completed runs`;

    const kvEl = document.getElementById('ops-cache-kv');
    clear(kvEl);
    const t = data.totals || {};
    const kvs = [
      ['observations analyzed', t.observations_analyzed],
      ['patterns found', t.patterns_found],
      ['memories created', t.memories_created],
      ['memories reinforced', t.memories_reinforced],
    ];
    for (const [k, v] of kvs) {
      kvEl.append(el('dt', null, k), el('dd', null, (v ?? 0).toLocaleString()));
    }
  }

  function renderTopDecaying(rows) {
    const tbody = document.getElementById('ops-decay-table').querySelector('tbody');
    clear(tbody);
    if (!rows || rows.length === 0) {
      tbody.append(el('tr', null, el('td', { colspan: 6, class: 'ops-empty' }, 'no decayed memories yet — your store is healthy.')));
      return;
    }
    for (const r of rows) {
      tbody.append(
        el('tr', null,
          el('td', null, String(r.id)),
          el('td', null, r.type),
          el('td', { class: 'ops-cell-scope', title: r.scope }, r.scope),
          el('td', { class: 'ops-cell-summary', title: r.summary }, (r.summary || '').slice(0, 80)),
          el('td', null, r.total_score.toFixed(3)),
          el('td', null, r.days_since_access.toFixed(1))
        )
      );
    }
  }

  // Dream history — chronological record of what dreaming actually did. The 0/0/0
  // case (passes completing with no proposed/applied/pending changes) is the
  // expected steady state on a clean corpus; corpus-health's ACTIONABLE pair count
  // below tells you whether that's "nothing to do" or "dreaming isn't seeing the
  // dups" (total pairs don't — most are anchored/cross-scope, exempt by design).
  function renderDreamHistory(data) {
    const subEl = document.getElementById('ops-dream-sub');
    const sumEl = document.getElementById('ops-dream-summary');
    const tbody = document.getElementById('ops-dream-table').querySelector('tbody');
    clear(tbody);
    if (!data || data.__unreachable) {
      if (subEl) subEl.textContent = 'api unreachable';
      if (sumEl) sumEl.textContent = 'could not reach /api/ops/dream-history — not a config state';
      tbody.append(el('tr', null, el('td', { colspan: 8, class: 'ops-empty' }, 'api unreachable')));
      return;
    }
    if (data.enabled === false) {
      if (subEl) subEl.textContent = 'dreaming off';
      if (sumEl) sumEl.textContent = 'DREAMING_ENABLED=false — no passes recorded';
      tbody.append(el('tr', null, el('td', { colspan: 8, class: 'ops-empty' }, 'dreaming disabled')));
      return;
    }
    const dreams = data.dreams || [];
    if (subEl) subEl.textContent = `${dreams.length} recent pass${dreams.length === 1 ? '' : 'es'}`;
    if (dreams.length === 0) {
      if (sumEl) sumEl.textContent = 'no completed dream passes yet';
      tbody.append(el('tr', null, el('td', { colspan: 8, class: 'ops-empty' }, 'no dream passes recorded')));
      return;
    }
    let proposed = 0, applied = 0, pending = 0;
    for (const d of dreams) {
      const c = d.changes || {};
      proposed += c.proposed || 0;
      applied += (c.auto_applied || 0) + (c.accepted || 0);
      pending += c.pending || 0;
    }
    const lastAge = fmtAge(dreams[0].completed_at || dreams[0].started_at);
    if (sumEl) {
      // All-zero across every shown pass is the healthy steady state, not a
      // stall — say so inline instead of letting 0/0/0 read as failure.
      const allZero = proposed === 0 && applied === 0 && pending === 0;
      sumEl.textContent =
        `last pass ${lastAge} · across ${dreams.length} shown: ${proposed} proposed · ${applied} applied · ${pending} awaiting review`
        + (allZero ? ' — corpus has no dream-actionable pairs (see corpus health)' : '');
    }
    for (const d of dreams) {
      const c = d.changes || {};
      tbody.append(
        el('tr', null,
          el('td', { title: d.completed_at || d.started_at }, fmtAge(d.completed_at || d.started_at)),
          el('td', { class: 'ops-cell-scope', title: d.scope || 'all scopes' }, d.scope || 'all'),
          el('td', null, d.mode),
          el('td', null, String(d.memories_examined ?? '—')),
          el('td', null, String(c.proposed ?? 0)),
          el('td', null, String((c.auto_applied ?? 0) + (c.accepted ?? 0))),
          el('td', null, String(c.pending ?? 0)),
          el('td', null, d.status)
        )
      );
    }
  }

  // Corpus health — the effectiveness signal. The big number is the ACTIONABLE
  // duplicate-pair count: same-scope, unanchored pairs the dream collapse tier could
  // actually propose on. Anchored (confidence 1.0 / locked — Hard Anchor) and
  // cross-scope (R6 promote-not-collapse) pairs are by-design exempt, so they render
  // as context rows, not as the alarm metric. actionable > 0 while dreaming applies
  // nothing = the rotating window isn't co-windowing those pairs (the R12 far-apart
  // blind spot) → the case for whole-corpus mode. Heavy (O(n^2) over a sample) so it
  // rides the 30s slow poll. Reads meta for the sample caveat.
  function renderCorpusHealth(data, meta) {
    const dupEl = document.getElementById('ops-corpus-dups');
    const dupLabelEl = document.getElementById('ops-corpus-dups-label');
    const subEl = document.getElementById('ops-corpus-sub');
    const kvEl = document.getElementById('ops-corpus-kv');
    if (!data || data.__unreachable) {
      if (dupEl) dupEl.textContent = '—';
      if (subEl) subEl.textContent = data && data.__unreachable ? 'api unreachable' : 'unavailable';
      clear(kvEl);
      return;
    }
    // duplicate_pairs breakdown ships with the actionability split; a pre-upgrade
    // server only has the flat count, which must NOT be labelled actionable.
    const pairs = data.duplicate_pairs;
    const shown = pairs ? (pairs.actionable ?? 0) : (data.duplicate_pair_count ?? 0);
    if (dupEl) dupEl.textContent = shown.toLocaleString();
    if (dupLabelEl) {
      dupLabelEl.textContent = !pairs
        ? 'duplicate pairs in sample (server predates actionability breakdown)'
        : shown > 0
          ? 'dream-actionable duplicate pairs — dreaming should collapse these'
          : 'dream-actionable duplicate pairs';
    }
    if (subEl) {
      subEl.textContent = meta?.sampled
        ? `sampled ${(meta.sample_size ?? 0).toLocaleString()} of ${(data.active_memory_count ?? 0).toLocaleString()} — undercounts`
        : `full corpus · ${(data.active_memory_count ?? 0).toLocaleString()} active`;
    }
    clear(kvEl);
    const kvs = [
      ...(pairs ? [
        ['anchored pairs (exempt)', pairs.anchored],
        ['cross-scope pairs (not collapsible)', pairs.cross_scope],
        ['total pairs ≥0.95', pairs.total],
      ] : []),
      ['decayed at-risk', data.decayed_at_risk_count],
      ['contradiction-flagged', data.contradiction_flagged_count],
      ['active memories', data.active_memory_count],
      ['mean confidence', data.mean_confidence != null ? data.mean_confidence.toFixed(3) : '—'],
    ];
    for (const [k, v] of kvs) {
      kvEl.append(el('dt', null, k), el('dd', null, typeof v === 'number' ? v.toLocaleString() : String(v ?? '—')));
    }
  }

  // ── Scope-drift panel (T76 Task 9) ──
  //
  // Consumes GET /api/ops/scope-drift (light one-GROUP-BY endpoint, rides the
  // fast 10s cadence) and drives two admin-keyed mutating routes: POST
  // /api/admin/scopes/rule (approve-alias / mark-distinct) and POST
  // /api/admin/scopes/archive-ephemeral (two-step dry-run/confirm). The proxy
  // injects the admin key server-side — this file never holds it.
  //
  // Ruling L-1: no action is pre-selected. Every button here waits for a
  // click; render never fires a request on its own.

  function driftChip(label, value, tone) {
    return el('span', { class: 'radyn-pill' + (tone ? ` radyn-pill--${tone}` : '') }, `${label} ${value}`);
  }

  // The cluster aggregate is true iff EVERY uncovered variant has been marked
  // distinct — it hides the whole action block. The per-variant flag
  // (v.ruled_distinct) is what the individual buttons filter on: in a
  // partially-ruled cluster the aggregate is false, and without the per-variant
  // check the bulk "alias the variants" button would alias away the one scope
  // the operator just ruled separate.
  function clusterRuledDistinct(cluster) {
    return cluster.ruled_distinct === true;
  }

  // The variants a "merge into <target>" click would actually rule. ONE
  // definition, used by both the render-time emptiness guard and approveAlias
  // itself — a button whose action set is empty is never drawn, and the guard
  // cannot drift away from the action the way a second hand-written filter would.
  function mergeSources(cluster, target) {
    return cluster.variants.filter(v =>
      v.scope !== target && v.aliased_to === null && !v.ruled_distinct
    );
  }

  function topEntries(rec, n) {
    return Object.entries(rec || {}).sort((a, b) => b[1] - a[1]).slice(0, n);
  }

  // The viz is served from the repo while the server is a long-running service,
  // so the panel routinely runs a build ahead of the API. An ephemeral row from
  // a PRE-GATE-L-A server carries no aggregate, and `${undefined}` renders the
  // literal "undefined" — worse than the missing evidence it replaces. The
  // `by_*`/`first_write` fields already degrade to '—' via topEntries/fmtAge;
  // this is the same courtesy for the counts.
  function countOrDash(n) {
    return typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString() : '—';
  }

  // Scope literals keep their true casing inside .radyn-btn labels. The
  // button's uppercase transform (styles.css, the editable layer) rendered
  // "MARK PROJECT:ACME-PLATFORM-BACKUP DISTINCT" — erasing exactly the
  // distinction a *casing* cluster exists to show. A child span with
  // text-transform: none overrides the inherited transform for the scope
  // token only; the rest of the label stays Radyn-uppercase.
  function scopeLiteral(scope) {
    return el('span', { class: 'ops-scope-literal' }, scope);
  }

  // ---- State reversibility, stated AT THE POINT OF ACTION (GATE L-A) --------
  // The operator's second finding: "marking something as distinct also feels
  // dangerous." Both actions here are in fact recoverable, and that fact was
  // documented everywhere except next to the button. One helper, so the two
  // sentences have one spelling wherever their buttons appear.
  const REVERSIBILITY = {
    archive: 'archived, not deleted — every row is snapshotted first and can be rolled back by id',
    mark_distinct: 'labels the scope as real; touches no memories; a later merge ruling supersedes it',
    // The ephemeral variant is honest about the second consequence: a
    // mark-distinct ruling ENDS the scope's discovery hold (T76 §5.3), so its
    // held observations stop being held forever. Cluster variants are never
    // ephemeral-shaped, so they keep the shorter sentence.
    mark_distinct_ephemeral: 'labels the scope as real and ends its discovery hold — held observations return to the normal clock; touches no memories; a later merge ruling supersedes it',
    alias: 'writes an alias entry — new writes land on the target; existing rows stay put until the migration command (in the follow-ups) is run',
    // Re-scoping an UNRULED ephemeral scope is also the hold release (T76
    // §5.3): the alias entry is what ends the hold, so the consequence rides
    // the same sentence. Ruled rows use the plain `alias` line — their hold
    // was already released by mark_distinct.
    alias_ephemeral: 'writes an alias entry and ends this scope\'s discovery hold — new writes land on the target; existing rows stay put until the migration command (in the follow-ups) is run',
    // The reinforce is deliberate G1 behavior and surprising if unsaid
    // (SYNTHESIS §1.2f): without it, a rescued row's restored snapshot clock
    // would put it right back under the next decay pass's archive line.
    rollback: 'restores each row from its snapshot and unarchives it; deliberately REINFORCES the rescued row (bumps last_seen) so the next decay pass doesn\'t immediately re-archive it',
    // Deliberately explicit that deferring does NOT clean the metric: the
    // §1.2a watchdog rule is only real if the operator can see it holds.
    defer: 'bookkeeping only — touches no memories and makes no ruling; the cluster leaves "actionable" but its rows still count in rows-adrift, so the drift metric can\'t be silenced by deferring',
    undefer: 'clears the deferral and returns the cluster to the actionable list',
  };

  // A button and the one-line consequence of pressing it, as a single column so
  // the hint cannot be read against the wrong button in a wrapped action row.
  function actionWithHint(btn, kind) {
    return el('div', { class: 'ops-drift-action' },
      btn,
      el('div', { class: 'ops-drift-reversibility' }, REVERSIBILITY[kind]));
  }

  // ---- Peek: a few real memories from the scope (GATE L-A) ------------------
  // The panel described scopes entirely in aggregates — no row anywhere showed a
  // line of actual memory content, so "archive project:wf_a1b2c3" was a decision
  // about an opaque token. Peek is READ-ONLY (a public GET, no key) and
  // COLLAPSED by default, so a resting panel costs nothing and the 10s poll
  // fetches nothing.
  //
  // Two pieces of state, both keyed by scope (a scope appears in at most one
  // cluster OR the ephemeral list, never both, so the key is unique):
  //   peekCache — the fetched result, so re-opening never refetches;
  //   peekOpen  — which peeks are expanded, so a poll's re-render RESTORES them.
  // Restoring is what keeps the poll from moving the page: a peek that collapsed
  // every 10s would shrink the panel under the operator mid-read.
  const peekCache = new Map(); // scope → { rows, display, cursor, hasMore, loading?, moreError? } | { error: string }
  const peekOpen = new Set();  // scopes whose peek is currently expanded
  // The variant's own active-row count, so the peek can say "showing 5 of 19"
  // (item 3, theme D). Fed by renderDriftVariant; undefined on a pre-GATE-L-A
  // server, in which case the label degrades to a bare "showing 5".
  const peekTotals = new Map();
  const PEEK_EXCERPT = 320;
  const PEEK_PAGE = 5;        // rows shown on first open
  const PEEK_PAGE_MORE = 20;  // rows added per "show more" click
  // Server page size. Larger than the display page because the list endpoint's
  // scope match is CASE-INSENSITIVE (COLLATE NOCASE) while drift evidence is
  // exact-string — peeked pages are filtered to the exact spelling below, and
  // in a casing cluster a page can be mostly case-twin rows. Cheap: lite rows
  // carry no embedding.
  const PEEK_FETCH = 100;

  function peekExcerpt(content) {
    const t = String(content == null ? '' : content).replace(/\s+/g, ' ').trim();
    if (t === '') return '(empty content)';
    if (t.length <= PEEK_EXCERPT) return t;
    // Cut at a word boundary so a path is dropped whole rather than sliced
    // mid-token (theme D: a truncated path reads as a DIFFERENT path). Only
    // back off when a boundary exists in the tail of the window — a single
    // enormous token still truncates hard.
    let cut = t.slice(0, PEEK_EXCERPT);
    const sp = cut.lastIndexOf(' ');
    if (sp > PEEK_EXCERPT * 0.6) cut = cut.slice(0, sp);
    return cut + '…';
  }

  function peekBodyFor(scope) {
    return document.querySelector(`[data-peek-body="${scope.replace(/"/g, '\\"')}"]`);
  }

  // Text nodes only, via el() — the corpus holds arbitrary operator and
  // tool-captured text, so nothing here may ever reach innerHTML.
  function renderPeekBody(scope, body) {
    clear(body);
    const cached = peekCache.get(scope);
    if (!cached) {
      body.append(el('div', { class: 'ops-drift-peek-status' }, 'reading…'));
      return;
    }
    if (cached.error) {
      body.append(el('div', { class: 'ops-drift-peek-status ops-drift-peek-err' }, cached.error));
      return;
    }
    // "None" is only true once paging is exhausted — a first page can filter to
    // zero exact-spelling rows while the case-twin's pages still hold more.
    if (cached.rows.length === 0 && !cached.hasMore) {
      body.append(el('div', { class: 'ops-drift-peek-status' }, 'no active memories on this scope'));
      return;
    }
    const shownRows = cached.rows.slice(0, cached.display);
    for (const m of shownRows) {
      body.append(el('div', { class: 'ops-drift-peek-row' },
        el('div', { class: 'ops-drift-peek-meta' },
          el('span', null, `#${m.id}`),
          el('span', null, m.type || '—'),
          el('span', null, m.source || '—'),
          el('span', null, fmtAge(m.created_at))
        ),
        el('div', { class: 'ops-drift-peek-content' }, peekExcerpt(m.content))
      ));
    }
    // Item 3 (theme D): "5 of N shown" plus a way to reach the rest. N is the
    // drift report's active count for the scope — exact-string, the same
    // predicate the row filter above uses, so the two agree by construction
    // (modulo a refresh race, where the fully-fetched row count wins).
    const total = peekTotals.get(scope);
    const denom = !cached.hasMore && Number.isFinite(total) && cached.rows.length > total
      ? cached.rows.length
      : total;
    const label = Number.isFinite(denom)
      ? `showing ${shownRows.length} of ${denom.toLocaleString()}`
      : `showing ${shownRows.length}`;
    body.append(el('div', { class: 'ops-drift-peek-status' }, label));
    if (cached.moreError) {
      body.append(el('div', { class: 'ops-drift-peek-status ops-drift-peek-err' }, cached.moreError));
    }
    // Exhausted means no further exact-spelling rows can exist: either the
    // server pages ran out, or the cache already holds the drift report's
    // whole exact count — without the second clause the button would linger
    // over nothing but case-twin pages and every click would fetch in vain.
    const exhausted = !cached.hasMore
      || (Number.isFinite(total) && cached.rows.length >= total);
    if (cached.rows.length > cached.display || !exhausted) {
      const more = el('button', { class: 'replay-btn radyn-btn ops-drift-peek-btn' },
        cached.loading ? 'loading…' : `show ${PEEK_PAGE_MORE} more`);
      more.disabled = !!cached.loading;
      more.addEventListener('click', () => loadPeekMore(scope, body));
      body.append(more);
    }
  }

  // The exact-spelling filter (see PEEK_FETCH). A peeked variant must show ITS
  // rows — in a casing cluster the case-twin's rows under every variant would
  // make the variants indistinguishable, defeating the evidence purpose.
  function peekFilter(scope, data) {
    return (Array.isArray(data) ? data : []).filter(m => m && m.scope === scope);
  }

  // Fail-soft by construction: every failure lands in the cache as an `error`
  // string and renders as an inline line. Nothing here throws, and nothing here
  // mutates — it is a GET.
  //
  // `body` is the caller's own node and is ALWAYS the render fallback. On the
  // re-render-restore path that node is not attached yet (the row is appended
  // after it is built), so a document query would miss it and the restored peek
  // would paint blank — the bug this signature exists to prevent.
  // In-flight scopes. `peekCache.has()` alone can't dedupe: it isn't
  // populated until the fetch RESOLVES, so every re-render during a slow peek
  // launched another identical GET with last-one-wins semantics. That raced
  // at most once per 10s poll before the filter made re-renders per-keystroke
  // (review F3).
  const peekInFlight = new Set();

  async function loadPeek(scope, body) {
    if (peekInFlight.has(scope)) return; // the pending fetch will render
    if (!peekCache.has(scope)) {
      peekInFlight.add(scope);
      renderPeekBody(scope, body); // 'reading…'
      try {
        const r = await fetch(
          `/api/memories?scope=${encodeURIComponent(scope)}&limit=${PEEK_FETCH}&fields=lite`,
          { cache: 'no-store' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        // hasMore requires a numeric cursor — a server that says "more" without
        // one can't be paged, and `cursor=undefined` would 400 at the Zod coerce.
        peekCache.set(scope, {
          rows: peekFilter(scope, j.data),
          display: PEEK_PAGE,
          cursor: j.meta && j.meta.cursor,
          hasMore: !!(j.meta && j.meta.has_more && typeof j.meta.cursor === 'number'),
        });
      } catch (err) {
        peekCache.set(scope, { error: `could not read this scope: ${err.message}` });
      } finally {
        peekInFlight.delete(scope);
      }
    }
    // Collapsed while the fetch was in flight — stay collapsed.
    if (!peekOpen.has(scope)) return;
    // Prefer the LIVE body: a poll may have rebuilt the row mid-fetch, leaving
    // `body` detached. Fall back to `body` when the query misses (first render).
    renderPeekBody(scope, peekBodyFor(scope) || body);
  }

  // Grows the display window, fetching further server pages (same public GET,
  // cursor from the last page) only while the filtered cache can't cover it —
  // bounded per click, so one click is at most a few requests even when the
  // exact spelling is buried under a large case-twin. Fetched rows accumulate
  // in the cache, so a poll re-render repaints the full expanded set and
  // "show more" never refetches what is already shown. A page failure lands
  // as an inline line (moreError) with the button still live; the next
  // successful page clears it.
  async function loadPeekMore(scope, body) {
    const cached = peekCache.get(scope);
    if (!cached || cached.error || cached.loading) return;
    if (cached.rows.length <= cached.display && !cached.hasMore) return;
    cached.loading = true;
    cached.display += PEEK_PAGE_MORE;
    renderPeekBody(scope, peekBodyFor(scope) || body); // repaint the disabled button
    try {
      let fetches = 0;
      while (cached.rows.length < cached.display && cached.hasMore && fetches < 3) {
        fetches++;
        const r = await fetch(
          `/api/memories?scope=${encodeURIComponent(scope)}&limit=${PEEK_FETCH}&fields=lite&cursor=${encodeURIComponent(cached.cursor)}`,
          { cache: 'no-store' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        cached.rows.push(...peekFilter(scope, j.data));
        cached.cursor = j.meta && j.meta.cursor;
        cached.hasMore = !!(j.meta && j.meta.has_more && typeof cached.cursor === 'number');
      }
      cached.moreError = null;
    } catch (err) {
      cached.moreError = `could not read more: ${err.message}`;
    } finally {
      cached.loading = false;
    }
    if (!peekOpen.has(scope)) return;
    renderPeekBody(scope, peekBodyFor(scope) || body);
  }

  function renderPeekControl(scope) {
    const body = el('div', { class: 'ops-drift-peek-body', dataset: { peekBody: scope } });
    const btn = el('button', { class: 'replay-btn radyn-btn ops-drift-peek-btn' });
    const sync = () => {
      const open = peekOpen.has(scope);
      btn.textContent = open ? 'hide contents' : 'peek contents';
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      body.hidden = !open;
    };
    btn.addEventListener('click', () => {
      if (peekOpen.has(scope)) {
        peekOpen.delete(scope);
        clear(body);
        sync();
        return;
      }
      peekOpen.add(scope);
      sync();
      loadPeek(scope, body);
    });
    sync();
    // Re-render restore. A cache hit paints synchronously here, which is what
    // keeps an open peek the same height across a poll — the panel must not
    // shrink and re-grow under an operator mid-read.
    if (peekOpen.has(scope)) loadPeek(scope, body);
    return el('div', { class: 'ops-drift-peek' }, btn, body);
  }

  // ---- Triage line at rest (item 11, theme J) -------------------------------
  // The four facts that decide "junk or real work?", on ONE line, before any
  // action is taken. They were previously spread across by_type / by_source /
  // two date fields — and `anchored`, the most decisive of them, existed only
  // AFTER running an archive dry-run, which is the wrong order: it is an input
  // to the decision, not a result of acting on it.
  //
  // `origin` is deliberately "auto-discovery vs everything else", not "human":
  // `source` records the WRITE PATH (auto-discovery / mcp / claude-code / …),
  // and only the auto-discovery bucket is machine-generated with certainty.
  // Calling the remainder "human" would assert more than the data supports.
  const AUTO_SOURCE = 'auto-discovery';

  function renderTriageLine(v, opts) {
    // `archivable` gates the archive-framed wording and the warning colour to
    // rows that actually offer an archive (review F4). A cluster variant's
    // only actions are merge_into / mark_distinct, and the Hard Anchor
    // constrains neither — an alias entry moves nothing and refuses nothing —
    // so warning-colouring every operator-confirmed variant was alarm noise on
    // the exact decision this line exists to speed up.
    const archivable = !!(opts && opts.archivable);
    const active = typeof v.active === 'number' ? v.active : null;
    // ACTIVE-only source counts (review F3): mixing all-row `by_source` with
    // the active-only `active` compared two different populations and could
    // report 0 operator-written rows while live ones sat there. Falls back to
    // the all-row map on a server that predates by_source_active.
    const sources = v.by_source_active || v.by_source || {};
    const auto = Math.min(sources[AUTO_SOURCE] || 0, active ?? Infinity);
    const parts = [];
    if (active === null) {
      parts.push('— no aggregate from this server');
    } else {
      const other = Math.max(0, active - auto);
      parts.push(`${auto.toLocaleString()} auto-discovery`);
      parts.push(`${other.toLocaleString()} other-source`);
      parts.push(typeof v.anchored === 'number'
        ? `${v.anchored.toLocaleString()} anchored`
        : 'anchored —');
    }
    // fmtAge yields "66d ago"; "idle 66d ago" reads as two time phrases.
    parts.push(v.last_write ? `idle ${fmtAge(v.last_write).replace(/\s*ago$/, '')}` : 'idle —');
    let text = parts.join(' · ');
    // The case worth spelling out rather than leaving as arithmetic: every
    // active row is anchored, so the archive button below will refuse ALL of
    // them. Discovering that from a dry-run is precisely the ordering theme J
    // objected to — but only say it where an archive is actually on offer.
    if (archivable && active !== null && active > 0 && v.anchored === active) {
      text += ' — an archive would refuse every row';
    }
    const line = el('div', { class: 'ops-drift-triage' }, text);
    line.setAttribute('title',
      'auto-discovery = rows written by the discovery engine; other-source = every other write path '
      + '(mcp, claude-code, …), which is operator-initiated but not proof of a human author. '
      + 'anchored = ACTIVE rows the Hard Anchor protects'
      + (archivable
        ? ' — an archive refuses exactly these.'
        : ' (this row offers no archive; anchoring does not constrain a merge or a distinct ruling).')
      + ' idle = age of the most recent write.');
    if (archivable && typeof v.anchored === 'number' && v.anchored > 0) {
      line.classList.add('ops-drift-triage--anchored');
    }
    return line;
  }

  /**
   * THE evidence renderer — one spelling, both row kinds (GATE L-A).
   *
   * Ephemeral rows used to hand-roll their own head and show no evidence at
   * all, which is how the rows carrying the destructive action ended up with
   * the least context. They now render through here; `opts` carries only what
   * genuinely differs (the container/head classes, the ephemeral count + reason
   * pills, the cluster-only canonical/favored badges), while the evidence block
   * and the peek control are shared by construction.
   */
  function renderDriftVariant(v, opts) {
    const o = opts || {};
    const row = el('div', { class: o.rowClass || 'ops-drift-variant' });
    row.append(el('div', { class: o.headClass || 'ops-drift-variant-head' },
      el('span', { class: 'ops-drift-variant-scope' }, v.scope),
      o.isCanonical ? el('span', { class: 'radyn-pill radyn-pill--success' }, 'canonical') : null,
      o.countPill ? el('span', { class: 'radyn-pill' }, `${v.count} rows`) : null,
      o.reason ? el('span', { class: 'ops-drift-reason' }, o.reason) : null,
      v.aliased_to ? el('span', { class: 'radyn-pill' }, `→ ${v.aliased_to}`) : null,
      v.ruled_distinct ? el('span', { class: 'radyn-pill' }, 'ruled distinct') : null,
      // Deferral is LABELLED, never hidden (§1.2a): the row stays in the
      // report with its evidence, carrying the operator's own reason.
      v.deferred_at ? el('span', { class: 'radyn-pill radyn-pill--warning' },
        v.deferred_note ? `deferred — ${v.deferred_note}` : 'deferred') : null,
      o.favored ? el('span', { class: 'radyn-pill radyn-pill--info' }, 'evidence favors this target') : null
    ));
    row.append(renderTriageLine(v, { archivable: !!o.archivable }));
    row.append(el('dl', { class: 'ops-kv' },
      el('dt', null, 'active / archived'), el('dd', null, `${countOrDash(v.active)} / ${countOrDash(v.archived)}`),
      el('dt', null, 'by type'), el('dd', null, topEntries(v.by_type, 3).map(([k, n]) => `${k}:${n}`).join(', ') || '—'),
      el('dt', null, 'by source'), el('dd', null, topEntries(v.by_source, 3).map(([k, n]) => `${k}:${n}`).join(', ') || '—'),
      el('dt', null, 'first write'), el('dd', null, fmtAge(v.first_write)),
      el('dt', null, 'last write'), el('dd', null, fmtAge(v.last_write))
    ));
    // The peek's "showing X of N" denominator: active rows, the population the
    // list endpoint pages. Undefined on a pre-aggregate server — the label
    // degrades rather than lying.
    peekTotals.set(v.scope, v.active);
    row.append(renderPeekControl(v.scope));
    return row;
  }

  // ---- Where an outcome renders (GATE L-A, two live findings) ----------------
  // Round 2 moved every archive/ruling outcome to the persistent #ops-drift-msg
  // area at the TOP of the card so the 10s poll could not wipe a confirm button
  // mid-decision. That was right about the poll and wrong about the place: the
  // buttons sit rows deep in a 70+ row list, so the outcome rendered ~900px
  // offscreen and the click read as "nothing happened". Scrolling to it was
  // worse — the panel yanked the view out from under the operator.
  //
  // So the outcome is PINNED to the row it came from: rendered into that row's
  // host element, and re-attached after every re-render (the same node objects
  // move into the freshly built row), which is what makes it survive the poll
  // without moving the page at all. One outcome at a time — the operator is
  // doing one thing — and it is dismissible.
  //
  // The one case that still scrolls: the host row is GONE (a fully-drained
  // scope leaves the ephemeral list, taking its anchor with it). Then the
  // outcome — which carries the archived ids, i.e. the only undo enumeration —
  // falls back to the top area and pulls the view to it. Nothing is yanked out
  // from under the operator there, because the thing they were looking at no
  // longer exists.
  let pinnedOutcome = null; // { key: string, nodes: Node[] }

  function outcomeHostFor(key) {
    return document.querySelector(`[data-outcome-host="${key.replace(/"/g, '\\"')}"]`);
  }

  function attachPinnedOutcome({ scrollIfOrphaned = false } = {}) {
    if (!pinnedOutcome) return;
    const msg = document.getElementById('ops-drift-msg');
    const host = outcomeHostFor(pinnedOutcome.key);
    if (host) {
      if (msg) clear(msg);
      clear(host);
      for (const n of pinnedOutcome.nodes) host.append(n);
      return;
    }
    if (!msg) return;
    clear(msg);
    for (const n of pinnedOutcome.nodes) msg.append(n);
    if (scrollIfOrphaned) msg.scrollIntoView({ block: 'nearest' });
  }

  function pinOutcome(key, nodes) {
    const dismiss = el('button', { class: 'replay-btn radyn-btn ops-drift-dismiss' }, 'dismiss');
    dismiss.addEventListener('click', () => {
      pinnedOutcome = null;
      const host = outcomeHostFor(key);
      if (host) clear(host);
      const msg = document.getElementById('ops-drift-msg');
      if (msg) clear(msg);
    });
    pinnedOutcome = { key, nodes: [...nodes, dismiss] };
    attachPinnedOutcome({ scrollIfOrphaned: true });
  }

  // ---- Change ruling (item 8, theme K) --------------------------------------
  // mark_distinct's hint promises "a later merge ruling supersedes it", but a
  // ruled row used to lose every action — the stated undo was unreachable. A
  // ruled row now keeps ONE action: a collapsed "change ruling" disclosure
  // whose merge buttons post the superseding merge_into (the server clears
  // ruled_distinct_at when the alias entry lands — this IS the documented
  // undo, not a second mechanism). L-1 holds: everything sits behind the
  // disclosure, no direction pre-selected. Open state + any typed target
  // survive the 10s poll's row rebuild the same way peekOpen does.
  const changeRulingOpen = new Set();   // scopes whose disclosure is expanded
  const changeRulingTarget = new Map(); // scope → typed merge target (ephemeral rows)
  const deferNoteDraft = new Map();     // scope → in-progress deferral note (survives the poll)

  // ---- Defer / undefer control (blocker 4) ---------------------------------
  // One control, both row kinds. A deferred variant shows "undefer"; an
  // undeferred one shows a note field + "defer". The note is the operator's
  // own reason and is what the pill displays, so the panel answers "why is
  // this still here?" without a second lookup.
  function renderDeferControl(v, hostKey) {
    if (v.deferred_at) {
      const btn = el('button', { class: 'replay-btn radyn-btn' }, 'undefer ', scopeLiteral(v.scope));
      btn.addEventListener('click', () => deferScope(v.scope, 'undefer', null, btn, hostKey));
      return actionWithHint(btn, 'undefer');
    }
    const input = el('input', {
      class: 'ops-drift-target-input', type: 'text', maxlength: '500',
      placeholder: 'why defer? (optional note)', value: deferNoteDraft.get(v.scope) || '',
      dataset: { targetInput: `defer:${v.scope}` },
    });
    input.addEventListener('input', () => deferNoteDraft.set(v.scope, input.value));
    const btn = el('button', { class: 'replay-btn radyn-btn' }, 'defer ', scopeLiteral(v.scope));
    btn.addEventListener('click', () => deferScope(v.scope, 'defer', input.value.trim(), btn, hostKey));
    return el('div', { class: 'ops-drift-defer' }, input, actionWithHint(btn, 'defer'));
  }

  function changeRulingShell(scope, body, labelKids, onOpen) {
    body.hidden = !changeRulingOpen.has(scope);
    const toggle = el('button', { class: 'replay-btn radyn-btn' }, labelKids);
    const sync = () => toggle.setAttribute('aria-expanded', body.hidden ? 'false' : 'true');
    toggle.addEventListener('click', () => {
      if (changeRulingOpen.has(scope)) changeRulingOpen.delete(scope);
      else {
        changeRulingOpen.add(scope);
        if (onOpen) onOpen();
      }
      body.hidden = !changeRulingOpen.has(scope);
      sync();
    });
    sync();
    return el('div', { class: 'ops-drift-change-ruling' }, toggle, body);
  }

  // Cluster variant: the merge targets are the cluster's own un-aliased members.
  function renderChangeRuling(scope, targetScopes, hostKey) {
    const body = el('div', { class: 'ops-drift-change-ruling-body' });
    for (const target of targetScopes) {
      const btn = el('button', { class: 'replay-btn radyn-btn' },
        'merge ', scopeLiteral(scope), ' into ', scopeLiteral(target));
      btn.addEventListener('click', () => mergeScopeInto(scope, target, btn, hostKey));
      body.append(actionWithHint(btn, 'alias'));
    }
    return changeRulingShell(scope, body, ['change ruling for ', scopeLiteral(scope)]);
  }

  // ---- Re-scope: merge into…, seeded from the peeked content (blocker 1) ----
  // Theme A, all three reviewers: given the same peeked contents they each
  // concluded the memories were MISROUTED, not junk — and the ephemeral row
  // offered only archive-or-keep. "Merge into…" is the missing verb, and it is
  // server-complete: the alias entry redirects new writes, the follow-up
  // migration command moves the rows, and on an unruled ephemeral scope the
  // entry is ALSO the hold release (T76 §5.3) — resolving the hidden
  // held-observation consequence by construction (SYNTHESIS §1.2e).

  // The known-scope inventory (GET /api/stats by_scope), cached 5 min — it
  // backs seed ranking only, so staleness is cosmetic. Failure caches empty
  // for 1 min: seeds degrade to explicit tokens, the picker still works.
  let scopeInventory = null;        // { at, entries: [scope, count][] }
  let scopeInventoryPromise = null; // in-flight dedup: a poll restoring several
                                    // open pickers must not fan out N stats calls
  async function loadScopeInventory() {
    const ttl = scopeInventory && scopeInventory.entries.length > 0 ? 300000 : 60000;
    if (scopeInventory && Date.now() - scopeInventory.at < ttl) return scopeInventory.entries;
    if (scopeInventoryPromise) return scopeInventoryPromise;
    scopeInventoryPromise = (async () => {
      try {
        const stats = await fetchStats();
        scopeInventory = { at: Date.now(), entries: Object.entries(stats.by_scope || {}) };
      } catch (err) {
        scopeInventory = { at: Date.now(), entries: [] };
      } finally {
        scopeInventoryPromise = null;
      }
      return scopeInventory.entries;
    })();
    return scopeInventoryPromise;
  }

  // Left boundary + captured token so "myproject:alpha" can't seed
  // "project:alpha"; trailing ._- are trimmed after the match so a
  // sentence-final "…in project:acme." doesn't mint a one-click merge button
  // into the nonexistent "project:acme." (isScopeForm accepts any non-empty
  // remainder, so the server would have taken the ruling).
  const SCOPE_TOKEN_RE = /(^|[^A-Za-z0-9._-])((?:project|client):[A-Za-z0-9][A-Za-z0-9._-]*)/g;
  const MERGE_SEED_CAP = 6;

  // "Scopes named in the peeked content": explicit scope tokens outrank known
  // scopes whose bare name appears in the text; among name matches, bigger
  // scopes rank higher (a likelier home). Pure — no I/O. Precision rules,
  // earned across the first live walk + review: boundary-safe token matching,
  // numeric-only names never seed (a date fragment is not a project — this
  // also covers the project:2026-from-"20260630_…" case), and case-twins
  // collapse to the better-scoring spelling. Deliberately NO self-echo rule:
  // for a "<datestamp>_<realname>" ephemeral scope, the name inside the
  // source's own name is often exactly the right target (review F3), and a
  // case-twin or cross-prefix twin of the source is a legitimate ruling.
  function seedsFromContent(scope, rows, inventory) {
    const text = rows.map(m => String((m && m.content) || '')).join('\n');
    if (!text) return [];
    const seeds = new Map();
    for (const m of text.matchAll(SCOPE_TOKEN_RE)) {
      const t = m[2].replace(/[._-]+$/, '');
      if (t && t !== scope && !/^(?:project|client):$/.test(t)) {
        seeds.set(t, (seeds.get(t) || 0) + 100);
      }
    }
    const lower = text.toLowerCase();
    for (const [known, count] of inventory) {
      if (known === scope || known === 'global') continue;
      const bare = known.slice(known.indexOf(':') + 1);
      // Short names ("api", "web") match everything — require ≥4 chars so a
      // seed means the NAME was plausibly written, not a syllable.
      if (bare.length < 4) continue;
      const bareLower = bare.toLowerCase();
      if (/^[0-9]+$/.test(bareLower)) continue;
      const esc = bareLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (!new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`).test(lower)) continue;
      seeds.set(known, (seeds.get(known) || 0) + 1 + Math.min(count, 1000) / 1000);
    }
    const byFold = new Map(); // lowercased scope → [scope, score]
    for (const [t, score] of seeds) {
      const key = t.toLowerCase();
      const prev = byFold.get(key);
      if (!prev || score > prev[1]) byFold.set(key, [t, score]);
    }
    return [...byFold.values()].sort((a, b) => b[1] - a[1])
      .slice(0, MERGE_SEED_CAP).map(([t]) => t);
  }

  // Ephemeral row: a disclosure with evidence-seeded target buttons plus the
  // free-text input for targets the content doesn't name. The server is the
  // validator (scope form, chains, generic capture) and a refusal renders as
  // the 400's own message via the standard ruling outcome. L-1 holds: the
  // picker is collapsed, seeds are buttons, nothing is pre-selected.
  function renderMergeInto(scope, hostKey, opts) {
    const o = opts || {};
    const hintKind = o.hintKind || 'alias';
    const seedArea = el('div', { class: 'ops-drift-merge-seeds' });
    const paintSeeds = (targets) => {
      clear(seedArea);
      if (targets === null) {
        seedArea.append(el('div', { class: 'ops-drift-peek-status' }, 'reading this scope\'s contents for likely targets…'));
        return;
      }
      if (targets.length === 0) {
        seedArea.append(el('div', { class: 'ops-drift-peek-status' },
          'no target named in this scope\'s contents — type one below'));
        return;
      }
      seedArea.append(el('div', { class: 'ops-drift-peek-status' }, 'targets named in this scope\'s contents:'));
      for (const target of targets) {
        const btn = el('button', { class: 'replay-btn radyn-btn' },
          'merge ', scopeLiteral(scope), ' into ', scopeLiteral(target));
        btn.addEventListener('click', () => mergeScopeInto(scope, target, btn, hostKey));
        seedArea.append(actionWithHint(btn, hintKind));
      }
    };
    const fillSeeds = async () => {
      const cached = peekCache.get(scope);
      const needPeek = !cached || cached.error;
      if (needPeek) {
        paintSeeds(null);
        // A cached {error} would make loadPeek a no-op (it never refetches a
        // populated entry) — drop it so opening the picker RETRIES the read
        // instead of silently claiming "no target named" (review F2).
        if (cached && cached.error) peekCache.delete(scope);
      }
      // Independent fetches — pay one latency, not two (review F5). The
      // throwaway node satisfies loadPeek's render fallback; the peek itself
      // stays closed unless the operator opened it.
      const [inventory] = await Promise.all([
        loadScopeInventory(),
        needPeek ? loadPeek(scope, document.createElement('div')) : Promise.resolve(),
      ]);
      const after = peekCache.get(scope);
      if (!after || after.error) {
        clear(seedArea);
        seedArea.append(el('div', { class: 'ops-drift-peek-status ops-drift-peek-err' },
          `${(after && after.error) || 'could not read this scope'} — seeds unavailable, type a target below`));
        return;
      }
      // Memoized per (row-count, inventory age): the poll rebuilds open
      // pickers every 10s, and the O(inventory × text) scan must not re-run
      // when nothing it reads has changed (review F4).
      const memoKey = `${after.rows.length}|${scopeInventory ? scopeInventory.at : 0}`;
      if (!after.seedsMemo || after.seedsMemo.key !== memoKey) {
        after.seedsMemo = { key: memoKey, seeds: seedsFromContent(scope, after.rows, inventory) };
      }
      paintSeeds(after.seedsMemo.seeds);
    };

    const body = el('div', { class: 'ops-drift-change-ruling-body' });
    const input = el('input', {
      class: 'ops-drift-target-input', type: 'text',
      placeholder: 'client:… or project:…', value: changeRulingTarget.get(scope) || '',
      dataset: { targetInput: scope },
    });
    input.addEventListener('input', () => changeRulingTarget.set(scope, input.value));
    const btn = el('button', { class: 'replay-btn radyn-btn' }, 'merge ', scopeLiteral(scope), ' into target');
    btn.addEventListener('click', () => {
      const target = input.value.trim();
      if (!target) return;
      mergeScopeInto(scope, target, btn, hostKey);
    });
    body.append(seedArea, input, actionWithHint(btn, hintKind));

    const shell = changeRulingShell(scope, body,
      o.toggleLabel || ['change ruling for ', scopeLiteral(scope)], fillSeeds);
    // Re-render restore (the peekOpen pattern): an open picker refills from
    // caches, so a poll rebuild repaints seeds without a visible reload.
    if (changeRulingOpen.has(scope)) fillSeeds();
    return shell;
  }

  function renderDriftCluster(cluster) {
    const card = el('div', { class: 'ops-drift-cluster' });
    const head = el('div', { class: 'ops-drift-cluster-head' },
      el('span', { class: 'radyn-pill' + (cluster.kind === 'cross_prefix' ? ' radyn-pill--warning' : '') }, cluster.kind),
      el('span', { class: 'ops-drift-cluster-key' }, cluster.key),
      cluster.active_rows_adrift > 0 ? el('span', { class: 'radyn-pill radyn-pill--error' }, `${cluster.active_rows_adrift} rows adrift`) : null,
      cluster.covered ? el('span', { class: 'radyn-pill radyn-pill--success' }, 'covered') : null,
      clusterRuledDistinct(cluster) ? el('span', { class: 'radyn-pill' }, 'ruled distinct') : null,
      cluster.deferred ? el('span', { class: 'radyn-pill radyn-pill--warning' }, 'deferred') : null
    );
    card.append(head);

    // Evidence hint (cross_prefix only, L-1: a label, never a selection): a
    // project:-side variant reading ≥90% auto-discovery in by_source badges
    // every OTHER variant EXCEPT another ≥90%-auto-discovery project:-side
    // variant — the badge belongs on plausible real-entity targets only.
    const favoredScopes = new Set();
    if (cluster.kind === 'cross_prefix') {
      const discoveryHeavy = new Set();
      for (const v of cluster.variants) {
        if (!v.scope.startsWith('project:') || !v.total) continue;
        const auto = (v.by_source && v.by_source['auto-discovery']) || 0;
        if (auto / v.total >= 0.9) discoveryHeavy.add(v.scope);
      }
      if (discoveryHeavy.size > 0) {
        for (const v of cluster.variants) if (!discoveryHeavy.has(v.scope)) favoredScopes.add(v.scope);
      }
    }

    for (const v of cluster.variants) {
      card.append(renderDriftVariant(v, {
        isCanonical: cluster.kind === 'casing' && v.scope === cluster.canonical,
        favored: favoredScopes.has(v.scope),
      }));
    }

    const actions = el('div', { class: 'review-actions ops-drift-actions' });
    // Deferred clusters keep their full action set (review F4): the server
    // supports merge_into / mark_distinct on a deferred scope directly and
    // clears the deferral as part of the ruling, so gating the buttons on
    // !deferred would force an undefer-per-variant detour to reach the
    // one-step path the defer response itself documents.
    if (!cluster.covered && !clusterRuledDistinct(cluster)) {
      // A ruled-distinct variant is never a merge SOURCE (mergeSources
      // excludes it — aliasing it away would undo the ruling) and never
      // re-offered for marking. It IS a valid merge TARGET: merge_into clears
      // ruled_distinct_at on the SOURCE scope only, so folding variants into
      // the ruled spelling is the mark-distinct-then-consolidate workflow,
      // not an undo (review F2).
      //
      // Direction choice for BOTH cluster kinds (blocker 5, theme I; §1.2c):
      // every un-aliased member is offered as a merge target — the
      // slug-canonical labelled but never privileged — so the operator can
      // make the 1,168-row spelling win by aliasing the canonical INTO it.
      // This deliberately routes through merge_into, NOT registry `rename`:
      // rename re-keys claimant identity and tombstones the freed scope — a
      // different concept from drift's display-proposal canonical. The rule
      // endpoint validates the resulting table (chains, generic capture ⇒
      // a 400 the panel renders), so the guard rail is server-side. L-1
      // holds: every direction is a button, nothing pre-selected.
      const dependents = new Set(cluster.variants.map(v => v.aliased_to).filter(Boolean));
      let suppressedChained = false;
      for (const target of cluster.variants.filter(v => v.aliased_to === null)) {
        // Emptiness guard: with two uncovered members and one of them ruled,
        // the only offered target has nothing left to merge into it, and the
        // click would send no request at all.
        const sources = mergeSources(cluster, target.scope);
        if (sources.length === 0) continue;
        // A source that other members already alias INTO is a canonical VALUE
        // in the table — merging it elsewhere would form a chain the server
        // refuses, so the button would 400 on its first request (review F1).
        // Redirecting a covered cluster is a per-variant re-ruling, not a
        // bulk button.
        if (sources.some(s => dependents.has(s.scope))) {
          suppressedChained = true;
          continue;
        }
        const btn = el('button', { class: 'replay-btn radyn-btn' },
          `merge ${sources.length} variant${sources.length === 1 ? '' : 's'} into `,
          scopeLiteral(target.scope),
          cluster.kind === 'casing' && target.scope === cluster.canonical ? ' (canonical)' : null);
        btn.addEventListener('click', () => approveAlias(cluster, target.scope, btn, `cluster:${cluster.key}`));
        actions.append(actionWithHint(btn, 'alias'));
      }
      if (suppressedChained) {
        actions.append(el('div', { class: 'ops-hint' },
          'some merge directions are unavailable: a member already carries aliases into it, and moving it would chain — re-rule the aliased members individually before redirecting'));
      }
      // Mark distinct — one scope per click, no bulk (Step 4). The canonical
      // spelling itself is excluded: marking it distinct is a no-op mutation
      // (cluster.canonical is null for cross_prefix, so this is a no-op filter there).
      for (const v of cluster.variants.filter(v =>
        v.aliased_to === null && v.scope !== cluster.canonical && !v.ruled_distinct
      )) {
        const btn = el('button', { class: 'replay-btn radyn-btn' }, 'mark ', scopeLiteral(v.scope), ' distinct');
        btn.addEventListener('click', () => markDistinct(v.scope, btn, `cluster:${cluster.key}`));
        actions.append(actionWithHint(btn, 'mark_distinct'));
      }
      // Defer/undefer per un-aliased, un-ruled variant — the third answer
      // beside "merge it" and "it's distinct": "not now" (blocker 4). The
      // canonical is excluded for the same reason the mark-distinct loop
      // excludes it: drift's cluster arithmetic ignores the canonical, so
      // deferring it would flip no aggregate while permanently minting a
      // registry row for a spelling that may hold no rows at all.
      for (const v of cluster.variants.filter(v =>
        v.aliased_to === null && !v.ruled_distinct && v.scope !== cluster.canonical
      )) {
        actions.append(renderDeferControl(v, `cluster:${cluster.key}`));
      }
    }
    // Ruled-distinct variants keep the change-ruling disclosure (item 8) —
    // rendered OUTSIDE the covered/all-ruled gate above, since a fully-ruled
    // cluster is exactly where every row used to go actionless. Targets are
    // the cluster's other un-aliased members (an aliased member as target
    // would chain, which the server refuses anyway).
    for (const v of cluster.variants.filter(v => v.ruled_distinct && v.aliased_to === null)) {
      const targets = cluster.variants
        .filter(t => t.scope !== v.scope && t.aliased_to === null)
        .map(t => t.scope);
      if (targets.length > 0) actions.append(renderChangeRuling(v.scope, targets, `cluster:${cluster.key}`));
    }
    if (actions.childElementCount > 0) card.append(actions);
    // The cluster's own outcome anchor — same reasoning as the ephemeral rows'
    // (see the pinnedOutcome comment): a ruling reports where it was clicked.
    card.append(el('div', {
      class: 'ops-drift-cluster-result',
      dataset: { outcomeHost: `cluster:${cluster.key}` },
    }));

    return card;
  }

  // `total` (item 12) distinguishes "the corpus has none" from "the filter
  // matched none" — the same never-silently-empty rule the cluster list gets.
  function renderDriftEphemeral(list, total) {
    const wrap = document.getElementById('ops-drift-ephemeral');
    if (!wrap) return;
    clear(wrap);
    if (!list || list.length === 0) {
      const hiddenByFilter = driftFilter && (total ?? 0) > 0;
      wrap.append(el('div', { class: 'ops-empty' },
        hiddenByFilter ? `no ephemeral scope matches "${driftFilter}"` : 'no ephemeral scopes'));
      return;
    }
    for (const e of list) {
      // Same evidence renderer the cluster variants use (GATE L-A) — the
      // ephemeral row keeps its own container/head classes, its count + reason
      // pills, and its own action set, and shares everything else.
      const row = renderDriftVariant(e, {
        rowClass: 'ops-drift-ephemeral-row',
        headClass: 'ops-drift-ephemeral-head',
        countPill: true,
        reason: e.reason,
        // Ephemeral rows are the ONLY ones offering an archive, so they are
        // the only ones whose triage line may frame anchoring as a refusal
        // (review F4). Stated explicitly rather than inferred from countPill,
        // which is about a badge and would be a silent coupling.
        archivable: true,
      });
      // Archive is hidden (not disabled) whenever the route would 400 it —
      // spec §5.4: only aliased_to === null && !ruled_distinct is eligible.
      const actions = el('div', { class: 'review-actions ops-drift-actions' });
      const archiveResult = el('div', {
        class: 'ops-drift-archive-result',
        dataset: { outcomeHost: `eph:${e.scope}` },
      });
      if (e.aliased_to === null && !e.ruled_distinct) {
        // Re-scope leads (blocker 1): it is the verb all three reviewers
        // reached for on this row, so it comes before the keep/discard pair.
        actions.append(renderMergeInto(e.scope, `eph:${e.scope}`, {
          toggleLabel: ['re-scope — merge ', scopeLiteral(e.scope), ' into…'],
          hintKind: 'alias_ephemeral',
        }));
        const distinctBtn = el('button', { class: 'replay-btn radyn-btn' }, 'mark distinct');
        distinctBtn.addEventListener('click', () => markDistinct(e.scope, distinctBtn, `eph:${e.scope}`));
        actions.append(actionWithHint(distinctBtn, 'mark_distinct_ephemeral'));
        const archiveBtn = el('button', { class: 'replay-btn radyn-btn' }, 'archive ephemeral (dry-run)');
        archiveBtn.addEventListener('click', () => archiveEphemeralDryRun(e.scope, archiveResult));
        // Deferred or not: the row keeps its full action set and the defer
        // control renders as "undefer" when deferred (review F4).
        actions.append(actionWithHint(archiveBtn, 'archive'));
        actions.append(renderDeferControl(e, `eph:${e.scope}`));
      } else if (e.aliased_to === null && e.ruled_distinct) {
        // ruled_distinct takes precedence over a stale deferral (which the
        // server now refuses to create anyway) — the change-ruling control is
        // this row's only undo and must never be displaced.
        // Item 8: the ruled row keeps its change-ruling action so the
        // mark-distinct hint's stated undo stays reachable — same picker,
        // plain alias hint (this row's hold was already released).
        actions.append(renderMergeInto(e.scope, `eph:${e.scope}`, {
          toggleLabel: ['change ruling for ', scopeLiteral(e.scope)],
          hintKind: 'alias',
        }));
      }
      if (actions.childElementCount > 0) row.append(actions, archiveResult);
      wrap.append(row);
    }
  }

  function renderRulingOutcome(hostKey, done, failure) {
    const nodes = [];
    if (done.length > 0) {
      nodes.push(el('div', { class: failure ? 'review-msg-err' : 'review-msg-ok' },
        `ruled ${done.length} scope${done.length === 1 ? '' : 's'}: ${done.map(d => d.scope).join(', ')}` +
        (failure ? ` — stopped: ${failure}` : '')));
    } else if (failure) {
      nodes.push(el('div', { class: 'review-msg-err' }, `ruling failed: ${failure}`));
    }
    const followUps = done.flatMap(d => d.followUps || []);
    if (followUps.length > 0) {
      nodes.push(el('div', { class: 'ops-hint' }, 'follow-ups (run manually — never auto-run):'));
      for (const f of followUps) nodes.push(el('div', { class: 'ops-drift-followup' }, f));
    }
    pinOutcome(hostKey || 'ops-drift-msg', nodes);
  }

  async function refreshDrift() {
    try {
      renderScopeDrift(await fetchOps('/api/ops/scope-drift'));
    } catch (err) {
      console.error('scope-drift refresh failed', err);
      renderScopeDrift(UNREACHABLE);
    }
  }

  // Sequential, STOP on first failure (F-8) — a partial merge must not race
  // ahead past a rejected entry. follow_ups are surfaced verbatim, never
  // auto-run (I-7); the report is re-fetched whether the loop succeeded or
  // stopped, since it IS the recovery view.
  async function approveAlias(cluster, target, btn, hostKey) {
    if (btn) btn.disabled = true;
    // Per-variant, not the cluster aggregate: in a partially-ruled cluster the
    // aggregate is false while individual members carry their own ruling, and
    // those must not be aliased away by the bulk button. Shared with the
    // render-time guard, so no button reaches this with an empty set.
    const variants = mergeSources(cluster, target);
    const done = [];
    let failure = null;
    for (const v of variants) {
      try {
        const r = await fetch('/api/admin/scopes/rule', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ scope: v.scope, action: 'merge_into', target }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { failure = `${v.scope}: ${j.error || r.status}`; break; }
        done.push({ scope: v.scope, followUps: (j.meta && j.meta.follow_ups) || [] });
      } catch (err) {
        failure = `${v.scope}: ${err.message}`;
        break;
      }
    }
    renderRulingOutcome(hostKey, done, failure);
    await refreshDrift();
  }

  // Deferral (blocker 4). Same request/outcome shape as markDistinct — the
  // server treats defer/undefer as actions on the ruling endpoint, so the
  // panel reports them through the one ruling-outcome renderer.
  async function deferScope(scope, action, note, btn, hostKey) {
    if (btn) btn.disabled = true;
    try {
      const body = { scope, action };
      if (action === 'defer' && note) body.note = note;
      const r = await fetch('/api/admin/scopes/rule', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        renderRulingOutcome(hostKey, [], `${scope}: ${j.error || r.status}`);
        if (btn) btn.disabled = false;
        return;
      }
      deferNoteDraft.delete(scope);
      renderRulingOutcome(hostKey, [{ scope, followUps: [] }], null);
    } catch (err) {
      renderRulingOutcome(hostKey, [], `${scope}: ${err.message}`);
      if (btn) btn.disabled = false;
      return;
    }
    await refreshDrift();
  }

  async function markDistinct(scope, btn, hostKey) {
    if (btn) btn.disabled = true;
    try {
      const r = await fetch('/api/admin/scopes/rule', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope, action: 'mark_distinct' }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        renderRulingOutcome(hostKey, [], `${scope}: ${j.error || r.status}`);
        if (btn) btn.disabled = false;
        return;
      }
      renderRulingOutcome(hostKey, [{ scope, followUps: [] }], null);
    } catch (err) {
      renderRulingOutcome(hostKey, [], `${scope}: ${err.message}`);
      if (btn) btn.disabled = false;
      return;
    }
    await refreshDrift();
  }

  // One-scope merge_into — the change-ruling path (item 8). Same endpoint the
  // bulk approveAlias loop posts to; the outcome rendering and the report
  // refresh are identical, so the two paths cannot disagree on what a ruling
  // looks like. On success the disclosure state is dropped — the rebuilt row
  // no longer has a ruling to change.
  async function mergeScopeInto(scope, target, btn, hostKey) {
    if (btn) btn.disabled = true;
    const done = [];
    let failure = null;
    try {
      const r = await fetch('/api/admin/scopes/rule', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope, action: 'merge_into', target }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) failure = `${scope}: ${j.error || r.status}`;
      else done.push({ scope, followUps: (j.meta && j.meta.follow_ups) || [] });
    } catch (err) {
      failure = `${scope}: ${err.message}`;
    }
    if (failure && btn) btn.disabled = false;
    else {
      changeRulingOpen.delete(scope);
      changeRulingTarget.delete(scope);
    }
    renderRulingOutcome(hostKey, done, failure);
    await refreshDrift();
  }

  // Why the two stop reasons are hinted differently (Codex round-2 item 5):
  // the split is by CAUSE, not by spelling. BOTH read failures —
  // 'resolution_read_failed' (the F-7 re-check's uncached table read) and
  // 'store_read_failed' (the page fetch) — are transient; the call took the
  // fail-CLOSED branch and archived nothing further, so retrying is exactly the
  // right move. Only a version or eligibility change means a RULING landed
  // mid-call, and that is the case the operator must re-read the report about
  // before doing anything else.
  function isTransientStop(reason) {
    return reason === 'resolution_read_failed' || reason === 'store_read_failed';
  }

  // Item 9 (theme G): the ruling-landed branch names WHAT changed — an
  // eligibility stop is a ruling on THIS scope; a version stop is the alias
  // table itself (the response can't say which entry, so the report is the
  // place to look).
  function stoppedHint(reason, scope) {
    if (isTransientStop(reason)) return 'read hiccup — safe to retry: already-archived rows are skipped';
    return reason === 'eligibility_changed'
      ? `a ruling landed on ${scope} mid-call — re-check the report before retrying`
      : 'the alias table changed mid-call (a ruling landed) — re-check the report before retrying';
  }

  // `container` is the spawning row's status node; the outcome's own re-run
  // button has no row node to hand over (the row may have been rebuilt), so
  // null routes the transient status through the pinned outcome instead.
  async function archiveEphemeralDryRun(scope, container) {
    if (container) {
      clear(container);
      container.append(el('div', { class: 'ops-drift-archive-status' }, 'checking…'));
    } else {
      renderArchiveOutcome(scope, [el('div', { class: 'ops-drift-archive-status' }, `${scope}: checking…`)]);
    }
    try {
      const r = await fetch('/api/admin/scopes/archive-ephemeral', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope }),
      });
      const j = await r.json().catch(() => ({}));
      if (container) clear(container);
      if (!r.ok) {
        renderArchiveOutcome(scope, [el('div', { class: 'review-msg-err' },
          `${scope}: dry-run failed (${r.status}) ${j.error || ''}`.trim())]);
        return;
      }
      const d = j.data;
      const nodes = [
        el('div', { class: 'ops-drift-archive-status' }, `${scope}:`),
        el('div', { class: 'ops-drift-archive-status' },
          `would archive ${d.archived} (${d.refused_anchored} anchored refused)`),
      ];
      if (d.stopped) {
        // Codex round-2 item 1: a STOPPED dry-run is not a preview. The page
        // read can fail on the first chunk (the guard is not gated on `apply`),
        // which previews `would archive 0` while the apply that follows would
        // walk up to the full 500-row cap. Offering "confirm archive" off that
        // number would be offering an unbounded action behind a zero. No
        // confirm button until a CLEAN dry-run: re-run it from the row's
        // dry-run button.
        nodes.push(
          el('div', { class: 'review-msg-err' },
            `dry-run STOPPED: ${d.stopped} — ${stoppedHint(d.stopped, scope)}`),
          el('div', { class: 'ops-hint' },
            'the counts above are partial, so apply is withheld — re-run the dry-run for a clean preview')
        );
        // Item 9: "re-run the dry-run" was an instruction with no control (the
        // row's own button may sit offscreen). Transient stops only — a
        // ruling-landed stop wants the report re-read, not a reflex retry.
        if (isTransientStop(d.stopped)) {
          const rerun = el('button', { class: 'replay-btn radyn-btn' }, 're-run dry-run');
          rerun.addEventListener('click', () => archiveEphemeralDryRun(scope, null));
          nodes.push(rerun);
        }
        renderArchiveOutcome(scope, nodes);
        return;
      }
      const confirmBtn = el('button', { class: 'replay-btn radyn-btn' }, 'confirm archive of ', scopeLiteral(scope));
      confirmBtn.addEventListener('click', () => archiveEphemeralApply(scope));
      // The confirm click is the actual mutation, so the reversibility line
      // belongs here too — same helper, same sentence as the dry-run button's.
      nodes.push(actionWithHint(confirmBtn, 'archive'));
      renderArchiveOutcome(scope, nodes);
    } catch (err) {
      if (container) clear(container); // null on the outcome's own re-run path
      renderArchiveOutcome(scope, [el('div', { class: 'review-msg-err' },
        `${scope}: dry-run request failed: ${err.message}`)]);
    }
  }

  // Codex round-2 item 4c (+ the addendum): EVERY archive-ephemeral outcome —
  // dry-run preview, its confirm button, and the apply result — goes to the
  // PERSISTENT #ops-drift-msg area, never to the per-row container.
  // `renderDriftEphemeral` rebuilds every row from scratch, so anything in that
  // container is destroyed by the refresh that follows an apply AND by the ops
  // tab's own 10s poll. For the dry-run that mattered twice over: the STOPPED
  // warning gating the apply could be wiped mid-read, and the confirm button
  // could vanish under the operator while they were deciding. This is the same
  // area every ruling outcome already uses.
  function renderArchiveOutcome(scope, nodes) {
    pinOutcome(`eph:${scope}`, nodes);
  }

  // No container parameter: the confirm button now lives in the persistent
  // message area, so the row element that spawned this call may already have
  // been replaced by a poll. Its transient status renders where its result will.
  async function archiveEphemeralApply(scope) {
    renderArchiveOutcome(scope, [el('div', { class: 'ops-drift-archive-status' }, `${scope}: archiving…`)]);
    try {
      const r = await fetch('/api/admin/scopes/archive-ephemeral', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope, apply: true }),
      });
      if (r.status === 423) {
        renderArchiveOutcome(scope, [el('div', { class: 'review-msg-err' },
          `${scope}: consolidation lock busy — retry shortly`)]);
        return;
      }
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        renderArchiveOutcome(scope, [el('div', { class: 'review-msg-err' },
          `${scope}: archive failed (${r.status}) ${j.error || ''}`.trim())]);
        return;
      }
      const d = j.data;
      // The peek lists ACTIVE rows only, and this call just archived some of
      // them — so the cached excerpt set is stale. Drop it; an open peek
      // refetches on the re-render below, a closed one on its next open.
      peekCache.delete(scope);
      const nodes = [];
      // finalization_failed FIRST and loud (item 4b): the archives stand and
      // are individually audited, but the carrier row never reached
      // 'completed', so dream-history and every counter-based view of this pass
      // under-report it. That has to be read before the counts below it are.
      if (d.finalization_failed) {
        nodes.push(el('div', { class: 'review-msg-err' },
          `${scope}: the audit carrier failed to finalize — the archives below STAND and are individually audited, ` +
          `but the carrier row may still read "running" with stale counters, so dream-history under-reports this pass`));
      }
      const lines = [`archived ${d.archived} (${d.refused_anchored} anchored refused)`];
      if (d.failed_total > 0) {
        lines.push(`${d.failed_total} failed${d.failed && d.failed.length < d.failed_total ? ` (showing ${d.failed.length})` : ''}`);
      }
      if (d.truncated) lines.push('truncated at the cap — run again to drain (the cap is the design)');
      if (d.stopped) lines.push(`stopped: ${d.stopped} — ${stoppedHint(d.stopped, scope)}`);
      if (d.withheld) lines.push(`withheld: ${d.withheld} (${d.withheld_rows ?? 0} rows)`);
      // Item 4d: `dream_id` is the CARRIER (the audit row), not something the
      // operator rolls back — rollback is per-memory, off the ids below.
      if (d.dream_id != null) {
        lines.push(`audit carrier: dream #${d.dream_id} — rollback is PER-MEMORY, off the archived ids below`);
      }
      nodes.push(el('div', { class: 'ops-drift-archive-status' }, `${scope}:`));
      for (const line of lines) nodes.push(el('div', { class: 'ops-drift-archive-status' }, line));
      // Item 6 (theme F): the per-row failures were computed, capped server-side
      // at 20 and returned — then discarded here. Each one is a row the operator
      // may believe archived that wasn't. First five inline, the rest behind a
      // details fold; the `failed_total` line above reconciles past the server's
      // detail cap. Text nodes only — `error` is server-produced free text.
      if (Array.isArray(d.failed) && d.failed.length > 0) {
        const rowFor = (f) => el('div', { class: 'ops-drift-failed-row' }, `#${f.memory_id}: ${f.error}`);
        const failedWrap = el('div', { class: 'ops-drift-failed' });
        for (const f of d.failed.slice(0, 5)) failedWrap.append(rowFor(f));
        if (d.failed.length > 5) {
          failedWrap.append(el('details', { class: 'ops-drift-failed-more' },
            el('summary', null, `${d.failed.length - 5} more`),
            d.failed.slice(5).map(rowFor)));
        }
        nodes.push(failedWrap);
      }
      // Item 4a: the archived ids ARE the undo enumeration — the rows are
      // already archived by the time this renders, so without the list there is
      // no way to enumerate what to hand POST /api/memories/:id/rollback short
      // of a manual archived-rows query. Collapsed (up to 500 ids) and
      // text-node only.
      if (Array.isArray(d.archived_ids) && d.archived_ids.length > 0) {
        const ids = el('details', { class: 'ops-drift-archive-ids' },
          el('summary', null, `${d.archived_ids.length} archived id${d.archived_ids.length === 1 ? '' : 's'} (copy for rollback)`),
          el('div', { class: 'ops-drift-archive-idlist' }, d.archived_ids.join(', '))
        );
        nodes.push(ids);
      }
      // Blocker 2 (theme B): the outcome promised rollback and offered no
      // control, and its ids died with a dismiss/reload. Persist the pass
      // (localStorage, capped) and put "roll back N" where the ids are;
      // progress renders under "recent archive passes", which survives both.
      if (d.archived > 0 && Array.isArray(d.archived_ids) && d.archived_ids.length > 0) {
        const pass = {
          key: `${d.dream_id ?? 'pass'}-${Date.now()}`, ts: Date.now(), scope,
          dream_id: d.dream_id ?? null, archived: d.archived,
          failed_total: d.failed_total || 0, ids: d.archived_ids,
        };
        recordArchivePass(pass);
        const rb = el('button', { class: 'replay-btn radyn-btn' },
          `roll back ${pass.ids.length} row${pass.ids.length === 1 ? '' : 's'} of `, scopeLiteral(scope));
        rb.addEventListener('click', () => {
          rb.disabled = true;
          rb.textContent = 'rolling back — progress under recent archive passes';
          rollbackPass(pass);
        });
        nodes.push(actionWithHint(rb, 'rollback'));
      }
      // Item 9 (theme G): "run again to drain" was an instruction with no
      // control. The continuation is idempotent — archived rows have left the
      // active set, so a repeat only touches survivors — and it is still an
      // apply, so it keeps the reversibility line. Truncation and transient
      // stops only; a ruling-landed stop wants the report re-read first.
      if (d.truncated || (d.stopped && isTransientStop(d.stopped))) {
        const again = el('button', { class: 'replay-btn radyn-btn' },
          'run again — continue archiving ', scopeLiteral(scope));
        again.addEventListener('click', () => archiveEphemeralApply(scope));
        nodes.push(
          el('div', { class: 'ops-hint' },
            'safe to repeat — already-archived rows are skipped; anchored rows refuse again'),
          actionWithHint(again, 'archive'));
      }
      // Refresh BEFORE rendering (item 4c): renderDriftEphemeral rebuilds the
      // rows, and doing it after would clear the message we just wrote.
      await refreshDrift();
      renderArchiveOutcome(scope, nodes);
    } catch (err) {
      renderArchiveOutcome(scope, [el('div', { class: 'review-msg-err' },
        `${scope}: archive request failed: ${err.message}`)]);
    }
  }

  // ---- Recent archive passes + bulk rollback (blocker 2, theme B) ----------
  // The apply outcome carries the archived ids — the ONLY undo enumeration —
  // and it used to die with a dismiss or a reload. Passes now persist in
  // localStorage (newest-first, capped) and each carries a bounded,
  // progress-reporting bulk rollback. localStorage rather than a server list:
  // the response's archived_ids is exactly the needed data and already
  // client-side, while the durable server-side record (the carrier dream +
  // per-row audits) exists independently in dream-history. The rollback
  // endpoint needs NO proxy change — /api/memories/:id/rollback has been on
  // the viz proxy's ADMIN_ROUTES allowlist since T27 (SYNTHESIS §1.1).
  const ARCHIVE_PASSES_KEY = 'kopeng-viz-archive-passes';
  const ARCHIVE_PASSES_CAP = 10;

  // Session-scoped fallback when localStorage is unavailable (privacy mode,
  // quota): the passes section still renders and rollback progress still
  // paints — only reload-durability is lost, which is the honest best
  // available (review F5: the inline button used to point at a section that
  // would render nothing).
  let archivePassesMem = null;

  function loadArchivePasses() {
    if (archivePassesMem) return archivePassesMem.slice();
    try {
      const list = JSON.parse(localStorage.getItem(ARCHIVE_PASSES_KEY) || '[]');
      return Array.isArray(list) ? list : [];
    } catch (err) {
      return [];
    }
  }
  function saveArchivePasses(list) {
    const capped = list.slice(0, ARCHIVE_PASSES_CAP);
    try {
      localStorage.setItem(ARCHIVE_PASSES_KEY, JSON.stringify(capped));
      archivePassesMem = null;
    } catch (err) {
      archivePassesMem = capped;
    }
  }
  function recordArchivePass(pass) {
    saveArchivePasses([pass, ...loadArchivePasses()]);
    renderArchivePasses();
  }
  function updateArchivePass(key, patch) {
    const list = loadArchivePasses();
    const i = list.findIndex(p => p.key === key);
    if (i >= 0) {
      list[i] = Object.assign({}, list[i], patch);
      saveArchivePasses(list);
    }
  }

  // In-flight rollback state lives module-level so a poll rebuild repaints
  // truthful progress instead of wiping it (the pinnedOutcome doctrine).
  const rollbackState = new Map(); // pass.key → { running, done, total, failures, finished }

  function passStatusText(pass) {
    const st = rollbackState.get(pass.key);
    if (st && st.running) {
      return `rolling back… ${st.done}/${st.total}${st.failures.length ? ` (${st.failures.length} failed)` : ''}`;
    }
    if (typeof pass.rolled_back === 'number') {
      const remaining = Array.isArray(pass.remaining_ids) ? pass.remaining_ids.length : 0;
      return `rolled back ${pass.rolled_back}/${pass.ids.length}`
        + (remaining ? ` — ${remaining} still archived` : '');
    }
    return '';
  }

  function repaintPassStatus(key) {
    const node = document.querySelector(`[data-pass-status="${key.replace(/"/g, '\\"')}"]`);
    const pass = loadArchivePasses().find(p => p.key === key);
    if (node && pass) node.textContent = passStatusText(pass);
  }

  // Sequential by design: each rollback is its own audited restore, failures
  // are independent, and one slow id must not hide progress. Failures are
  // RETAINED per id (SYNTHESIS §1.2f) and the loop continues past them —
  // a rollback pass is a rescue, not a transaction. Re-runnable ONLY over the
  // ids that stayed archived: state is re-read fresh by key (review F2 — the
  // pinned outcome's button holds a stale pass object, and re-rolling an
  // already-restored id would restore its pre-rollback snapshot and mint junk
  // revisions), and a fully-rescued pass is a no-op.
  async function rollbackPass(passRef) {
    const key = passRef.key;
    const existing = rollbackState.get(key);
    if (existing && existing.running) return;
    const pass = loadArchivePasses().find(p => p.key === key) || passRef;
    const idsToRoll = Array.isArray(pass.remaining_ids)
      ? pass.remaining_ids
      : (typeof pass.rolled_back === 'number' ? [] : pass.ids);
    if (idsToRoll.length === 0) return;
    const st = { running: true, done: 0, total: idsToRoll.length, failures: [], finished: false };
    rollbackState.set(key, st);
    renderArchivePasses();
    for (const id of idsToRoll) {
      try {
        const r = await fetch(`/api/memories/${id}/rollback`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) st.failures.push({ id, error: String(j.error || r.status) });
      } catch (err) {
        st.failures.push({ id, error: err.message });
      }
      st.done++;
      repaintPassStatus(key);
    }
    st.running = false;
    st.finished = true;
    // Persist the outcome INCLUDING the per-id failures (review F4): after a
    // reload the in-memory state is gone, and the failed ids are the only
    // record of which rows are still archived. Cumulative accounting: every
    // id not in THIS run's failures is rescued now or was rescued before.
    const failedIds = st.failures.map(f => f.id);
    updateArchivePass(key, {
      rolled_back: pass.ids.length - failedIds.length,
      rollback_failures: failedIds.length,
      remaining_ids: failedIds,
      failures: st.failures,
    });
    await refreshDrift(); // restored rows return to the active lists
    renderArchivePasses();
  }

  // Open-details state, so the 10s poll's rebuild can't snap an id list or
  // failure fold shut mid-read (review F3 — the peekOpen doctrine, again).
  const passDetailsOpen = new Set(); // `${pass.key}:ids` | `${pass.key}:failures`

  function passDetails(openKey, cls, summaryText, kids) {
    const d = el('details', { class: cls }, el('summary', null, summaryText), kids);
    d.open = passDetailsOpen.has(openKey);
    d.addEventListener('toggle', () => {
      if (d.open) passDetailsOpen.add(openKey);
      else passDetailsOpen.delete(openKey);
    });
    return d;
  }

  function renderArchivePasses() {
    const wrap = document.getElementById('ops-drift-passes');
    const head = document.getElementById('ops-drift-passes-h');
    if (!wrap) return;
    const passes = loadArchivePasses();
    if (head) head.hidden = passes.length === 0;
    clear(wrap);
    for (const pass of passes) {
      const st = rollbackState.get(pass.key);
      const row = el('div', { class: 'ops-drift-pass-row' });
      row.append(el('div', { class: 'ops-drift-pass-head' },
        el('span', { class: 'ops-drift-variant-scope' }, pass.scope),
        el('span', { class: 'radyn-pill' }, `${pass.archived} archived`),
        pass.failed_total ? el('span', { class: 'radyn-pill radyn-pill--error' }, `${pass.failed_total} failed`) : null,
        pass.dream_id != null ? el('span', { class: 'radyn-pill' }, `carrier #${pass.dream_id}`) : null,
        el('span', { class: 'ops-drift-reason' }, fmtAge(new Date(pass.ts).toISOString()))
      ));
      if (pass.ids.length > 0) {
        row.append(passDetails(`${pass.key}:ids`, 'ops-drift-archive-ids',
          `${pass.ids.length} archived id${pass.ids.length === 1 ? '' : 's'}`,
          el('div', { class: 'ops-drift-archive-idlist' }, pass.ids.join(', '))));
      }
      row.append(el('div', {
        class: 'ops-drift-archive-status',
        dataset: { passStatus: pass.key },
      }, passStatusText(pass)));
      // Live failures during/after a run in this session; the PERSISTED list
      // otherwise (review F4 — after a reload it is the only record of which
      // rows stayed archived).
      const failures = (st && st.failures.length > 0) ? st.failures
        : (Array.isArray(pass.failures) ? pass.failures : []);
      if (failures.length > 0) {
        const failedWrap = el('div', { class: 'ops-drift-failed' });
        for (const f of failures.slice(0, 5)) {
          failedWrap.append(el('div', { class: 'ops-drift-failed-row' }, `#${f.id}: ${f.error}`));
        }
        if (failures.length > 5) {
          failedWrap.append(passDetails(`${pass.key}:failures`, 'ops-drift-failed-more',
            `${failures.length - 5} more`,
            failures.slice(5).map(f => el('div', { class: 'ops-drift-failed-row' }, `#${f.id}: ${f.error}`))));
        }
        row.append(failedWrap);
      }
      const actions = el('div', { class: 'review-actions ops-drift-actions' });
      // First run rolls everything; afterwards the button offers ONLY the
      // still-archived remainder (review F1 — an all-423 pass must stay
      // retryable, not become a dead list).
      const remaining = Array.isArray(pass.remaining_ids)
        ? pass.remaining_ids
        : (typeof pass.rolled_back === 'number' ? [] : pass.ids);
      if (remaining.length > 0 && !(st && st.running)) {
        const isRetry = typeof pass.rolled_back === 'number';
        const btn = el('button', { class: 'replay-btn radyn-btn' },
          `${isRetry ? 'retry rollback of' : 'roll back'} ${remaining.length} row${remaining.length === 1 ? '' : 's'} of `,
          scopeLiteral(pass.scope));
        btn.addEventListener('click', () => { btn.disabled = true; rollbackPass(pass); });
        actions.append(actionWithHint(btn, 'rollback'));
      }
      const rm = el('button', { class: 'replay-btn radyn-btn ops-drift-dismiss' }, 'remove from list');
      rm.addEventListener('click', () => {
        saveArchivePasses(loadArchivePasses().filter(p => p.key !== pass.key));
        renderArchivePasses();
      });
      actions.append(rm);
      row.append(actions);
      wrap.append(row);
    }
  }

  // ---- Minimal text filter (item 12, theme H subset) ----------------------
  // "Find one of 71" with no scrolling. Deliberately minimal: substring match
  // over the scope strings an operator would actually type, no sort, no facets
  // — the full scanning treatment (sort, collapse-at-rest, saved views) is the
  // Phase-5 design pass, which should design that surface rather than inherit
  // a guess at it.
  //
  // Two rules this shares with the deferral counter, for the same reason:
  // the filter narrows the LIST only — the summary chips stay corpus-wide
  // truth — and whenever it hides anything it SAYS SO with a count, so a
  // filtered panel can never be mistaken for a clean one.
  let driftFilter = '';
  // The last GOOD report + when it arrived, so a keystroke re-renders without
  // refetching — and so a stale repaint can SAY how old it is (review F1).
  let lastDriftReport = null;
  let lastDriftAt = 0;
  let driftUnreachable = false;

  function driftFilterMatches(text) {
    return String(text || '').toLowerCase().includes(driftFilter);
  }

  // A row hosting the operator's pending outcome is NEVER filtered away
  // (review F2): the pinned nodes carry the dry-run's confirm button and the
  // archived-id list — the only undo enumeration — and filtering the host
  // out would relocate them to the top of the card, off-screen, reviving the
  // exact "the click read as nothing happened" defect the pinning fixed.
  function hostsPinnedOutcome(key) {
    return !!pinnedOutcome && pinnedOutcome.key === key;
  }

  // A cluster matches on its key or ANY variant scope: the operator types a
  // spelling they saw, which may be a variant rather than the slug key.
  function clusterMatchesFilter(cluster) {
    if (!driftFilter) return true;
    if (hostsPinnedOutcome(`cluster:${cluster.key}`)) return true;
    if (driftFilterMatches(cluster.key)) return true;
    return (cluster.variants || []).some(v => driftFilterMatches(v.scope));
  }

  function ephemeralMatchesFilter(e) {
    if (!driftFilter) return true;
    if (hostsPinnedOutcome(`eph:${e.scope}`)) return true;
    return driftFilterMatches(e.scope) || driftFilterMatches(e.reason);
  }

  function wireDriftFilter() {
    const input = document.getElementById('ops-drift-filter-input');
    const clearBtn = document.getElementById('ops-drift-filter-clear');
    if (!input || input.dataset.wired) return; // static node — wire once
    input.dataset.wired = '1';
    let debounce = null;
    const apply = () => {
      driftFilter = input.value.trim().toLowerCase();
      if (clearBtn) clearBtn.hidden = driftFilter === '';
      // Re-render from the last report — no refetch, so typing never waits on
      // the network. `stale` is load-bearing: repainting a cached report as
      // though it were live would erase the api-unreachable state (F1).
      if (lastDriftReport) renderScopeDrift(lastDriftReport, { stale: driftUnreachable });
    };
    // Coalesce keystrokes (review F3): each apply rebuilds 40+ clusters and
    // 70+ rows and re-reads the passes list from localStorage; at 120ms the
    // typing still feels immediate.
    const applyDebounced = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(apply, 120);
    };
    input.addEventListener('input', applyDebounced);
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { input.value = ''; if (debounce) clearTimeout(debounce); apply(); }
    });
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        input.value = '';
        if (debounce) clearTimeout(debounce);
        apply();
        input.focus();
      });
    }
    // Adopt a value the browser restored (session restore / bfcache survive
    // autocomplete="off"), so the field and the filter can't disagree — F5.
    if (input.value.trim() !== '') apply();
  }

  function renderDriftFilterCount(shownClusters, totalClusters, shownEph, totalEph) {
    const countEl = document.getElementById('ops-drift-filter-count');
    if (!countEl) return;
    if (!driftFilter) { countEl.textContent = ''; return; }
    countEl.textContent =
      `showing ${shownClusters} of ${totalClusters} cluster${totalClusters === 1 ? '' : 's'}`
      + ` · ${shownEph} of ${totalEph} ephemeral scope${totalEph === 1 ? '' : 's'}`
      + ' — the chips above stay corpus-wide';
  }

  function renderScopeDrift(report, opts) {
    // `stale` = re-rendered from cache while the API is unreachable (the
    // filter path). The rows are shown because losing them mid-filter is
    // worse, but the panel must never LOOK live: an operator ruling against
    // an arbitrarily old report is the failure this flag exists to prevent.
    const stale = !!(opts && opts.stale);
    // The 10s poll rebuilds every row, which would drop keyboard focus from a
    // mid-typing free-target input (its VALUE survives via changeRulingTarget;
    // focus and caret do not). Capture before the teardown, restore after —
    // the same survive-the-poll doctrine as peekOpen/pinnedOutcome.
    const active = document.activeElement;
    const focusedTarget = active && active.classList
      && active.classList.contains('ops-drift-target-input')
      ? { scope: active.dataset.targetInput, start: active.selectionStart, end: active.selectionEnd }
      : null;
    const sub = document.getElementById('ops-drift-sub');
    const chips = document.getElementById('ops-drift-chips');
    const clustersEl = document.getElementById('ops-drift-clusters');
    const foot = document.getElementById('ops-drift-foot');
    if (!chips || !clustersEl) return; // markup missing (stale cached page) — degrade silently
    wireDriftFilter();
    // Keep the last GOOD report so a keystroke during an outage can re-render
    // it — LABELLED stale (see `stale` above), never as if it were live.
    if (report && !report.__unreachable) {
      lastDriftReport = report;
      lastDriftAt = Date.now();
      driftUnreachable = false;
    }

    // Distinguish UNREACHABLE (api down) from an empty-but-healthy report
    // (the 2026-07-03 false-alarm rule) — an empty `clusters`/`ephemeral` list
    // is a legitimate "nothing to rule" state, not a fetch failure.
    if (!report || report.__unreachable) {
      driftUnreachable = true;
      if (sub) sub.textContent = 'api unreachable';
      clear(chips);
      chips.append(el('span', { class: 'ops-empty' }, 'could not reach /api/ops/scope-drift'));
      clear(clustersEl);
      const ephemeralWrap = document.getElementById('ops-drift-ephemeral');
      if (ephemeralWrap) {
        clear(ephemeralWrap);
        ephemeralWrap.append(el('div', { class: 'ops-empty' }, 'api unreachable'));
      }
      if (foot) foot.textContent = '';
      // NOT "0 of 0" (review F4): during a fetch failure nothing is known,
      // and a zero reads as corpus truth in exactly that state.
      const countEl = document.getElementById('ops-drift-filter-count');
      if (countEl) countEl.textContent = '';
      return;
    }

    if (sub) {
      sub.textContent = stale
        ? `API UNREACHABLE — showing the last report, from ${new Date(lastDriftAt).toLocaleTimeString()}`
        : 'the Librarian — Phase A';
    }
    const s = report.summary || {};
    clear(chips);
    // Leads the row so every number after it is read as historical, and the
    // action buttons below are understood to be aimed at a stale report.
    if (stale) chips.append(driftChip('stale', 'not live', 'error'));
    chips.append(
      driftChip('rows adrift', s.active_rows_adrift ?? 0, (s.active_rows_adrift ?? 0) > 0 ? 'error' : 'success'),
      driftChip('clusters actionable', s.clusters_actionable ?? 0, (s.clusters_actionable ?? 0) > 0 ? 'warning' : ''),
      driftChip('ruled distinct', s.clusters_ruled_distinct ?? 0, ''),
      // Additive counter (§1.2a): deferred work stays counted and visible —
      // `countOrDash` so a pre-blocker-4 server reads '—', never a false 0.
      driftChip('deferred', countOrDash(s.clusters_deferred), (s.clusters_deferred ?? 0) > 0 ? 'warning' : ''),
      driftChip('ephemeral', `${s.ephemeral_scopes ?? 0} scopes / ${s.ephemeral_rows ?? 0} rows`, ''),
      driftChip('alias rejects', s.alias_entries_rejected ?? 0, (s.alias_entries_rejected ?? 0) > 0 ? 'error' : 'success')
    );

    const allClusters = report.clusters || [];
    const allEphemeral = report.ephemeral || [];
    const shownClusters = allClusters.filter(clusterMatchesFilter);
    const shownEphemeral = allEphemeral.filter(ephemeralMatchesFilter);
    renderDriftFilterCount(shownClusters.length, allClusters.length,
      shownEphemeral.length, allEphemeral.length);

    clear(clustersEl);
    if (allClusters.length === 0) {
      clustersEl.append(el('div', { class: 'ops-empty' }, 'no drift clusters — nothing to rule'));
    } else if (shownClusters.length === 0) {
      // Never a bare empty list under a filter: an operator who forgot the
      // filter was on would read "nothing to rule" as corpus truth.
      clustersEl.append(el('div', { class: 'ops-empty' }, `no cluster matches "${driftFilter}"`));
    } else {
      // Server pre-sorts worst-first (most live un-aliased rows).
      for (const cluster of shownClusters) clustersEl.append(renderDriftCluster(cluster));
    }

    renderDriftEphemeral(shownEphemeral, allEphemeral.length);
    renderArchivePasses();
    // Re-attach the operator's pending outcome to its freshly rebuilt host —
    // this is what lets the 10s poll keep the panel live without wiping a
    // preview or its confirm button. Never scrolls: a poll must not move the
    // page (the orphaned-host scroll is reserved for the user-action path).
    attachPinnedOutcome();
    if (focusedTarget && focusedTarget.scope) {
      const inp = document.querySelector(
        `[data-target-input="${focusedTarget.scope.replace(/"/g, '\\"')}"]`);
      if (inp) {
        inp.focus();
        try { inp.setSelectionRange(focusedTarget.start, focusedTarget.end); }
        catch { /* selection restore is best-effort */ }
      }
    }

    if (foot) {
      // The alias-table version is what the archive-ephemeral F-7 guard
      // reasons about, so a stale one must not read as current.
      const ver = ((s.alias_table_version || '').slice(0, 8) || '—') + (stale ? ' (stale)' : '');
      foot.textContent = `alias table ${ver} · ${s.scopes_total ?? 0} scopes · ${s.near_miss_pairs ?? 0} near-miss pairs`;
    }
  }

  async function pollOpsFast() {
    if (activeTab !== 'ops') return;
    setOpsStatus('fetching…');
    try {
      const [disc, reasoner, prom, conf, cache, dream, drift] = await Promise.all([
        fetchOps('/api/ops/discovery-status').catch(() => UNREACHABLE),
        fetchOps('/api/ops/reasoner-status').catch(() => UNREACHABLE),
        fetchOps('/api/ops/last-promotion').catch(() => UNREACHABLE),
        fetchOps('/api/ops/confidence-distribution').catch(() => UNREACHABLE),
        fetchOps('/api/ops/cache-stats').catch(() => UNREACHABLE),
        fetchOps('/api/ops/dream-history?limit=15').catch(() => UNREACHABLE),
        fetchOps('/api/ops/scope-drift').catch(() => UNREACHABLE),
      ]);
      renderDiscoveryStatus(disc);
      renderReasonerStatus(reasoner);
      renderLastPromotion(prom);
      renderConfidence(conf);
      renderCacheStats(cache);
      renderDreamHistory(dream);
      renderScopeDrift(drift);
      setOpsStatus('updated ' + new Date().toLocaleTimeString('en-US', { hour12: false }));
    } catch (err) {
      console.error('ops poll failed', err);
      setOpsStatus('error · see console');
    }
  }

  async function pollOpsSlow() {
    if (activeTab !== 'ops') return;
    try {
      const rows = await fetchOps('/api/ops/top-decaying?limit=20');
      renderTopDecaying(rows);
    } catch (err) {
      console.error('top-decaying fetch failed', err);
    }
    // corpus-health carries a sample caveat in meta, so fetch it raw (fetchOps drops meta).
    try {
      const r = await fetch('/api/ops/corpus-health?sample=2000', { cache: 'no-store' });
      if (r.ok) {
        const j = await r.json();
        renderCorpusHealth(j.data, j.meta);
      } else {
        renderCorpusHealth(UNREACHABLE, null);
      }
    } catch (err) {
      console.error('corpus-health fetch failed', err);
      renderCorpusHealth(UNREACHABLE, null);
    }
  }

  function startOpsPolling() {
    if (opsFastTimer) return; // already polling
    pollOpsFast();
    pollOpsSlow();
    opsFastTimer = setInterval(pollOpsFast, OPS_FAST_MS);
    opsSlowTimer = setInterval(pollOpsSlow, OPS_SLOW_MS);
  }

  function stopOpsPolling() {
    if (opsFastTimer) { clearInterval(opsFastTimer); opsFastTimer = null; }
    if (opsSlowTimer) { clearInterval(opsSlowTimer); opsSlowTimer = null; }
    setOpsStatus('idle');
  }

  // ── Replay tab — historical session playback ──
  //
  // Pure client-side playback over a one-shot fetch of /api/observations/by-session.
  // The SSE live stream is NOT consumed here — replay is read-only history.
  //
  // Timing model: walk the array with setTimeout; the delay between events is
  // `min(real_delta_ms, 2000) / speed`. The 2000ms cap keeps sparse sessions
  // (30-min gaps) from sitting idle even at 16×.
  //
  // Scrub-bar state machine (per handoff): jumping forward or backward →
  // clear the pending timer, re-render the slice [0..newIndex] from scratch,
  // resume the timer from `newIndex` if it was playing.
  const replayState = {
    initialized: false,
    sessionId: null,
    events: [],          // observations array, ordered by id ASC
    index: 0,            // index of the NEXT event to render
    playing: false,
    speed: 4,
    timer: null,
  };
  const REPLAY_DELTA_CAP_MS = 2000;
  const els_r = {
    panel: () => document.querySelector('[data-panel="replay"]'),
    picker: () => document.getElementById('replay-session'),
    refresh: () => document.getElementById('replay-refresh'),
    play: () => document.getElementById('replay-play'),
    reset: () => document.getElementById('replay-reset'),
    scrub: () => document.getElementById('replay-scrub'),
    pos: () => document.getElementById('replay-pos'),
    total: () => document.getElementById('replay-total'),
    status: () => document.getElementById('replay-status'),
    list: () => document.getElementById('replay-list'),
    speedBtns: () => document.querySelectorAll('.replay-speed-btn'),
  };

  function setReplayStatus(text) {
    const s = els_r.status();
    if (s) s.textContent = text;
  }

  function updatePosLabels() {
    els_r.pos().textContent = replayState.events.length ? String(replayState.index) : '—';
    els_r.total().textContent = replayState.events.length ? String(replayState.events.length) : '—';
    const scrub = els_r.scrub();
    scrub.value = String(replayState.index);
  }

  // Render an event as a row, reusing the .live-row styles. Mirrors appendRow()
  // in the live tab but APPENDS (chronological order) rather than prepending,
  // since replay reads events in their original timeline order.
  function renderReplayRow(obs) {
    const list = els_r.list();
    const row = document.createElement('div');
    row.className = 'live-row fresh';
    if (obs.id != null) row.dataset.obsId = obs.id;

    const time = document.createElement('span');
    time.className = 'live-time';
    time.textContent = fmtTime(Date.parse(obs.started_at) || Date.now());

    const pill = document.createElement('span');
    const replayStatus = obs.status || 'started';
    pill.className = 'live-pill radyn-pill'
      + (replayStatus === 'completed' ? ' radyn-pill--success' : replayStatus === 'failed' ? ' radyn-pill--error' : '');
    pill.dataset.status = replayStatus;
    pill.textContent = replayStatus;

    const tool = document.createElement('span');
    tool.className = 'live-tool';
    tool.textContent = obs.tool_name || '—';
    tool.title = obs.tool_name || '';

    const proj = document.createElement('span');
    proj.className = 'live-proj';
    proj.textContent = obs.project_scope || '';
    proj.title = obs.project_scope || '';

    const dur = document.createElement('span');
    dur.className = 'live-dur';
    dur.textContent = obs.duration_ms != null ? obs.duration_ms + 'ms' : '';

    row.append(time, pill, tool, proj, dur);

    row.addEventListener('click', () => {
      const existing = row.querySelector('.live-row-detail');
      if (existing) { existing.remove(); row.classList.remove('expanded'); return; }
      const detail = document.createElement('div');
      detail.className = 'live-row-detail';
      const parts = [];
      if (obs.input_summary) parts.push('input: ' + obs.input_summary);
      if (obs.output_summary) parts.push('output: ' + obs.output_summary);
      detail.textContent = parts.join('\n\n') || '(no summary)';
      row.append(detail);
      row.classList.add('expanded');
    });

    list.append(row);
  }

  // Render the slice [0..upTo) from scratch — used on scrub jumps and on
  // initial load. Cheaper than trying to incrementally un-append.
  function renderReplaySlice(upTo) {
    const list = els_r.list();
    while (list.firstChild) list.removeChild(list.firstChild);
    if (upTo === 0) {
      const empty = document.createElement('div');
      empty.className = 'live-empty';
      empty.textContent = replayState.events.length
        ? `loaded ${replayState.events.length} events — press play.`
        : 'pick a session above to load its event timeline.';
      list.append(empty);
      return;
    }
    for (let i = 0; i < upTo; i++) renderReplayRow(replayState.events[i]);
  }

  function pauseReplay() {
    if (replayState.timer) { clearTimeout(replayState.timer); replayState.timer = null; }
    replayState.playing = false;
    const playBtn = els_r.play();
    if (playBtn) { playBtn.textContent = 'play'; delete playBtn.dataset.state; }
  }

  function scheduleNext() {
    if (!replayState.playing) return;
    if (replayState.index >= replayState.events.length) {
      pauseReplay();
      setReplayStatus(`done · ${replayState.events.length} events played`);
      return;
    }
    const curr = replayState.events[replayState.index];
    const prev = replayState.index > 0 ? replayState.events[replayState.index - 1] : null;
    let delta = 0;
    if (prev) {
      const t1 = Date.parse(curr.started_at) || 0;
      const t0 = Date.parse(prev.started_at) || 0;
      delta = Math.max(0, t1 - t0);
    }
    // Clamp BEFORE dividing by speed — 30-min real gaps should not still wait
    // ~2 min even at 16× speed.
    delta = Math.min(delta, REPLAY_DELTA_CAP_MS);
    const wait = Math.max(0, Math.round(delta / replayState.speed));

    replayState.timer = setTimeout(() => {
      replayState.timer = null;
      if (!replayState.playing) return;
      renderReplayRow(replayState.events[replayState.index]);
      replayState.index++;
      updatePosLabels();
      setReplayStatus(`playing · ${replayState.index} / ${replayState.events.length}`);
      scheduleNext();
    }, wait);
  }

  function playReplay() {
    if (!replayState.events.length) return;
    if (replayState.index >= replayState.events.length) {
      // Replay was at end — reset to start before playing again.
      replayState.index = 0;
      renderReplaySlice(0);
      updatePosLabels();
    }
    replayState.playing = true;
    const playBtn = els_r.play();
    if (playBtn) { playBtn.textContent = 'pause'; playBtn.dataset.state = 'playing'; }
    setReplayStatus(`playing · ${replayState.index} / ${replayState.events.length}`);
    // If this is event 0, render the first one immediately so the user doesn't
    // see an empty list while waiting on the first delta (which is always 0).
    scheduleNext();
  }

  function resetReplay() {
    pauseReplay();
    replayState.index = 0;
    renderReplaySlice(0);
    updatePosLabels();
    setReplayStatus(replayState.events.length
      ? `loaded ${replayState.events.length} events — press play.`
      : 'pick a session above');
  }

  function jumpToIndex(newIndex) {
    const wasPlaying = replayState.playing;
    if (replayState.timer) { clearTimeout(replayState.timer); replayState.timer = null; }
    const clamped = Math.max(0, Math.min(replayState.events.length, newIndex));
    replayState.index = clamped;
    // Full re-render of the slice — simpler than computing forward/backward
    // diffs and fast enough for any realistic session size.
    renderReplaySlice(clamped);
    updatePosLabels();
    if (wasPlaying) {
      replayState.playing = true;
      scheduleNext();
    } else {
      setReplayStatus(`scrubbed · ${clamped} / ${replayState.events.length}`);
    }
  }

  async function loadSessionList() {
    setReplayStatus('loading sessions…');
    try {
      const r = await fetch('/api/observations/sessions?limit=100', { cache: 'no-store' });
      if (!r.ok) throw new Error(`sessions: ${r.status}`);
      const j = await r.json();
      const sessions = j.data || [];
      const picker = els_r.picker();
      // Preserve current selection if the session is still in the list.
      const currentValue = picker.value;
      while (picker.firstChild) picker.removeChild(picker.firstChild);
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = sessions.length ? '— pick a session —' : '— no sessions —';
      picker.append(placeholder);
      for (const s of sessions) {
        const opt = document.createElement('option');
        opt.value = s.session_id;
        // sid · count events · started_at · tool list head
        const shortId = s.session_id.slice(0, 12);
        const tools = (s.tool_names || []).slice(0, 3).join(', ');
        const more = (s.tool_names || []).length > 3 ? '…' : '';
        opt.textContent = `${shortId} · ${s.observation_count} ev · ${s.started_at} · ${tools}${more}`;
        picker.append(opt);
      }
      if (currentValue && sessions.find(s => s.session_id === currentValue)) {
        picker.value = currentValue;
      }
      setReplayStatus(`${sessions.length} sessions loaded`);
    } catch (err) {
      console.error('session list fetch failed', err);
      setReplayStatus('error loading sessions');
    }
  }

  async function loadSession(sessionId) {
    pauseReplay();
    if (!sessionId) {
      replayState.sessionId = null;
      replayState.events = [];
      replayState.index = 0;
      els_r.scrub().disabled = true;
      els_r.play().disabled = true;
      els_r.reset().disabled = true;
      renderReplaySlice(0);
      updatePosLabels();
      setReplayStatus('pick a session above');
      return;
    }
    setReplayStatus('loading events…');
    try {
      const r = await fetch(`/api/observations/by-session?session_id=${encodeURIComponent(sessionId)}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(`by-session: ${r.status}`);
      const j = await r.json();
      replayState.sessionId = sessionId;
      replayState.events = Array.isArray(j.data) ? j.data : [];
      replayState.index = 0;
      const scrub = els_r.scrub();
      scrub.max = String(replayState.events.length);
      scrub.value = '0';
      scrub.disabled = replayState.events.length === 0;
      els_r.play().disabled = replayState.events.length === 0;
      els_r.reset().disabled = replayState.events.length === 0;
      renderReplaySlice(0);
      updatePosLabels();
      setReplayStatus(replayState.events.length
        ? `loaded ${replayState.events.length} events — press play.`
        : 'this session has no events.');
    } catch (err) {
      console.error('session load failed', err);
      setReplayStatus('error loading session');
    }
  }

  function ensureReplayInit() {
    if (replayState.initialized) return;
    replayState.initialized = true;

    els_r.picker().addEventListener('change', (e) => loadSession(e.target.value));
    els_r.refresh().addEventListener('click', () => loadSessionList());
    els_r.play().addEventListener('click', () => {
      if (replayState.playing) pauseReplay();
      else playReplay();
    });
    els_r.reset().addEventListener('click', () => resetReplay());
    for (const btn of els_r.speedBtns()) {
      btn.addEventListener('click', () => {
        replayState.speed = parseInt(btn.dataset.speed, 10) || 1;
        for (const b of els_r.speedBtns()) b.classList.toggle('active', b === btn);
        // No need to reschedule mid-tick — the next setTimeout already reads
        // replayState.speed when it computes the next delay.
      });
    }
    const scrub = els_r.scrub();
    scrub.addEventListener('input', (e) => jumpToIndex(parseInt(e.target.value, 10) || 0));

    // Initial session list fetch.
    loadSessionList();
  }

  // ── Review tab — pending-dreams diff review (T8) ──
  //
  // Backed entirely by the existing dream review surface:
  //   GET  /api/dreams/pending            — list dreams awaiting review
  //   GET  /api/dreams/:id/diff           — human-readable diff (rationale,
  //                                          evidence counts, confidence deltas,
  //                                          member excerpts)
  //   POST /api/dreams/:id/resolve        — { action: accept|reject,
  //                                          entry_indices? } (partial = subset)
  //
  // Member excerpts come straight from the diff endpoint, which deliberately
  // does NOT reinforce the members it reads — so this tab never touches a
  // reinforcement path. Accept runs server-side under the consolidation lock
  // (423 when busy); a 423 surfaces inline and the list/diff re-fetch.
  const REVIEW_POLL_MS = 15_000;
  let reviewTimer = null;
  let reviewSelectedId = null;
  let reviewSelectedFrom = null; // 'pending' | 'history' — history selections survive the pending-list refresh
  const reviewListTbody = () => document.getElementById('review-list-tbody');
  const reviewDiffPane = () => document.getElementById('review-diff-pane');
  const reviewDot = document.getElementById('review-dot');

  function setReviewStatus(text) {
    const el2 = document.getElementById('review-poll-status');
    if (el2) el2.textContent = text;
  }

  async function reviewFetchJson(path, opts) {
    const r = await fetch(path, { cache: 'no-store', ...(opts || {}) });
    if (!r.ok) {
      const err = new Error(`${path}: ${r.status}`);
      err.status = r.status;
      throw err;
    }
    return r.json();
  }

  async function loadPendingDreams() {
    if (activeTab !== 'review') return;
    setReviewStatus('loading…');
    try {
      const j = await reviewFetchJson('/api/dreams/pending?limit=50');
      const rows = Array.isArray(j.data) ? j.data : [];
      renderPendingList(rows);
      const totalPending = rows.reduce((n, d) => n + (d.pending_entries || 0), 0);
      if (reviewDot) {
        reviewDot.dataset.state = totalPending > 0 ? 'pending' : 'clear';
        reviewDot.title = `${totalPending} pending entr${totalPending === 1 ? 'y' : 'ies'}`;
      }
      setReviewStatus(`${rows.length} dream${rows.length === 1 ? '' : 's'} · ${totalPending} pending`);
      // Keep an open diff fresh if its dream is still pending. A HISTORY selection
      // is left alone — it legitimately isn't in the pending list.
      if (reviewSelectedId != null && rows.some(d => d.id === reviewSelectedId)) {
        loadDreamDiff(reviewSelectedId, true);
      } else if (reviewSelectedId != null && reviewSelectedFrom === 'pending') {
        reviewSelectedId = null;
        reviewSelectedFrom = null;
        const pane = reviewDiffPane();
        if (pane) { clear(pane); pane.append(el('div', { class: 'live-empty' }, 'this dream is no longer pending — pick another.')); }
      }
    } catch (err) {
      console.error('pending dreams fetch failed', err);
      setReviewStatus('error');
      const tb = reviewListTbody();
      if (tb) { clear(tb); tb.append(el('tr', null, el('td', { colspan: 6, class: 'ops-empty' }, 'error loading pending dreams'))); }
    }
  }

  function renderPendingList(rows) {
    const tb = reviewListTbody();
    if (!tb) return;
    clear(tb);
    if (rows.length === 0) {
      tb.append(el('tr', null, el('td', { colspan: 6, class: 'ops-empty' }, 'no dreams awaiting review')));
      return;
    }
    for (const d of rows) {
      const tr = el('tr', { class: 'review-row' + (d.id === reviewSelectedId ? ' review-row-active' : '') },
        el('td', null, String(d.id)),
        el('td', { class: 'ops-cell-scope', title: d.scope }, d.scope),
        el('td', { title: d.window_key }, d.mode === 'whole_corpus' ? 'whole' : (d.window_key || '—')),
        el('td', null, `${d.pending_entries}/${d.entries_total}`),
        el('td', null, String(d.memories_examined ?? '—')),
        el('td', null, fmtAge(d.started_at))
      );
      tr.addEventListener('click', () => {
        reviewSelectedId = d.id;
        reviewSelectedFrom = 'pending';
        clearReviewActiveRows();
        tr.classList.add('review-row-active');
        loadDreamDiff(d.id, false);
      });
      tb.append(tr);
    }
  }

  function clearReviewActiveRows() {
    for (const id of ['review-list-tbody', 'review-history-tbody']) {
      const body = document.getElementById(id);
      if (!body) continue;
      for (const r2 of body.querySelectorAll('tr')) r2.classList.remove('review-row-active');
    }
  }

  // ── Round-2: dream history — every completed pass, clickable into its diff ──
  // A healthy corpus produces pass after pass with nothing proposed; without this
  // list the review tab looks like dreaming never runs at all.
  async function loadDreamHistoryList() {
    const tb = document.getElementById('review-history-tbody');
    if (!tb) return;
    try {
      const j = await reviewFetchJson('/api/ops/dream-history?limit=15');
      const data = j.data || {};
      clear(tb);
      if (data.enabled === false) {
        tb.append(el('tr', null, el('td', { colspan: 6, class: 'ops-empty' }, 'dreaming disabled (DREAMING_ENABLED=false)')));
        return;
      }
      const dreams = Array.isArray(data.dreams) ? data.dreams : [];
      if (dreams.length === 0) {
        tb.append(el('tr', null, el('td', { colspan: 6, class: 'ops-empty' }, 'no completed passes yet')));
        return;
      }
      for (const d of dreams) {
        const c = d.changes || {};
        const applied = (c.auto_applied ?? 0) + (c.accepted ?? 0);
        const tr = el('tr', { class: 'review-row' + (d.id === reviewSelectedId ? ' review-row-active' : '') },
          el('td', { title: d.completed_at || d.started_at }, fmtAge(d.completed_at || d.started_at)),
          // Carrier rows ride in this list looking like any other whole-corpus
          // pass; the pill is what distinguishes "this archived 19 rows" from
          // "this examined the corpus and proposed nothing".
          el('td', { title: d.window_key }, d.mode === 'whole_corpus' ? 'whole' : (d.window_key || '—'),
            d.is_carrier ? el('span', { class: 'radyn-pill review-carrier-pill' }, 'carrier') : null),
          el('td', null, String(d.memories_examined ?? '—')),
          el('td', null, String(c.proposed ?? 0)),
          el('td', null, String(applied)),
          el('td', null, d.status)
        );
        tr.addEventListener('click', () => {
          reviewSelectedId = d.id;
          reviewSelectedFrom = 'history';
          clearReviewActiveRows();
          tr.classList.add('review-row-active');
          loadDreamDiff(d.id, false);
        });
        tb.append(tr);
      }
    } catch (err) {
      console.error('dream history fetch failed', err);
      clear(tb);
      tb.append(el('tr', null, el('td', { colspan: 6, class: 'ops-empty' }, 'error loading history')));
    }
  }

  // ── Round-2: dreaming controls — live operator-config knobs ──
  // dream_cadence/auto_accept_* are top-level columns (safe to PATCH alone); the
  // whole-corpus cadence lives inside the config JSON blob. Since T26 the PATCH
  // handler MERGES the provided `config` keys into the stored blob server-side
  // (an explicit null deletes a key), so that toggle sends ONLY its own key —
  // the rotation cursors stored next to it (dream_window_cursor, …) are left
  // untouched. No client-side read-merge-write (it would race engine cursor
  // writes).
  async function loadReviewControls() {
    const body = document.getElementById('review-controls-body');
    if (!body) return;
    try {
      const j = await reviewFetchJson('/api/operator-config');
      renderReviewControls(j.data);
    } catch (err) {
      console.error('operator-config fetch failed', err);
      clear(body);
      body.append(el('div', { class: 'ops-empty' }, 'error loading operator config'));
    }
  }

  function readConfigBlob(cfg) {
    try {
      const parsed = JSON.parse(cfg?.config ?? '{}');
      return typeof parsed === 'object' && parsed !== null ? parsed : {};
    } catch { return {}; }
  }

  function renderReviewControls(cfg) {
    const body = document.getElementById('review-controls-body');
    if (!body) return;
    clear(body);
    const msg = el('div', { class: 'review-controls-msg' });
    const blob = readConfigBlob(cfg);
    const wholeCadence = blob.dream_whole_corpus_cadence === 'monthly' ? 'monthly' : 'off';

    const rows = [
      {
        label: 'nightly dreaming',
        hint: 'scheduled passes; manual triggers work either way',
        on: cfg.dream_cadence !== 'off',
        patch: (on) => ({ dream_cadence: on ? 'off' : 'nightly' }), // flip
      },
      {
        label: 'auto-accept exact dups',
        hint: 'identical-content collapses apply without review',
        on: !!cfg.auto_accept_exact_dup,
        patch: (on) => ({ auto_accept_exact_dup: !on }),
      },
      {
        label: 'auto-accept decay archival',
        hint: 'decayed memories archive without review (rollback-able)',
        on: !!cfg.auto_accept_decay,
        patch: (on) => ({ auto_accept_decay: !on }),
      },
      {
        label: 'whole-corpus sweep',
        hint: 'monthly full-corpus pass — catches pairs rotation can\'t co-window',
        on: wholeCadence === 'monthly',
        onText: 'monthly',
        offText: 'off',
        // Blob key: send just this key — the server merges it into the stored
        // blob (T26), so the rotation cursors beside it are never clobbered.
        patch: (on) => ({ config: { dream_whole_corpus_cadence: on ? 'off' : 'monthly' } }),
      },
    ];

    for (const row of rows) {
      const btn = el('button', { class: 'replay-btn radyn-btn' + (row.on ? ' review-toggle-on' : '') },
        row.on ? (row.onText || 'on') : (row.offText || 'off'));
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        msg.className = 'review-controls-msg';
        msg.textContent = 'saving…';
        try {
          const patch = row.patch(row.on);
          const r = await fetch('/api/operator-config', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch),
          });
          if (!r.ok) {
            const je = await r.json().catch(() => ({}));
            throw new Error(`${r.status} ${je.error || ''}`.trim());
          }
          const j = await r.json();
          renderReviewControls(j.data); // re-render every control from the server's truth
        } catch (err) {
          console.error('operator-config patch failed', err);
          msg.className = 'review-controls-msg review-msg-err';
          msg.textContent = `save failed (${err.message || 'fetch'})`;
          btn.disabled = false;
        }
      });
      body.append(el('div', { class: 'review-toggle' },
        el('div', { class: 'review-toggle-label' },
          el('span', null, row.label),
          el('span', { class: 'review-toggle-hint' }, row.hint)
        ),
        btn
      ));
    }
    body.append(msg);
  }

  function refreshReviewTab() {
    loadPendingDreams();
    loadDreamHistoryList();
  }

  async function loadDreamDiff(dreamId, silent) {
    const pane = reviewDiffPane();
    if (!pane) return;
    if (!silent) { clear(pane); pane.append(el('div', { class: 'live-empty' }, 'loading diff…')); }
    try {
      const j = await reviewFetchJson(`/api/dreams/${dreamId}/diff`);
      renderDreamDiff(j.data);
    } catch (err) {
      console.error('dream diff fetch failed', err);
      clear(pane);
      pane.append(el('div', { class: 'review-msg review-msg-err' }, `error loading diff (${err.status || 'fetch'})`));
    }
  }

  function fmtDelta(v) {
    if (v == null) return null;
    const s = v >= 0 ? '+' : '';
    return `Δconf ${s}${v.toFixed(2)}`;
  }

  function renderDreamDiff(data) {
    const pane = reviewDiffPane();
    if (!pane || !data) return;
    clear(pane);
    const dream = data.dream || {};
    const entries = Array.isArray(data.entries) ? data.entries : [];

    pane.append(el('div', { class: 'review-entry-head' },
      el('b', null, `dream #${dream.id}`),
      el('span', { class: 'review-badge radyn-pill' }, dream.scope || '—'),
      // An audit carrier is the row a bulk archive hangs its audit off, not a
      // dream that proposed anything — worth saying out loud, since its entry
      // list reads the same as an ordinary empty pass. Absent = ordinary pass,
      // so only the true case earns a badge.
      dream.is_carrier ? el('span', { class: 'review-badge radyn-pill' }, 'carrier') : null,
      el('span', { class: 'review-badge radyn-pill review-badge-tier' }, dream.status || '—'),
      el('span', { class: 'review-badge radyn-pill review-badge-tier' }, `${dream.changes_auto_applied ?? 0} auto · ${dream.changes_queued ?? 0} queued`)
    ));

    const pendingIndices = entries.filter(e => (e.resolution ?? 'pending') === 'pending').map(e => e.index);

    if (entries.length === 0) {
      pane.append(el('div', { class: 'live-empty' }, 'this pass proposed no changes — nothing dream-actionable was in its window.'));
      return;
    }

    for (const entry of entries) {
      const res = entry.resolution ?? 'pending';
      const card = el('div', { class: 'review-entry', 'data-entry-index': String(entry.index) });
      const head = el('div', { class: 'review-entry-head' },
        el('span', { class: 'review-badge radyn-pill' }, `#${entry.index}`),
        el('span', { class: 'review-badge radyn-pill' }, entry.change_class || '—'),
        el('span', { class: 'review-badge radyn-pill review-badge-tier' }, entry.tier || '—'),
        el('span', { class: `review-res-${res}` }, res)
      );
      const delta = fmtDelta(entry.confidence_delta);
      if (delta) head.append(el('span', { class: 'review-badge radyn-pill review-badge-tier' }, delta));
      card.append(head);

      if (entry.rationale) card.append(el('div', { class: 'review-rationale' }, entry.rationale));

      if (entry.impact) {
        const impactRows = [
          el('div', null, el('b', null, 'If accepted: '), entry.impact.if_accepted),
          el('div', null, el('b', null, 'If rejected: '), entry.impact.if_rejected),
        ];
        if (entry.impact.reversible) {
          impactRows.push(el('div', { class: 'review-reversible' }, 'Accepting is reversible — snapshotted, restorable via rollback.'));
        }
        card.append(el('div', { class: 'review-impact' }, ...impactRows));
      }

      const members = Array.isArray(entry.members) ? entry.members : [];
      for (const m of members) {
        if (m.missing) {
          card.append(el('div', { class: 'review-member' }, `memory #${m.id} (missing)`));
          continue;
        }
        card.append(el('div', { class: 'review-member' },
          el('span', { class: 'review-badge radyn-pill review-badge-tier' }, `#${m.id} ${m.type}`),
          ' ',
          el('span', { class: 'review-badge radyn-pill review-badge-tier', title: 'evidence sessions' }, `ev ${m.evidence_count ?? 0}`),
          ' ',
          el('span', { class: 'review-badge radyn-pill review-badge-tier' }, `conf ${typeof m.confidence === 'number' ? m.confidence.toFixed(2) : '—'}`),
          el('div', { class: 'review-member-excerpt' }, m.excerpt || '')
        ));
      }
      pane.append(card);
    }

    // Resolve actions — accept-all / reject-all / accept-selected (partial).
    const msg = el('div', { class: 'review-msg' });
    const actions = el('div', { class: 'review-actions' });
    const hasPending = pendingIndices.length > 0;

    const acceptAll = el('button', { class: 'replay-btn radyn-btn' }, 'accept all');
    const rejectAll = el('button', { class: 'replay-btn radyn-btn' }, 'reject all');
    const acceptSel = el('button', { class: 'replay-btn radyn-btn' }, 'accept checked');
    if (!hasPending) { acceptAll.disabled = true; rejectAll.disabled = true; acceptSel.disabled = true; }

    acceptAll.addEventListener('click', () => resolveDreamEntries(dream.id, 'accept', null, msg, [acceptAll, rejectAll, acceptSel]));
    rejectAll.addEventListener('click', () => resolveDreamEntries(dream.id, 'reject', null, msg, [acceptAll, rejectAll, acceptSel]));
    acceptSel.addEventListener('click', () => {
      const checked = [...pane.querySelectorAll('.review-entry-check:checked')].map(c => parseInt(c.dataset.index, 10));
      if (checked.length === 0) { msg.className = 'review-msg review-msg-err'; msg.textContent = 'check at least one pending entry first'; return; }
      resolveDreamEntries(dream.id, 'accept', checked, msg, [acceptAll, rejectAll, acceptSel]);
    });

    actions.append(acceptAll, rejectAll, acceptSel);
    // Per-entry checkboxes for partial accept — only for still-pending entries.
    if (pendingIndices.length > 1) {
      const checkRow = el('div', { class: 'review-actions' });
      for (const idx of pendingIndices) {
        const cb = el('input', { type: 'checkbox', class: 'review-entry-check' });
        cb.dataset.index = String(idx);
        checkRow.append(el('label', null, cb, `#${idx}`));
      }
      pane.append(checkRow);
    }
    pane.append(actions, msg);
  }

  async function resolveDreamEntries(dreamId, action, entryIndices, msgEl, btns) {
    for (const b of btns) b.disabled = true;
    msgEl.className = 'review-msg';
    msgEl.textContent = `${action}…`;
    try {
      const body = { action };
      if (Array.isArray(entryIndices) && entryIndices.length > 0) body.entry_indices = entryIndices;
      const r = await fetch(`/api/dreams/${dreamId}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (r.status === 423) {
        msgEl.className = 'review-msg review-msg-err';
        msgEl.textContent = 'consolidation lock held elsewhere — retry shortly';
        for (const b of btns) b.disabled = false;
        return;
      }
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        msgEl.className = 'review-msg review-msg-err';
        msgEl.textContent = `resolve failed (${r.status}) ${j.error || ''}`.trim();
        for (const b of btns) b.disabled = false;
        return;
      }
      msgEl.className = 'review-msg review-msg-ok';
      msgEl.textContent = `${action} applied`;
      // Re-fetch list + this diff to reflect new resolutions.
      await loadPendingDreams();
      if (reviewSelectedId === dreamId) await loadDreamDiff(dreamId, false);
    } catch (err) {
      console.error('resolve failed', err);
      msgEl.className = 'review-msg review-msg-err';
      msgEl.textContent = 'resolve request failed';
      for (const b of btns) b.disabled = false;
    }
  }

  function startReviewPolling() {
    if (reviewTimer) return;
    refreshReviewTab();
    loadReviewControls(); // config knobs load on activation + explicit refresh, not the poll (PATCH re-renders them)
    reviewTimer = setInterval(refreshReviewTab, REVIEW_POLL_MS);
  }

  function stopReviewPolling() {
    if (reviewTimer) { clearInterval(reviewTimer); reviewTimer = null; }
    setReviewStatus('idle');
  }

  {
    const refreshBtn = document.getElementById('review-refresh');
    if (refreshBtn) refreshBtn.addEventListener('click', () => { refreshReviewTab(); loadReviewControls(); });
  }

  for (const btn of tabBtns) {
    btn.addEventListener('click', () => setTab(btn.dataset.tab));
  }

  // Restore last tab. Default to graph so first-paint doesn't kick off SSE.
  let saved = null;
  try { saved = localStorage.getItem(TAB_KEY); } catch {}
  const validTabs = new Set(['graph', 'live', 'ops', 'replay', 'review', 'slots']);
  setTab(validTabs.has(saved) ? saved : 'graph');
}

// Sidebar collapse toggles. State persists per side via localStorage. After
// toggling, re-render the graph so the force layout reflows into the new
// canvas width.
{
  const STORAGE = { left: 'kopeng-viz-left-collapsed', right: 'kopeng-viz-right-collapsed' };
  function applyCollapsed(side, collapsed) {
    document.body.dataset[side === 'left' ? 'leftCollapsed' : 'rightCollapsed'] = collapsed ? 'true' : 'false';
    const btn = document.querySelector(`.aside-toggle[data-target="${side}"]`);
    if (btn) btn.title = collapsed ? 'Expand' : 'Collapse';
  }
  // Defaults on first visit: left collapsed (stores+legend), right open
  // (filters are the more frequent interaction). Stored values override.
  const DEFAULT_COLLAPSED = { left: true, right: false };
  for (const side of ['left', 'right']) {
    let stored = null;
    try { stored = localStorage.getItem(STORAGE[side]); } catch {}
    const collapsed = stored === null ? DEFAULT_COLLAPSED[side] : stored === 'true';
    applyCollapsed(side, collapsed);
  }
  for (const btn of document.querySelectorAll('.aside-toggle')) {
    btn.addEventListener('click', () => {
      const side = btn.dataset.target;
      const key = side === 'left' ? 'leftCollapsed' : 'rightCollapsed';
      const next = document.body.dataset[key] !== 'true';
      try { localStorage.setItem(STORAGE[side], next ? 'true' : 'false'); } catch {}
      applyCollapsed(side, next);
      // Reflow the force graph after the grid transition lands.
      setTimeout(() => { if (lastStats) renderGraph(); }, 180);
    });
  }
}

{
  const body = document.body;
  function closeDrawers() { delete body.dataset.leftDrawer; delete body.dataset.rightDrawer; }
  function openDrawer(side) { closeDrawers(); body.dataset[side === 'left' ? 'leftDrawer' : 'rightDrawer'] = 'open'; }
  const lb = document.getElementById('drawer-left-btn');
  const rb = document.getElementById('drawer-right-btn');
  if (lb) lb.addEventListener('click', () => openDrawer('left'));
  if (rb) rb.addEventListener('click', () => openDrawer('right'));
  const backdrop = document.getElementById('drawer-backdrop');
  if (backdrop) backdrop.addEventListener('click', closeDrawers);
  for (const b of document.querySelectorAll('[data-drawer-close]')) b.addEventListener('click', closeDrawers);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawers(); });
  let drawerResizeT;
  window.addEventListener('resize', () => {
    clearTimeout(drawerResizeT);
    drawerResizeT = setTimeout(() => {
      const w = window.innerWidth;
      if (w >= 1280) { closeDrawers(); return; }
      if (w >= 768 && body.dataset.rightDrawer) delete body.dataset.rightDrawer;
    }, 150);
  });
}

load();
