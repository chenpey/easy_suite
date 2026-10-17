import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { filePath, imagePath, MAX_POSITION, noteFingerprint } from '../src/shared/types';
import { placePositions } from '../src/shared/order';
import { exportArchive, importArchive, importExternalFiles, missingCachedFileIds } from '../src/client/transfer';

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

for (const version of [2, 3]) {
  for (const existingTarget of [false, true]) {
    test(`archive v${version} remaps links to ${existingTarget ? 'existing' : 'new'} notes and duplicate targets`, async () => {
      const sourceId = randomUUID(), targetId = randomUUID(), copyId = randomUUID(), outsideId = randomUUID();
      const existingId = randomUUID();
      const sourceContent = `[[${targetId.toUpperCase()}|Target]] [[${copyId}|Copy]] [[${sourceId}|Self]] [[${outsideId}|Outside]]`;
      const targetContent = existingTarget ? 'existing target' : `[[${sourceId}|Back]]`;
      const notes = [
        { id: sourceId, title: 'Source', content: sourceContent },
        { id: targetId, title: 'Target', content: targetContent },
        { id: copyId, title: 'Copy', content: targetContent },
      ];
      const archive = new File([new Uint8Array(zipSync({
        'manifest.json': strToU8(JSON.stringify({
          format: 'easynote', version, files: [],
          notes: notes.map(({ id, title }) => ({
            id, title, path: `notes/${title}.md`, tags: [], pinned: false, archived: false, deletedAt: null,
          })),
        })),
        ...Object.fromEntries(notes.map((note) => [`notes/${note.title}.md`, strToU8(note.content)])),
      }))], 'linked.zip');
      const saved: Array<{ id: string; title: string; content: string }> = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        assert.equal(init?.method, 'POST');
        assert.match(String(input), /^\/api\/notes\//);
        const note = { ...JSON.parse(String(init.body)), id: String(input).split('/').at(-1)! };
        saved.push(note);
        return Response.json({ note: { ...note, revision: 1 } }, { status: 201 });
      }) as typeof fetch;
      try {
        const targetFingerprint = await noteFingerprint('Target', targetContent);
        assert.deepEqual(await importArchive(archive, config, () => {}, async () =>
          existingTarget ? new Map([[targetFingerprint, existingId]]) : new Map()),
        { imported: existingTarget ? 1 : 2, skipped: existingTarget ? 2 : 1 });
        const source = saved.find((note) => note.title === 'Source')!;
        const target = existingTarget ? existingId : saved.find((note) => note.title === 'Target')!.id;
        assert.notEqual(source.id, sourceId);
        assert.notEqual(target, targetId);
        assert.equal(source.content, `[[${target}|Target]] [[${target}|Copy]] [[${source.id}|Self]] [[${outsideId}|Outside]]`);
        if (!existingTarget) assert.equal(saved.find((note) => note.id === target)!.content, `[[${source.id}|Back]]`);
      } finally { globalThis.fetch = originalFetch; }
    });
  }
}

test('reimporting an archive resolves duplicate targets before checking linked ancestors', async () => {
  const leafId = randomUUID(), branchId = randomUUID(), rootId = randomUUID();
  const notes = [
    { id: rootId, title: 'Root', content: `[[${branchId}|Branch]]` },
    { id: branchId, title: 'Branch', content: `[[${leafId}|Leaf]]` },
    { id: leafId, title: 'Leaf', content: 'leaf body' },
  ];
  const archive = new File([new Uint8Array(zipSync({
    'manifest.json': strToU8(JSON.stringify({
      format: 'easynote', version: 3, files: [],
      notes: notes.map(({ id, title }) => ({
        id, title, path: `notes/${title}.md`, tags: [], pinned: false, archived: false, deletedAt: null,
      })),
    })),
    ...Object.fromEntries(notes.map((note) => [`notes/${note.title}.md`, strToU8(note.content)])),
  }))], 'chain.zip');
  const saved: Array<{ id: string; title: string; content: string }> = [];
  const fingerprints = new Map<string, string>();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(init?.method, 'POST');
    const note = { ...JSON.parse(String(init.body)), id: String(input).split('/').at(-1)! };
    saved.push(note);
    fingerprints.set(await noteFingerprint(note.title, note.content), note.id);
    return Response.json({ note: { ...note, revision: 1 } }, { status: 201 });
  }) as typeof fetch;
  const findDuplicates = async (values: string[]) => new Map(
    values.filter((value) => fingerprints.has(value)).map((value) => [value, fingerprints.get(value)!]),
  );
  try {
    assert.deepEqual(await importArchive(archive, config, () => {}, findDuplicates), { imported: 3, skipped: 0 });
    assert.equal(saved.find((note) => note.title === 'Root')!.content, `[[${saved.find((note) => note.title === 'Branch')!.id}|Branch]]`);
    assert.deepEqual(await importArchive(archive, config, () => {}, findDuplicates), { imported: 0, skipped: 3 });
    assert.equal(saved.length, 3);
  } finally { globalThis.fetch = originalFetch; }
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


test('folder archives validate before writing and remap nested folders without duplication', async () => {
  const parent = randomUUID(), otherParent = randomUUID(), child = randomUUID(), sibling = randomUUID(), noteId = randomUUID();
  const folders: Array<{ id: string; name: string; parentId: string | null }> = [];
  const notes: Array<{ folderId: string | null; content: string }> = [];
  const importedFingerprints = new Set<string>();
  let writes = 0;
  const manifest = {
    format: 'easynote', version: 2, files: [],
    folders: [{ id: child, name: 'child', parentId: parent }, { id: sibling, name: 'child', parentId: parent }, { id: parent, name: 'parent', parentId: null }, { id: otherParent, name: 'parent', parentId: null }, { id: randomUUID(), name: 'beta', parentId: otherParent }],
    notes: [{ id: noteId, path: 'notes/note.md', title: 'archive', tags: [], pinned: false, archived: false, deletedAt: null, folderId: child }],
  };
  manifest.notes.push({ ...manifest.notes[0], id: randomUUID(), path: 'notes/other.md', title: 'other', folderId: sibling });
  const archive = (value: unknown) => new File([new Uint8Array(zipSync({
    'manifest.json': strToU8(JSON.stringify(value)), 'notes/note.md': strToU8('body'), 'notes/other.md': strToU8('other body'),
  }))], 'backup.zip');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    let response: unknown;
    if (url === '/api/folders' && init?.method === 'GET') response = { folders: [...folders].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)) };
    else if (url === '/api/folders' && init?.method === 'POST') {
      const folder = JSON.parse(String(init.body));
      folders.push(folder); writes++;
      response = { folder };
    } else if (url.startsWith('/api/notes/') && init?.method === 'POST') {
      const note = JSON.parse(String(init.body));
      importedFingerprints.add(await noteFingerprint(note.title, note.content));
      notes.push(note); writes++;
      response = { note: { ...note, revision: 1 } };
    } else throw new Error(`Unexpected ${init?.method} ${url}`);
    return new Response(JSON.stringify(response), { status: 200 });
  }) as typeof fetch;
  try {
    await assert.rejects(importArchive(archive({ ...manifest, notes: [{ ...manifest.notes[0], path: 'notes/missing.md' }] }), config, () => {}, async () => new Map()));
    assert.equal(writes, 0);
    const deep = Array.from({ length: 6 }, (_, index) => ({ id: randomUUID(), name: String(index), parentId: null as string | null }));
    deep.forEach((folder, index) => { folder.parentId = index ? deep[index - 1].id : null; });
    await assert.rejects(importArchive(archive({ ...manifest, folders: deep, notes: [] }), config, () => {}, async () => new Map()));
    assert.equal(writes, 0);
    assert.deepEqual(await importArchive(archive(manifest), config, () => {}, async () => new Map()), { imported: 2, skipped: 0 });
    // Sibling folders sharing a name collapse into one target folder.
    assert.equal(folders.length, 3);
    const firstChild = folders.find((folder) => folder.id === notes[0].folderId);
    assert.ok(firstChild);
    assert.ok(firstChild.parentId);
    assert.equal(notes[0].content, 'body');
    assert.equal(notes[0].folderId, notes[1].folderId);
    assert.equal(folders.find((folder) => folder.id === notes[1].folderId)?.parentId, firstChild.parentId);
    // Merging the two 'parent' roots also makes 'child' and 'beta' siblings.
    assert.equal(folders.find((folder) => folder.name === 'beta')?.parentId, firstChild.parentId);
    // The two archive roots collapse to a single root instead of creating one per name group.
    assert.equal(folders.filter((folder) => folder.parentId === null).length, 1);
    // Legacy archives with duplicate sibling names reuse folders and skip notes already present.
    assert.deepEqual(
      await importArchive(archive(manifest), config, () => {}, async (values) =>
        new Map(values.filter((value) => importedFingerprints.has(value)).map((value) => [value, 'imported']))),
      { imported: 0, skipped: 2 },
    );
    assert.equal(folders.length, 3);
    assert.equal(notes.length, 2);
    const { folders: _unused, ...legacy } = manifest;
    await importArchive(archive(legacy), config, () => {}, async () => new Map());
    assert.equal(notes.at(-1)?.folderId, null);
  } finally { globalThis.fetch = originalFetch; }
});

test('folder restore creates one level with bounded concurrency', async () => {
  const folders: Array<{ id: string; name: string; parentId: string | null }> = [];
  const manifest = {
    format: 'easynote', version: 2, files: [], notes: [],
    folders: Array.from({ length: 12 }, (_, index) => ({ id: randomUUID(), name: `folder-${index}`, parentId: null })),
  };
  const archive = new File([new Uint8Array(zipSync({
    'manifest.json': strToU8(JSON.stringify(manifest)),
  }))], 'backup.zip');
  let inFlight = 0, peak = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/folders' && init?.method === 'GET') return new Response(JSON.stringify({ folders }));
    if (url === '/api/folders' && init?.method === 'POST') {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const folder = JSON.parse(String(init.body));
      folders.push(folder);
      inFlight--;
      return new Response(JSON.stringify({ folder }));
    }
    throw new Error(`Unexpected ${init?.method} ${url}`);
  }) as typeof fetch;
  try {
    assert.deepEqual(await importArchive(archive, config, () => {}, async () => new Map()), { imported: 0, skipped: 0 });
  } finally { globalThis.fetch = originalFetch; }
  assert.equal(folders.length, 12);
  assert.ok(peak > 1, `expected parallel creation, peak ${peak}`);
  assert.ok(peak <= 6, `expected bounded concurrency, peak ${peak}`);
});

test('folder archives never reuse an archived ID owned by an unrelated folder', async () => {
  const archivedParent = randomUUID(), archivedChild = randomUUID(), noteId = randomUUID();
  const folders = [{ id: archivedChild, name: 'unrelated', parentId: null as string | null }];
  const notes: Array<{ folderId: string | null }> = [];
  const manifest = {
    format: 'easynote', version: 2, files: [],
    folders: [{ id: archivedParent, name: 'archive', parentId: null }, { id: archivedChild, name: 'nested', parentId: archivedParent }],
    notes: [{ id: noteId, path: 'notes/note.md', title: 'archive', tags: [], pinned: false, archived: false, deletedAt: null, folderId: archivedChild }],
  };
  const archive = new File([new Uint8Array(zipSync({
    'manifest.json': strToU8(JSON.stringify(manifest)), 'notes/note.md': strToU8('body'),
  }))], 'backup.zip');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    let response: unknown;
    if (url === '/api/folders' && init?.method === 'GET') response = { folders };
    else if (url === '/api/folders' && init?.method === 'POST') {
      const folder = JSON.parse(String(init.body));
      folders.push(folder);
      response = { folder };
    } else if (url.startsWith('/api/notes/') && init?.method === 'POST') {
      const note = JSON.parse(String(init.body));
      notes.push(note);
      response = { note: { ...note, revision: 1 } };
    } else throw new Error(`Unexpected ${init?.method} ${url}`);
    return new Response(JSON.stringify(response), { status: 200 });
  }) as typeof fetch;
  try {
    assert.deepEqual(await importArchive(archive, config, () => {}, async () => new Map()), { imported: 1, skipped: 0 });
  } finally { globalThis.fetch = originalFetch; }
  // The unrelated folder is untouched and both archive folders are created fresh.
  assert.equal(folders.length, 3);
  const root = folders.find((folder) => folder.name === 'archive');
  assert.ok(root && root.id !== archivedChild);
  const nested = folders.find((folder) => folder.id === notes[0].folderId);
  assert.equal(nested?.name, 'nested');
  assert.equal(nested?.parentId, root.id);
  assert.notEqual(nested?.id, archivedChild);
});

test('folder archives survive an archived ID owned by another account', async () => {
  const archived = randomUUID(), noteId = randomUUID();
  const folders: Array<{ id: string; name: string; parentId: string | null }> = [];
  const notes: Array<{ folderId: string | null }> = [];
  const manifest = {
    format: 'easynote', version: 2, files: [],
    folders: [{ id: archived, name: 'archive', parentId: null }],
    notes: [{ id: noteId, path: 'notes/note.md', title: 'archive', tags: [], pinned: false, archived: false, deletedAt: null, folderId: archived }],
  };
  const archive = new File([new Uint8Array(zipSync({
    'manifest.json': strToU8(JSON.stringify(manifest)), 'notes/note.md': strToU8('body'),
  }))], 'backup.zip');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/folders' && init?.method === 'GET') return new Response(JSON.stringify({ folders }), { status: 200 });
    if (url === '/api/folders' && init?.method === 'POST') {
      const folder = JSON.parse(String(init.body));
      // Another account owns this global ID: invisible in GET, rejected with 409 on POST.
      if (folder.id === archived) {
        return new Response(JSON.stringify({ error: { message: 'Folder ID already used by another folder.' } }), { status: 409 });
      }
      folders.push(folder);
      return new Response(JSON.stringify({ folder }), { status: 200 });
    }
    if (url.startsWith('/api/notes/') && init?.method === 'POST') {
      const note = JSON.parse(String(init.body));
      notes.push(note);
      return new Response(JSON.stringify({ note: { ...note, revision: 1 } }), { status: 200 });
    }
    throw new Error(`Unexpected ${init?.method} ${url}`);
  }) as typeof fetch;
  try {
    assert.deepEqual(await importArchive(archive, config, () => {}, async () => new Map()), { imported: 1, skipped: 0 });
  } finally { globalThis.fetch = originalFetch; }
  assert.equal(folders.length, 1);
  assert.notEqual(folders[0].id, archived);
  assert.equal(notes[0].folderId, folders[0].id);
});

test('folder archives reject an oversized folder list before writing', async () => {
  const manifest = {
    format: 'easynote', version: 2, files: [], notes: [],
    folders: Array.from({ length: 1201 }, (_, index) => ({ id: randomUUID(), name: `folder-${index}`, parentId: null })),
  };
  const archive = new File([new Uint8Array(zipSync({
    'manifest.json': strToU8(JSON.stringify(manifest)),
  }))], 'backup.zip');
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error('unexpected request'); }) as typeof fetch;
  try {
    await assert.rejects(importArchive(archive, config, () => {}, async () => new Map()), /目录数量/);
  } finally { globalThis.fetch = originalFetch; }
  assert.equal(calls, 0);
});

test('export refuses more folders than the archive limit', async () => {
  const folders = Array.from({ length: 1201 }, (_, index) => ({ id: randomUUID(), name: `folder-${index}`, parentId: null }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/api/notes?')) return new Response(JSON.stringify({ notes: [], nextOffset: null }), { status: 200 });
    if (url === '/api/folders') return new Response(JSON.stringify({ folders }), { status: 200 });
    throw new Error(`Unexpected GET ${url}`);
  }) as typeof fetch;
  try {
    await assert.rejects(exportArchive(() => {}), /目录数量/);
  } finally { globalThis.fetch = originalFetch; }
});

for (const position of [3072, -1024, MAX_POSITION, -MAX_POSITION]) {
  test(`archives restore manual order key ${position}`, async () => {
    const folderId = randomUUID();
    const noteId = randomUUID();
    const topPosition = placePositions([{ id: folderId, position: 0 }, { id: noteId, position: 0 }], [noteId], 0).get(noteId)!;
    assert.ok(topPosition < 0);
    const notePosition = position === -1024 ? topPosition : position;
    const folderPosition = position === 3072 ? 2048 : notePosition;
    const folder = { id: folderId, name: '顺序目录', parentId: null, position: folderPosition, createdAt: 1, updatedAt: 1 };
    const note = {
      id: noteId, title: '顺序笔记', content: '正文', tags: [], pinned: false, archived: false,
      deletedAt: null, folderId, position: notePosition, createdAt: 1, updatedAt: 2, revision: 1,
    };
    const created: Array<{ url: string; body: Record<string, unknown> }> = [];
    let freshLibrary = false;
    let archive: Blob | null = null;
    const originalFetch = globalThis.fetch;
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    const originalSetTimeout = globalThis.setTimeout;
    const originalDocument = (globalThis as { document?: unknown }).document;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
      if (url === '/api/folders' && init?.method === 'GET') return json({ folders: freshLibrary ? [] : [folder] });
      if (url === '/api/notes?view=export&offset=0') return json({ notes: [{ ...note, content: undefined, excerpt: '正文' }], nextOffset: null });
      if (url === `/api/notes/${noteId}` && init?.method === 'GET') return json({ note });
      if (init?.method === 'POST' && (url === '/api/folders' || url.startsWith('/api/notes/'))) {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        created.push({ url, body });
        return json(url.startsWith('/api/notes/') ? { note: { ...body, revision: 1 } } : { folder: body }, 201);
      }
      throw new Error(`Unexpected ${init?.method ?? 'GET'} ${url}`);
    }) as typeof fetch;
    URL.createObjectURL = (blob: Blob) => { archive = blob; return 'blob:archive'; };
    URL.revokeObjectURL = () => undefined;
    // The download helper only needs a clickable anchor; the archive is captured through createObjectURL.
    (globalThis as { document?: unknown }).document = { createElement: () => ({ click() { /* capture only */ } }) };
    // Drop the 10s revoke timer (fflate's scheduler uses queueMicrotask, so nothing else depends on it).
    globalThis.setTimeout = (() => 0) as unknown as typeof setTimeout;
    try {
      await exportArchive(() => {});
      assert.ok(archive, 'export did not produce an archive');
      const bytes = new Uint8Array(await (archive as Blob).arrayBuffer());
      const entries = unzipSync(bytes);
      const manifest = JSON.parse(strFromU8(entries['manifest.json'])) as {
        version: number;
        notes: Array<{ position?: number }>;
        folders?: Array<{ position?: number }>;
      };
      assert.equal(manifest.version, 3);
      assert.equal(manifest.notes[0].position, notePosition);
      assert.equal(manifest.folders?.[0].position, folderPosition);

      // Restore into an empty library: both order keys must reach the server.
      freshLibrary = true;
      assert.deepEqual(
        await importArchive(new File([bytes], 'easynote.zip'), config, () => {}, async () => new Map()),
        { imported: 1, skipped: 0 },
      );
      assert.equal(created.find((item) => item.url === '/api/folders')?.body.position, folderPosition);
      assert.equal(created.find((item) => item.url.startsWith('/api/notes/'))?.body.position, notePosition);

      // A v2 archive has no order keys, still imports, and leaves the server default in place.
      const { position: _folderPosition, ...legacyFolder } = folder;
      const { position: _notePosition, ...legacyNote } = note;
      const legacy = new File([new Uint8Array(zipSync({
        'manifest.json': strToU8(JSON.stringify({
          format: 'easynote', version: 2, files: [], folders: [legacyFolder],
          notes: [{ ...legacyNote, path: 'notes/legacy.md' }],
        })),
        'notes/legacy.md': strToU8('legacy body'),
      }))], 'legacy.zip');
      created.length = 0;
      assert.deepEqual(await importArchive(legacy, config, () => {}, async () => new Map()), { imported: 1, skipped: 0 });
      assert.equal(created.find((item) => item.url.startsWith('/api/notes/'))?.body.position, undefined);
    } finally {
      globalThis.fetch = originalFetch;
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
      globalThis.setTimeout = originalSetTimeout;
      if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
      else (globalThis as { document?: unknown }).document = originalDocument;
    }
  });
}
