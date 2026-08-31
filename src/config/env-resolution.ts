/**
 * The packaged-install `.env` resolution (Task 2.3.1, Ruling 7/8) — pulled
 * into its OWN tiny, dependency-light module (review finding 4) so that
 * `src/index.ts` (the MCP stdio entry point) can consult the SAME resolution
 * `src/config/config.ts` uses without importing config.ts wholesale. config.ts
 * eagerly reads and validates every env var at module-load time (e.g. throws
 * on a malformed `ACCESS_LOG_RETENTION_DAYS`) — fine for the REST server,
 * which wants to fail loudly on bad config, but wrong for a stdio entry that
 * should still answer `--version`/tool listing even with a poisoned launch
 * environment. This module has none of that: no dotenv side effect, no env
 * validation, just the pure resolution function.
 */
import fs from 'fs';
import path from 'path';

export interface EnvFileResolutionInputs {
  /** Launch environment to consult for the explicit override. */
  env: NodeJS.ProcessEnv;
  /** Repo/app root — `<projectRoot>/.env` is the from-source candidate. */
  projectRoot: string;
  /** `~/.kopeng/.env` (honors KOPENG_HOME) — the packaged-install fallback. */
  packagedEnvFile: string;
}

/** True iff `dirPath` has a `node_modules` path segment — the shape of an
 *  installed package's location (`~/.kopeng/app/node_modules/kopeng`), never
 *  a from-source checkout. Splits on both separators and folds case, since
 *  the string might be built with either on Windows. */
function isInsideNodeModules(dirPath: string): boolean {
  return dirPath.split(/[/\\]+/).some((segment) => segment.toLowerCase() === 'node_modules');
}

/**
 * Ruling 8 (Task 2.3, binding controller ruling — refines Ruling 7):
 * `KOPENG_ENV_FILE` (explicit) wins outright. Otherwise tier 2
 * (`<projectRoot>/.env`) applies whenever that file EXISTS **or**
 * `projectRoot` is not inside a `node_modules` path — so every from-source
 * checkout keeps pre-Ruling-7 behavior byte-identical, `.env` present or not
 * (first-run still creates the repo `.env` there). `~/.kopeng/.env` is
 * EXCLUSIVELY the packaged fallback: reached only when projectRoot is
 * node_modules-resident AND has no local `.env` of its own. Pure and
 * side-effect-free so it's directly unit-testable without reloading a caller
 * module.
 */
export function resolveEnvFile(inputs: EnvFileResolutionInputs): string {
  if (inputs.env.KOPENG_ENV_FILE) return inputs.env.KOPENG_ENV_FILE;
  const projectEnvFile = path.join(inputs.projectRoot, '.env');
  const packaged = isInsideNodeModules(inputs.projectRoot);
  if (!packaged || fs.existsSync(projectEnvFile)) return projectEnvFile;
  return inputs.packagedEnvFile;
}
