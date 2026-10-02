import { describe, expect, it, vi, beforeEach } from 'vitest';
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
vi.mock('@cloudflare/streamline', () => ({ StreamlineSessionDO: class {}, ContainerProxy: class {}, MAX_START_BYTES: 65536, MAX_INGEST_BYTES: 1048576 }));
import { handle, MediaContainer } from '../src/index';
import { issueVisitor, INSTANCE_PATTERN } from '../src/server/visitor';
import { MAX_REACTION_BYTES } from '../src/shared/pipeline';
const env = { LOCAL_DOCKER_ORIGIN: '', ALLOWED_ORIGINS: 'https://fox.example', SESSION_SECRET: 'test-only-signing-key', PUBLISHER_SECRET: 'publisher-only', TURNSTILE_SITEKEY: 'public-sitekey', ASSETS: { fetch: async () => new Response('asset') } } as unknown as Env;
const stub = vi.fn(async (_request: Request) => new Response('session'));
const ctx = { exports: { MediaContainer: { getByName: vi.fn(() => ({ fetch: stub })) } } } as unknown as ExecutionContext;
describe('Public Worker authentication boundary', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });
  it('serves the studio and config publicly, but denies session access without a signed permit', async () => {
    expect((await handle(new Request('https://fox.example/'), env, ctx)).status).toBe(200);
    const config = await handle(new Request('https://fox.example/api/config'), env, ctx);
    expect(await config.json()).toMatchObject({ turnstileSitekey: 'public-sitekey', localDocker: false });
    for (const path of ['/relay/prepare', '/start', '/ingest', '/api/annotation', '/relay/view', '/metrics', '/stop', '/relay/publish']) {
      const method = path === '/api/annotation' ? 'PUT' : ['/relay/view', '/metrics', '/relay/publish'].includes(path) ? 'GET' : 'POST';
      expect((await handle(new Request(`https://fox.example${path}`, { method, headers: { 'X-Streamline-Principal': 'spoof', 'Cf-Access-Jwt-Assertion': 'spoof' } }), env, ctx)).status).toBe(401);
    }
    expect(stub).not.toHaveBeenCalled();
  });
  it('bounds PNG uploads and requires a same-origin, authenticated annotation request', async () => {
    const token = await issueVisitor(env.SESSION_SECRET, 'https://fox.example');
    const headers = { Origin: 'https://fox.example', 'X-Fox-Session': token, 'X-Streamline-Session-ID': 'active-session', 'Content-Type': 'image/png' };
    const send = (body: BodyInit, override = {}) => handle(new Request('https://fox.example/api/annotation', { method: 'PUT', headers: { ...headers, ...override }, body }), env, ctx);
    expect((await send('png', { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await send('png', { 'Content-Type': 'application/octet-stream' })).status).toBe(415);
    expect((await send(new Uint8Array(MAX_REACTION_BYTES + 1))).status).toBe(413);
    expect(stub).not.toHaveBeenCalled();
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    expect((await send(png)).status).toBe(200);
    const forwarded = stub.mock.calls.at(-1)![0];
    expect(forwarded.method).toBe('PUT');
    expect(forwarded.headers.get('X-Streamline-Session-ID')).toBe('active-session');
    expect(forwarded.headers.get('X-Streamline-Principal')).toMatch(INSTANCE_PATTERN);
    expect(forwarded.headers.get('X-Fox-Session')).toBeNull();
    expect(new Uint8Array(await forwarded.arrayBuffer())).toEqual(png);
  });
  it('requires permits even on loopback; production configuration never skips Turnstile', async () => {
    expect((await handle(new Request('http://localhost/start', { method: 'POST' }), env, ctx)).status).toBe(401);
    const response = await handle(new Request('http://localhost/api/config'), env, ctx);
    expect((await response.json()).turnstileSitekey).toBe('public-sitekey');
  });
  it('only enables development verification for explicitly configured loopback', async () => {
    const local = { ...env, LOCAL_DOCKER_ORIGIN: 'http://127.0.0.1:8788' };
    expect((await (await handle(new Request('https://fox.example/api/config'), local, ctx)).json()).localDocker).toBe(false);
    const response = await handle(new Request('http://127.0.0.1:5173/api/session', { method: 'POST', headers: { Origin: 'http://127.0.0.1:5173', 'Content-Type': 'application/json' }, body: '{}' }), local, ctx);
    const { token } = await response.json();
    const headers = { Origin: 'http://127.0.0.1:5173', 'X-Fox-Session': token, 'X-Streamline-Principal': 'spoof' };
    expect((await handle(new Request('http://127.0.0.1:5173/relay/prepare', { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' } }), local, ctx)).status).toBe(403);
    expect((await handle(new Request('http://127.0.0.1:5173/relay/prepare', { method: 'POST', headers }), local, ctx)).status).toBe(200);
    const principal = stub.mock.calls.at(-1)![0].headers.get('X-Streamline-Principal');
    expect(principal).toMatch(INSTANCE_PATTERN);
    expect(ctx.exports.MediaContainer.getByName).toHaveBeenCalledWith(principal);
  });
  it('routes distinct visitors independently and removes credentials before forwarding', async () => {
    const names = [];
    for (let i = 0; i < 2; i++) {
      const token = await issueVisitor(env.SESSION_SECRET, 'https://fox.example');
      await handle(new Request('https://fox.example/stop', { method: 'POST', headers: { Origin: 'https://fox.example', 'X-Fox-Session': token, 'X-Streamline-Principal': 'spoof' } }), env, ctx);
      const forwarded = stub.mock.calls.at(-1)![0];
      expect(forwarded.headers.get('X-Fox-Session')).toBeNull();
      names.push(forwarded.headers.get('X-Streamline-Principal'));
    }
    expect(names[0]).not.toBe(names[1]);
  });
  it('authenticates publishers and preserves the upstream session capability', async () => {
    const instance = crypto.randomUUID();
    const headers = { Upgrade: 'websocket', 'X-Fox-Publisher-Key': 'publisher-only', Authorization: 'Bearer upstream-capability', 'X-Streamline-Principal': 'spoof' };
    for (const suffix of ['', '?instance=invalid']) {
      expect((await handle(new Request(`https://fox.example/relay/publish${suffix}`, { headers }), env, ctx)).status).toBe(401);
    }
    expect(stub).not.toHaveBeenCalled();
    expect((await handle(new Request(`https://fox.example/relay/publish?instance=${instance}`, { headers: { ...headers, 'X-Fox-Publisher-Key': 'forged' } }), env, ctx)).status).toBe(401);
    expect((await handle(new Request(`https://fox.example/relay/publish?instance=${instance}`, { headers }), env, ctx)).status).toBe(200);
    expect(ctx.exports.MediaContainer.getByName).toHaveBeenCalledWith(instance);
    const forwarded = stub.mock.calls.at(-1)![0];
    expect(forwarded.headers.get('Authorization')).toBe('Bearer upstream-capability');
    expect(forwarded.headers.get('X-Fox-Publisher-Key')).toBeNull();
    expect(forwarded.headers.get('X-Streamline-Principal')).toBeNull();
  });
  it('retires a canceled permit before a delayed prepare can reserve an encoder', async () => {
    const storage = new Map<string, unknown>();
    const admission = { release: vi.fn(async () => {}), acquire: vi.fn(async () => true) };
    const state = {
      storage: { get: async (key: string) => storage.get(key), put: async (key: string, value: unknown) => { storage.set(key, value); } },
      exports: { SessionAdmission: { getByName: () => admission } },
    };
    const container = Object.assign(new MediaContainer(state as unknown as DurableObjectState, env), { ctx: state, env });
    const headers = { 'X-Streamline-Principal': 'canceled-visitor' };
    expect((await container.fetch(new Request('https://fox.example/stop', { method: 'POST', headers }))).status).toBe(204);
    expect((await container.fetch(new Request('https://fox.example/relay/prepare', { method: 'POST', headers }))).status).toBe(409);
    expect(admission.release).toHaveBeenCalledWith('canceled-visitor');
    expect(admission.acquire).not.toHaveBeenCalled();
  });
  it('limits publisher credentials to the exact HTTPS WebSocket destination', async () => {
    const fetcher = vi.fn(async (_request: Request) => new Response('publisher'));
    vi.stubGlobal('fetch', fetcher);
    const publish = MediaContainer.outbound! as (request: Request, env: Env) => Promise<Response>;
    const credentials = env;
    for (const url of ['https://other.example/relay/publish', 'https://fox.example/metrics', 'http://fox.example/relay/publish']) {
      expect((await publish(new Request(url, { headers: { Upgrade: 'websocket' } }), credentials)).status).toBe(403);
    }
    expect((await publish(new Request('https://fox.example/relay/publish'), credentials)).status).toBe(403);
    expect((await publish(new Request('https://fox.example/relay/publish', { headers: { Upgrade: 'websocket' } }), { ...env, PUBLISHER_SECRET: '' })).status).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();
    expect((await publish(new Request('https://fox.example/relay/publish?instance=visitor', { headers: { Upgrade: 'websocket', Authorization: 'Bearer upstream-capability' } }), credentials)).status).toBe(200);
    const forwarded = fetcher.mock.calls[0][0];
    expect(forwarded.headers.get('X-Fox-Publisher-Key')).toBe('publisher-only');
    expect(forwarded.headers.get('CF-Access-Client-ID')).toBeNull();
    expect(forwarded.headers.get('CF-Access-Client-Secret')).toBeNull();
    expect(forwarded.headers.get('Authorization')).toBe('Bearer upstream-capability');
  });

});
