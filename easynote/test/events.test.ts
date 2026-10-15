import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { Miniflare, Response, convertV4MiniflareOptions } from 'miniflare';

test('a slow change notification continues after the response without blocking it', { timeout: 10_000 }, async () => {
  const bundle = await build({
    stdin: {
      resolveDir: new URL('..', import.meta.url).pathname,
      contents: `
        import { publishNoteChanges } from './src/worker/events';
        export default {
          fetch(request, env) {
            publishNoteChanges({ NOTE_EVENTS: { getByName: () => env.NOTIFY } }, 'user', request);
            return new Response('saved');
          }
        };
      `,
    },
    bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:*'],
  });
  let release!: () => void;
  let delivered!: () => void;
  let completed = false;
  let notification: { method: string; client: string | null } | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const delivery = new Promise<void>((resolve) => { delivered = resolve; });
  const client = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-09-14',
    serviceBindings: {
      NOTIFY: async (request) => {
        notification = { method: request.method, client: request.headers.get('X-EasyNote-Client') };
        await gate;
        completed = true;
        delivered();
        return new Response('ok');
      },
    },
  }));
  try {
    const response = await runtime.dispatchFetch('https://test.example/', {
      headers: { 'X-EasyNote-Client': client },
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(await response.text(), 'saved');
    assert.equal(completed, false);
    release();
    await delivery;
    assert.deepEqual(notification, { method: 'POST', client });
    assert.equal(completed, true);
  } finally {
    release();
    await runtime.dispose();
  }
});
