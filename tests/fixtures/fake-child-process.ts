import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

/**
 * A minimal fake ChildProcess: an EventEmitter carrying its own stdout/stderr
 * EventEmitters, enough to drive npm-spawn.ts's runNpmInstall (and any other
 * consumer wiring 'data'/'error'/'close' the same way) without touching a
 * real process. Deliberately dependency-free (no DB/config imports) so it's
 * safe to use from pure CLI test files that avoid those entirely.
 */
export interface FakeChildProcess {
  child: ChildProcess;
  emitStdout: (chunk: string) => void;
  emitStderr: (chunk: string) => void;
  emitClose: (code: number | null) => void;
  emitError: (err: Error) => void;
}

export function fakeChildProcess(): FakeChildProcess {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const proc = new EventEmitter() as unknown as ChildProcess;
  Object.assign(proc, { stdout, stderr });
  return {
    child: proc,
    emitStdout: (chunk) => stdout.emit('data', chunk),
    emitStderr: (chunk) => stderr.emit('data', chunk),
    emitClose: (code) => proc.emit('close', code, null),
    emitError: (err) => proc.emit('error', err),
  };
}
