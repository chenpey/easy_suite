import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createRuntime, testUserId } from './runtime';
import { digest } from '../src/worker/core';

let instance: Awaited<ReturnType<typeof createRuntime>>;
const origin = 'https://easynote.test';
const writeSecret = `enai_${'d'.repeat(64)}`;
const readSecret = `enai_${'e'.repeat(64)}`;

async function integrationRequest(secret: string, path: string, method = 'GET', body?: unknown) {
  return instance.runtime.dispatchFetch(`${origin}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${secret}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function connectMcp(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    authProvider: { token: async () => token },
    fetch: (url, init) => instance.runtime.dispatchFetch(url, init as never) as unknown as Promise<Response>,
  });
  const client = new Client({ name: 'easynote-test-client', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

before(async () => {
  instance = await createRuntime();
  const now = Date.now();
  await instance.db.batch([
    instance.db.prepare(`INSERT INTO integration_tokens
      (id,user_id,name,token_hash,access,created_at,expires_at,last_used_at,revoked_at)
      VALUES(?,?,?,?,?,?,?,NULL,NULL)`)
      .bind(randomUUID(), testUserId, '测试写入桥接器', await digest(writeSecret), 'read-write', now, now + 86400_000),
    instance.db.prepare(`INSERT INTO integration_tokens
      (id,user_id,name,token_hash,access,created_at,expires_at,last_used_at,revoked_at)
      VALUES(?,?,?,?,?,?,?,NULL,NULL)`)
      .bind(randomUUID(), testUserId, '测试只读桥接器', await digest(readSecret), 'read', now, now + 86400_000),
  ]);

  const fixtures = JSON.parse(await readFile(new URL('./fixtures/ai-evaluation-notes.json', import.meta.url), 'utf8')) as Array<{
    id: string;
    title: string;
    content: string;
    tags: string[];
  }>;
  for (const note of fixtures) {
    const response = await integrationRequest(writeSecret, `/api/integrations/notes/${note.id}`, 'POST', {
      ...note,
      pinned: false,
      archived: false,
      deletedAt: null,
      revision: 0,
      operationId: randomUUID(),
    });
    assert.equal(response.status, 201, await response.clone().text());
  }
});

after(async () => {
  await instance?.runtime.dispose();
});

test('remote MCP requires its bearer token, POST and same-origin browser requests', async () => {
  const initialize = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
  });
  const missing = await instance.runtime.dispatchFetch(`${origin}/mcp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: initialize,
  });
  assert.equal(missing.status, 401);

  const get = await instance.runtime.dispatchFetch(`${origin}/mcp`, {
    headers: { Authorization: `Bearer ${readSecret}` },
  });
  assert.equal(get.status, 405);

  const crossOrigin = await instance.runtime.dispatchFetch(`${origin}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${readSecret}`,
      'Content-Type': 'application/json',
      Origin: 'https://attacker.example',
    },
    body: initialize,
  });
  assert.equal(crossOrigin.status, 403);
});

test('MCP searches, reads and writes through the EasyNote API', async () => {
  const client = await connectMcp(writeSecret);
  try {
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === 'easynote_create_note'));
    assert.ok(tools.tools.some((tool) => tool.name === 'easynote_update_note'));
    assert.ok(tools.tools.some((tool) => tool.name === 'easynote_search_notes'));
    assert.ok(tools.tools.some((tool) => tool.name === 'easynote_list_recent'));
    assert.ok(tools.tools.some((tool) => tool.name === 'easynote_read_note'));
    assert.ok(tools.tools.some((tool) => tool.name === 'easynote_read_notes'));
    assert.ok(tools.tools.some((tool) => tool.name === 'easynote_connection_status'));
    assert.ok(tools.tools.some((tool) => tool.name === 'easynote_note_stats'));
    assert.ok(!tools.tools.some((tool) => tool.name.includes('sync') || tool.name.includes('purge')));

    const stats = (await client.callTool({
      name: 'easynote_note_stats', arguments: {},
    })).structuredContent as { active: number; archived: number; trash: number; total: number };
    assert.equal(stats.total, stats.active + stats.archived + stats.trash);
    assert.ok(stats.active > 0);

    const recentResult = await client.callTool({
      name: 'easynote_list_recent',
      arguments: { limit: 2, tag: 'Atlas' },
    });
    const recent = recentResult.structuredContent as {
      count: number;
      notes: Array<{
        id: string;
        tags: string[];
        updatedAt: number;
        excerpt: string;
        uri: string;
        content?: string;
        matches?: unknown[];
      }>;
    };
    assert.equal(recent.count, 2);
    assert.ok(recent.notes.every((note) => note.tags.includes('Atlas')));
    assert.ok(recent.notes.every((note) => note.excerpt && note.uri === `easynote://notes/${note.id}.md`));
    assert.ok(recent.notes.every((note) => note.content === undefined && note.matches === undefined));
    assert.ok(recent.notes[0].updatedAt > recent.notes[1].updatedAt ||
      recent.notes[0].updatedAt === recent.notes[1].updatedAt &&
      recent.notes[0].id.localeCompare(recent.notes[1].id) < 0);

    const evaluationSearch = await client.callTool({
      name: 'easynote_search_notes',
      arguments: { query: '法兰克福', view: 'any', limit: 10 },
    });
    const evaluationNotes = (evaluationSearch.structuredContent as {
      notes: Array<{
        id: string;
        title: string;
        uri: string;
        matches: Array<{
          field: string;
          line: number | null;
          heading: string | null;
          startOffset: number | null;
          endOffset: number | null;
          snippet: string;
        }>;
      }>;
    }).notes;
    const acceptance = evaluationNotes.find((item) => item.title === 'Atlas 发布验收');
    assert.ok(acceptance);
    const atlas = evaluationNotes
      .find((item) => item.title === 'Atlas 事故复盘');
    assert.ok(atlas);
    assert.equal(atlas.uri, `easynote://notes/${atlas.id}.md`);
    const atlasMatch = atlas.matches.find((match) =>
      match.field === 'content' && match.heading === '影响' && match.snippet.includes('法兰克福'));
    assert.ok(atlasMatch?.startOffset !== null && atlasMatch?.startOffset !== undefined);
    assert.equal(atlasMatch.endOffset, atlasMatch.startOffset + '法兰克福'.length);

    const read = await client.callTool({
      name: 'easynote_read_note',
      arguments: { id: atlas.id, limit: 100 },
    });
    assert.match((read.structuredContent as { content: string }).content, /47 分钟/);

    const focusedRead = await client.callTool({
      name: 'easynote_read_note',
      arguments: { id: atlas.id, offset: atlasMatch.startOffset, limit: 20 },
    });
    assert.match((focusedRead.structuredContent as { content: string }).content, /^法兰克福/);

    const batchRead = await client.callTool({
      name: 'easynote_read_notes',
      arguments: { ids: [acceptance.id, atlas.id], max_chars_per_note: 40 },
    });
    const batchNotes = (batchRead.structuredContent as {
      notes: Array<{ note: { id: string }; content: string; truncated: boolean; nextOffset: number | null }>;
    }).notes;
    assert.deepEqual(batchNotes.map((item) => item.note.id), [acceptance.id, atlas.id]);
    assert.match(batchNotes[0].content, /99\.96%/);
    assert.match(batchNotes[1].content, /47 分钟/);
    assert.ok(batchNotes.every((item) => item.truncated && item.nextOffset === 40));

    const templates = await client.listResourceTemplates();
    assert.ok(templates.resourceTemplates.some((template) => template.uriTemplate === 'easynote://notes/{id}.md'));
    const resources = await client.listResources();
    assert.ok(resources.resources.some((resource) => resource.uri === atlas.uri && resource.name === atlas.title));
    const resource = await client.readResource({ uri: atlas.uri });
    assert.equal(resource.contents[0].mimeType, 'text/markdown');
    assert.match((resource.contents[0] as { text: string }).text, /^# Atlas 事故复盘/);
    assert.match((resource.contents[0] as { text: string }).text, /47 分钟/);

    const result = await client.callTool({
      name: 'easynote_create_note',
      arguments: {
        title: 'MCP 创建',
        content: '## MCP 正文',
        tags: ['MCP'],
        pinned: false,
        archived: false,
      },
    });
    assert.notEqual(result.isError, true);
    const output = result.structuredContent as { note: { id: string; revision: number } };
    assert.equal(output.note.revision, 1);
    const remote = await integrationRequest(writeSecret, `/api/integrations/notes/${output.note.id}`);
    assert.equal((await remote.json() as any).note.title, 'MCP 创建');

    const concurrent = await integrationRequest(writeSecret, `/api/integrations/notes/${output.note.id}`, 'PUT', {
      title: 'MCP 创建',
      content: '## 用户更新',
      tags: ['MCP'],
      pinned: false,
      archived: false,
      deletedAt: null,
      revision: output.note.revision,
      operationId: randomUUID(),
    });
    assert.equal(concurrent.status, 200);
    const conflict = await client.callTool({
      name: 'easynote_update_note',
      arguments: {
        id: output.note.id,
        expected_revision: output.note.revision,
        content: '## AI 陈旧更新',
      },
    });
    assert.equal(conflict.isError, true);
    assert.match(JSON.stringify(conflict.content), /409/);
  } finally {
    await client.close();
  }
});

test('read-only MCP credentials do not expose write tools', async () => {
  const client = await connectMcp(readSecret);
  try {
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name), [
      'easynote_search_notes',
      'easynote_list_recent',
      'easynote_read_note',
      'easynote_read_notes',
      'easynote_connection_status',
      'easynote_note_stats',
    ]);
  } finally {
    await client.close();
  }
});
