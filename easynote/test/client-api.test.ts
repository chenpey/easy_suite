import assert from 'node:assert/strict';
import test from 'node:test';
import { request } from '../src/client/api';

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

function responseWithAbortableBody(signal: AbortSignal): Response {
  return {
    ok: true,
    status: 200,
    text: () => new Promise<string>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const fallback = realSetTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        reject(new Error('response body did not abort'));
      }, 250);
      const onAbort = () => {
        realClearTimeout(fallback);
        reject(signal.reason);
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }),
  } as Response;
}

test('request timeout aborts response body even with a caller signal', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    t.mock.timers.reset();
  });
  t.mock.timers.enable();
  globalThis.fetch = ((_, init) => Promise.resolve(responseWithAbortableBody(init!.signal!))) as typeof fetch;

  const caller = new AbortController();
  const pending = request<{ ok: true }>('/api/slow', 'GET', undefined, caller.signal);
  await Promise.resolve();
  await Promise.resolve();
  t.mock.timers.tick(30_000);

  await assert.rejects(
    pending,
    (error: unknown) => error instanceof Error &&
      error.message === 'GET /api/slow\nRequest timed out after 30 seconds.',
  );
  assert.equal(caller.signal.aborted, false);
});

test('caller cancellation keeps its original error', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const caller = new AbortController();
  const reason = new Error('selection changed');
  globalThis.fetch = ((_, init) => Promise.resolve(responseWithAbortableBody(init!.signal!))) as typeof fetch;

  const pending = request<{ ok: true }>('/api/cancelled', 'GET', undefined, caller.signal);
  caller.abort(reason);

  await assert.rejects(pending, (error: unknown) => error === reason);
});
