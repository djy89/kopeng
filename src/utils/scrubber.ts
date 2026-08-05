/**
 * Multi-layer secret scrubbing for observation data.
 * Applied both client-side (in hook) and server-side (Fastify preHandler) as defense-in-depth.
 */

const REDACTED = '[REDACTED]';

// Layer 1: Keyword-based patterns (port of ECC _SECRET_RE)
const KEYWORD_PATTERNS: RegExp[] = [
  // key=value and key: value forms
  /(?:api[_-]?key|apikey|secret|token|password|passwd|pwd|auth|credential|private[_-]?key|access[_-]?key|secret[_-]?key)\s*[:=]\s*['"]?[^\s'"}{,]+/gi,
  // Authorization headers (capture scheme + token as a unit, e.g. "Bearer abc123")
  /(?:Authorization)\s*[:=]\s*['"]?(?:Bearer|Basic|Token)\s+[^\s'"}{,]+/gi,
  // Bare Bearer/Basic prefix (when used without "Authorization:")
  /(?:Bearer|Basic)\s+[A-Za-z0-9_=.+/-]{8,}/gi,
];

// Layer 2: Format-based patterns (catches secrets by their known formats)
const FORMAT_PATTERNS: { pattern: RegExp; replacement: string }[] = [
  // AWS access keys (long-term AKIA + temporary STS ASIA)
  { pattern: /(?:AKIA|ASIA)[0-9A-Z]{16}/g, replacement: REDACTED },
  // AWS secret keys (40 char base64-ish after common prefixes)
  { pattern: /(?:aws_secret_access_key|AWS_SECRET)\s*[:=]\s*['"]?[A-Za-z0-9/+=]{40}/gi, replacement: REDACTED },
  // GitHub classic PATs / server-to-server (ghp_, ghs_) and OAuth (gho_ below)
  { pattern: /gh[ps]_[A-Za-z0-9_]{36,}/g, replacement: REDACTED },
  // GitHub fine-grained PATs (github_pat_ prefix — distinct format from the ghp_/ghs_ shapes above)
  { pattern: /github_pat_[A-Za-z0-9_]{36,}/g, replacement: REDACTED },
  // GitHub OAuth tokens
  { pattern: /gho_[A-Za-z0-9_]{36,}/g, replacement: REDACTED },
  // Stripe keys
  { pattern: /sk_(?:live|test)_[A-Za-z0-9]{24,}/g, replacement: REDACTED },
  { pattern: /pk_(?:live|test)_[A-Za-z0-9]{24,}/g, replacement: REDACTED },
  // Anthropic / OpenAI keys
  { pattern: /sk-[A-Za-z0-9_-]{40,}/g, replacement: REDACTED },
  // Slack tokens
  { pattern: /xox[bpsa]-[A-Za-z0-9-]{10,}/g, replacement: REDACTED },
  // JWTs (three base64url segments separated by dots)
  { pattern: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, replacement: REDACTED },
  // Connection strings — redact password portion only
  { pattern: /((?:postgres|postgresql|mysql|mongodb|mongodb\+srv|redis|amqp|amqps):\/\/[^:]+):([^@]+)@/gi, replacement: `$1:${REDACTED}@` },
  // PEM private keys
  { pattern: /-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+ PRIVATE KEY-----/g, replacement: REDACTED },
  // Generic hex tokens (32+ hex chars after common key prefixes)
  { pattern: /(?:key|token|secret|hash)[_-]?[=:]\s*['"]?[0-9a-f]{32,}/gi, replacement: REDACTED },
];

// Layer 3: Content denylist — tool outputs to suppress entirely
const DENYLIST_TOOLS: Set<string> = new Set([
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
]);

/**
 * Check if a tool invocation should have its output suppressed entirely.
 * Returns true if the input references a denylisted file.
 */
export function shouldSuppressOutput(toolName: string, inputSummary: string | null | undefined): boolean {
  if (!inputSummary) return false;
  const lower = inputSummary.toLowerCase();
  for (const denylisted of DENYLIST_TOOLS) {
    if (lower.includes(denylisted)) return true;
  }
  // Also suppress if reading SSH keys or .env files
  if (toolName === 'Read' || toolName === 'read_file') {
    if (/\.env(\.|$)/i.test(inputSummary) || /id_(rsa|ed25519|ecdsa|dsa)/i.test(inputSummary)) {
      return true;
    }
  }
  return false;
}

/**
 * Strip characters Postgres refuses to store in a `text` column.
 *
 * PG rejects NUL (0x00) outright — `invalid byte sequence for encoding "UTF8": 0x00`
 * — which surfaces as a 500 the observe hook treats as transient, so the offending
 * chunk retries forever and head-of-line blocks the whole flush queue. The real-world
 * source is UTF-16LE tool output (e.g. `wsl.exe --list`), where every other byte is a
 * NUL; dropping them yields the readable text ("U\0b\0u\0..." → "Ubuntu"), so removal
 * is lossless in practice. Other C0 controls are legal in PG and are left alone.
 */
export function stripUnstorableChars(text: string): string {
  if (!text) return text;
  const NUL = String.fromCharCode(0);
  return text.indexOf(NUL) === -1 ? text : text.split(NUL).join('');
}

/**
 * Recursively strip unstorable characters from every string in a JSON-ish value.
 * Used for `metadata`, which is JSON-stringified into a text column and so carries
 * the same NUL hazard as the summaries but never passes through scrubSecrets.
 */
export function stripUnstorableCharsDeep<T>(value: T): T {
  if (typeof value === 'string') return stripUnstorableChars(value) as unknown as T;
  if (Array.isArray(value)) return value.map(stripUnstorableCharsDeep) as unknown as T;
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      (value as Record<string, unknown>)[k] = stripUnstorableCharsDeep(v);
    }
  }
  return value;
}

/**
 * Scrub secrets from text using keyword-based and format-based pattern matching.
 * Safe to call on any string — returns the scrubbed version.
 *
 * Also strips storage-hostile characters (see stripUnstorableChars): this is the
 * single chokepoint every observation summary passes through server-side, so
 * sanitizing here guarantees no summary can 500 the batch insert.
 */
export function scrubSecrets(text: string): string {
  if (!text) return text;

  let result = stripUnstorableChars(text);

  // Layer 1: Keyword-based
  for (const pattern of KEYWORD_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    result = result.replace(pattern, REDACTED);
  }

  // Layer 2: Format-based
  for (const { pattern, replacement } of FORMAT_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, replacement);
  }

  return result;
}

/**
 * Truncate text to a maximum length, appending ellipsis if truncated.
 */
export function truncate(text: string, maxLength: number): string {
  if (!text || text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}
