import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRuntime, testCsrf, testToken, testUserId, testPassword } from './runtime';
import { digest } from '../src/worker/core';
import { cleanup } from '../src/worker/images';
import { passwordVerifier } from '../src/worker/auth';
import { MAX_FOLDERS, MAX_POSITION, noteFingerprint, validPosition } from '../src/shared/types';

let instance: Awaited<ReturnType<typeof createRuntime>>;
const origin = 'https://easynote.example.test';
const base = { title: '测试笔记', content: '中文搜索与图片', tags: ['工作'], pinned: false, archived: false, deletedAt: null };
async function request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  return instance.runtime.dispatchFetch(`${origin}${path}`, {
    method, headers: {
      Origin: origin, 'CF-Connecting-IP': '192.0.2.3',
      Cookie: `__Host-easynote=${testToken}`, 'X-CSRF-Token': testCsrf,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers,
    }, body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function save(
  id: string,
  revision = 0,
  patch: Record<string, unknown> = {},
  operationId = randomUUID(),
  createVersion = true,
) {
  return request(`/api/notes/${id}`, revision ? 'PUT' : 'POST', {
    ...base, ...patch, revision, operationId, createVersion,
  });
}
async function create(patch: Record<string, unknown> = {}) {
  const id = randomUUID();
  const response = await save(id, 0, patch);
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json() as any).note;
}
before(async () => { instance = await createRuntime(); });
after(async () => { await instance?.runtime.dispose(); });

test('anonymous requests, cross-origin writes and missing CSRF are rejected', async () => {
  assert.equal((await request('/api/notes', 'GET', undefined, { Cookie: '' })).status, 401);
  assert.equal((await request(`/api/events?client=${randomUUID()}`, 'GET', undefined, {
    Cookie: '',
  })).status, 401);
  assert.equal((await request(`/api/events?client=${randomUUID()}`, 'GET', undefined, {
    Origin: 'https://other.test',
  })).status, 403);
  assert.equal((await request(`/api/notes/${randomUUID()}`, 'POST', {}, { Origin: 'https://other.test' })).status, 403);
  assert.equal((await request(`/api/notes/${randomUUID()}`, 'POST', {}, { 'X-CSRF-Token': '' })).status, 403);
  assert.equal((await instance.runtime.dispatchFetch('http://easynote.example.test/api/session')).status, 403);
});

test('login uses HttpOnly secure cookie; logout revokes the session', async () => {
  const wrong = await request('/api/login', 'POST', { username: 'tester', password: 'wrong' });
  assert.equal(wrong.status, 401);
  const good = await request('/api/login', 'POST', { username: 'tester', password: testPassword });
  assert.equal(good.status, 200, await good.clone().text());
  const cookie = good.headers.get('Set-Cookie')!;
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /Secure/); assert.match(cookie, /SameSite=Strict/);
  const data = await good.json() as any;
  assert.ok(data.expiresAt > Date.now());
  assert.equal((await request('/api/logout', 'POST', {}, { Cookie: cookie.split(';')[0], 'X-CSRF-Token': data.csrf })).status, 200);
  assert.equal((await request('/api/notes', 'GET', undefined, { Cookie: cookie.split(';')[0] })).status, 401);
  assert.equal((await (await request('/api/session', 'GET', undefined, { Cookie: cookie.split(';')[0] })).json() as any).expiresAt, null);
});

test('exhausted global login failures allow correct passwords while the per-IP limit still blocks', async () => {
  const ip = '198.51.100.77';
  const ipKey = `ip:${await digest(ip)}`;
  const previous = await instance.db.prepare("SELECT started_at,attempts FROM login_attempts WHERE key='global'")
    .first<{ started_at: number; attempts: number }>();
  try {
    await instance.db.prepare("INSERT OR REPLACE INTO login_attempts VALUES('global',?,10001)").bind(Date.now()).run();
    const login = (password: string) => request('/api/login', 'POST', { username: 'tester', password }, { 'CF-Connecting-IP': ip });
    assert.equal((await login('wrong')).status, 429);
    assert.equal((await login(testPassword)).status, 200);
    await instance.db.prepare('INSERT OR REPLACE INTO login_attempts VALUES(?,?,1001)').bind(ipKey, Date.now()).run();
    assert.equal((await login(testPassword)).status, 429);
  } finally {
    await instance.db.prepare("DELETE FROM login_attempts WHERE key IN ('global',?)").bind(ipKey).run();
    if (previous) {
      await instance.db.prepare("INSERT INTO login_attempts VALUES('global',?,?)").bind(previous.started_at, previous.attempts).run();
    }
  }
});

test('session bootstrap preserves authenticated, anonymous and first-install behavior', async () => {
  const authenticated = await (await request('/api/session')).json() as any;
  assert.equal(authenticated.user.username, 'tester');
  assert.equal(authenticated.configured, true);
  assert.equal(authenticated.csrf, testCsrf);
  const anonymous = await (await request('/api/session', 'GET', undefined, { Cookie: '' })).json() as any;
  assert.equal(anonymous.user, null);
  assert.equal(anonymous.configured, true);
  assert.equal(anonymous.registrationEnabled, authenticated.registrationEnabled);

  const fresh = await createRuntime();
  try {
    await fresh.db.batch(['DELETE FROM sessions', 'DELETE FROM users'].map((sql) => fresh.db.prepare(sql)));
    const response = await fresh.runtime.dispatchFetch(`${origin}/api/session`);
    assert.equal(response.status, 200);
    const session = await response.json() as any;
    assert.equal(session.configured, true);
    assert.equal(session.user, null);
    assert.equal((await fresh.db.prepare('SELECT username FROM users').first())?.username, 'tester');
  } finally { await fresh.runtime.dispose(); }
});

test('AI tokens are scoped, revocable and preserve revision history', async () => {
  const created = await request('/api/integrations/tokens', 'POST', {
    name: '测试 AI', access: 'read-write', expiresInDays: null,
  });
  assert.equal(created.status, 201, await created.clone().text());
  const credential = await created.json() as any;
  assert.match(credential.secret, /^enai_[a-f0-9]{64}$/);
  assert.equal(credential.token.expiresAt, null);
  const bearer = { Authorization: `Bearer ${credential.secret}`, Cookie: '', 'X-CSRF-Token': '' };
  const status = await request('/api/integrations/status', 'GET', undefined, bearer);
  assert.deepEqual(await status.json(), { account: 'tester', integration: '测试 AI', access: 'read-write' });
  const emptyStats = await (await request('/api/integrations/stats', 'GET', undefined, bearer)).json() as any;
  assert.deepEqual(emptyStats, { active: 0, archived: 0, trash: 0, total: 0 });

  const id = randomUUID();
  const longQuery = '跨设备检索'.repeat(5);
  const aiCreate = await request(`/api/integrations/notes/${id}`, 'POST', {
    ...base, title: 'AI 创建', content: `## 影响\n\n法兰克福 AI 上下文\n${longQuery}`, revision: 0, operationId: randomUUID(),
  }, bearer);
  assert.equal(aiCreate.status, 201, await aiCreate.clone().text());
  const note = (await aiCreate.json() as any).note;
  const search = await (await request(`/api/integrations/notes?q=${encodeURIComponent('法兰克福')}&view=all&limit=10`, 'GET', undefined, bearer)).json() as any;
  const searchResult = search.notes.find((item: any) => item.id === id);
  assert.equal(searchResult.uri, `easynote://notes/${id}.md`);
  assert.ok(searchResult.matches.some((match: any) =>
    match.field === 'content' && match.line === 3 && match.heading === '影响' &&
    match.startOffset === note.content.indexOf('法兰克福') &&
    match.endOffset === match.startOffset + '法兰克福'.length && match.snippet.includes('法兰克福')));
  assert.match(searchResult.excerpt, /法兰克福/);
  const titleSearch = await (await request('/api/integrations/notes?q=AI&limit=10', 'GET', undefined, bearer)).json() as any;
  assert.ok(titleSearch.notes.find((item: any) => item.id === id).matches.some((match: any) =>
    match.field === 'title' && match.line === null && match.heading === null &&
    match.startOffset === null && match.endOffset === null && match.snippet.includes('AI')));
  const longSearch = await request(
    `/api/integrations/notes?q=${encodeURIComponent(longQuery)}&view=all&limit=10`,
    'GET',
    undefined,
    bearer,
  );
  assert.equal(longSearch.status, 200, await longSearch.clone().text());
  assert.ok((await longSearch.json() as any).notes.some((item: any) => item.id === id));
  assert.equal((await request('/api/integrations/notes?limit=21', 'GET', undefined, bearer)).status, 400);
  assert.equal((await request('/api/integrations/notes?sort=invalid', 'GET', undefined, bearer)).status, 400);

  const secondId = randomUUID();
  const secondCreate = await request(`/api/integrations/notes/${secondId}`, 'POST', {
    ...base, title: '批量读取第二篇', archived: true, revision: 0, operationId: randomUUID(),
  }, bearer);
  assert.equal(secondCreate.status, 201, await secondCreate.clone().text());
  const secondNote = (await secondCreate.clone().json() as any).note;
  const anyView = await (await request('/api/integrations/notes?q=批量读取第二篇&view=any', 'GET', undefined, bearer)).json() as any;
  assert.ok(anyView.notes.some((item: any) => item.id === secondId));
  const activeView = await (await request('/api/integrations/notes?q=批量读取第二篇&view=all', 'GET', undefined, bearer)).json() as any;
  assert.ok(!activeView.notes.some((item: any) => item.id === secondId));
  const unarchive = await request(`/api/integrations/notes/${secondId}`, 'PUT', {
    ...base, title: '批量读取第二篇', archived: false, revision: secondNote.revision, operationId: randomUUID(),
  }, bearer);
  assert.equal(unarchive.status, 200, await unarchive.clone().text());
  const stats = await (await request('/api/integrations/stats', 'GET', undefined, bearer)).json() as any;
  assert.deepEqual(stats, { active: 2, archived: 0, trash: 0, total: 2 });
  const batch = await (await request(
    `/api/integrations/notes/batch?ids=${encodeURIComponent(`${secondId},${id}`)}`,
    'GET',
    undefined,
    bearer,
  )).json() as any;
  assert.deepEqual(batch.notes.map((item: any) => item.id), [secondId, id]);
  assert.equal((await request('/api/integrations/notes/batch?ids=invalid', 'GET', undefined, bearer)).status, 400);
  assert.equal((await request(
    `/api/integrations/notes/batch?ids=${Array.from({ length: 21 }, () => randomUUID()).join(',')}`,
    'GET',
    undefined,
    bearer,
  )).status, 400);
  assert.equal((await request(
    `/api/integrations/notes/batch?ids=${randomUUID()}`,
    'GET',
    undefined,
    bearer,
  )).status, 404);

  const rankMarker = `rank${randomUUID().replaceAll('-', '').slice(0, 8)}`;
  const rankedNotes = [
    { id: randomUUID(), title: rankMarker, content: '标题完全匹配' },
    { id: randomUUID(), title: '正文重复命中', content: `${rankMarker}\n${rankMarker}\n${rankMarker}` },
    { id: randomUUID(), title: '正文单次命中', content: `${'填充 '.repeat(80)}${rankMarker}` },
  ];
  for (const item of rankedNotes) {
    const response = await request(`/api/integrations/notes/${item.id}`, 'POST', {
      ...base,
      title: item.title,
      content: item.content,
      revision: 0,
      operationId: randomUUID(),
    }, bearer);
    assert.equal(response.status, 201, await response.clone().text());
  }
  const ranked = await (await request(
    `/api/integrations/notes?q=${rankMarker}&limit=10`,
    'GET',
    undefined,
    bearer,
  )).json() as any;
  assert.deepEqual(ranked.notes.slice(0, 3).map((item: any) => item.id), rankedNotes.map((item) => item.id));
  assert.equal(ranked.notes[1].matches.length, 3);

  const literalId = randomUUID();
  assert.equal((await request(`/api/integrations/notes/${literalId}`, 'POST', {
    ...base,
    title: '字面量检索',
    content: '部署状态是 100%_ready',
    revision: 0,
    operationId: randomUUID(),
  }, bearer)).status, 201);
  const literalSearch = await (await request(
    `/api/integrations/notes?q=${encodeURIComponent('100%_ready')}`,
    'GET',
    undefined,
    bearer,
  )).json() as any;
  assert.deepEqual(literalSearch.notes.map((item: any) => item.id), [literalId]);

  const aiUpdate = await request(`/api/integrations/notes/${id}`, 'PUT', {
    ...base, title: 'AI 更新', content: '## 结果\n\n索引迁移到了苏黎世区域',
    revision: note.revision, operationId: randomUUID(), createVersion: false,
  }, bearer);
  assert.equal(aiUpdate.status, 200, await aiUpdate.clone().text());
  const updated = (await aiUpdate.json() as any).note;
  const removedMatch = await (await request(
    `/api/integrations/notes?q=${encodeURIComponent('法兰克福')}`,
    'GET',
    undefined,
    bearer,
  )).json() as any;
  assert.ok(!removedMatch.notes.some((item: any) => item.id === id));
  const updatedMatch = await (await request(
    `/api/integrations/notes?q=${encodeURIComponent('苏黎世')}`,
    'GET',
    undefined,
    bearer,
  )).json() as any;
  assert.ok(updatedMatch.notes.some((item: any) => item.id === id));
  assert.equal((await request(`/api/integrations/notes/${id}`, 'PUT', {
    ...base, title: '陈旧写入', revision: note.revision, operationId: randomUUID(),
  }, bearer)).status, 409);
  assert.equal((await (await request(`/api/integrations/notes/${id}`, 'GET', undefined, bearer)).json() as any).note.title, 'AI 更新');

  const versions = await (await request(`/api/notes/${id}/versions`)).json() as any;
  assert.deepEqual(versions.versions.map((version: any) => version.revision), [2, 1]);
  assert.equal(versions.versions[0].actorType, 'ai');
  assert.equal(versions.versions[0].actorName, '测试 AI');

  const readOnlyResponse = await request('/api/integrations/tokens', 'POST', {
    name: '只读镜像', access: 'read', expiresInDays: 30,
  });
  const readOnly = await readOnlyResponse.json() as any;
  const readOnlyHeaders = { Authorization: `Bearer ${readOnly.secret}`, Cookie: '', 'X-CSRF-Token': '' };
  assert.equal((await request('/api/integrations/notes?q=AI&limit=1', 'GET', undefined, readOnlyHeaders)).status, 200);
  assert.equal((await request(`/api/integrations/notes/${id}`, 'GET', undefined, readOnlyHeaders)).status, 200);
  assert.equal((await request(`/api/integrations/notes/batch?ids=${id}`, 'GET', undefined, readOnlyHeaders)).status, 200);
  assert.equal((await request(`/api/integrations/notes/${id}`, 'PUT', {
    ...base, revision: updated.revision, operationId: randomUUID(),
  }, readOnlyHeaders)).status, 403);
  assert.equal((await request(`/api/integrations/notes/${id}`, 'DELETE', {
    revision: updated.revision,
  }, bearer)).status, 404);

  const listed = await (await request('/api/integrations/tokens')).json() as any;
  assert.equal(listed.tokens.length, 2);
  assert.equal(listed.tokens.find((item: any) => item.id === credential.token.id).expiresAt, null);
  assert.ok(!JSON.stringify(listed).includes(credential.secret));
  assert.equal((await request(`/api/integrations/tokens/${credential.token.id}`, 'DELETE', {})).status, 200);
  assert.equal((await request('/api/integrations/status', 'GET', undefined, bearer)).status, 401);
});

test('idempotent create and update; operation IDs cannot be reused with changed input', async () => {
  const id = randomUUID(), operation = randomUUID();
  assert.equal((await save(id, 0, {}, operation)).status, 201);
  assert.equal((await save(id, 0, {}, operation)).status, 200);
  assert.equal((await save(id, 0, { title: 'different' }, operation)).status, 409);
  const updateOperation = randomUUID();
  const updated = await save(id, 1, { title: 'new' }, updateOperation);
  assert.equal(updated.status, 200);
  // The save response comes from the write itself (RETURNING), so it must carry the new content.
  const savedBody = await updated.json() as any;
  assert.equal(savedBody.note.revision, 2);
  assert.equal(savedBody.note.title, 'new');
  const retry = await save(id, 1, { title: 'new' }, updateOperation);
  assert.equal(retry.status, 200);
  assert.equal((await retry.json() as any).note.revision, 2);
});

test('automatic saves skip history while manual checkpoints are explicit and deduplicated', async () => {
  const id = randomUUID();
  assert.equal((await save(id, 0, { content: '自动保存 1' }, randomUUID(), false)).status, 201);
  assert.equal((await save(id, 1, { content: '自动保存 2' }, randomUUID(), false)).status, 200);
  let history = await (await request(`/api/notes/${id}/versions`)).json() as any;
  assert.deepEqual(history.versions, []);

  const checkpointOperation = randomUUID();
  const checkpoint = await save(id, 2, { content: '自动保存 2' }, checkpointOperation, true);
  assert.equal(checkpoint.status, 200, await checkpoint.clone().text());
  assert.equal((await checkpoint.json() as any).note.revision, 2);
  assert.equal((await save(id, 2, { content: '自动保存 2' }, checkpointOperation, true)).status, 200);
  assert.equal((await save(id, 2, { content: '自动保存 2' }, checkpointOperation, false)).status, 409);
  assert.equal((await save(id, 2, { content: '自动保存 2' }, randomUUID(), true)).status, 200);
  history = await (await request(`/api/notes/${id}/versions`)).json() as any;
  assert.deepEqual(history.versions.map((version: any) => version.revision), [2]);

  assert.equal((await save(id, 2, { content: '自动保存 3' }, randomUUID(), false)).status, 200);
  assert.equal((await save(id, 3, { content: '手动保存 4' }, randomUUID(), true)).status, 200);
  history = await (await request(`/api/notes/${id}/versions`)).json() as any;
  assert.deepEqual(history.versions.map((version: any) => version.revision), [4, 2]);
});

test('only one completely blank active note can exist', async () => {
  const first = await create({ title: '', content: '', tags: [] });
  const lookup = await (await request('/api/notes/blank')).json() as any;
  assert.equal(lookup.note.id, first.id);

  const duplicateId = randomUUID();
  const duplicate = await save(duplicateId, 0, { title: '', content: '', tags: [] });
  assert.equal(duplicate.status, 200, await duplicate.clone().text());
  assert.equal((await duplicate.json() as any).note.id, first.id);
  assert.equal((await instance.db.prepare(`SELECT COUNT(*) AS count FROM notes
    WHERE user_id=? AND title='' AND content='' AND tags='[]' AND archived=0 AND deleted_at IS NULL`)
    .bind(testUserId).first<{ count: number }>())!.count, 1);

  assert.equal((await save(first.id, 1, { title: '开始记录', content: '', tags: [] })).status, 200);
  const next = await create({ title: '', content: '', tags: [] });
  assert.notEqual(next.id, first.id);
});

test('batch duplicate lookup follows content fingerprints and tracks updates', async () => {
  const marker = randomUUID();
  const note = await create({ title: '原始标题', content: marker, tags: [] });
  const empty = await create({ title: `空正文-${marker}`, content: '', tags: [] });
  const contentFingerprint = await noteFingerprint('另一个标题', marker);
  const emptyFingerprint = await noteFingerprint(empty.title, '');
  const missingFingerprint = await noteFingerprint('原始标题', '不同正文');
  const duplicate = await request('/api/notes/duplicates', 'POST', {
    fingerprints: [contentFingerprint, emptyFingerprint, missingFingerprint, contentFingerprint],
  });
  assert.equal(duplicate.status, 200);
  const matches = new Map((await duplicate.json() as any).matches
    .map((match: any) => [match.fingerprint, match.noteId]));
  assert.equal(matches.get(contentFingerprint), note.id);
  assert.equal(matches.get(emptyFingerprint), empty.id);
  assert.equal(matches.has(missingFingerprint), false);

  const updatedContent = `${marker}-updated`;
  assert.equal((await save(note.id, note.revision, { content: updatedContent })).status, 200);
  const updatedFingerprint = await noteFingerprint(note.title, updatedContent);
  const afterUpdate = await (await request('/api/notes/duplicates', 'POST', {
    fingerprints: [contentFingerprint, updatedFingerprint],
  })).json() as any;
  assert.deepEqual(afterUpdate.matches, [{ fingerprint: updatedFingerprint, noteId: note.id }]);
  assert.equal((await request('/api/notes/duplicates', 'POST', { fingerprints: ['invalid'] })).status, 400);
  assert.deepEqual(await (await request('/api/notes/duplicates', 'POST', { fingerprints: [] })).json(), { matches: [] });
});

test('batch existing-note lookup checks IDs without listing the library', async () => {
  const first = await create({ content: randomUUID() });
  const second = await create({ content: randomUUID() });
  const missing = randomUUID();
  const response = await request('/api/notes/existing', 'POST', { ids: [first.id, missing, second.id, first.id] });
  assert.equal(response.status, 200);
  assert.deepEqual(new Set((await response.json() as { ids: string[] }).ids), new Set([first.id, second.id]));
  assert.equal((await request('/api/notes/existing', 'POST', { ids: ['invalid'] })).status, 400);
  assert.deepEqual(await (await request('/api/notes/existing', 'POST', { ids: [] })).json(), { ids: [] });
});

test('unchanged saves do not create revisions, including reordered tags', async () => {
  const note = await create({ tags: ['工作', '个人'] });
  const unchanged = await save(note.id, 1, { tags: ['个人', '工作'] });
  assert.equal(unchanged.status, 200, await unchanged.clone().text());
  const body = await unchanged.json() as any;
  assert.equal(body.unchanged, true);
  assert.equal(body.note.revision, 1);
  const versions = await (await request(`/api/notes/${note.id}/versions`)).json() as any;
  assert.deepEqual(versions.versions.map((version: any) => version.revision), [1]);
  const changed = await save(note.id, 1, { tags: ['个人', '工作'], pinned: true });
  assert.equal(changed.status, 200, await changed.clone().text());
  assert.equal((await changed.json() as any).note.revision, 2);
  const afterPin = await (await request(`/api/notes/${note.id}/versions`)).json() as any;
  assert.deepEqual(afterPin.versions.map((version: any) => version.revision), [1]);
  const unpinned = await save(note.id, 2, { tags: ['个人', '工作'], pinned: false });
  assert.equal(unpinned.status, 200, await unpinned.clone().text());
  assert.equal((await unpinned.json() as any).note.revision, 3);
  const afterUnpin = await (await request(`/api/notes/${note.id}/versions`)).json() as any;
  assert.deepEqual(afterUnpin.versions.map((version: any) => version.revision), [1]);
});

test('two devices cannot silently overwrite the same revision', async () => {
  const note = await create();
  const results = await Promise.all([save(note.id, 1, { content: 'device A' }), save(note.id, 1, { content: 'device B' })]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const conflict = await results.find((r) => r.status === 409)!.json() as any;
  assert.equal(conflict.error.current.revision, 2);
  const remote = await request(`/api/notes/${note.id}`);
  assert.ok(['device A', 'device B'].includes((await remote.json() as any).note.content));
});

test('Chinese search, tags, pin order and archive filters work', async () => {
  const marker = randomUUID().slice(0, 8);
  const longQuery = '完整中文搜索'.repeat(5);
  await create({ title: `${marker}-普通`, content: '中文没有空格也可查询', tags: ['验收标签'] });
  await create({ title: `${marker}-置顶`, content: '中文没有空格也可查询', tags: ['验收标签'], pinned: true });
  await create({ title: `${marker}-归档`, content: '中文没有空格也可查询', tags: ['仅归档标签'], archived: true });
  const longSearchNote = await create({ title: '长查询', content: longQuery });
  const trashed = await create({ title: `${marker}-回收站`, tags: ['仅回收站标签'] });
  await save(trashed.id, 1, { title: `${marker}-回收站`, tags: ['仅回收站标签'], deletedAt: Date.now() });
  const response = await request(`/api/notes?q=${encodeURIComponent(marker)}&view=all`);
  const data = await response.json() as any;
  assert.deepEqual(data.notes.map((note: any) => note.title), [`${marker}-置顶`, `${marker}-普通`]);
  const archive = await (await request(`/api/notes?q=${encodeURIComponent(marker)}&view=archive&tag=${encodeURIComponent('仅归档标签')}`)).json() as any;
  assert.deepEqual(archive.notes.map((note: any) => note.title), [`${marker}-归档`]);
  const longSearch = await request(`/api/notes?q=${encodeURIComponent(longQuery)}&view=all`);
  assert.equal(longSearch.status, 200, await longSearch.clone().text());
  assert.ok((await longSearch.json() as any).notes.some((note: any) => note.id === longSearchNote.id));
  const allTags = (await (await request('/api/tags?view=all')).json() as any).tags;
  assert.ok(allTags.includes('验收标签'));
  assert.ok(!allTags.includes('仅归档标签'));
  assert.ok(!allTags.includes('仅回收站标签'));
  assert.deepEqual((await (await request('/api/tags?view=archive')).json() as any).tags, ['仅归档标签']);
  assert.deepEqual((await (await request('/api/tags?view=trash')).json() as any).tags, ['仅回收站标签']);
  assert.equal((await request('/api/notes?view=pinned')).status, 400);
  assert.equal((await request('/api/tags?view=export')).status, 400);
});

test('trash, restore, permanent deletion and purge tombstones protect old devices', async () => {
  const note = await create();
  assert.equal((await request(`/api/notes/${note.id}`, 'DELETE', { revision: 1 })).status, 409);
  assert.equal((await save(note.id, 1, { deletedAt: Date.now() })).status, 200);
  assert.equal((await save(note.id, 2, { deletedAt: null })).status, 200);
  assert.equal((await save(note.id, 3, { deletedAt: Date.now() })).status, 200);
  assert.equal((await request(`/api/notes/${note.id}`, 'DELETE', { revision: 3 })).status, 409);
  assert.equal((await request(`/api/notes/${note.id}`, 'DELETE', { revision: 4 })).status, 200);
  assert.equal((await request(`/api/notes/${note.id}`)).status, 404);
  assert.equal((await save(note.id, 0)).status, 410);
  // Cleanup keeps a fresh tombstone (an old device is still answered) and drops aged ones so
  // purged_notes cannot grow without bound.
  const env = { DB: instance.db, IMAGES: instance.bucket, IMAGE_GRACE_HOURS: '24' } as any;
  await cleanup(env);
  assert.ok(await instance.db.prepare('SELECT id FROM purged_notes WHERE id=?').bind(note.id).first());
  assert.equal((await save(note.id, 0)).status, 410);
  await instance.db.prepare('UPDATE purged_notes SET purged_at=? WHERE id=?').bind(Date.now() - 31 * 86400_000, note.id).run();
  await cleanup(env);
  assert.equal(await instance.db.prepare('SELECT id FROM purged_notes WHERE id=?').bind(note.id).first(), null);
  // Updates still fail after expiry, but a revision-zero create can reuse the old ID.
  assert.equal((await save(note.id, 4)).status, 410);
  assert.equal((await save(note.id, 0)).status, 201);
});

test('all trash notes can be permanently deleted in one operation', async () => {
  const first = await create({ title: '批量删除一' });
  const second = await create({ title: '批量删除二' });
  const active = await create({ title: '保留的正常笔记' });
  assert.equal((await save(first.id, 1, { title: first.title, deletedAt: Date.now() })).status, 200);
  assert.equal((await save(second.id, 1, { title: second.title, deletedAt: Date.now() })).status, 200);

  const response = await request('/api/notes/trash', 'DELETE', {});
  assert.equal(response.status, 200, await response.clone().text());
  assert.ok(((await response.json() as any).deleted) >= 2);
  assert.equal((await request(`/api/notes/${first.id}`)).status, 404);
  assert.equal((await request(`/api/notes/${second.id}`)).status, 404);
  assert.equal((await request(`/api/notes/${active.id}`)).status, 200);
  assert.equal((await save(first.id, 0)).status, 410);
  assert.equal((await (await request('/api/notes/trash', 'DELETE', {})).json() as any).deleted, 0);
});

test('history keeps the configured content-version limit across pin revision gaps', async () => {
  const note = await create();
  assert.equal((await save(note.id, 1, { pinned: true })).status, 200);
  assert.equal((await save(note.id, 2, { content: 'version 3', pinned: true })).status, 200);
  assert.equal((await save(note.id, 3, { content: 'version 3', pinned: false })).status, 200);
  assert.equal((await save(note.id, 4, { content: 'version 5' })).status, 200);
  assert.equal((await save(note.id, 5, { content: 'version 6' })).status, 200);
  const data = await (await request(`/api/notes/${note.id}/versions`)).json() as any;
  assert.deepEqual(data.versions.map((v: any) => v.revision), [6, 5, 3]);
});

test('validation rejects malformed notes, missing images and oversized content', async () => {
  assert.equal((await save(randomUUID(), 0, { content: 'x'.repeat(262145) })).status, 400);
  assert.equal((await save(randomUUID(), 0, { tags: [42] })).status, 400);
  assert.equal((await request(`/api/notes/${randomUUID()}`, 'POST', {
    ...base, revision: 0, operationId: randomUUID(), createVersion: 'yes',
  })).status, 400);
  assert.equal((await save(randomUUID(), 0, { content: `![missing](/api/images/${randomUUID()})` })).status, 409);
});

test('a note can reference the documented maximum of 80 stored files', async () => {
  const ids = Array.from({ length: 80 }, () => randomUUID());
  const now = Date.now();
  await instance.db.prepare(`INSERT INTO images
    (id,user_id,filename,mime,size,width,height,sha256,status,created_at,last_used_at)
    SELECT value,?,value||'.txt','text/plain',1,0,0,?,'ready',?,? FROM json_each(?)`)
    .bind(testUserId, '0'.repeat(64), now, now, JSON.stringify(ids)).run();
  const id = randomUUID();
  const response = await save(id, 0, {
    content: ids.map((fileId) => `[附件](/api/files/${fileId})`).join('\n'),
  });
  assert.equal(response.status, 201, await response.clone().text());
  const refs = await instance.db.prepare('SELECT COUNT(*) AS count FROM image_refs WHERE note_id=?')
    .bind(id).first<{ count: number }>();
  assert.equal(refs?.count, 80);
});

test('private images validate media type, have no public cache, and survive history references', async () => {
  const id = randomUUID();
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
  const upload = (mime: string) => instance.runtime.dispatchFetch(`${origin}/api/images/${id}`, {
    method: 'PUT', headers: { Origin: origin, Cookie: `__Host-easynote=${testToken}`, 'X-CSRF-Token': testCsrf, 'Content-Type': mime, 'X-Filename': encodeURIComponent('测试.png') }, body: bytes,
  });
  assert.equal((await upload('image/jpeg')).status, 415);
  assert.equal((await upload('image/png')).status, 201);
  assert.equal((await upload('image/png')).status, 200);
  const response = await request(`/api/images/${id}`);
  assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal((await request(`/api/images/${id}`, 'GET', undefined, { Cookie: '' })).status, 401);
  const note = await create({ content: `![test](/api/images/${id})` });
  await save(note.id, 1, { content: 'image removed' });
  await instance.db.prepare('UPDATE images SET last_used_at=0 WHERE id=?').bind(id).run();
  const env = { DB: instance.db, IMAGES: instance.bucket, IMAGE_GRACE_HOURS: '24' } as any;
  await cleanup(env);
  assert.equal((await request(`/api/images/${id}`)).status, 200);
  await save(note.id, 2, { content: 'cleanup step one' });
  await save(note.id, 3, { content: 'cleanup step two' });
  await cleanup(env);
  assert.equal((await request(`/api/images/${id}`)).status, 404);
});

test('another account cannot read, edit or reference private notes and images', async () => {
  const otherId = randomUUID(), otherToken = 'c'.repeat(64);
  await instance.db.prepare(`INSERT INTO users
    (id,username,password_verifier,created_at,role,enabled,approved_at,updated_at)
    VALUES(?,?,?,?,'user',1,?,?)`).bind(otherId, 'other', '{}', Date.now(), Date.now(), Date.now()).run();
  await instance.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').bind(await digest(otherToken), otherId, testCsrf, Date.now() + 60000).run();
  const note = await create();
  const headers = { Cookie: `__Host-easynote=${otherToken}` };
  assert.equal((await request(`/api/notes/${note.id}`, 'GET', undefined, headers)).status, 404);
  assert.equal((await request(`/api/notes/${note.id}`, 'PUT', { ...base, revision: 1, operationId: randomUUID() }, headers)).status, 410);
  const duplicateLookup = await request('/api/notes/duplicates', 'POST', {
    fingerprints: [await noteFingerprint(note.title, note.content)],
  }, headers);
  assert.deepEqual(await duplicateLookup.json(), { matches: [] });
  const existingLookup = await request('/api/notes/existing', 'POST', { ids: [note.id] }, headers);
  assert.deepEqual(await existingLookup.json(), { ids: [] });
  const imageId = randomUUID();
  await instance.db.prepare("INSERT INTO images VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .bind(imageId, testUserId, 'owned.png', 'image/png', 1, 1, 1, '0'.repeat(64), 'ready', Date.now(), Date.now()).run();
  const foreign = await request(`/api/notes/${randomUUID()}`, 'POST',
    { ...base, content: `![private](/api/images/${imageId})`, revision: 0, operationId: randomUUID() }, headers);
  assert.equal(foreign.status, 409);
  assert.equal((await request(`/api/images/${imageId}`, 'GET', undefined, headers)).status, 404);
});

test('password changes revoke other sessions and logout-all revokes the current session', async () => {
  const userId = randomUUID();
  const firstToken = '1'.repeat(64);
  const secondToken = '2'.repeat(64);
  const csrf = '3'.repeat(64);
  const originalPassword = 'Original-Test-Password-938!';
  const newPassword = 'Updated-Test-Password-482!';
  await instance.db.prepare(`INSERT INTO users
    (id,username,password_verifier,created_at,role,enabled,approved_at,updated_at)
    VALUES(?,?,?,?,'user',1,?,?)`)
    .bind(userId, `account-${userId.slice(0, 8)}`, JSON.stringify(await passwordVerifier(originalPassword)),
      Date.now(), Date.now(), Date.now()).run();
  await instance.db.batch([
    instance.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').bind(await digest(firstToken), userId, csrf, Date.now() + 60_000),
    instance.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').bind(await digest(secondToken), userId, csrf, Date.now() + 60_000),
  ]);
  const accountHeaders = { Cookie: `__Host-easynote=${firstToken}`, 'X-CSRF-Token': csrf };
  assert.equal((await request('/api/account/password', 'POST', {
    currentPassword: 'wrong', newPassword,
  }, accountHeaders)).status, 403);
  const changed = await request('/api/account/password', 'POST', {
    currentPassword: originalPassword, newPassword,
  }, accountHeaders);
  assert.equal(changed.status, 200, await changed.clone().text());
  assert.equal((await request('/api/session', 'GET', undefined, accountHeaders)).status, 200);
  assert.equal((await request('/api/session', 'GET', undefined, {
    Cookie: `__Host-easynote=${secondToken}`, 'X-CSRF-Token': csrf,
  })).status, 200);
  const secondSession = await (await request('/api/session', 'GET', undefined, {
    Cookie: `__Host-easynote=${secondToken}`, 'X-CSRF-Token': csrf,
  })).json() as any;
  assert.equal(secondSession.user, null);
  assert.equal((await request('/api/login', 'POST', {
    username: `account-${userId.slice(0, 8)}`, password: originalPassword,
  })).status, 401);
  assert.equal((await request('/api/login', 'POST', {
    username: `account-${userId.slice(0, 8)}`, password: newPassword,
  })).status, 200);
  const loggedOut = await request('/api/account/logout-all', 'POST', { currentPassword: newPassword }, accountHeaders);
  assert.equal(loggedOut.status, 200, await loggedOut.clone().text());
  const currentSession = await (await request('/api/session', 'GET', undefined, accountHeaders)).json() as any;
  assert.equal(currentSession.user, null);
});

test('administrators manage isolated tenant accounts and registration approval', async () => {
  const username = `tenant-${randomUUID().slice(0, 8)}`;
  const password = 'Tenant-Test-Password-482!';
  const created = await request('/api/admin/users', 'POST', { username, password, role: 'user' });
  assert.equal(created.status, 201, await created.clone().text());
  const account = (await created.json() as any).user;
  assert.equal(account.role, 'user');
  assert.equal(account.enabled, true);

  const login = await request('/api/login', 'POST', { username, password });
  assert.equal(login.status, 200, await login.clone().text());
  const loginBody = await login.json() as any;
  assert.equal(loginBody.user.role, 'user');
  const accountCookie = login.headers.get('Set-Cookie')!.split(';')[0];
  const tenantHeaders = { Cookie: accountCookie, 'X-CSRF-Token': loginBody.csrf };
  const privateNote = await create({ title: `管理员私有-${randomUUID().slice(0, 6)}` });
  assert.equal((await request(`/api/notes/${privateNote.id}`, 'GET', undefined, tenantHeaders)).status, 404);
  const tenantNoteId = randomUUID();
  assert.equal((await request(`/api/notes/${tenantNoteId}`, 'POST', {
    ...base, title: '租户独立笔记', revision: 0, operationId: randomUUID(),
  }, tenantHeaders)).status, 201);
  assert.equal((await request(`/api/notes/${tenantNoteId}`)).status, 404);
  assert.equal((await request('/api/admin/users', 'GET', undefined, tenantHeaders)).status, 403);

  const disabled = await request(`/api/admin/users/${account.id}`, 'PATCH', { enabled: false });
  assert.equal(disabled.status, 200, await disabled.clone().text());
  assert.equal((await request('/api/session', 'GET', undefined, tenantHeaders)).status, 200);
  assert.equal((await (await request('/api/session', 'GET', undefined, tenantHeaders)).json() as any).user, null);
  assert.equal((await request('/api/login', 'POST', { username, password })).status, 401);

  assert.equal((await request('/api/admin/settings/registration', 'PATCH', { enabled: true })).status, 200);
  const pendingName = `pending-${randomUUID().slice(0, 8)}`;
  const pendingPassword = 'Pending-Test-Password-592!';
  const registration = await request('/api/register', 'POST', {
    username: pendingName, password: pendingPassword,
  }, { Cookie: '', 'X-CSRF-Token': '' });
  assert.equal(registration.status, 201, await registration.clone().text());
  const recoveryCode = (await registration.json() as any).recoveryCode;
  assert.match(recoveryCode, /^(?:[a-f0-9]{8}-){7}[a-f0-9]{8}$/);
  assert.equal((await request('/api/login', 'POST', { username: pendingName, password: pendingPassword })).status, 401);
  const users = (await (await request('/api/admin/users')).json() as any).users;
  const pending = users.find((item: any) => item.username === pendingName);
  assert.equal(pending.pendingApproval, true);
  assert.equal((await request(`/api/admin/users/${pending.id}`, 'PATCH', { enabled: true })).status, 200);
  assert.equal((await request('/api/login', 'POST', { username: pendingName, password: pendingPassword })).status, 200);

  const recoveredPassword = 'Recovered-Test-Password-593!';
  assert.equal((await request('/api/account/reset-password', 'POST', {
    username: pendingName, recoveryCode, newPassword: recoveredPassword,
  }, { Cookie: '', 'X-CSRF-Token': '' })).status, 200);
  assert.equal((await request('/api/login', 'POST', { username: pendingName, password: pendingPassword })).status, 401);
  const recoveredLogin = await request('/api/login', 'POST', { username: pendingName, password: recoveredPassword });
  assert.equal(recoveredLogin.status, 200);
  const recoveredSession = await recoveredLogin.json() as any;
  const recoveredHeaders = {
    Cookie: recoveredLogin.headers.get('Set-Cookie')!.split(';')[0],
    'X-CSRF-Token': recoveredSession.csrf,
  };
  assert.equal((await request('/api/account', 'DELETE', {
    username: pendingName, currentPassword: recoveredPassword,
  }, recoveredHeaders)).status, 202);
  await cleanup({ DB: instance.db, IMAGES: instance.bucket, IMAGE_GRACE_HOURS: '24' } as any);
  assert.equal(await instance.db.prepare('SELECT id FROM users WHERE id=?').bind(pending.id).first(), null);
  assert.equal((await request('/api/admin/settings/registration', 'PATCH', { enabled: false })).status, 200);
});

test('concurrent administrator changes always preserve one enabled administrator', async () => {
  const username = `admin-${randomUUID().slice(0, 8)}`;
  const password = 'Concurrent-Admin-Password-684!';
  const created = await request('/api/admin/users', 'POST', { username, password, role: 'admin' });
  assert.equal(created.status, 201, await created.clone().text());
  const other = (await created.json() as any).user;
  const login = await request('/api/login', 'POST', { username, password });
  assert.equal(login.status, 200, await login.clone().text());
  const session = await login.json() as any;
  const otherHeaders = {
    Cookie: login.headers.get('Set-Cookie')!.split(';')[0],
    'X-CSRF-Token': session.csrf,
  };

  try {
    const responses = await Promise.all([
      request(`/api/admin/users/${other.id}`, 'PATCH', { role: 'user' }),
      request(`/api/admin/users/${testUserId}`, 'PATCH', { role: 'user' }, otherHeaders),
    ]);
    const statuses = responses.map((response) => response.status);
    const remaining = await instance.db.prepare(`SELECT COUNT(*) AS count FROM users
      WHERE role='admin' AND enabled=1 AND deletion_requested_at IS NULL`).first<{ count: number }>();
    assert.equal(remaining?.count, 1, `unexpected statuses: ${statuses.join(',')}`);
    assert.ok(statuses.some((status) => status === 200));
    assert.ok(statuses.some((status) => [401, 403, 409].includes(status)), `unexpected statuses: ${statuses.join(',')}`);
  } finally {
    await instance.db.prepare(`UPDATE users SET role='admin',enabled=1,deletion_requested_at=NULL WHERE id=?`)
      .bind(testUserId).run();
    await instance.db.prepare('INSERT OR REPLACE INTO sessions VALUES(?,?,?,?)')
      .bind(await digest(testToken), testUserId, testCsrf, Date.now() + 86400_000).run();
    await instance.db.prepare('DELETE FROM users WHERE id=?').bind(other.id).run();
  }
});

test('task center aggregates unfinished tasks with source positions', async () => {
  const first = await create({
    title: '任务来源',
    content: ['- [ ] 第一项', '- [x] 已完成', '```md', '- [ ] 代码示例', '```', '- [] 简写项'].join('\n'),
  });
  const archived = await create({ title: '归档任务', content: '- [ ] 仍需处理', archived: true });
  const result = await request('/api/tasks');
  assert.equal(result.status, 200);
  const tasks = (await result.json() as any).tasks.filter((item: any) => [first.id, archived.id].includes(item.noteId));
  const firstTasks = tasks.filter((item: any) => item.noteId === first.id);
  assert.deepEqual(firstTasks.map((item: any) => item.text), ['第一项', '简写项']);
  assert.deepEqual(firstTasks.map((item: any) => item.line), [1, 6]);
  assert.equal(firstTasks[1].offset, first.content.lastIndexOf('- []'));
  assert.equal(tasks.find((item: any) => item.noteId === archived.id).archived, true);
  // The scan is paged because it must read note bodies: pages must not overlap or drop tasks.
  const paged = await (await request('/api/tasks?limit=1')).json() as any;
  assert.deepEqual(Object.keys(paged).sort(), ['nextCursor', 'tasks']);
  assert.ok(paged.tasks.length >= 1);
  assert.equal(typeof paged.nextCursor, 'string');
  const rest = await (await request(`/api/tasks?limit=50&cursor=${encodeURIComponent(paged.nextCursor)}`)).json() as any;
  assert.equal(rest.nextCursor, null);
  const pagedTasks = [...paged.tasks, ...rest.tasks];
  const keys = pagedTasks.map((item: any) => `${item.noteId}:${item.line}`);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(pagedTasks.filter((item: any) => item.noteId === first.id).length, 2);
  assert.equal(pagedTasks.filter((item: any) => item.noteId === archived.id).length, 1);
  assert.equal((await request('/api/tasks?limit=0')).status, 400);
  assert.equal((await request('/api/tasks?limit=51')).status, 400);
  assert.equal((await request('/api/tasks?limit=200')).status, 400);
  for (const cursor of ['', 'bad', `-1:${first.id}`, `1:bad`, `${Number.MAX_SAFE_INTEGER + 1}:${first.id}`]) {
    assert.equal((await request(`/api/tasks?cursor=${encodeURIComponent(cursor)}`)).status, 400);
  }
});

test('task cursors retain tied rows and do not shift after edits or trashing a read row', async () => {
  const notes: Array<{ id: string }> = [];
  const time = Date.now() + 60_000;
  for (let index = 0; index < 5; index++) {
    const note = await create({ title: `分页任务 ${index}`, content: `- [ ] 任务 ${index}` });
    // Ties span pages, so the cursor must include the ID as well as the timestamp.
    await instance.db.prepare('UPDATE notes SET updated_at=? WHERE id=?').bind(time, note.id).run();
    notes.push(note);
  }
  notes.sort((a, b) => a.id.localeCompare(b.id));
  const first = await (await request('/api/tasks?limit=2')).json() as any;
  assert.deepEqual(first.tasks.map((task: any) => task.noteId), notes.slice(0, 2).map((note) => note.id));
  assert.equal((await save(notes[0].id, 1, { content: '- [ ] 已删除', deletedAt: Date.now() })).status, 200);
  assert.equal((await save(notes[1].id, 1, { content: '- [ ] 已编辑' })).status, 200);
  await instance.db.prepare('UPDATE notes SET updated_at=? WHERE id=?').bind(time + 1, notes[1].id).run();
  const tasks = [...first.tasks];
  let cursor = first.nextCursor;
  for (let page = 0; cursor !== null; page++) {
    assert.ok(page < 100, 'task scan failed to terminate');
    const next = await (await request(`/api/tasks?limit=2&cursor=${encodeURIComponent(cursor)}`)).json() as any;
    tasks.push(...next.tasks);
    cursor = next.nextCursor;
  }
  const ids = tasks.filter((task: any) => notes.some((note) => note.id === task.noteId)).map((task: any) => task.noteId);
  assert.deepEqual(ids, notes.map((note) => note.id));
  assert.equal(new Set(ids).size, ids.length);
});

test('read-only note shares can be listed, extended, made permanent and revoked', async () => {
  const note = await create({ title: '公开只读笔记', content: '仅可阅读' });
  const created = await request(`/api/notes/${note.id}/share`, 'POST', { expiresInHours: 24 });
  assert.equal(created.status, 201, await created.clone().text());
  const share = await created.json() as any;
  assert.match(share.url, /^https:\/\/easynote\.example\.test\/shared\/[a-f0-9]{64}$/);
  const rawToken = share.url.split('/').at(-1);
  const listed = await (await request('/api/shares')).json() as any;
  assert.deepEqual(
    listed.shares.find((item: any) => item.noteId === note.id),
    {
      noteId: note.id,
      title: '公开只读笔记',
      noteUpdatedAt: note.updatedAt,
      archived: false,
      createdAt: share.share.createdAt,
      expiresAt: share.share.expiresAt,
    },
  );

  const extendedResponse = await request(`/api/notes/${note.id}/share`, 'PATCH', { expiresInHours: 24 });
  assert.equal(extendedResponse.status, 200, await extendedResponse.clone().text());
  const extended = await extendedResponse.json() as any;
  assert.equal(extended.share.createdAt, share.share.createdAt);
  assert.equal(extended.share.expiresAt, share.share.expiresAt + 24 * 3600_000);

  const publicResponse = await request(`/api/public/shares/${rawToken}`, 'GET', undefined, {
    Cookie: '', 'X-CSRF-Token': '',
  });
  assert.equal(publicResponse.status, 200);
  assert.deepEqual((await publicResponse.json() as any).note.title, '公开只读笔记');
  assert.equal(publicResponse.headers.get('Cache-Control'), 'no-store');

  const permanentResponse = await request(`/api/notes/${note.id}/share`, 'POST', { expiresInHours: null });
  assert.equal(permanentResponse.status, 201, await permanentResponse.clone().text());
  const permanent = await permanentResponse.json() as any;
  assert.equal(permanent.share.expiresAt, null);
  const permanentToken = permanent.url.split('/').at(-1);
  assert.equal((await request(`/api/public/shares/${rawToken}`, 'GET', undefined, {
    Cookie: '', 'X-CSRF-Token': '',
  })).status, 404);
  const permanentPublic = await request(`/api/public/shares/${permanentToken}`, 'GET', undefined, {
    Cookie: '', 'X-CSRF-Token': '',
  });
  assert.equal(permanentPublic.status, 200);
  assert.equal((await permanentPublic.json() as any).note.expiresAt, null);
  assert.equal((await (await request(`/api/notes/${note.id}/share`)).json() as any).share.expiresAt, null);
  assert.equal((await (await request('/api/shares')).json() as any).shares
    .find((item: any) => item.noteId === note.id).expiresAt, null);

  const permanentExtension = await request(`/api/notes/${note.id}/share`, 'PATCH', { expiresInHours: 24 });
  assert.equal((await permanentExtension.json() as any).share.expiresAt, null);
  assert.equal((await request(`/api/notes/${note.id}/share`, 'POST', { expiresInHours: 0 })).status, 400);
  assert.equal((await request(`/api/notes/${note.id}/share`, 'DELETE', {})).status, 200);
  assert.equal((await request(`/api/public/shares/${permanentToken}`, 'GET', undefined, {
    Cookie: '', 'X-CSRF-Token': '',
  })).status, 404);
});

test('incremental sync emits current notes and purge tombstones', async () => {
  const created = await create({ title: `离线同步-${randomUUID().slice(0, 6)}`, content: '第一版' });
  const first = await (await request('/api/sync?after=0&limit=200')).json() as any;
  const head = await (await request('/api/sync/cursor')).json() as any;
  const creation = first.changes.find((change: any) => change.noteId === created.id);
  assert.equal(creation.note.content, '第一版');
  assert.ok(first.cursor >= creation.sequence);
  assert.ok(head.cursor >= first.cursor);

  const updatedResponse = await save(created.id, created.revision, { title: created.title, content: '第二版' });
  const updated = (await updatedResponse.json() as any).note;
  const second = await (await request(`/api/sync?after=${first.cursor}&limit=200`)).json() as any;
  assert.equal(second.changes.find((change: any) => change.noteId === created.id).note.content, '第二版');

  await save(created.id, updated.revision, { title: created.title, content: '第二版', deletedAt: Date.now() });
  const trashed = await (await request(`/api/notes/${created.id}`)).json() as any;
  await request(`/api/notes/${created.id}`, 'DELETE', { revision: trashed.note.revision });
  const third = await (await request(`/api/sync?after=${second.cursor}&limit=200`)).json() as any;
  assert.equal(third.changes.find((change: any) => change.noteId === created.id).note, null);
});

test('stable internal links expose backlinks', async () => {
  const target = await create({ title: '链接目标', content: '目标正文' });
  const source = await create({ title: '链接来源', content: `参见 [[${target.id}|链接目标]]` });
  const backlinks = await (await request(`/api/notes/${target.id}/backlinks`)).json() as any;
  assert.ok(backlinks.notes.some((note: any) => note.id === source.id));
});

test('private PDF and text attachments are validated and downloaded safely', async () => {
  const pdfId = randomUUID();
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF');
  const upload = await instance.runtime.dispatchFetch(`${origin}/api/files/${pdfId}`, {
    method: 'PUT',
    headers: {
      Origin: origin,
      Cookie: `__Host-easynote=${testToken}`,
      'X-CSRF-Token': testCsrf,
      'Content-Type': 'application/pdf',
      'X-Filename': encodeURIComponent('资料.pdf'),
    },
    body: pdf,
  });
  assert.equal(upload.status, 201, await upload.clone().text());
  const stored = (await upload.json() as any).file;
  assert.equal(stored.url, `/api/files/${pdfId}`);
  const downloaded = await request(`/api/files/${pdfId}`);
  assert.equal(downloaded.status, 200);
  assert.match(downloaded.headers.get('Content-Disposition') ?? '', /^attachment;/);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), pdf);
  assert.equal((await request(`/api/images/${pdfId}`)).status, 404);

  const invalid = await instance.runtime.dispatchFetch(`${origin}/api/files/${randomUUID()}`, {
    method: 'PUT',
    headers: {
      Origin: origin,
      Cookie: `__Host-easynote=${testToken}`,
      'X-CSRF-Token': testCsrf,
      'Content-Type': 'application/pdf',
      'X-Filename': encodeURIComponent('伪造.pdf'),
    },
    body: Buffer.from('not a pdf'),
  });
  assert.equal(invalid.status, 415);
});

test('folders enforce five levels, ownership, and empty-only deletion', async () => {
  const ids: string[] = [];
  for (let depth = 0; depth < 5; depth++) {
    const id = randomUUID();
    const response = await request('/api/folders', 'POST', { id, name: `层-${id}`, parentId: ids.at(-1) ?? null });
    assert.equal(response.status, 201, await response.clone().text());
    ids.push(id);
  }
  assert.equal((await request('/api/folders', 'POST', { id: randomUUID(), name: '第六层', parentId: ids[4] })).status, 400);
  assert.equal((await request('/api/folders', 'POST', { id: randomUUID(), name: '无父目录', parentId: randomUUID() })).status, 400);
  assert.equal((await request('/api/folders', 'POST', { id: randomUUID(), name: '   ', parentId: null })).status, 400);
  assert.equal((await request(`/api/folders/${ids[0]}`, 'DELETE')).status, 409);
  const foreignUser = randomUUID(), foreignFolder = randomUUID();
  await instance.db.prepare(`INSERT INTO users(id,username,password_verifier,created_at,updated_at) VALUES(?,?,?,1,1)`)
    .bind(foreignUser, `other-${foreignUser}`, '{}').run();
  await instance.db.prepare('INSERT INTO folders(id,user_id,parent_id,name,created_at,updated_at) VALUES(?,?,NULL,?,1,1)')
    .bind(foreignFolder, foreignUser, 'private').run();
  assert.equal((await request('/api/folders', 'POST', { id: randomUUID(), name: '越权', parentId: foreignFolder })).status, 400);
  assert.equal((await request(`/api/folders/${foreignFolder}`, 'PATCH', { name: '改名' })).status, 404);
  assert.equal((await request(`/api/folders/${foreignFolder}`, 'DELETE')).status, 404);
  assert.equal((await save(randomUUID(), 0, { folderId: foreignFolder })).status, 400);
  const folders = (await (await request('/api/folders')).json() as any).folders;
  assert.ok(!folders.some((folder: any) => folder.id === foreignFolder));
  const note = await create({ folderId: ids[4], title: randomUUID() });
  assert.equal((await request(`/api/folders/${ids[4]}`, 'DELETE')).status, 409);
  const trashed = await save(note.id, note.revision, { ...note, deletedAt: Date.now() });
  assert.equal(trashed.status, 200);
  assert.equal((await request(`/api/folders/${ids[4]}`, 'DELETE')).status, 409);
  const root = await save(note.id, (await trashed.json() as any).note.revision, { ...note, deletedAt: Date.now(), folderId: null });
  assert.equal(root.status, 200);
  for (const id of ids.reverse()) assert.equal((await request(`/api/folders/${id}`, 'DELETE')).status, 200);
});

test('folders reject duplicate sibling names and keep renames idempotent', async () => {
  const root = randomUUID(), child = randomUUID(), otherRoot = randomUUID();
  assert.equal((await request('/api/folders', 'POST', { id: root, name: '同名', parentId: null })).status, 201);
  assert.equal((await request('/api/folders', 'POST', { id: randomUUID(), name: '同名', parentId: null })).status, 409);
  assert.equal((await request('/api/folders', 'POST', { id: child, name: '同名', parentId: root })).status, 201);
  assert.equal((await request('/api/folders', 'POST', { id: randomUUID(), name: '同名', parentId: root })).status, 409);
  assert.equal((await request('/api/folders', 'POST', { id: otherRoot, name: '同名', parentId: null })).status, 409);
  const sibling = randomUUID();
  assert.equal((await request('/api/folders', 'POST', { id: sibling, name: '兄弟', parentId: root })).status, 201);
  assert.equal((await request(`/api/folders/${sibling}`, 'PATCH', { name: '同名' })).status, 409);
  assert.equal((await request(`/api/folders/${sibling}`, 'PATCH', { name: '兄弟' })).status, 200);
  assert.equal((await request(`/api/folders/${root}`, 'PATCH', { name: '同名' })).status, 200);
  const foreign = randomUUID(), foreignFolder = randomUUID();
  await instance.db.prepare('INSERT INTO users(id,username,password_verifier,created_at,updated_at) VALUES(?,?,?,1,1)')
    .bind(foreign, `dup-${foreign}`, '{}').run();
  await instance.db.prepare(`INSERT INTO folders(id,user_id,parent_id,name,created_at,updated_at) VALUES(?,?,NULL,'同名',1,1)`)
    .bind(foreignFolder, foreign).run();
  assert.equal((await request('/api/folders', 'POST', { id: randomUUID(), name: '独立', parentId: null })).status, 201);
  // An ID owned by another account is a conflict, not a 500.
  assert.equal((await request('/api/folders', 'POST', { id: foreignFolder, name: '外来', parentId: null })).status, 409);
});

test('folder moves carry subtrees and notes, and reject cycles, depth overflow and name clashes', async () => {
  const target = randomUUID(), source = randomUUID(), middle = randomUUID(), leaf = randomUUID();
  assert.equal((await request('/api/folders', 'POST', { id: target, name: '目标', parentId: null })).status, 201);
  assert.equal((await request('/api/folders', 'POST', { id: source, name: '来源', parentId: null })).status, 201);
  assert.equal((await request('/api/folders', 'POST', { id: middle, name: '中', parentId: source })).status, 201);
  assert.equal((await request('/api/folders', 'POST', { id: leaf, name: '叶', parentId: middle })).status, 201);
  const note = await create({ folderId: middle, title: randomUUID() });
  const clash = randomUUID();
  assert.equal((await request('/api/folders', 'POST', { id: clash, name: '中', parentId: target })).status, 201);
  assert.equal((await request(`/api/folders/${middle}`, 'PATCH', { parentId: target })).status, 409);
  assert.equal((await request(`/api/folders/${clash}`, 'DELETE')).status, 200);
  const moved = await request(`/api/folders/${middle}`, 'PATCH', { parentId: target });
  assert.equal(moved.status, 200, await moved.clone().text());
  assert.equal((await moved.json() as any).folder.parentId, target);
  // Descendants and notes travel with the moved folder.
  const folders = (await (await request('/api/folders')).json() as any).folders;
  assert.equal(folders.find((folder: any) => folder.id === leaf).parentId, middle);
  assert.equal((await (await request(`/api/notes/${note.id}`)).json() as any).note.folderId, middle);
  assert.equal((await request(`/api/folders/${middle}`, 'PATCH', { parentId: source })).status, 200);
  assert.equal((await request(`/api/folders/${source}`, 'PATCH', { parentId: source })).status, 400);
  assert.equal((await request(`/api/folders/${source}`, 'PATCH', { parentId: leaf })).status, 400);
  assert.equal((await request(`/api/folders/${middle}`, 'PATCH', { parentId: leaf })).status, 400);
  // A folder that would push its subtree past the fifth level cannot be a destination.
  const deep2 = randomUUID(), deep3 = randomUUID(), deep4 = randomUUID();
  assert.equal((await request('/api/folders', 'POST', { id: deep2, name: '深二', parentId: target })).status, 201);
  assert.equal((await request('/api/folders', 'POST', { id: deep3, name: '深三', parentId: deep2 })).status, 201);
  assert.equal((await request('/api/folders', 'POST', { id: deep4, name: '深四', parentId: deep3 })).status, 201);
  assert.equal((await request(`/api/folders/${source}`, 'PATCH', { parentId: deep4 })).status, 400);
  assert.equal((await request(`/api/folders/${middle}`, 'PATCH', { parentId: null })).status, 200);
  assert.equal((await request(`/api/folders/${leaf}`, 'PATCH', { name: '叶改' })).status, 200);
  assert.equal((await request(`/api/folders/${leaf}`, 'PATCH', {})).status, 400);
});

test('folder creation stops at the export limit and the database keeps siblings unique', async () => {
  const fresh = await createRuntime();
  try {
    const freshRequest = (path: string, method = 'GET', body?: unknown) =>
      fresh.runtime.dispatchFetch(`${origin}${path}`, {
        method, headers: {
          Origin: origin, 'CF-Connecting-IP': '192.0.2.3',
          Cookie: `__Host-easynote=${testToken}`, 'X-CSRF-Token': testCsrf,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        }, body: body === undefined ? undefined : JSON.stringify(body),
      });
    await fresh.db.prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<${MAX_FOLDERS})
      INSERT INTO folders(id,user_id,parent_id,name,created_at,updated_at)
      SELECT lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-4'||substr(hex(randomblob(2)),2)||'-'||
        substr('89ab',1+abs(random())%4,1)||substr(hex(randomblob(2)),2)||'-'||hex(randomblob(6))),
        ?,NULL,'seed-'||n,1,1 FROM seq`).bind(testUserId).run();
    const seeded = await fresh.db.prepare('SELECT id FROM folders WHERE user_id=? AND name=?')
      .bind(testUserId, 'seed-1').first<{ id: string }>();
    assert.equal((await freshRequest('/api/folders', 'POST', { id: randomUUID(), name: '超额', parentId: null })).status, 409);
    // Renaming still works at the cap because it adds no folder.
    assert.equal((await freshRequest(`/api/folders/${seeded!.id}`, 'PATCH', { name: 'seed-1-改' })).status, 200);
    await assert.rejects(fresh.db.prepare('INSERT INTO folders(id,user_id,parent_id,name,created_at,updated_at) VALUES(?,?,NULL,?,1,1)')
      .bind(randomUUID(), testUserId, 'seed-2').run());
  } finally { await fresh.runtime.dispose(); }
});

test('moving notes preserves content/history, old requests keep folders, and blanks stay scoped', async () => {
  const folderId = randomUUID();
  assert.equal((await request('/api/folders', 'POST', { id: folderId, name: folderId, parentId: null })).status, 201);
  const note = await create({ title: randomUUID(), folderId });
  const oldRequest = await save(note.id, note.revision, { title: note.title });
  assert.equal(oldRequest.status, 200);
  assert.equal((await oldRequest.json() as any).note.folderId, folderId);
  const operationId = randomUUID();
  const moved = await save(note.id, note.revision, { title: note.title, folderId: null }, operationId);
  assert.equal(moved.status, 200, await moved.clone().text());
  const saved = (await moved.json() as any).note;
  assert.equal(saved.content, note.content);
  assert.equal(saved.revision, note.revision + 1);
  assert.equal(saved.folderId, null);
  assert.equal((await save(note.id, note.revision, { title: note.title, folderId: null }, operationId)).status, 200);
  const versions = (await (await request(`/api/notes/${note.id}/versions`)).json() as any).versions;
  assert.equal(versions.length, 1);
  assert.equal(versions[0].content, note.content);
  assert.equal((await save(note.id, saved.revision, { folderId: randomUUID() })).status, 400);
  const cursor = (await (await request('/api/sync/cursor')).json() as any).cursor;
  const blank = await create({ title: '', content: '', tags: [], folderId });
  const rootBlank = (await (await save(randomUUID(), 0, { title: '', content: '', tags: [], folderId: null })).json() as any).note;
  assert.notEqual(blank.id, rootBlank.id);
  assert.equal((await (await request(`/api/notes/blank?folder=${folderId}`)).json() as any).note.id, blank.id);
  const list = (await (await request(`/api/notes?folder=${folderId}`)).json() as any).notes;
  assert.ok(list.every((item: any) => item.folderId === folderId));
  const sync = (await (await request(`/api/sync?after=${cursor}&limit=200`)).json() as any).changes;
  assert.ok(sync.some((change: any) => change.noteId === blank.id && change.note.folderId === folderId));
});

test('blank-note moves never overwrite another blank and account deletion cascades safely', async () => {
  const folderId = randomUUID();
  await request('/api/folders', 'POST', { id: folderId, name: folderId, parentId: null });
  const blank = await create({ title: '', content: '', tags: [], folderId });
  await save(randomUUID(), 0, { title: '', content: '', tags: [], folderId: null });
  const moved = await save(blank.id, blank.revision, { title: '', content: '', tags: [], folderId: null });
  assert.equal(moved.status, 409);
  assert.equal((await (await request(`/api/notes/${blank.id}`)).json() as any).note.folderId, folderId);
  const userId = randomUUID(), child = randomUUID();
  await instance.db.prepare('INSERT INTO users(id,username,password_verifier,created_at,updated_at) VALUES(?,?,?,1,1)')
    .bind(userId, userId, '{}').run();
  await instance.db.prepare('INSERT INTO folders VALUES(?,?,NULL,?,1,1,0)').bind(child, userId, 'folder').run();
  for (const target of [null, child]) await instance.db.prepare(`INSERT INTO notes
    (id,user_id,title,content,dedup_hash,created_at,updated_at,mutation_id,mutation_hash,folder_id)
    VALUES(?,?,'','','hash',1,1,?,?,?)`).bind(randomUUID(), userId, randomUUID(), 'hash', target).run();
  await instance.db.prepare('DELETE FROM users WHERE id=?').bind(userId).run();
  assert.equal(await instance.db.prepare('SELECT id FROM notes WHERE user_id=?').bind(userId).first(), null);
  assert.equal(await instance.db.prepare('SELECT id FROM folders WHERE user_id=?').bind(userId).first(), null);
});

test('note and folder creates preserve signed order keys and reject invalid positions', async () => {
  for (const position of [-MAX_POSITION, -1024, 0, MAX_POSITION]) {
    const folderId = randomUUID();
    const created = await request('/api/folders', 'POST', { id: folderId, name: folderId, parentId: null, position });
    assert.equal(created.status, 201, await created.clone().text());
    assert.equal((await created.json() as any).folder.position, position);
    const note = await create({ title: `顺序 ${position}`, folderId, position });
    assert.equal(note.position, position);
    const updated = await save(note.id, 1, { title: '编辑保留位置', folderId, position: 1234 });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json() as any).note.position, position);
  }
  for (const position of [-MAX_POSITION - 1, MAX_POSITION + 1, 1.5, '-1024', null]) {
    const folderId = randomUUID();
    assert.equal((await request('/api/folders', 'POST', { id: folderId, name: folderId, parentId: null, position })).status, 400);
    const note = await save(randomUUID(), 0, { position });
    assert.equal(note.status, 400);
    assert.equal((await note.json() as any).error.message, 'Invalid note position.');
  }
});

test('note and folder drops at signed bounds renumber siblings into the archive range', async () => {
  for (const position of [MAX_POSITION, -MAX_POSITION]) {
    const parentId = randomUUID(), anchorId = randomUUID(), movingId = randomUUID();
    assert.equal((await request('/api/folders', 'POST', { id: parentId, name: parentId, parentId: null })).status, 201);
    for (const [id, key] of [[anchorId, position], [movingId, 0]] as const) {
      assert.equal((await request('/api/folders', 'POST', { id, name: id, parentId, position: key })).status, 201);
    }
    const anchor = await create({ title: '边界锚点', folderId: parentId, position });
    const moving = await create({ title: '移动笔记', folderId: parentId });
    const folderAnchor = position > 0 ? { afterId: anchorId } : { beforeId: anchorId };
    const noteAnchor = position > 0 ? { afterId: anchor.id } : { beforeId: anchor.id };
    const movedFolder = await request(`/api/folders/${movingId}`, 'PATCH', { parentId, ...folderAnchor });
    assert.equal(movedFolder.status, 200, await movedFolder.clone().text());
    const movedNotes = await request('/api/notes/order', 'PATCH', { ids: [moving.id], ...noteAnchor });
    assert.equal(movedNotes.status, 200, await movedNotes.clone().text());
    assert.equal((await movedNotes.json() as any).notes.length, 2);
    const folders = ((await (await request('/api/folders')).json() as any).folders as any[])
      .filter((folder) => folder.parentId === parentId);
    const notes = (await (await request(`/api/notes?folder=${parentId}&sort=manual`)).json() as any).notes as any[];
    for (const items of [folders, notes]) {
      assert.ok(items.every((item) => validPosition(item.position)));
      assert.deepEqual(items.map((item) => item.position), [1024, 2048]);
    }
    assert.deepEqual(folders.map((folder) => folder.id), position > 0 ? [anchorId, movingId] : [movingId, anchorId]);
    assert.deepEqual(notes.map((note) => note.id), position > 0 ? [anchor.id, moving.id] : [moving.id, anchor.id]);
    assert.ok(notes.every((note) => note.revision === 1));
  }
});

test('manual note order writes only the position and never bumps a revision', async () => {
  const folderId = randomUUID();
  assert.equal((await request('/api/folders', 'POST', { id: folderId, name: folderId, parentId: null })).status, 201);
  for (const title of ['第一篇', '第二篇', '第三篇']) await create({ title, folderId });
  const before = (await (await request(`/api/notes?folder=${folderId}&sort=manual`)).json() as any).notes
    .map((item: any) => item.id) as string[];
  const last = before[before.length - 1];
  const revisionBefore = (await (await request(`/api/notes/${last}`)).json() as any).note;
  const cursor = (await (await request('/api/sync/cursor')).json() as any).cursor;

  // The UI sends the neighbouring row as the anchor, never an absolute index.
  const moved = await request('/api/notes/order', 'PATCH', { ids: [last], beforeId: before[0] });
  assert.equal(moved.status, 200, await moved.clone().text());
  const movedNote = (await moved.json() as any).notes[0];
  assert.ok(movedNote.position < 0);
  const reordered = (await (await request(`/api/notes?folder=${folderId}&sort=manual`)).json() as any).notes
    .map((item: any) => item.id) as string[];
  assert.deepEqual(reordered, [last, ...before.filter((id) => id !== last)]);

  // Reordering is placement metadata: no new revision, timestamp or content version.
  const revisionAfter = (await (await request(`/api/notes/${last}`)).json() as any).note;
  assert.equal(revisionAfter.revision, revisionBefore.revision);
  assert.equal(revisionAfter.updatedAt, revisionBefore.updatedAt);
  assert.equal(revisionAfter.content, revisionBefore.content);
  assert.equal((await (await request(`/api/notes/${last}/versions`)).json() as any).versions.length, 1);
  // Other devices learn the new key through sync, so the order converges without a content edit.
  const sync = (await (await request(`/api/sync?after=${cursor}&limit=200`)).json() as any).changes;
  assert.ok(sync.some((change: any) => change.noteId === last && change.note.position === movedNote.position));
  // The last-modified view keeps its own order, so the manual key never leaks out of folder views.
  const recent = (await (await request(`/api/notes?folder=${folderId}`)).json() as any).notes;
  assert.deepEqual(new Set(recent.map((item: any) => item.id)), new Set(before));
});

test('a tight reorder returns and publishes every key it had to renumber', async () => {
  const folderId = randomUUID();
  assert.equal((await request('/api/folders', 'POST', { id: folderId, name: folderId, parentId: null })).status, 201);
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  for (const [index, id] of ids.entries()) {
    assert.equal((await save(id, 0, { title: `紧凑 ${index}`, folderId })).status, 201);
  }
  // Adjacent keys leave no integer slot between the first two notes.
  for (const [position, id] of [[1024, ids[0]], [1025, ids[1]], [2048, ids[2]]] as const) {
    await instance.db.prepare('UPDATE notes SET position=? WHERE id=?').bind(position, id).run();
  }
  const cursor = (await (await request('/api/sync/cursor')).json() as any).cursor;
  const moved = await request('/api/notes/order', 'PATCH', { ids: [ids[2]], afterId: ids[0] });
  assert.equal(moved.status, 200, await moved.clone().text());
  const notes = (await moved.json() as any).notes;
  // The response carries the dragged note and the neighbour whose key had to move.
  assert.deepEqual(notes.map((item: any) => item.id).sort(), [ids[1], ids[2]].sort());
  assert.equal(notes.find((item: any) => item.id === ids[1]).position, 3072);
  const list = (await (await request(`/api/notes?folder=${folderId}&sort=manual`)).json() as any).notes;
  assert.deepEqual(list.map((item: any) => item.id), [ids[0], ids[2], ids[1]]);
  assert.deepEqual(list.map((item: any) => item.position), [1024, 2048, 3072]);
  const sync = (await (await request(`/api/sync?after=${cursor}&limit=200`)).json() as any).changes;
  // Other devices must learn about the renumbered neighbour too, not only the dragged note.
  for (const id of [ids[1], ids[2]]) assert.ok(sync.some((change: any) => change.noteId === id), id);
});

test('note order rejects cross-folder groups, foreign anchors and missing notes', async () => {
  const folderA = randomUUID(), folderB = randomUUID();
  for (const id of [folderA, folderB]) {
    assert.equal((await request('/api/folders', 'POST', { id, name: id, parentId: null })).status, 201);
  }
  const a = await create({ title: 'A', folderId: folderA });
  const b = await create({ title: 'B', folderId: folderB });
  assert.equal((await request('/api/notes/order', 'PATCH', { ids: [a.id, b.id], afterId: null })).status, 400);
  assert.equal((await request('/api/notes/order', 'PATCH', { ids: [a.id], beforeId: randomUUID() })).status, 400);
  assert.equal((await request('/api/notes/order', 'PATCH', { ids: [a.id], beforeId: a.id })).status, 400);
  assert.equal((await request('/api/notes/order', 'PATCH', { ids: [randomUUID()], afterId: null })).status, 404);
  assert.equal((await request('/api/notes/order', 'PATCH', { ids: [a.id], extra: true })).status, 400);
  // Notes that live outside every folder can be ordered too; "root" is a view, not a folder ID.
  const root = await create({ title: '未归档', folderId: null });
  assert.equal((await request('/api/notes/order', 'PATCH', { ids: [root.id], afterId: null })).status, 200);
  assert.equal((await (await request(`/api/notes/blank?folder=root`)).json() as any).note.folderId, null);
});

test('a large folder reorder keeps one JSON query per batch and returns only positions', async () => {
  const folderId = randomUUID();
  assert.equal((await request('/api/folders', 'POST', { id: folderId, name: folderId, parentId: null })).status, 201);
  const total = 230;
  const ids: string[] = [];
  for (let i = 0; i < total; i++) {
    const note = await create({ title: `批量 ${i}`, folderId });
    ids.push(note.id);
  }
  // Every note starts at position 0, so the first drop renumbers the whole folder.
  const moved = await request('/api/notes/order', 'PATCH', { ids: [ids[0]], beforeId: ids[1] });
  assert.equal(moved.status, 200, await moved.clone().text());
  const updated = (await moved.json() as any).notes;
  assert.equal(updated.length, total);
  // A huge backfill must not echo every note's full content, only the new keys.
  for (const entry of updated) assert.deepEqual(Object.keys(entry).sort(), ['id', 'position']);

  // A >200 ID selection also exceeds the old 8192-byte request limit.
  const group = ids.slice(0, 220);
  const grouped = await request('/api/notes/order', 'PATCH', { ids: group, afterId: null });
  assert.equal(grouped.status, 200, await grouped.clone().text());
  assert.equal((await grouped.json() as any).notes.length, 220);
});

test('folder moves land on the sibling anchor and are rejected inside their own subtree', async () => {
  const parent = randomUUID();
  assert.equal((await request('/api/folders', 'POST', { id: parent, name: '排序父目录', parentId: null })).status, 201);
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  for (const [index, id] of ids.entries()) {
    assert.equal((await request('/api/folders', 'POST', { id, name: `目录 ${index}`, parentId: parent })).status, 201);
  }
  const children = async () => ((await (await request('/api/folders')).json() as any).folders as any[])
    .filter((item) => item.parentId === parent).map((item) => item.id) as string[];
  const before = await children();
  const last = before[before.length - 1];
  const moved = await request(`/api/folders/${last}`, 'PATCH', { parentId: parent, beforeId: before[0] });
  assert.equal(moved.status, 200, await moved.clone().text());
  assert.deepEqual(await children(), [last, ...before.filter((id) => id !== last)]);

  // A plain rename keeps the slot; an unknown anchor and a cycle both fail loudly.
  assert.equal((await request(`/api/folders/${last}`, 'PATCH', { name: '改名目录' })).status, 200);
  assert.deepEqual(await children(), [last, ...before.filter((id) => id !== last)]);
  assert.equal((await request(`/api/folders/${last}`, 'PATCH', { parentId: parent, beforeId: parent })).status, 400);
  const nested = randomUUID();
  assert.equal((await request('/api/folders', 'POST', { id: nested, name: '子目录', parentId: last })).status, 201);
  assert.equal((await request(`/api/folders/${last}`, 'PATCH', { parentId: nested })).status, 400);
  assert.equal((await request(`/api/folders/${last}`, 'PATCH', { parentId: parent, beforeId: randomUUID() })).status, 400);
});

test('manual order is ignored for folder searches, tags and non-active views', async () => {
  const folderId = randomUUID(), tag = randomUUID();
  assert.equal((await request('/api/folders', 'POST', { id: folderId, name: folderId, parentId: null })).status, 201);
  const ids: string[] = [];
  for (let index = 0; index < 3; index++) {
    const note = await create({ title: `检索顺序-${index}`, folderId, tags: [tag] });
    ids.push(note.id);
    await instance.db.prepare('UPDATE notes SET updated_at=? WHERE id=?').bind(1000 + index, note.id).run();
  }
  assert.equal((await request('/api/notes/order', 'PATCH', { ids })).status, 200);
  const listed = async (extra: string) => ((await (await request(`/api/notes?folder=${folderId}&sort=manual${extra}`)).json() as any).notes as any[]).map((note) => note.id);
  assert.deepEqual(await listed(''), ids);
  assert.deepEqual(await listed('&q=检索顺序'), [...ids].reverse());
  assert.deepEqual(await listed(`&tag=${tag}`), [...ids].reverse());
  await instance.db.prepare('UPDATE notes SET archived=1 WHERE folder_id=?').bind(folderId).run();
  assert.deepEqual(await listed('&view=archive'), [...ids].reverse());
  await instance.db.prepare('UPDATE notes SET deleted_at=1234 WHERE folder_id=?').bind(folderId).run();
  assert.deepEqual(await listed('&view=trash'), [...ids].reverse());
});

test('first Chinese folder drop uses the same collation as the visible tree', async () => {
  const parentId = randomUUID();
  assert.equal((await request('/api/folders', 'POST', { id: parentId, name: parentId, parentId: null })).status, 201);
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  for (const [index, name] of ['阿', '波', '张'].entries()) {
    assert.equal((await request('/api/folders', 'POST', { id: ids[index], name, parentId })).status, 201);
  }
  const names = async () => ((await (await request('/api/folders')).json() as any).folders as any[]).filter((folder) => folder.parentId === parentId).map((folder) => folder.name);
  assert.deepEqual(await names(), ['阿', '波', '张']);
  assert.equal((await request(`/api/folders/${ids[2]}`, 'PATCH', { parentId, beforeId: ids[1] })).status, 200);
  assert.deepEqual(await names(), ['阿', '张', '波']);
});

test('pre-folder mutation hashes accept identical upgrade retries and reject changed payloads', async () => {
  const id = randomUUID(), operationId = randomUUID(), title = randomUUID();
  assert.equal((await save(id, 0, { title }, operationId)).status, 201);
  const legacyHash = await digest(JSON.stringify({ ...base, title, revision: 0, createVersion: true }));
  await instance.db.prepare('UPDATE notes SET mutation_hash=? WHERE id=?').bind(legacyHash, id).run();
  const retried = await save(id, 0, { title, folderId: null }, operationId);
  assert.equal(retried.status, 200, await retried.clone().text());
  assert.equal((await retried.json() as any).note.revision, 1);
  assert.equal((await save(id, 0, { title: `${title}-changed` }, operationId)).status, 409);
});
