import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createRuntime, testPassword, testToken } from './runtime';

let instance: Awaited<ReturnType<typeof createRuntime>>;
const origin = 'https://easynote.test';
const redirect = 'https://chatgpt.example/callback';
const verifier = 'v'.repeat(64);
const challenge = createHash('sha256').update(verifier).digest('base64url');
let clientIp = 0;
// Each request gets its own address so rate limits never leak between tests.
const nextIp = () => ({ 'CF-Connecting-IP': `198.51.100.${++clientIp % 250 + 1}` });

const dispatch = (path: string, init: RequestInit = {}) =>
  instance.runtime.dispatchFetch(`${origin}${path}`, init as never) as unknown as Promise<Response>;

async function register(redirectUris = [redirect]): Promise<string> {
  const response = await dispatch('/oauth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...nextIp() },
    body: JSON.stringify({ client_name: 'ChatGPT', redirect_uris: redirectUris }),
  });
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json() as { client_id: string }).client_id;
}

function authorizeBody(clientId: string, extra: Record<string, string> = {}) {
  return new URLSearchParams({
    client_id: clientId, redirect_uri: redirect, state: 'xyz', response_type: 'code',
    code_challenge: challenge, code_challenge_method: 'S256',
    username: 'tester', password: testPassword, access: 'read-write', ...extra,
  });
}

async function authorize(clientId: string, extra: Record<string, string> = {}): Promise<URL> {
  const response = await dispatch('/oauth/authorize', {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin, ...nextIp() },
    body: authorizeBody(clientId, extra),
  });
  assert.equal(response.status, 302, await response.clone().text());
  return new URL(response.headers.get('Location')!);
}

async function exchange(fields: Record<string, string>): Promise<Response> {
  return dispatch('/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });
}

async function grant(clientId: string, access = 'read-write'): Promise<{ access_token: string; refresh_token: string }> {
  const code = (await authorize(clientId, { access })).searchParams.get('code')!;
  const response = await exchange({
    grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: redirect, code_verifier: verifier,
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json() as Promise<{ access_token: string; refresh_token: string }>;
}

async function connectMcp(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    authProvider: { token: async () => token },
    fetch: (url, init) => instance.runtime.dispatchFetch(url, init as never) as unknown as Promise<Response>,
  });
  const client = new Client({ name: 'oauth-test-client', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

before(async () => {
  instance = await createRuntime();
});

after(async () => {
  await instance?.runtime.dispose();
});

test('MCP challenges unauthenticated clients and advertises OAuth metadata', async () => {
  const response = await dispatch('/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('WWW-Authenticate'),
    `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`);

  const resource = await (await dispatch('/.well-known/oauth-protected-resource/mcp')).json() as Record<string, unknown>;
  assert.equal(resource.resource, `${origin}/mcp`);
  assert.deepEqual(resource.authorization_servers, [origin]);

  const metadata = await (await dispatch('/.well-known/oauth-authorization-server')).json() as Record<string, unknown>;
  assert.equal(metadata.issuer, origin);
  assert.equal(metadata.authorization_endpoint, `${origin}/oauth/authorize`);
  assert.equal(metadata.token_endpoint, `${origin}/oauth/token`);
  assert.equal(metadata.registration_endpoint, `${origin}/oauth/register`);
  assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
});

test('unknown well-known paths get a JSON 404, never the SPA HTML', async () => {
  // Strict OIDC clients probe this path; an HTML 200 breaks discovery, a JSON 404 lets them fall back.
  for (const path of ['/.well-known/openid-configuration', '/.well-known/unknown-thing']) {
    const response = await dispatch(path);
    assert.equal(response.status, 404, path);
    assert.match(response.headers.get('Content-Type') ?? '', /application\/json/, path);
  }
});

test('registration only accepts HTTPS or loopback redirect URIs', async () => {
  const bad = await dispatch('/oauth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...nextIp() },
    body: JSON.stringify({ redirect_uris: ['http://attacker.example/cb'] }),
  });
  assert.equal(bad.status, 400);

  const loopback = await dispatch('/oauth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...nextIp() },
    body: JSON.stringify({ redirect_uris: ['http://127.0.0.1:8787/cb'] }),
  });
  assert.equal(loopback.status, 201);
});

test('authorize never redirects to an unregistered redirect URI', async () => {
  const clientId = await register();
  const response = await dispatch(`/oauth/authorize?${new URLSearchParams({
    client_id: clientId, redirect_uri: 'https://evil.example/steal', response_type: 'code',
    code_challenge: challenge, code_challenge_method: 'S256',
  })}`, { redirect: 'manual' });
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('Location'), null);
});

test('consent page renders with a restrictive CSP and rejects wrong passwords', async () => {
  const clientId = await register();
  const consent = await dispatch(`/oauth/authorize?${new URLSearchParams({
    client_id: clientId, redirect_uri: redirect, state: 'xyz', response_type: 'code',
    code_challenge: challenge, code_challenge_method: 'S256',
  })}`);
  assert.equal(consent.status, 200);
  assert.match(consent.headers.get('Content-Security-Policy') ?? '', /default-src 'none'/);
  assert.match(await consent.text(), /name="password"/);

  const wrong = await dispatch('/oauth/authorize', {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin, ...nextIp() },
    body: authorizeBody(clientId, { password: 'wrong-password-value' }),
  });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers.get('Location'), null);
});

test('PKCE code exchange issues a token that works on MCP and is single use', async () => {
  const clientId = await register();
  const code = (await authorize(clientId)).searchParams.get('code')!;
  const tokens = await exchange({
    grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: redirect, code_verifier: verifier,
  });
  assert.equal(tokens.status, 200);
  const body = await tokens.json() as { access_token: string; refresh_token: string; token_type: string };
  assert.equal(body.token_type, 'Bearer');
  assert.match(body.access_token, /^enai_[a-f0-9]{64}$/);
  assert.match(body.refresh_token, /^eor_[a-f0-9]{64}$/);

  const replay = await exchange({
    grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: redirect, code_verifier: verifier,
  });
  assert.equal(replay.status, 400);

  const client = await connectMcp(body.access_token);
  try {
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === 'easynote_search_notes'));
    const stats = await client.callTool({ name: 'easynote_note_stats', arguments: {} });
    assert.ok(stats.structuredContent);
  } finally {
    await client.close();
  }
});

test('wrong PKCE verifier and mismatched redirect URI fail', async () => {
  const clientId = await register();
  const code = (await authorize(clientId)).searchParams.get('code')!;
  const wrong = await exchange({
    grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: redirect, code_verifier: 'w'.repeat(64),
  });
  assert.equal(wrong.status, 400);

  const other = await authorize(clientId);
  const otherCode = other.searchParams.get('code')!;
  const mismatch = await exchange({
    grant_type: 'authorization_code', code: otherCode, client_id: clientId,
    redirect_uri: 'https://chatgpt.example/other', code_verifier: verifier,
  });
  assert.equal(mismatch.status, 400);
});

test('read-only grants cannot call write tools', async () => {
  const clientId = await register();
  const tokens = await grant(clientId, 'read');
  const client = await connectMcp(tokens.access_token);
  try {
    const tools = await client.listTools();
    assert.ok(!tools.tools.some((tool) => tool.name === 'easynote_create_note'));
  } finally {
    await client.close();
  }
});

test('refresh rotates tokens and reuse of an old refresh token revokes the grant', async () => {
  const clientId = await register();
  const first = await grant(clientId);

  const rotated = await exchange({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: clientId });
  assert.equal(rotated.status, 200);
  const second = await rotated.json() as { access_token: string; refresh_token: string };
  assert.notEqual(second.refresh_token, first.refresh_token);

  const oldAccess = await dispatch('/api/integrations/status', { headers: { Authorization: `Bearer ${first.access_token}` } });
  assert.equal(oldAccess.status, 401);
  const newAccess = await dispatch('/api/integrations/status', { headers: { Authorization: `Bearer ${second.access_token}` } });
  assert.equal(newAccess.status, 200);

  const reuse = await exchange({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: clientId });
  assert.equal(reuse.status, 400);
  const revoked = await dispatch('/api/integrations/status', { headers: { Authorization: `Bearer ${second.access_token}` } });
  assert.equal(revoked.status, 401);
});

test('OAuth grants appear as revocable integration tokens', async () => {
  const clientId = await register();
  await grant(clientId, 'read');
  const list = await dispatch('/api/integrations/tokens', {
    headers: { Cookie: `__Host-easynote=${testToken}` },
  });
  assert.equal(list.status, 200);
  const body = await list.json() as { tokens: Array<{ name: string; access: string }> };
  assert.ok(body.tokens.some((token) => token.name === 'ChatGPT' && token.access === 'read'));
});

test('a fresh database accepts OAuth consent before any web sign-in creates the owner', async () => {
  // Separate runtime: no seeded user, so the owner row only exists once ensureOwner runs.
  const fresh = await createRuntime(undefined, { seedOwner: false });
  const fetchFresh = (path: string, init: RequestInit = {}) =>
    fresh.runtime.dispatchFetch(`${origin}${path}`, init as never) as unknown as Promise<Response>;
  try {
    const registered = await fetchFresh('/oauth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...nextIp() },
      body: JSON.stringify({ redirect_uris: [redirect] }),
    });
    const clientId = (await registered.json() as { client_id: string }).client_id;
    const submit = (password: string) => fetchFresh('/oauth/authorize', {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin, ...nextIp() },
      body: authorizeBody(clientId, { password }),
    });

    const ok = await submit(testPassword);
    assert.equal(ok.status, 302, await ok.clone().text());
    assert.ok(new URL(ok.headers.get('Location')!).searchParams.get('code'));

    const wrong = await submit('wrong-password-value');
    assert.equal(wrong.status, 401);
  } finally {
    await fresh.runtime.dispose();
  }
});
