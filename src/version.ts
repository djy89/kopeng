import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packagePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as { version?: unknown };

if (typeof packageJson.version !== 'string' || !packageJson.version) {
  throw new Error(`package.json at ${packagePath} has no valid version`);
}

export const KOPENG_VERSION = packageJson.version;
