/** Durable scheduled-task expectations shared by installers and heartbeats-report. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function expectedTasksPath(homedir = os.homedir()) {
  return path.join(homedir, '.kopeng', 'metrics', 'expected-tasks.json');
}

export function parseExpectedTasks(text) {
  const parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
  if (!Array.isArray(parsed)) throw new Error('expected-tasks registry must be a JSON array');

  const seen = new Set();
  return parsed.map((value, index) => {
    if (typeof value !== 'object' || value === null) {
      throw new Error(`expected-tasks entry ${index} must be an object`);
    }
    const { task, cadenceHours } = value;
    if (typeof task !== 'string' || !task.trim()) {
      throw new Error(`expected-tasks entry ${index} has no task name`);
    }
    if (!Number.isFinite(cadenceHours) || cadenceHours <= 0) {
      throw new Error(`expected-tasks entry ${index} has an invalid cadenceHours`);
    }
    if (seen.has(task)) throw new Error(`expected-tasks registry repeats task '${task}'`);
    seen.add(task);
    return { task, cadenceHours };
  });
}

export function readExpectedTasks(filePath = expectedTasksPath()) {
  if (!fs.existsSync(filePath)) return [];
  return parseExpectedTasks(fs.readFileSync(filePath, 'utf8'));
}

export function updateExpectedTask(filePath, expected, installed) {
  if (typeof expected.task !== 'string' || !expected.task.trim()) {
    throw new Error('task name is required');
  }
  if (installed && (!Number.isFinite(expected.cadenceHours) || expected.cadenceHours <= 0)) {
    throw new Error('cadenceHours must be greater than zero');
  }

  const tasks = readExpectedTasks(filePath).filter((entry) => entry.task !== expected.task);
  if (installed) tasks.push(expected);
  tasks.sort((a, b) => a.task.localeCompare(b.task));

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(tasks, null, 2) + '\n', 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    fs.rmSync(tmpPath, { force: true });
    throw err;
  }
  return tasks;
}

function main() {
  const [command, task, cadence, ...rest] = process.argv.slice(2);
  if (rest.length > 0 || !task || !['register', 'unregister'].includes(command)) {
    throw new Error('usage: node expected-tasks.mjs <register|unregister> <task> [cadence-hours]');
  }

  const installed = command === 'register';
  const cadenceHours = installed ? Number(cadence) : 1;
  if (installed && (!Number.isFinite(cadenceHours) || cadenceHours <= 0)) {
    throw new Error('register requires cadence-hours > 0');
  }
  if (!installed && cadence !== undefined) {
    throw new Error('unregister does not accept cadence-hours');
  }

  updateExpectedTask(expectedTasksPath(), { task, cadenceHours }, installed);
  console.log(`${task}: heartbeat expectation ${installed ? 'registered' : 'removed'}`);
}

const entry = process.argv[1] ? path.resolve(process.argv[1]).toLowerCase() : '';
if (entry === fileURLToPath(import.meta.url).toLowerCase()) {
  try {
    main();
  } catch (err) {
    console.error(`expected-tasks failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
