import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { filePath, imagePath } from '../src/shared/types';
import { importExternalFiles, missingCachedFileIds } from '../src/client/transfer';

const config = {
  maxNoteBytes: 1024 * 1024,
  maxImageBytes: 1024 * 1024,
  maxImagePixels: 4_000_000,
  maxAttachmentBytes: 1024 * 1024,
  autosaveMs: 500,
  pollSeconds: 30,
};

function relativeFile(path: string, content: string): File {
  const file = new File([content], path.split('/').at(-1)!, { type: 'text/markdown' });
  Object.defineProperty(file, 'webkitRelativePath', { value: path });
  return file;
}

test('local draft export identifies every referenced file without a cache entry', () => {
  const cached = randomUUID();
  const missing = randomUUID();
  assert.deepEqual(
    missingCachedFileIds([
      { note: { content: `![one](${imagePath(cached)})` } },
      { note: { content: `[two](${filePath(missing)})` } },
    ], new Set([cached])),
    [missing],
  );
});

test('reimporting an external note with links and attachments skips before uploading', async () => {
  const notes = new Map<string, { id: string; title: string; content: string; tags: string[] }>();
  let uploads = 0;
  let lookups = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(rawUrl, 'http://localhost');
    if (url.pathname === '/api/notes/existing' && init?.method === 'POST') {
      lookups++;
      const ids = (JSON.parse(String(init.body)) as { ids: string[] }).ids.filter((id) => notes.has(id));
      return new Response(JSON.stringify({ ids }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (/^\/api\/(?:images|files)\/[0-9a-f-]+$/i.test(url.pathname) && init?.method === 'PUT') {
      uploads++;
      const id = randomUUID();
      return new Response(JSON.stringify({ file: {
        id, filename: 'asset.csv', mime: 'text/csv', size: 5, width: 0, height: 0,
        sha256: '', url: filePath(id),
      } }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }
    if (/^\/api\/notes\/[0-9a-f-]+$/i.test(url.pathname) && init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      const id = url.pathname.split('/').at(-1)!;
      notes.set(id, { id, title: body.title, content: body.content, tags: body.tags });
      return new Response(JSON.stringify({ note: { ...body, id, revision: 1 } }), {
        status: 201, headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${url.pathname}`);
  }) as typeof fetch;
  try {
    const selected = [
      relativeFile('Vault/Main.md', '# Main\n\n![[asset.csv]]\n\nSee [[Linked]]'),
      relativeFile('Vault/Linked.md', '# Linked\n\nThe linked note.'),
      relativeFile('Vault/Copy.md', '# Linked\n\nThe linked note.'),
      relativeFile('Vault/asset.csv', 'asset'),
    ];
    const findDuplicates = async () => new Map<string, string>();
    const first = await importExternalFiles(selected, config, () => {}, findDuplicates);
    assert.deepEqual(first, { imported: 2, skipped: 1 });
    assert.equal(uploads, 1);
    assert.equal(notes.size, 2);
    assert.equal(lookups, 1);
    assert.match([...notes.values()].find((note) => note.title === 'Main')!.content, /\/api\/files\//);

    const second = await importExternalFiles(selected, config, () => {}, findDuplicates);
    assert.deepEqual(second, { imported: 0, skipped: 3 });
    assert.equal(uploads, 1);
    assert.equal(notes.size, 2);
    assert.equal(lookups, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
