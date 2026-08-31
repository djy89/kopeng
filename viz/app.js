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

  async function pollOpsFast() {
    if (activeTab !== 'ops') return;
    setOpsStatus('fetching…');
    try {
      const [disc, reasoner, prom, conf, cache, dream] = await Promise.all([
        fetchOps('/api/ops/discovery-status').catch(() => UNREACHABLE),
        fetchOps('/api/ops/reasoner-status').catch(() => UNREACHABLE),
        fetchOps('/api/ops/last-promotion').catch(() => UNREACHABLE),
        fetchOps('/api/ops/confidence-distribution').catch(() => UNREACHABLE),
        fetchOps('/api/ops/cache-stats').catch(() => UNREACHABLE),
        fetchOps('/api/ops/dream-history?limit=15').catch(() => UNREACHABLE),
      ]);
      renderDiscoveryStatus(disc);
      renderReasonerStatus(reasoner);
      renderLastPromotion(prom);
      renderConfidence(conf);
      renderCacheStats(cache);
      renderDreamHistory(dream);
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
          el('td', { title: d.window_key }, d.mode === 'whole_corpus' ? 'whole' : (d.window_key || '—')),
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
