import { createMcpHandler } from '@modelcontextprotocol/server';
import { EasyNoteClient } from '../ai/client';
import { createMcpServer } from '../ai/index';
import { ApiError, json, type Env } from './core';
import { integrationIdentity, integrationRoutes } from './integrations';

export async function mcpRoute(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method not allowed.', { status: 405, headers: { Allow: 'POST' } });
  }
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) throw new ApiError(403, 'Cross-origin request rejected.');

  const identity = await integrationIdentity(request, env);
  const token = request.headers.get('Authorization')!.slice('Bearer '.length);
  const apiFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const internalRequest = new Request(url, init);
    try {
      const response = await integrationRoutes(internalRequest, env, identity, url.pathname);
      return response ?? json({ error: { message: 'Endpoint not found.' } }, 404);
    } catch (error) {
      if (error instanceof ApiError) {
        return json({ error: { message: error.message, ...error.data } }, error.status);
      }
      throw error;
    }
  };
  const client = new EasyNoteClient({ url: new URL(request.url).origin, token }, apiFetch);
  const handler = createMcpHandler(() => createMcpServer(client));
  return handler.fetch(request);
}
