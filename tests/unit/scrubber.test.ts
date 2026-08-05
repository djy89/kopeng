import { describe, it, expect } from 'vitest';
import { scrubSecrets, truncate, shouldSuppressOutput } from '../../src/utils/scrubber.js';

describe('scrubSecrets', () => {
  describe('Layer 1: Keyword-based patterns', () => {
    it('should redact api_key=value patterns', () => {
      expect(scrubSecrets('api_key=sk_live_abc123')).not.toContain('sk_live_abc123');
    });

    it('should redact password=value patterns', () => {
      expect(scrubSecrets('password=hunter2')).not.toContain('hunter2');
    });

    it('should redact token: value patterns', () => {
      expect(scrubSecrets('token: my_secret_token_value')).not.toContain('my_secret_token_value');
    });

    it('should redact Authorization headers', () => {
      const result = scrubSecrets('Authorization: Bearer my_secret_token_123');
      expect(result).not.toContain('my_secret_token_123');
    });

    it('should be case insensitive', () => {
      expect(scrubSecrets('API_KEY=secret123')).not.toContain('secret123');
      expect(scrubSecrets('Password=secret123')).not.toContain('secret123');
    });
  });

  describe('Layer 2: Format-based patterns', () => {
    it('should redact AWS access keys', () => {
      const text = 'Found key AKIAIOSFODNN7EXAMPLE in config';
      const result = scrubSecrets(text);
      expect(result).not.toContain('AKIAIOSFODNN7EXAMPLE');
      expect(result).toContain('[REDACTED]');
    });

    it('should redact GitHub PATs (classic)', () => {
      const pat = 'ghp_ABCDEFghijklmnop1234567890abcdefgh1234';
      const result = scrubSecrets(`token: ${pat}`);
      expect(result).not.toContain(pat);
    });

    it('should redact GitHub server-to-server tokens (ghs_)', () => {
      const pat = 'ghs_ABCDEFghijklmnop1234567890abcdefgh1234';
      const result = scrubSecrets(pat);
      expect(result).not.toContain(pat);
    });

    it('should redact GitHub fine-grained PATs (github_pat_)', () => {
      const pat = 'github_pat_11ABCDEFG0abcdefghijk_1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJ';
      const result = scrubSecrets(`bare token in output: ${pat}`);
      expect(result).not.toContain(pat);
      expect(result).toContain('[REDACTED]');
    });

    it('should redact AWS temporary STS keys (ASIA)', () => {
      const key = 'ASIAIOSFODNN7EXAMPLE';
      const result = scrubSecrets(`Found key ${key} in config`);
      expect(result).not.toContain(key);
      expect(result).toContain('[REDACTED]');
    });

    it('should redact Stripe secret keys', () => {
      // Prefix assembled at runtime: a literal live-key-shaped string trips GitHub
      // push protection even when the body is synthetic, and this repo is public.
      const key = `sk_${'live'}_FAKEKEYFORSCRUBBERTESTS0000`;
      const result = scrubSecrets(`Stripe key: ${key}`);
      expect(result).not.toContain(key);
    });

    it('should redact Stripe publishable keys', () => {
      const key = 'pk_test_4eC39HqLyjWDarjtT1zdp7dc';
      const result = scrubSecrets(key);
      expect(result).not.toContain(key);
    });

    it('should redact Anthropic/OpenAI-style keys', () => {
      const key = 'sk-ant-api03-ABCDEFghijklmnop1234567890abcdef_ghijklmnop';
      const result = scrubSecrets(key);
      expect(result).not.toContain(key);
    });

    it('should redact Slack tokens', () => {
      const token = 'xoxb-1234567890-abcdefghij';
      const result = scrubSecrets(token);
      expect(result).not.toContain(token);
    });

    it('should redact JWTs', () => {
      const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abc_DEF-123';
      const result = scrubSecrets(`Bearer ${jwt}`);
      expect(result).not.toContain(jwt);
    });

    it('should redact password in PostgreSQL connection strings', () => {
      const conn = 'postgresql://user:s3cret_P4ss@db.example.com:5432/mydb';
      const result = scrubSecrets(conn);
      expect(result).not.toContain('s3cret_P4ss');
      expect(result).toContain('postgresql://user:');
      expect(result).toContain('@');
    });

    it('should redact password in MongoDB connection strings', () => {
      const conn = 'mongodb://admin:password123@mongo.example.com:27017/db';
      const result = scrubSecrets(conn);
      expect(result).not.toContain('password123');
    });

    it('should redact password in Redis connection strings', () => {
      const conn = 'redis://default:myRedisPass@redis.example.com:6379';
      const result = scrubSecrets(conn);
      expect(result).not.toContain('myRedisPass');
    });

    it('should redact PEM private keys', () => {
      const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----';
      const result = scrubSecrets(pem);
      expect(result).not.toContain('MIIEowIBAAKCAQEA');
      expect(result).toBe('[REDACTED]');
    });
  });

  describe('preserves benign content', () => {
    it('should not modify normal text', () => {
      const text = 'Running npm test in project directory. All 44 tests passed.';
      expect(scrubSecrets(text)).toBe(text);
    });

    it('should not modify git commands', () => {
      const text = 'git commit -m "fix: resolve auth timeout issue"';
      expect(scrubSecrets(text)).toBe(text);
    });

    it('should not modify file paths', () => {
      const text = 'Reading src/config/config.ts at line 42';
      expect(scrubSecrets(text)).toBe(text);
    });

    it('should handle empty string', () => {
      expect(scrubSecrets('')).toBe('');
    });

    it('should handle null-ish values', () => {
      expect(scrubSecrets(undefined as unknown as string)).toBeUndefined();
    });
  });
});

describe('truncate', () => {
  it('should not truncate short text', () => {
    expect(truncate('hello', 100)).toBe('hello');
  });

  it('should truncate long text with ellipsis', () => {
    const long = 'a'.repeat(200);
    const result = truncate(long, 50);
    expect(result).toHaveLength(50);
    expect(result.endsWith('...')).toBe(true);
  });

  it('should handle empty string', () => {
    expect(truncate('', 100)).toBe('');
  });

  it('should handle exact length', () => {
    expect(truncate('12345', 5)).toBe('12345');
  });
});

describe('shouldSuppressOutput', () => {
  it('should suppress .env file reads', () => {
    expect(shouldSuppressOutput('Read', '/path/to/.env')).toBe(true);
    expect(shouldSuppressOutput('Read', '/path/to/.env.local')).toBe(true);
    expect(shouldSuppressOutput('Read', '/path/to/.env.production')).toBe(true);
  });

  it('should suppress SSH key reads', () => {
    expect(shouldSuppressOutput('Read', '/home/user/.ssh/id_rsa')).toBe(true);
    expect(shouldSuppressOutput('Read', '/home/user/.ssh/id_ed25519')).toBe(true);
  });

  it('should not suppress normal file reads', () => {
    expect(shouldSuppressOutput('Read', 'src/config/config.ts')).toBe(false);
    expect(shouldSuppressOutput('Bash', 'npm test')).toBe(false);
  });

  it('should handle null input', () => {
    expect(shouldSuppressOutput('Read', null)).toBe(false);
    expect(shouldSuppressOutput('Read', undefined)).toBe(false);
  });
});
