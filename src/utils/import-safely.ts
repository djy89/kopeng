/**
 * Dynamic import that absorbs Node's DUPLICATE unhandled rejection.
 *
 * On Node <= 20, when a CommonJS dependency throws while an ESM graph is being
 * linked, Node rejects TWO promises with the SAME error object: the one
 * `import()` returns — which the caller can catch — and an internal module-job
 * promise no caller can reach. With no `unhandledRejection` listener registered,
 * that unreachable twin is fatal (`triggerUncaughtException`, `fromPromise:
 * true`). Node 22 no longer emits it, and attaching another `.catch` to the
 * promise `import()` returned does not suppress it — it is a different promise.
 *
 * This bit the server on a fresh Windows install with no VC++ Redistributable
 * (stranger-install finding #2, 2026-08-26): `onnxruntime-node`'s native binding
 * failed to dlopen, `initEmbedder()`'s `.catch` correctly logged "Continuing
 * with keyword-only search", and the process then died on the twin — the
 * designed fail-open path defeated by a rejection it never had a chance to
 * handle.
 *
 * The suppression is deliberately narrow: only a rejection whose reason is
 * IDENTICAL (===) to an error one of these imports already reported is
 * discarded. Anything else keeps Node's fail-fast default, so genuine unhandled
 * rejections still crash loudly instead of hiding behind this guard.
 */

/** Errors already surfaced to a caller — their twins are safe to discard. */
const reportedFailures = new Set<object>();
let listener: ((reason: unknown) => void) | null = null;
let activeImports = 0;

function installListener(): void {
  if (listener) return;
  listener = (reason: unknown): void => {
    if (reason !== null && typeof reason === 'object' && reportedFailures.has(reason)) return;

    // Not ours. This listener is the only thing standing between an unhandled
    // rejection and Node's default crash, so reproduce that default — unless
    // the application installed a handler of its own, which then owns it.
    if (process.listenerCount('unhandledRejection') > 1) return;
    throw reason;
  };
  process.on('unhandledRejection', listener);
}

function releaseListener(): void {
  if (--activeImports > 0 || !listener) return;
  const current = listener;
  listener = null;
  process.off('unhandledRejection', current);
  reportedFailures.clear();
}

/**
 * Run `load()` — a thunk wrapping the import, so the literal specifier stays at
 * the call site — with the duplicate-rejection guard active. Resolves and rejects
 * exactly like the underlying import, so callers degrade as they always did.
 */
export async function importWithoutDuplicateRejection<T>(load: () => Promise<T>): Promise<T> {
  activeImports++;
  installListener();
  try {
    return await load();
  } catch (err) {
    // Only object errors are tracked: identity is the whole safety argument
    // here, and primitives can collide across unrelated rejections.
    if (err !== null && typeof err === 'object') reportedFailures.add(err);
    throw err;
  } finally {
    // Node emits the twin at the end of the turn, AFTER this settles, so the
    // listener has to outlive the import by one macrotask. unref() so a pending
    // guard can never hold the process open on its own.
    setTimeout(releaseListener, 0).unref();
  }
}
