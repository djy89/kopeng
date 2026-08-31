/**
 * The `~/.kopeng` install layout (Task 2.1.2). Pure constants, no side
 * effects — nothing here creates a directory or touches the filesystem.
 * `init`/`ensure`/`uninstall` (later tasks) are the only callers that create
 * or remove any of these paths.
 */

import os from 'node:os';
import path from 'node:path';

/** Root of the install; overridable for tests and multi-instance setups. */
export const KOPENG_HOME = path.resolve(process.env.KOPENG_HOME || path.join(os.homedir(), '.kopeng'));

/** The installed server + CLI (`npm install --prefix` target). */
export const APP_DIR = path.join(KOPENG_HOME, 'app');

/** SQLite database(s) — memory.db, observations.db. */
export const DATA_DIR = path.join(KOPENG_HOME, 'data');

/** Cached embedding + reranker models (transformers cache dir). */
export const MODELS_DIR = path.join(KOPENG_HOME, 'models');

/** Server log output. */
export const LOGS_DIR = path.join(KOPENG_HOME, 'logs');

/** The install-wide .env (ABSOLUTE paths for DATABASE_PATH, MODELS_CACHE_DIR, etc.). */
export const ENV_FILE = path.join(KOPENG_HOME, '.env');
