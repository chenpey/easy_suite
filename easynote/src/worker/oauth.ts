import { ensureOwner, limitAccountAction, limitLogin, verifyLogin } from './auth';
import { ApiError, digest, json, readBytes, readJson, requireOrigin, token, type Env } from './core';

// OAuth 2.1 authorization code + PKCE for remote MCP clients (for example ChatGPT).
// Each grant is stored as an integration_tokens row, so revocation, access levels
// and the 10-token cap apply exactly as they do for manually created tokens.
const accessTtl = 3600_000;
const refreshTtl = 30 * 86400_000;
const codeTtl = 300_000;
const enc = new TextEncoder();

interface ClientRow { client_id: string; name: string; redirect_uris: string }
interface CodeRow { client_id: string; user_id: string; redirect_uri: string; code_challenge: string; access: AccessLevel }
interface RefreshRow {
  id: string; user_id: string; name: string; access: AccessLevel; client_id: string | null;
  expires_at: number | null; revoked_at: number | null; refresh_hash: string | null;
}
interface AuthContext { client: ClientRow; redirect: string; state: string; challenge: string }
type AccessLevel = 'read' | 'read-write';
type Fields = Record<string, string>;

const base64url = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const s256 = async (verifier: string) => base64url(await crypto.subtle.digest('SHA-256', enc.encode(verifier)));
const clean = (value: unknown) => (typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40) : '')
  || 'MCP client';
const esc = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
const oauthError = (error: string, description: string, status = 400) => json({ error, error_description: description }, status);
const invalidGrant = () => oauthError('invalid_grant', 'The authorization code or refresh token is invalid.');
const redirectTo = (url: URL) => new Response(null, { status: 302, headers: { Location: url.toString(), 'Cache-Control': 'no-store' } });

function validRedirect(value: string): boolean {
  if (value.length > 512) return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.hash) return false;
  // Loopback HTTP is allowed for native clients (RFC 8252); everything else must be HTTPS.
  return url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
}

async function formFields(request: Request): Promise<Fields> {
  const text = new TextDecoder().decode(await readBytes(request, 8192));
  return Object.fromEntries(new URLSearchParams(text));
}

async function findClient(env: Env, id: string | undefined): Promise<ClientRow | null> {
  if (!id) return null;
  return env.DB.prepare('SELECT client_id,name,redirect_uris FROM oauth_clients WHERE client_id=?')
    .bind(id).first<ClientRow>();
}

function page(title: string, body: string, status = 200): Response {
  const css = `body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px;box-sizing:border-box;
    font:16px/1.5 system-ui,-apple-system,"PingFang SC","Noto Sans SC",sans-serif;color:#1d1b16;
    background:radial-gradient(circle at 15% 10%,#f6e7c8,transparent 40%),radial-gradient(circle at 90% 90%,#d9ece6,transparent 45%),#faf6ee}
    .card{width:min(440px,100%);background:#fffdf8;border:1px solid #e4dccb;border-radius:20px;padding:32px;box-shadow:0 12px 40px #5a4a2a1a}
    .eyebrow{margin:0;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#8a6d32}
    h1{margin:6px 0 8px;font-size:22px;line-height:1.3}.lede{margin:0 0 20px;color:#5b5548}
    label{display:block;margin-bottom:14px;font-weight:600;font-size:14px}
    input[type=text],input:not([type]),input[type=password]{display:block;width:100%;box-sizing:border-box;margin-top:6px;
    padding:10px 12px;border:1px solid #cfc5ad;border-radius:10px;font:inherit;background:#fff}
    fieldset{border:0;padding:0;margin:0 0 18px}legend{font-weight:600;font-size:14px;margin-bottom:8px}
    .choice{display:block;font-weight:600;border:1px solid #e0d7c3;border-radius:12px;padding:10px 12px;margin-bottom:8px;cursor:pointer}
    .choice span{display:block;font-weight:400;font-size:13px;color:#6b6456}
    button{width:100%;padding:12px;border:0;border-radius:12px;background:#1d4d44;color:#fff;font:inherit;font-weight:700;cursor:pointer}
    .error{background:#fbe5df;color:#8c2a18;border-radius:10px;padding:10px 12px;margin:0 0 16px}
    .fine{margin:16px 0 0;font-size:13px;color:#6b6456}`;
  return new Response(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)}</title><style>${css}</style></head><body><main class="card">${body}</main></body></html>`, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

function consentPage(ctx: AuthContext, values: { username?: string; access?: string; error?: string }, status = 200): Response {
  const access = values.access ?? 'read';
  const hidden = {
    client_id: ctx.client.client_id, redirect_uri: ctx.redirect, state: ctx.state,
    response_type: 'code', code_challenge: ctx.challenge, code_challenge_method: 'S256',
  };
  return page('授权 EasyNote / Authorize EasyNote', `
    <p class="eyebrow">EasyNote</p>
    <h1>授权 ${esc(ctx.client.name)} 访问笔记</h1>
    <p class="lede">Allow ${esc(ctx.client.name)} to access your notes. It will return to ${esc(new URL(ctx.redirect).host)}.</p>
    ${values.error ? `<p class="error" role="alert">${esc(values.error)}</p>` : ''}
    <form method="POST" action="/oauth/authorize">
      ${Object.entries(hidden).map(([key, value]) => `<input type="hidden" name="${key}" value="${esc(value)}">`).join('')}
      <label>用户名 / Username<input type="text" name="username" value="${esc(values.username ?? '')}" autocomplete="username" required></label>
      <label>密码 / Password<input type="password" name="password" autocomplete="current-password" required></label>
      <fieldset>
        <legend>访问权限 / Access</legend>
        <label class="choice"><input type="radio" name="access" value="read" ${access === 'read' ? 'checked' : ''}> 只读 / Read only
          <span>搜索和读取笔记 · search and read notes</span></label>
        <label class="choice"><input type="radio" name="access" value="read-write" ${access === 'read-write' ? 'checked' : ''}> 读写 / Read and write
          <span>另可创建和修改笔记 · also create and edit notes</span></label>
      </fieldset>
      <button type="submit">授权 / Authorize</button>
    </form>
    <p class="fine">可随时在 EasyNote 设置中撤销。You can revoke this access any time in EasyNote settings.</p>`, status);
}

// Shared by GET and POST: a bad client or redirect URI must never redirect the user.
async function authorizeContext(env: Env, fields: Fields): Promise<AuthContext | Response> {
  const client = await findClient(env, fields.client_id);
  const redirect = fields.redirect_uri ?? '';
  if (!client || !(JSON.parse(client.redirect_uris) as string[]).includes(redirect)) {
    return page('Invalid request', '<h1>授权请求无效</h1><p class="lede">Invalid authorization request. Return to the app and try again.</p>', 400);
  }
  const state = fields.state ?? '';
  if (fields.response_type !== 'code' || fields.code_challenge_method !== 'S256' ||
      !/^[A-Za-z0-9_-]{43}$/.test(fields.code_challenge ?? '')) {
    const target = new URL(redirect);
    target.searchParams.set('error', 'invalid_request');
    if (state) target.searchParams.set('state', state);
    return redirectTo(target);
  }
  return { client, redirect, state, challenge: fields.code_challenge! };
}

async function registerClient(request: Request, env: Env): Promise<Response> {
  await limitAccountAction(request, env, 'oauth-register', 'OAUTH_CLIENT_IP_LIMIT', 'OAUTH_CLIENT_GLOBAL_LIMIT');
  const data = await readJson(request, 8192);
  const uris = data.redirect_uris;
  if (!Array.isArray(uris) || uris.length < 1 || uris.length > 5 ||
      !uris.every((uri) => typeof uri === 'string' && validRedirect(uri))) {
    return oauthError('invalid_redirect_uri', 'redirect_uris must be 1-5 HTTPS URLs or loopback HTTP URLs.');
  }
  const clientId = crypto.randomUUID();
  const name = clean(data.client_name);
  await env.DB.prepare('INSERT INTO oauth_clients(client_id,name,redirect_uris,created_at) VALUES(?,?,?,?)')
    .bind(clientId, name, JSON.stringify(uris), Date.now()).run();
  return json({
    client_id: clientId,
    client_name: name,
    redirect_uris: uris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  }, 201);
}

// Errors on the consent path render as a page: the browser has no JSON handler here.
async function authorizeSubmit(request: Request, env: Env): Promise<Response> {
  try {
    return await authorizeSubmitUnsafe(request, env);
  } catch (error) {
    if (error instanceof ApiError) {
      return page('无法完成授权 / Authorization failed', `
        <p class="eyebrow">EasyNote</p>
        <h1>无法完成授权 / Authorization failed</h1>
        <p class="lede">${esc(error.message)}</p>
        <p class="fine">请返回 ChatGPT 重试。Return to ChatGPT and try again.</p>`, error.status);
    }
    throw error;
  }
}

async function authorizeSubmitUnsafe(request: Request, env: Env): Promise<Response> {
  requireOrigin(request);
  const fields = await formFields(request);
  const ctx = await authorizeContext(env, fields);
  if (ctx instanceof Response) return ctx;
  const access = fields.access;
  if (access !== 'read' && access !== 'read-write') {
    return consentPage(ctx, { username: fields.username, error: 'Choose an access level.' }, 400);
  }
  // A fresh deployment has no user rows until ensureOwner runs; OAuth may be the first request.
  if (!await ensureOwner(env)) {
    return consentPage(ctx, { username: fields.username, access, error: 'EasyNote 尚未配置账号 / Owner account is not configured.' }, 503);
  }
  await limitLogin(request, env);
  const user = await verifyLogin(env, fields.username ?? '', fields.password ?? '');
  if (!user) {
    return consentPage(ctx, { username: fields.username, access, error: 'Incorrect username or password.' }, 401);
  }
  const code = token();
  await env.DB.prepare(`INSERT INTO oauth_codes(code_hash,client_id,user_id,redirect_uri,code_challenge,access,expires_at)
    VALUES(?,?,?,?,?,?,?)`)
    .bind(await digest(code), ctx.client.client_id, user.id, ctx.redirect, ctx.challenge, access, Date.now() + codeTtl).run();
  const target = new URL(ctx.redirect);
  target.searchParams.set('code', code);
  if (ctx.state) target.searchParams.set('state', ctx.state);
  return redirectTo(target);
}

async function issueTokens(env: Env, grant: { userId: string; clientId: string; name: string; level: AccessLevel }): Promise<Response> {
  const now = Date.now();
  const accessToken = `enai_${token()}`;
  const refresh = `eor_${token()}`;
  const inserted = await env.DB.prepare(`INSERT INTO integration_tokens
    (id,user_id,name,token_hash,access,created_at,expires_at,last_used_at,revoked_at,client_id,access_expires_at,refresh_hash,prev_refresh_hash)
    SELECT ?,?,?,?,?,?,?,NULL,NULL,?,?,?,NULL
    WHERE (SELECT COUNT(*) FROM integration_tokens
      WHERE user_id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?))<10`)
    .bind(crypto.randomUUID(), grant.userId, grant.name, await digest(accessToken), grant.level, now, now + refreshTtl,
      grant.clientId, now + accessTtl, await digest(refresh), grant.userId, now).run();
  if (!inserted.meta.changes) return oauthError('invalid_request', 'At most 10 active integration tokens are allowed. Revoke an old one in EasyNote settings.', 409);
  return json({ access_token: accessToken, token_type: 'Bearer', expires_in: accessTtl / 1000, refresh_token: refresh });
}

async function exchangeCode(env: Env, fields: Fields): Promise<Response> {
  const hash = await digest(fields.code ?? '');
  const row = await env.DB.prepare(`SELECT client_id,user_id,redirect_uri,code_challenge,access FROM oauth_codes
    WHERE code_hash=? AND expires_at>?`).bind(hash, Date.now()).first<CodeRow>();
  if (!row) return invalidGrant();
  // Single use: only the request whose DELETE actually removes the row may issue tokens.
  const consumed = await env.DB.prepare('DELETE FROM oauth_codes WHERE code_hash=?').bind(hash).run();
  if (!consumed.meta.changes) return invalidGrant();
  const verifier = fields.code_verifier ?? '';
  if (row.client_id !== fields.client_id || row.redirect_uri !== fields.redirect_uri ||
      !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || await s256(verifier) !== row.code_challenge) {
    return invalidGrant();
  }
  const client = await findClient(env, row.client_id);
  if (!client) return invalidGrant();
  return issueTokens(env, { userId: row.user_id, clientId: client.client_id, name: client.name, level: row.access });
}

async function refreshGrant(env: Env, fields: Fields): Promise<Response> {
  const now = Date.now();
  const hash = await digest(fields.refresh_token ?? '');
  const row = await env.DB.prepare(`SELECT t.id,t.user_id,t.name,t.access,t.client_id,t.expires_at,t.revoked_at,t.refresh_hash
    FROM integration_tokens t JOIN users u ON u.id=t.user_id
    WHERE (t.refresh_hash=? OR t.prev_refresh_hash=?) AND u.enabled=1 AND u.deletion_requested_at IS NULL`)
    .bind(hash, hash).first<RefreshRow>();
  // The refresh token is the credential; client_id is optional here (RFC 6749 §6) but must match when sent.
  const clientMismatch = fields.client_id !== undefined && row?.client_id !== fields.client_id;
  if (!row || row.revoked_at !== null || clientMismatch || (row.expires_at !== null && row.expires_at <= now)) {
    return invalidGrant();
  }
  if (row.refresh_hash !== hash) {
    // A rotated-out refresh token came back, so treat the whole grant as leaked and revoke it.
    await env.DB.prepare('UPDATE integration_tokens SET revoked_at=? WHERE id=? AND revoked_at IS NULL').bind(now, row.id).run();
    return invalidGrant();
  }
  const accessToken = `enai_${token()}`;
  const refresh = `eor_${token()}`;
  // Replacing token_hash revokes the previous access token immediately.
  const rotated = await env.DB.prepare(`UPDATE integration_tokens
    SET token_hash=?,access_expires_at=?,expires_at=?,refresh_hash=?,prev_refresh_hash=?,last_used_at=?
    WHERE id=? AND refresh_hash=? AND revoked_at IS NULL`)
    .bind(await digest(accessToken), now + accessTtl, now + refreshTtl, await digest(refresh), hash, now, row.id, hash).run();
  if (!rotated.meta.changes) return invalidGrant();
  return json({ access_token: accessToken, token_type: 'Bearer', expires_in: accessTtl / 1000, refresh_token: refresh });
}

async function tokenEndpoint(request: Request, env: Env): Promise<Response> {
  try {
    const fields = await formFields(request);
    if (fields.grant_type === 'authorization_code') return await exchangeCode(env, fields);
    if (fields.grant_type === 'refresh_token') return await refreshGrant(env, fields);
    return oauthError('unsupported_grant_type', 'Use authorization_code or refresh_token.');
  } catch (error) {
    if (error instanceof ApiError) return oauthError('invalid_request', error.message, error.status);
    throw error;
  }
}

export async function oauthRoute(request: Request, env: Env, path: string): Promise<Response | null> {
  const base = new URL(request.url).origin;
  if (request.method === 'GET' && ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'].includes(path)) {
    return json({ resource: `${base}/mcp`, authorization_servers: [base], bearer_methods_supported: ['header'] });
  }
  if (request.method === 'GET' && path === '/.well-known/oauth-authorization-server') {
    return json({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
  }
  if (path === '/oauth/authorize') {
    if (request.method === 'GET') {
      const ctx = await authorizeContext(env, Object.fromEntries(new URL(request.url).searchParams));
      return ctx instanceof Response ? ctx : consentPage(ctx, {});
    }
    if (request.method === 'POST') return authorizeSubmit(request, env);
    return null;
  }
  if (request.method === 'POST' && path === '/oauth/register') return registerClient(request, env);
  if (request.method === 'POST' && path === '/oauth/token') return tokenEndpoint(request, env);
  return null;
}
