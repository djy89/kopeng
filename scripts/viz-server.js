// KOPENG visualizer host: tiny static + API-proxy server (Node stdlib only).
// Run with: npm run viz   →   open http://localhost:8780

import http from 'node:http';
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import dotenv from 'dotenv';
import { isEntrypoint } from './hooks/entrypoint.mjs';

const PORT = parseInt(process.env.VIZ_PORT || '8780', 10);
const API = process.env.KOPENG_API_URL || 'http://localhost:3200';
const ROOT = fileURLToPath(new URL('../viz/', import.meta.url));

// T27: the mutating operator endpoints (operator-config PATCH, dream
// resolve/trigger, promote, rollback) are admin-key gated when the server has
// ADMIN_API_KEY set. The proxy injects the key server-side so the browser
// never holds it. Env wins; falls back to the repo .env so `npm run viz`
// keeps working with zero extra setup.
// CX-3: same parser + precedence as resolveAdminKey (src/config/first-run.ts)
// — dotenv semantics (last assignment wins, quotes stripped), non-empty env
// only — so the viz can never resolve a different key than the server.
export function loadAdminKey(envPath = new URL('../.env', import.meta.url)) {
  if (process.env.ADMIN_API_KEY) return process.env.ADMIN_API_KEY;
  try {
    return dotenv.parse(readFileSync(envPath, 'utf8')).ADMIN_API_KEY ?? '';
  } catch {
    return '';
  }
}
const ADMIN_KEY = loadAdminKey();

// Bind loopback by default. The proxy injects ADMIN_API_KEY into admin requests,
// so a wildcard bind would hand admin power to anyone who can reach this port
// without knowing the key. Remote binding is an explicit opt-in (VIZ_HOST).
const HOST = process.env.VIZ_HOST || '127.0.0.1';

// A remote (non-loopback) bind opens the viz to the network. Admin-key injection
// is then a SECOND, explicit opt-in (VIZ_ALLOW_REMOTE_ADMIN=1) — so binding the
// viz for read-only viewing over a VPN does not also hand admin mutations to
// every peer that can reach the port. Loopback binds inject admin as normal.
/** Pure so the bind policy is unit-testable (tests/unit/viz-remote-readonly.test.ts).
 * MUST agree with isLoopbackHost in src/config/first-run.ts (CX-4 semantics:
 * localhost | ::1 | a real v4 address in 127/8) — the server and the viz
 * deciding "loopback" differently for the same host (e.g. 127.0.0.2) would
 * strand the viz read-only on an install the server treats as local. The
 * agreement is pinned by tests/unit/viz-remote-readonly.test.ts. */
export function isLoopbackHost(host) {
  if (host === 'localhost' || host === '::1') return true;
  return net.isIP(host) === 4 && host.startsWith('127.');
}

const IS_LOOPBACK_BIND = isLoopbackHost(HOST);
const ALLOW_REMOTE_ADMIN = process.env.VIZ_ALLOW_REMOTE_ADMIN === '1' || process.env.VIZ_ALLOW_REMOTE_ADMIN === 'true';
const ADMIN_INJECTION_ENABLED = IS_LOOPBACK_BIND || ALLOW_REMOTE_ADMIN;

// Defense-in-depth: attach the admin key ONLY to the exact mutating operator
// routes it protects (T27), never to every proxied /api/* request. The primary
// control is the loopback bind above; this keeps the key off unrelated calls.
const ADMIN_ROUTES = [
  { method: 'PATCH', re: /^\/api\/operator-config(?:\?|$)/ },
  { method: 'POST', re: /^\/api\/dreams\/trigger(?:\?|$)/ },
  { method: 'POST', re: /^\/api\/dreams\/[^/]+\/resolve(?:\?|$)/ },
  { method: 'POST', re: /^\/api\/memories\/[^/]+\/rollback(?:\?|$)/ },
  { method: 'POST', re: /^\/api\/admin\/promote(?:\?|$)/ },
  { method: 'POST', re: /^\/api\/admin\/reindex(?:\?|$)/ },
  { method: 'POST', re: /^\/api\/admin\/backup(?:\?|$)/ },
  { method: 'POST', re: /^\/api\/discover(?:\?|$)/ },
  { method: 'POST', re: /^\/api\/admin\/discovery\/maintain(?:\?|$)/ },
];
function needsAdminKey(req) {
  return ADMIN_ROUTES.some((r) => r.method === req.method && r.re.test(req.url));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function safeJoin(base, requested) {
  const resolved = normalize(join(base, requested));
  if (!resolved.startsWith(base.replace(/[\\/]+$/, '') + sep) && resolved !== base.replace(/[\\/]+$/, '')) {
    return null;
  }
  return resolved;
}

// Strip the embedding column from memory list responses — saves ~95% of payload
// (~6 KB/row of base64 buffer per memory). The visualizer never reads embeddings.
// fields=lite requests skip the strip: the server already omits the column, so
// reparsing the body here would be pure waste. Parsed as a real query param —
// a substring test would also match e.g. ?tags=fields=lite.
function shouldStripEmbeddings(req) {
  if (req.method !== 'GET' || !req.url.startsWith('/api/memories') || req.url.includes('/related')) {
    return false;
  }
  try {
    return new URL(req.url, 'http://localhost').searchParams.get('fields') !== 'lite';
  } catch {
    return true;
  }
}

// Gzip text-ish bodies when the client allows it. gzipSync on typical bodies
// (up to a ~2 MB lite memory page) is a few ms — well under one round-trip
// saved — but it blocks this single-threaded proxy, so very large bodies
// (e.g. /api/observations/by-session at high limits) pass through uncompressed.
// Streaming (SSE) responses never reach this path.
const GZIP_MAX_BYTES = 8 * 1024 * 1024;
function maybeGzip(req, headers, buf, contentType) {
  if (buf.length < 1024 || buf.length > GZIP_MAX_BYTES) return buf;
  if (!/gzip/.test(req.headers['accept-encoding'] || '')) return buf;
  if (!/json|javascript|css|html|svg|text\//.test(contentType || '')) return buf;
  headers['content-encoding'] = 'gzip';
  headers['vary'] = 'accept-encoding';
  return gzipSync(buf);
}

function stripEmbeddingFromBody(buf) {
  try {
    const json = JSON.parse(buf.toString('utf8'));
    if (json && Array.isArray(json.data)) {
      for (const m of json.data) {
        if (m && 'embedding' in m) m.embedding = null;
      }
    } else if (json && json.data && 'embedding' in json.data) {
      json.data.embedding = null;
    }
    return Buffer.from(JSON.stringify(json), 'utf8');
  } catch {
    return buf;
  }
}

// SSE / streaming endpoints can't be buffered as arrayBuffer — they never
// "end" until the client disconnects. Detect them up front and stream-pipe.
function isStreamingRequest(req) {
  if (req.url.startsWith('/api/observations/stream')) return true;
  const accept = req.headers.accept || '';
  return accept.includes('text/event-stream');
}

/**
 * Remote read-only enforcement (sweep-3 PB-3).
 *
 * Withholding the admin key only stops routes that REQUIRE it. This proxy
 * forwards every method and body, so before PB-2 gated core CRUD a remote
 * viewer could POST /api/memories straight through — "read-only remote viz"
 * was never true. PB-2 closes that whenever ADMIN_API_KEY is set, but the
 * shipped default sets no key at all, and then every gate is open again.
 *
 * So the method restriction lives here too, where it holds regardless of key
 * configuration: on a non-loopback bind without the remote-admin opt-in, only
 * GET/HEAD (plus the SSE stream, which is a GET) reach the upstream.
 */
export function isReadOnlyBlocked(method, adminInjectionEnabled = ADMIN_INJECTION_ENABLED) {
  if (adminInjectionEnabled) return false; // loopback, or remote admin opted in
  return method !== 'GET' && method !== 'HEAD';
}

async function proxyApi(req, res) {
  if (isReadOnlyBlocked(req.method)) {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: 'Remote viz is read-only',
      detail: `${req.method} is refused on a non-loopback bind. Set VIZ_ALLOW_REMOTE_ADMIN=1 to permit mutations from remote clients.`,
    }));
    return;
  }

  const target = new URL(req.url, API);
  const headers = { ...req.headers };
  delete headers.host;
  delete headers['content-length'];
  if (ADMIN_KEY && ADMIN_INJECTION_ENABLED && needsAdminKey(req)) headers['x-api-key'] = ADMIN_KEY;

  const init = { method: req.method, headers };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (chunks.length) init.body = Buffer.concat(chunks);
  }

  const streaming = isStreamingRequest(req);

  try {
    const upstream = await fetch(target, init);

    if (streaming) {
      const outHeaders = {};
      upstream.headers.forEach((v, k) => {
        const kl = k.toLowerCase();
        // Keep content-type (text/event-stream), drop anything that
        // implies a fixed-length or compressed body.
        if (kl === 'content-encoding' || kl === 'content-length') return;
        outHeaders[k] = v;
      });
      // Force flushing — disable Nagle and any node-level chunk buffering.
      res.writeHead(upstream.status, outHeaders);
      res.flushHeaders?.();
      if (!upstream.body) {
        res.end();
        return;
      }
      const nodeStream = Readable.fromWeb(upstream.body);
      // If the client disconnects, stop pulling from upstream so the
      // upstream SSE consumer count decrements.
      const abort = () => { nodeStream.destroy(); };
      res.on('close', abort);
      res.on('error', abort);
      nodeStream.pipe(res);
      return;
    }

    let buf = Buffer.from(await upstream.arrayBuffer());
    if (shouldStripEmbeddings(req) && upstream.headers.get('content-type')?.includes('json')) {
      buf = stripEmbeddingFromBody(buf);
    }
    const outHeaders = {};
    upstream.headers.forEach((v, k) => {
      const kl = k.toLowerCase();
      if (kl === 'content-encoding' || kl === 'transfer-encoding' || kl === 'content-length') return;
      outHeaders[k] = v;
    });
    buf = maybeGzip(req, outHeaders, buf, upstream.headers.get('content-type'));
    outHeaders['content-length'] = String(buf.length);
    res.writeHead(upstream.status, outHeaders);
    res.end(buf);
  } catch (err) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'upstream_unreachable', detail: String(err), api: API }));
  }
}

async function serveStatic(req, res) {
  const urlPath = decodeURIComponent((req.url.split('?')[0] || '/'));
  const requested = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = safeJoin(ROOT, requested);
  if (!filePath) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  try {
    let data = await readFile(filePath);
    const contentType = MIME[extname(filePath)] || 'application/octet-stream';
    const headers = { 'content-type': contentType, 'cache-control': 'no-cache' };
    data = maybeGzip(req, headers, data, contentType);
    res.writeHead(200, headers);
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
}

// Server-side probe of optional KOPENG services. The viz UI calls this once,
// instead of making 3 cross-origin probes that surface as 404s in the console.
async function probeUpstream(path) {
  try {
    const r = await fetch(new URL(path, API));
    return r.status !== 404 && r.status !== 502;
  } catch {
    return false;
  }
}
async function handleCapabilities(req, res) {
  const [neo4j, redis, minio] = await Promise.all([
    probeUpstream('/api/graph/stats'),
    probeUpstream('/api/context'),
    probeUpstream('/api/storage/stats'),
  ]);
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ neo4j, redis, minio }));
}

const server = http.createServer((req, res) => {
  if (req.url === '/viz/capabilities' && req.method === 'GET') {
    handleCapabilities(req, res);
  } else if (req.url.startsWith('/api/')) {
    proxyApi(req, res);
  } else {
    serveStatic(req, res);
  }
});

// Listen only when invoked directly (mirrors kopeng-observe.js / memory-prompt-search.mjs)
// so the unit suite can import the pure bind-policy helpers without starting a server.
// Symlink-safe (T72) — see scripts/hooks/entrypoint.mjs.
const isMain = isEntrypoint(import.meta.url);
if (isMain) server.listen(PORT, HOST, () => {
  const shownHost = HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST;
  console.log(`KOPENG Viz → http://${shownHost}:${PORT}`);
  console.log(`Proxying /api/* → ${API}`);
  if (!IS_LOOPBACK_BIND) {
    console.warn(
      ADMIN_INJECTION_ENABLED
        ? '⚠ VIZ_HOST binds a non-loopback interface AND VIZ_ALLOW_REMOTE_ADMIN is set — every peer that can reach this port gets full admin access. Only do this behind a trusted VPN.'
        : '⚠ VIZ_HOST binds a non-loopback interface — the viz is reachable remotely, but admin mutations are NOT injected. Set VIZ_ALLOW_REMOTE_ADMIN=1 to enable remote admin (VPN-only).'
    );
  }
});
