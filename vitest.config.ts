import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Review finding 5 (latent): once `kopeng init` (Task 2.2) writes a real
    // ~/.kopeng/.env on a dev machine, a bare `npm test` would otherwise pick
    // it up — src/config/config.ts is imported by many test files, and
    // process.env is worker-wide. KOPENG_ENV_FILE (explicit) always wins the
    // Ruling 7/8 resolution, and this path is guaranteed not to exist, so
    // config.ts's dotenv.config() call is a harmless no-op by default.
    // Tests that specifically exercise resolution (first-run.test.ts)
    // override or delete this var for their own scope, same as any other.
    env: {
      KOPENG_ENV_FILE: path.join(REPO_ROOT, '.vitest-harmless-test.env'),
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/tools/**'],
    },
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
