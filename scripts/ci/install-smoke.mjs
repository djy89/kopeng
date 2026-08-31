/**
 * install-smoke.mjs (Task 2.5.1, Install Strategy release pipeline).
 *
 * NO SHEBANG, deliberately. This file is always invoked as
 * `node scripts/ci/install-smoke.mjs` (release.yml, docs/ops/release.md) and is
 * mode 644, so a shebang could never be used — but it DID break Windows CI:
 * `tests/unit/install-smoke-helpers.test.ts` imports the pure helpers from
 * here, and while Node strips a shebang natively, Vite/esbuild's transform does
 * not. vitest externalizes this module on Linux (so Node loads it and the
 * shebang is stripped) but inlined and transformed it on Windows, where it
 * failed to parse with `SyntaxError: Invalid or unexpected token` at line 1.
 * It was the only test-imported module in the repo carrying a shebang.
 *
 * A REAL end-to-end install test of a packed `kopeng` tarball, run by
 * `release.yml` on every target platform before a publish is ever allowed.
 * Node builtins only — no npm dependencies of its own, since it has to run
 * before anything it might depend on is even installed.
 *
 * Flow (numbered to match the task brief):
 *   1. Create a sandbox: SMOKE_HOME (fake user home, seeded with minimal
 *      client configs) + SMOKE_KOPENG_HOME (fake ~/.kopeng), under a temp
 *      root.
 *   2. `npm install --prefix <sandbox>/prefix <tarball>` — a bootstrap
 *      install, just enough to have a runnable `kopeng` CLI (this mirrors
 *      what `npx kopeng@x` does for a real user before `init` runs its OWN
 *      install into ~/.kopeng/app).
 *   3. Run the INSTALLED CLI's `init --non-interactive --profile minimal
 *      --no-autostart --port 3299 --from <tarball>` with HOME/USERPROFILE/
 *      KOPENG_HOME redirected into the sandbox.
 *   4. Assert: the server answers on 3299, `.env` carries a generated
 *      ADMIN_API_KEY, the ensure knob exists, and the client configs were
 *      wired (an MCP entry + all 5 hooks).
 *   5. Run `canary` via the installed CLI — a real store -> embed -> recall
 *      round trip against the server init just started (the real embedding
 *      model init downloaded, not a fake).
 *   6. Run `uninstall --yes` (data kept) and assert it actually removed the
 *      client wiring and the app dir while leaving data behind; then run
 *      `uninstall --yes --purge` on the SAME sandbox and assert nothing is
 *      left under SMOKE_KOPENG_HOME.
 *   7. ALWAYS (success or failure) try to stop any server left running on
 *      the sandbox port — first the graceful shutdown endpoint with the
 *      admin key this run generated, then (only if that didn't work) a
 *      platform-specific "whatever is listening on this port" kill — before
 *      deleting the sandbox. A leaked node process would otherwise hang the
 *      CI job.
 *   8. On any failure, exit non-zero naming exactly which numbered step
 *      failed, with the underlying detail — never a bare non-zero exit.
 *
 * This script is exercised by CI (and the one sanctioned local run — see
 * the task's Acceptance section), never by `npm test`: only the pure
 * helpers below are imported by tests/unit/install-smoke-helpers.test.ts.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// ─────────────────────────────────────────────────────────────────────────
// Pure helpers — no fs/network/spawn. Unit-tested directly.
// ─────────────────────────────────────────────────────────────────────────

/** Reads the tarball path off argv (argv[2] when this file is run directly). */
export function parseTarballArg(argv) {
  const tarball = argv[2];
  if (!tarball) {
    throw new Error('Usage: node scripts/ci/install-smoke.mjs <tarball-path>');
  }
  return tarball;
}

export function npmBinaryName(platform = process.platform) {
  return platform === 'win32' ? 'npm.cmd' : 'npm';
}

// Keys that could otherwise leak the operator's real install (or a stray
// value from a prior export in the same shell) into the sandboxed CLI runs.
// Everything else in baseEnv (PATH, TEMP, SystemRoot, etc.) passes through
// untouched — the sandbox only needs to redirect where KOPENG looks for its
// home and config, not rebuild the whole environment from scratch.
const SANDBOX_STRIP_KEYS = [
  'HOME', 'USERPROFILE', 'KOPENG_HOME', 'KOPENG_ENV_FILE',
  'PORT', 'HOST', 'MEMORY_API_URL', 'KOPENG_API_URL', 'ADMIN_API_KEY',
  'DATABASE_PATH', 'MODELS_CACHE_DIR',
];

/** The {HOME, USERPROFILE, KOPENG_HOME, ...} env the installed CLI runs under. */
export function buildSandboxEnv(baseEnv, sandbox) {
  const env = { ...baseEnv };
  for (const key of SANDBOX_STRIP_KEYS) delete env[key];
  env.HOME = sandbox.home;
  env.USERPROFILE = sandbox.home;
  env.KOPENG_HOME = sandbox.kopengHome;
  return env;
}

/** Layers the canary's target URL + admin key onto an already-sandboxed env. */
export function withCanaryEnv(env, canary) {
  return { ...env, KOPENG_API_URL: canary.apiUrl, ADMIN_API_KEY: canary.adminKey };
}

/** Scans a raw `.env` file's text for a non-empty ADMIN_API_KEY line. */
export function scanForAdminKey(envFileText) {
  const match = /^ADMIN_API_KEY=(.*)$/m.exec(envFileText);
  const value = match ? match[1].trim() : '';
  if (!value) {
    return { ok: false, adminKey: '', detail: '.env has no non-empty ADMIN_API_KEY line' };
  }
  return { ok: true, adminKey: value };
}

const KOPENG_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SessionEnd'];

function safeParseJson(text) {
  try {
    const value = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/**
 * Confirms `wireClient` (src/cli/wire-client.ts) actually wired the sandbox
 * client configs: an `mcpServers.kopeng` entry, and a kopeng-owned hook
 * command in all 5 hook events it manages.
 */
export function scanClientWiring(claudeJsonText, settingsJsonText) {
  const claudeConfig = safeParseJson(claudeJsonText);
  const settings = safeParseJson(settingsJsonText);

  const mcpServers = claudeConfig.mcpServers;
  const hasKopengMcp = Boolean(
    mcpServers && typeof mcpServers === 'object' && !Array.isArray(mcpServers) && mcpServers.kopeng
  );

  const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  const wiredEvents = KOPENG_HOOK_EVENTS.filter((event) => {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    return groups.some(
      (group) =>
        group &&
        typeof group === 'object' &&
        Array.isArray(group.hooks) &&
        group.hooks.some(
          (hook) =>
            hook &&
            typeof hook === 'object' &&
            typeof hook.command === 'string' &&
            hook.command.replace(/\\/g, '/').includes('/scripts/hooks/')
        )
    );
  });

  return { hasKopengMcp, wiredEvents, hookCount: wiredEvents.length };
}

/** Plain string scan for leftover "kopeng" text — what `uninstall` promises to remove. */
export function scanForKopengResidue(claudeJsonText, settingsJsonText) {
  return { hasResidue: /kopeng/i.test(claudeJsonText) || /kopeng/i.test(settingsJsonText) };
}

/** Classifies a parsed GET /api/health body against "server answers" (ready or degraded). */
export function classifyHealthBody(body) {
  const status = body && typeof body === 'object' && body.data && typeof body.data === 'object'
    ? body.data.status
    : undefined;
  if (status === 'ready' || status === 'degraded') return { ok: true, status };
  if (typeof status === 'string') {
    return { ok: false, status, detail: `server answered /api/health but reported status '${status}' (expected ready or degraded)` };
  }
  return { ok: false, status: undefined, detail: 'server did not answer /api/health with the expected {data:{status}} shape' };
}

/** True for a body carrying the `{data:{status}}` shape a KOPENG /api/health
 *  answers with, whatever the status value — the gate on whether the sandbox's
 *  admin key may be sent to whatever holds the port (mirrors the same guard in
 *  src/cli/uninstall.ts). Deliberately WIDER than classifyHealthBody's ok:
 *  a KOPENG server reporting some status other than ready/degraded is still a
 *  KOPENG server and can still be asked to shut itself down. */
export function isKopengHealthShape(body) {
  const result = classifyHealthBody(body);
  return result.ok || typeof result.status === 'string';
}

/** The one-line, non-stack-trace diagnosis printed on any failure. */
export function formatStepFailure(step, err) {
  const message = err instanceof Error ? err.message : String(err);
  return `install-smoke FAILED at step '${step}': ${message}`;
}

// ─────────────────────────────────────────────────────────────────────────
// Orchestration — real fs/network/spawn. Exercised by CI/local runs only.
// ─────────────────────────────────────────────────────────────────────────

const PORT = 3299;

class StepError extends Error {
  constructor(step, cause) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.step = step;
    this.cause = cause;
  }
}

function log(step, message) {
  console.log(`[install-smoke] ${step}: ${message}`);
}

async function runStep(name, fn) {
  log(name, 'starting');
  try {
    const result = await fn();
    log(name, 'ok');
    return result;
  } catch (err) {
    throw err instanceof StepError ? err : new StepError(name, err);
  }
}

function spawnInherit(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', windowsHide: true, ...options });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

function execCapture(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.on('error', () => resolve({ code: 1, stdout: '' }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout }));
  });
}

async function fetchJsonSafe(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    try { return await res.json(); } catch { return null; }
  } catch {
    return null;
  }
}

function seedClientConfigs(home) {
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, '.claude.json'), '{}\n', 'utf8');
  const claudeDir = path.join(home, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(path.join(claudeDir, 'settings.json'), '{}\n', 'utf8');
}

async function waitForPortFree(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) });
    } catch {
      return true; // connection refused / no response — the port is free
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Polls /api/health until it answers ready/degraded, or the timeout elapses. */
async function waitForHealthy(apiUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const body = await fetchJsonSafe(`${apiUrl}/api/health`);
    if (body) {
      const result = classifyHealthBody(body);
      if (result.ok) return result;
    }
    if (Date.now() >= deadline) {
      return { ok: false, detail: `no healthy /api/health response from ${apiUrl} within ${timeoutMs}ms` };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Best-effort, platform-specific "whatever is listening on this port" kill —
 *  the fallback for when the graceful shutdown endpoint didn't reach a real
 *  server (e.g. init failed before writing an admin key). Never throws. */
async function killProcessOnPort(port) {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execCapture('netstat', ['-ano']);
      for (const line of stdout.split(/\r?\n/)) {
        if (!/LISTENING/i.test(line)) continue;
        const columns = line.trim().split(/\s+/);
        const localAddress = columns[1];
        const pid = columns[columns.length - 1];
        if (localAddress && localAddress.endsWith(`:${port}`) && /^\d+$/.test(pid)) {
          await execCapture('taskkill', ['/F', '/PID', pid]);
          return true;
        }
      }
      return false;
    }
    const { stdout } = await execCapture('lsof', ['-ti', `tcp:${port}`]);
    const pids = stdout.split(/\s+/).map((s) => s.trim()).filter((s) => /^\d+$/.test(s));
    if (pids.length === 0) return false;
    for (const pid of pids) await execCapture('kill', ['-9', pid]);
    return true;
  } catch {
    return false;
  }
}

/** Step 7: always attempt to stop a leftover server, shutdown-endpoint first. */
async function killLeftoverServer(kopengHome, port) {
  let adminKey = '';
  try {
    const envPath = path.join(kopengHome, '.env');
    if (existsSync(envPath)) {
      const scan = scanForAdminKey(readFileSync(envPath, 'utf8'));
      if (scan.ok) adminKey = scan.adminKey;
    }
  } catch { /* best-effort — proceed with no key */ }

  // Probe before sending the key (same guard as src/cli/uninstall.ts's
  // stopServer): the sandbox key must not be handed to a foreign listener
  // that happens to hold PORT. CI-sandbox-only, so the risk is low — but the
  // two paths having different rules about who gets an admin key is exactly
  // how the real one would drift back.
  const health = await fetchJsonSafe(`http://127.0.0.1:${port}/api/health`);
  const isKopeng = health !== null && isKopengHealthShape(health);

  let shutdownAccepted = false;
  if (!isKopeng) {
    log('cleanup', `no KOPENG server answered /api/health on port ${port} — withholding the admin key and going straight to the port kill`);
  } else {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/admin/shutdown`, {
        method: 'POST',
        headers: adminKey ? { 'x-api-key': adminKey } : {},
        signal: AbortSignal.timeout(2000),
      });
      shutdownAccepted = res.ok || res.status === 202;
    } catch { /* went away between the probe and the POST — fine */ }
  }

  if (shutdownAccepted) {
    const wentQuiet = await waitForPortFree(port, 5000);
    if (wentQuiet) {
      log('cleanup', `stopped the sandbox server on port ${port} via the shutdown endpoint`);
      return;
    }
    log('cleanup', `shutdown was accepted on port ${port} but it did not go quiet within 5s — falling back to a port kill`);
  }

  const killed = await killProcessOnPort(port);
  log('cleanup', killed
    ? `killed a leftover process on port ${port} by PID (the shutdown endpoint did not reach it)`
    : `no leftover process found listening on port ${port}`);
}

async function main() {
  const tarball = parseTarballArg(process.argv);
  const resolvedTarball = path.resolve(tarball);

  // Do NOT realpath this. On macOS os.tmpdir() is /var/folders/... and /var is
  // a symlink to /private/var, which is exactly how this smoke caught T72: the
  // CLI's entry guard compared a non-realpath'd process.argv[1] against an
  // already-realpath'd import.meta.url, read false, and `kopeng init` exited 0
  // having printed nothing and written no .env. Installing through a symlinked
  // path is free coverage for every pnpm and `npm link` user; keep it.
  const rootDir = process.env.INSTALL_SMOKE_ROOT ? path.resolve(process.env.INSTALL_SMOKE_ROOT) : os.tmpdir();
  mkdirSync(rootDir, { recursive: true });
  const sandboxRoot = mkdtempSync(path.join(rootDir, 'kopeng-smoke-'));
  const home = path.join(sandboxRoot, 'home');
  const kopengHome = path.join(sandboxRoot, 'kopeng-home');
  const prefixDir = path.join(sandboxRoot, 'prefix');
  const claudeJsonPath = path.join(home, '.claude.json');
  const settingsJsonPath = path.join(home, '.claude', 'settings.json');
  const apiUrl = `http://127.0.0.1:${PORT}`;

  log('sandbox', `root=${sandboxRoot} tarball=${resolvedTarball}`);

  try {
    await runStep('sandbox', async () => {
      if (!existsSync(resolvedTarball)) throw new Error(`tarball not found: ${resolvedTarball}`);
      seedClientConfigs(home);
      mkdirSync(kopengHome, { recursive: true });
    });

    let cliEntry;
    await runStep('npm-install', async () => {
      mkdirSync(prefixDir, { recursive: true });
      // shell: true on win32 — npm.cmd is a batch file; child_process.spawn
      // cannot execute one directly (Windows CreateProcess needs cmd.exe to
      // interpret it), the same fix tests/unit/npm-pack-contents.test.ts
      // already applies to its own execFileSync(NPM_BIN, ...) call. Found
      // live: a bare spawn('npm.cmd', ...) throws a synchronous `spawn
      // EINVAL` before this promise's executor even returns.
      const code = await spawnInherit(npmBinaryName(), ['install', '--prefix', prefixDir, resolvedTarball], {
        cwd: sandboxRoot,
        env: process.env,
        shell: process.platform === 'win32',
      });
      if (code !== 0) throw new Error(`npm install exited with code ${code}`);
      cliEntry = path.join(prefixDir, 'node_modules', 'kopeng', 'dist', 'cli', 'index.js');
      if (!existsSync(cliEntry)) throw new Error(`installed CLI not found at ${cliEntry}`);
    });

    const sandboxEnv = buildSandboxEnv(process.env, { home, kopengHome });

    await runStep('init', async () => {
      const code = await spawnInherit(process.execPath, [
        cliEntry, 'init',
        '--non-interactive', '--profile', 'minimal',
        '--no-autostart', '--port', String(PORT),
        '--from', resolvedTarball,
      ], { cwd: sandboxRoot, env: sandboxEnv });
      if (code !== 0) throw new Error(`kopeng init exited with code ${code}`);

      const envFile = path.join(kopengHome, '.env');
      if (!existsSync(envFile)) throw new Error(`expected ${envFile} to exist after init`);
      const envScan = scanForAdminKey(readFileSync(envFile, 'utf8'));
      if (!envScan.ok) throw new Error(envScan.detail);

      const knobFile = path.join(kopengHome, 'ensure.json');
      if (!existsSync(knobFile)) throw new Error(`expected the ensure knob at ${knobFile}`);

      const wiring = scanClientWiring(readFileSync(claudeJsonPath, 'utf8'), readFileSync(settingsJsonPath, 'utf8'));
      if (!wiring.hasKopengMcp) throw new Error('client config has no mcpServers.kopeng entry');
      if (wiring.hookCount !== 5) {
        throw new Error(`expected 5 wired hook events, found ${wiring.hookCount} (${wiring.wiredEvents.join(', ') || 'none'})`);
      }

      const health = await fetchJsonSafe(`${apiUrl}/api/health`);
      const healthResult = classifyHealthBody(health);
      if (!healthResult.ok) throw new Error(healthResult.detail);
    });

    await runStep('canary', async () => {
      const envFile = path.join(kopengHome, '.env');
      const envScan = scanForAdminKey(readFileSync(envFile, 'utf8'));
      const canaryEnv = withCanaryEnv(sandboxEnv, { apiUrl: `http://localhost:${PORT}`, adminKey: envScan.adminKey });
      const code = await spawnInherit(process.execPath, [cliEntry, 'canary'], { cwd: sandboxRoot, env: canaryEnv });
      if (code !== 0) throw new Error(`kopeng canary exited with code ${code}`);
    });

    // Win32-only: proves boot-survival of the autostart .cmd shim (Finding 1
    // — an autostart-launched server's cwd is System32/`/`/$HOME, not
    // KOPENG_HOME, which used to crash the logger's mkdirSync at startup)
    // WITHOUT ever touching the real Task Scheduler. `autostart register`
    // itself runs schtasks, which this sandbox must never call, so instead:
    // generate the plan from the INSTALLED package's exported `planAutostart`,
    // write the shim files ourselves, and execute the .cmd directly (skipping
    // the .vbs hidden-window wrapper — the cwd/env setup under test lives in
    // the .cmd, not wscript).
    await runStep('autostart-shim', async () => {
      if (process.platform !== 'win32') {
        log('autostart-shim', 'skipped — win32-only (schtasks/.cmd shim is not applicable on this platform)');
        return;
      }

      // The server `init` left running must come down first: the shim spawns
      // a SECOND process on the same PORT, and a bind failure there would
      // otherwise be masked by the old process still answering healthy.
      await killLeftoverServer(kopengHome, PORT);
      if (!(await waitForPortFree(PORT, 5000))) {
        throw new Error(`port ${PORT} did not go quiet after stopping the init-started server`);
      }

      const autostartModule = path.join(kopengHome, 'app', 'node_modules', 'kopeng', 'dist', 'cli', 'autostart.js');
      if (!existsSync(autostartModule)) throw new Error(`installed autostart module not found at ${autostartModule}`);

      const autostartOpts = {
        nodePath: process.execPath,
        serverEntry: path.join(kopengHome, 'app', 'node_modules', 'kopeng', 'dist', 'server.js'),
        kopengHome,
        envFile: path.join(kopengHome, '.env'),
        homeDir: home,
        appDataDir: path.join(home, 'AppData', 'Roaming'),
      };
      // A tiny script run through the INSTALLED package (install-smoke.mjs
      // has zero deps of its own, and must not statically import a module
      // that only exists after the npm-install step) that builds the plan
      // and prints it as JSON; this script writes the files and runs the
      // .cmd itself — registerAutostart/schtasks is never called.
      const planScript =
        `(async () => {` +
        `const { planAutostart } = await import(${JSON.stringify(pathToFileURL(autostartModule).href)});` +
        `process.stdout.write(JSON.stringify(planAutostart('win32', ${JSON.stringify(autostartOpts)})));` +
        `})();`;
      const planResult = await execCapture(process.execPath, ['-e', planScript]);
      if (planResult.code !== 0 || !planResult.stdout.trim()) {
        throw new Error('failed to generate the win32 autostart plan via the installed package');
      }
      const plan = JSON.parse(planResult.stdout);

      for (const file of plan.files) {
        mkdirSync(path.dirname(file.path), { recursive: true });
        writeFileSync(file.path, file.content, 'utf8');
      }
      const cmdFile = plan.files.find((f) => f.path.toLowerCase().endsWith('.cmd'));
      if (!cmdFile) throw new Error('generated win32 autostart plan has no .cmd shim file');

      const shimChild = spawn(cmdFile.path, [], {
        cwd: kopengHome,
        shell: true,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      shimChild.unref();

      const healthResult = await waitForHealthy(apiUrl, 15000);
      if (!healthResult.ok) throw new Error(`shim-launched server did not become healthy: ${healthResult.detail}`);

      const logsDir = path.join(kopengHome, 'logs');
      if (!existsSync(logsDir)) {
        throw new Error(`expected logs to land under ${logsDir} (Finding 1: autostart cwd + absolute LOG_PATH)`);
      }

      // Stop the shim-launched server so `uninstall` (and the final cleanup)
      // don't race a process this step spawned independently.
      await killLeftoverServer(kopengHome, PORT);
      await waitForPortFree(PORT, 5000);
    });

    await runStep('uninstall', async () => {
      const code = await spawnInherit(process.execPath, [cliEntry, 'uninstall', '--yes'], { cwd: sandboxRoot, env: sandboxEnv });
      if (code !== 0) throw new Error(`kopeng uninstall exited with code ${code}`);

      const appDir = path.join(kopengHome, 'app');
      if (existsSync(appDir)) throw new Error(`expected ${appDir} to be removed`);
      const dataDir = path.join(kopengHome, 'data');
      if (!existsSync(dataDir)) throw new Error(`expected ${dataDir} to survive a plain uninstall`);

      const residue = scanForKopengResidue(readFileSync(claudeJsonPath, 'utf8'), readFileSync(settingsJsonPath, 'utf8'));
      if (residue.hasResidue) throw new Error('client configs still mention "kopeng" after uninstall');
    });

    await runStep('purge', async () => {
      const code = await spawnInherit(process.execPath, [cliEntry, 'uninstall', '--yes', '--purge'], { cwd: sandboxRoot, env: sandboxEnv });
      if (code !== 0) throw new Error(`kopeng uninstall --purge exited with code ${code}`);
      if (existsSync(kopengHome)) throw new Error(`expected ${kopengHome} to be fully removed after --purge`);
    });

    log('done', 'install smoke passed');
  } finally {
    await killLeftoverServer(kopengHome, PORT).catch((err) => {
      log('cleanup', `leftover-server cleanup itself failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    });
    try { rmSync(sandboxRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    const step = err instanceof StepError ? err.step : 'unknown';
    const cause = err instanceof StepError ? err.cause : err;
    console.error(formatStepFailure(step, cause));
    process.exitCode = 1;
  });
}
