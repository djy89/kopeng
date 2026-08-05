import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const projectRoot = path.resolve(__dirname, '../../');
dotenv.config({ path: path.join(projectRoot, '.env') });

function getEnvVar(name: string, defaultValue?: string): string {
  const value = process.env[name];
  if (!value && defaultValue === undefined) {
    throw new Error(`Environment variable ${name} is required but not set`);
  }
  return value || defaultValue || '';
}

function getEnvInt(name: string, defaultValue: number): number {
  const value = process.env[name];
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) throw new Error(`Environment variable ${name} must be an integer`);
  return parsed;
}

export const config = {
  server: {
    port: getEnvInt('PORT', 3200),
    // Loopback by default. With no .env at all, ADMIN_API_KEY and
    // OBSERVATION_API_KEY are both empty, which puts every gate in open dev mode
    // — so on a wildcard bind a first run exposed full memory read/write to the
    // whole network. Set HOST explicitly to bind wider, and read SECURITY.md
    // first: the API expects to sit behind a VPN or an authenticating proxy.
    host: getEnvVar('HOST', '127.0.0.1'),
    // T27: shared secret for the mutating operator endpoints (operator-config
    // PATCH, dream trigger/resolve, admin promote, rollback). Empty = open.
    adminApiKey: getEnvVar('ADMIN_API_KEY', ''),
  },
  database: {
    type: (getEnvVar('DATABASE_TYPE', 'sqlite') as 'sqlite' | 'postgres'),
    path: getEnvVar('DATABASE_PATH', path.join(projectRoot, 'data', 'memory.db')),
    backupPath: getEnvVar('BACKUP_PATH', path.join(projectRoot, 'data')),
    postgresUrl: getEnvVar('POSTGRES_URL', ''),
  },
  neo4j: {
    enabled: getEnvVar('NEO4J_ENABLED', 'false') === 'true',
    url: getEnvVar('NEO4J_URL', 'bolt://localhost:7687'),
    username: getEnvVar('NEO4J_USERNAME', 'neo4j'),
    password: getEnvVar('NEO4J_PASSWORD', ''),
  },
  redis: {
    enabled: getEnvVar('REDIS_ENABLED', 'false') === 'true',
    url: getEnvVar('REDIS_URL', 'redis://localhost:6379'),
    keyPrefix: getEnvVar('REDIS_KEY_PREFIX', 'memory:'),
    ttl: getEnvInt('REDIS_DEFAULT_TTL', 3600),
  },
  minio: {
    enabled: getEnvVar('MINIO_ENABLED', 'false') === 'true',
    endpoint: getEnvVar('MINIO_ENDPOINT', 'localhost'),
    port: getEnvInt('MINIO_PORT', 9000),
    useSSL: getEnvVar('MINIO_USE_SSL', 'false') === 'true',
    accessKey: getEnvVar('MINIO_ACCESS_KEY', ''),
    secretKey: getEnvVar('MINIO_SECRET_KEY', ''),
    bucket: getEnvVar('MINIO_BUCKET', 'memory-artifacts'),
  },
  embedding: {
    model: getEnvVar('EMBEDDING_MODEL', 'Xenova/all-MiniLM-L6-v2'),
    cacheDir: getEnvVar('MODELS_CACHE_DIR', path.join(projectRoot, 'models')),
    dimensions: 384,
    maxWarning: 25000,
  },
  logging: {
    level: getEnvVar('LOG_LEVEL', 'info'),
    path: getEnvVar('LOG_PATH', './logs'),
  },
  mcp: {
    name: getEnvVar('MCP_SERVER_NAME', 'kopeng'),
    version: getEnvVar('MCP_SERVER_VERSION', '1.0.0'),
    apiUrl: getEnvVar('MEMORY_API_URL', 'http://localhost:3200'),
  },
  reranker: {
    model: getEnvVar('RERANKER_MODEL', 'Xenova/ms-marco-MiniLM-L-6-v2'),
    defaultCandidates: 20,
    enabled: true,
  },
  search: {
    defaultLimit: 10,
    maxLimit: 100,
    maxContentSize: 50 * 1024, // 50KB
    rrfK: 60, // reciprocal rank fusion constant
  },
  rateLimit: {
    max: getEnvInt('RATE_LIMIT_MAX', 100),
    timeWindow: '1 minute',
  },
  discovery: {
    ingestionEnabled: getEnvVar('OBSERVATION_INGESTION_ENABLED', 'false') === 'true',
    detectionEnabled: getEnvVar('DISCOVERY_DETECTION_ENABLED', 'false') === 'true',
    apiKey: getEnvVar('OBSERVATION_API_KEY', ''),
    minOccurrences: getEnvInt('DISCOVERY_MIN_OCCURRENCES', 3),
    minErrorOccurrences: getEnvInt('DISCOVERY_MIN_ERROR_OCCURRENCES', 2),
    analysisWindowHours: getEnvInt('DISCOVERY_ANALYSIS_WINDOW_HOURS', 168),
    observationRetentionDays: getEnvInt('OBSERVATION_RETENTION_DAYS', 7),
    maxInputSize: getEnvInt('OBSERVATION_MAX_INPUT_SIZE', 5000),
    maxOutputSize: getEnvInt('OBSERVATION_MAX_OUTPUT_SIZE', 1024),
    maxErrorOutputSize: getEnvInt('OBSERVATION_MAX_ERROR_OUTPUT_SIZE', 4096),
    confidenceFloor: parseFloat(getEnvVar('DISCOVERY_CONFIDENCE_FLOOR', '0.5')),
    maxObservationsTableSize: getEnvInt('OBSERVATION_MAX_TABLE_SIZE', 100000),
    triggerEveryN: getEnvInt('DISCOVERY_TRIGGER_EVERY_N', 50),
    discoveryIntervalMs: getEnvInt('DISCOVERY_INTERVAL_MS', 60000),
  },
  dreaming: {
    // Feature-flagged OFF by default (invariant: dreaming is optional + greenfield).
    enabled: getEnvVar('DREAMING_ENABLED', 'false') === 'true',
    intervalMs: getEnvInt('DREAM_INTERVAL_MS', 60000),
    // Fallbacks used only when operator_config is unseeded / has null fields;
    // operator_config (DB) always takes precedence at runtime.
    defaultTimezone: getEnvVar('DREAM_TIMEZONE', 'UTC'),
    defaultIdleMinutes: getEnvInt('DREAM_IDLE_MINUTES', 30),
    defaultQuietStartHour: getEnvInt('DREAM_QUIET_START_HOUR', 2),
    defaultQuietEndHour: getEnvInt('DREAM_QUIET_END_HOUR', 6),
    // D2.1 local reasoner (classify-only). The enable flag is env-only —
    // arming the first LLM dependency is a deliberate restart-gated operator
    // action; the knobs below are DEFAULTS that operator_config's
    // `dream_reasoner` blob overrides at runtime (no restart needed).
    reasoner: {
      enabled: getEnvVar('DREAM_REASONER_ENABLED', 'false') === 'true',
      url: getEnvVar('DREAM_REASONER_URL', 'http://localhost:11434'),
      model: getEnvVar('DREAM_REASONER_MODEL', 'qwen3:8b'),
      timeoutMs: getEnvInt('DREAM_REASONER_TIMEOUT_MS', 30000),
      maxTokens: getEnvInt('DREAM_REASONER_MAX_TOKENS', 300),
    },
  },
};

export default config;
