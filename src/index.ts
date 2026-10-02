import { ContainerProxy, StreamlineSessionDO, MAX_START_BYTES, MAX_INGEST_BYTES, type ResolvedSessionStart, type StreamlineRelaySession } from '@cloudflare/streamline';
import { MAX_SESSION_SECONDS, MAX_REACTION_BYTES, PolicyError, validatePipeline } from './shared/pipeline';
import { internalRequest, isLoopback, limitedBody, secureResponse } from './server/security';
import { issueVisitor, visitorPrincipal, verifyTurnstile, publisherAuthorized, privateBucket, INSTANCE_PATTERN } from './server/visitor';
import { ADMISSION_INSTANCE, SessionAdmission } from './server/admission';
import { LocalDockerSession } from './server/local-session';

export { ContainerProxy, SessionAdmission };
const routes: Record<string, string> = { '/relay/prepare': 'POST', '/start': 'POST', '/ingest': 'POST', '/api/annotation': 'PUT', '/relay/view': 'GET', '/relay/publish': 'GET', '/metrics': 'GET', '/stop': 'POST' };
const PREPARED_KEY = 'fox-prepared-session';

export class MediaContainer extends StreamlineSessionDO<Env> {
  private local?: LocalDockerSession;
  private applicationTail: Promise<unknown> = Promise.resolve();
  protected async resolveStartConfig(_request: Request, body: Record<string, unknown>): Promise<ResolvedSessionStart> {
    return { body: validatePipeline(body), maxSessionSeconds: MAX_SESSION_SECONDS };
  }
  protected handleStartConfigError(error: unknown) { return error instanceof PolicyError ? new Response(error.message, { status: error.status }) : undefined; }
  protected ensurePublisherAccess() {
    if (!this.env.PUBLISHER_SECRET) throw new PolicyError('Publisher credentials are missing.', 503);
  }
  protected getRelayPublisherUrl(request: Request): URL {
    const url = super.getRelayPublisherUrl(request);
    url.searchParams.set('instance', request.headers.get('X-Streamline-Principal')!);
    return url;
  }
  protected async onRelaySessionCleared(session: StreamlineRelaySession) {
    await this.stop();
    await this.ctx.storage.delete(PREPARED_KEY);
    await this.ctx.exports.SessionAdmission.getByName(ADMISSION_INSTANCE).release(session.principal);
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.applicationTail.then(operation);
    this.applicationTail = result.catch(() => {});
    return result;
  }
  private dispatch(request: Request): Promise<Response> {
    if (this.env.LOCAL_DOCKER_ORIGIN && isLoopback(request)) {
      if (!/^http:\/\/(localhost|127\.0\.0\.1):8788$/.test(this.env.LOCAL_DOCKER_ORIGIN)) return Promise.resolve(new Response('Invalid local adapter', { status: 503 }));
      this.local ??= new LocalDockerSession(this.env.LOCAL_DOCKER_ORIGIN);
      return this.local.fetch(request);
    }
    return super.fetch(request);
  }
  async abortSession(principal: string): Promise<void> {
    await this.serialize(() => this.abortInner(principal));
  }
  private async abortInner(principal: string): Promise<void> {
    const sessionId = await this.ctx.storage.get<string>(PREPARED_KEY);
    if (sessionId) {
      const origin = this.env.LOCAL_DOCKER_ORIGIN ? 'http://127.0.0.1:5173' : this.env.ALLOWED_ORIGINS;
      const stopped = await this.dispatch(new Request(`${origin}/stop`, { method: 'POST', headers: { 'X-Streamline-Principal': principal, 'X-Streamline-Session-ID': sessionId } }));
      if (!stopped.ok) throw new Error('Session cleanup pending');
      await this.ctx.storage.delete(PREPARED_KEY);
    }
    await this.ctx.exports.SessionAdmission.getByName(ADMISSION_INSTANCE).release(principal);
  }
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (!['/relay/prepare', '/start', '/stop'].includes(path)) return this.dispatch(request);
    return this.serialize(async () => {
      const principal = request.headers.get('X-Streamline-Principal');
      if (!principal) return new Response('Unauthorized', { status: 401 });
      const admission = this.ctx.exports.SessionAdmission.getByName(ADMISSION_INSTANCE);
      if (path === '/relay/prepare') {
        if (await this.ctx.storage.get('fox-permit-used')) return new Response('Start again for a fresh session.', { status: 409 });
        if (!await admission.acquire(principal)) return new Response('Studio busy. Try Start again shortly.', { status: 429, headers: { 'Retry-After': '30' } });
        await this.ctx.storage.put('fox-permit-used', true);
        try {
          const response = await this.dispatch(request);
          if (response.ok) {
            const { session_id } = await response.clone().json() as { session_id: string };
            await this.ctx.storage.put(PREPARED_KEY, session_id);
          } else await admission.release(principal);
          return response;
        } catch (error) { await this.abortInner(principal); throw error; }
      }
      if (path === '/stop' && !await this.ctx.storage.get(PREPARED_KEY)) {
        // Stop can arrive before a canceled prepare request. Retire its permit too.
        await this.ctx.storage.put('fox-permit-used', true);
        await admission.release(principal);
        return new Response(null, { status: 204 });
      }
      if (path === '/start' && !await admission.commit(principal)) return new Response('Session expired. Try Start again.', { status: 409 });
      try {
        const response = await this.dispatch(request);
        if (path === '/start' && !response.ok) await this.abortInner(principal);
        if (path === '/stop' && response.ok) { await this.ctx.storage.delete(PREPARED_KEY); await admission.release(principal); }
        return response;
      } catch (error) { if (path === '/start') await this.abortInner(principal); throw error; }
    });
  }
}

MediaContainer.outbound = async (request: Request, env: Env) => {
  const url = new URL(request.url);
  if (url.protocol !== 'https:' || url.origin !== env.ALLOWED_ORIGINS || url.pathname !== '/relay/publish' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('Outbound destination not allowed', { status: 403 });
  if (!env.PUBLISHER_SECRET) return new Response('Publisher credentials missing', { status: 503 });
  const headers = new Headers(request.headers);
  headers.set('X-Fox-Publisher-Key', env.PUBLISHER_SECRET);
  return fetch(new Request(request, { headers }));
};

export async function handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const local = Boolean(env.LOCAL_DOCKER_ORIGIN) && isLoopback(request);
  if (url.pathname === '/api/config') {
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
    return Response.json({ localDocker: local, maxSessionSeconds: MAX_SESSION_SECONDS, turnstileSitekey: local ? null : env.TURNSTILE_SITEKEY });
  }
  if (url.pathname === '/api/session') {
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    if (request.headers.get('Origin') !== url.origin) return new Response('Origin not allowed', { status: 403 });
    if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/json') return new Response('Use application/json', { status: 415 });
    const bytes = await limitedBody(request, 4096);
    if (!bytes) return new Response('Request too large', { status: 413 });
    let body: { token?: unknown };
    try { body = JSON.parse(new TextDecoder().decode(bytes)); if (!body || typeof body !== 'object') throw new Error(); }
    catch { return new Response('Invalid verification request', { status: 400 }); }
    if (!local) {
      const bucket = await privateBucket(request.headers.get('CF-Connecting-IP') ?? 'unknown', env.SESSION_SECRET);
      if (!await ctx.exports.SessionAdmission.getByName(ADMISSION_INSTANCE).checkVerification(bucket)) return new Response('Too many attempts. Try again in 10 minutes.', { status: 429 });
      if (!await verifyTurnstile(body.token, request, { secret: env.TURNSTILE_SECRET, hostnames: env.TURNSTILE_HOSTNAMES })) return new Response('Verification failed. Try Start again.', { status: 403 });
    }
    return Response.json({ token: await issueVisitor(env.SESSION_SECRET, url.origin) });
  }
  if (!(url.pathname in routes)) return env.ASSETS.fetch(request);
  if (request.method !== routes[url.pathname]) return new Response('Method not allowed', { status: 405 });
  const publisher = url.pathname === '/relay/publish';
  let principal: string | null;
  if (publisher) {
    if (!await publisherAuthorized(request, env.PUBLISHER_SECRET)) return new Response('Unauthorized', { status: 401 });
    principal = url.searchParams.get('instance');
    if (!principal || !INSTANCE_PATTERN.test(principal)) return new Response('Unauthorized', { status: 401 });
  } else {
    principal = await visitorPrincipal(request, env.SESSION_SECRET);
    if (!principal) return new Response('Verification required. Try Start again.', { status: 401 });
  }
  if (!publisher && (request.method === 'POST' || request.method === 'PUT' || url.pathname === '/relay/view') && request.headers.get('Origin') !== url.origin) return new Response('Origin not allowed', { status: 403 });
  if (url.pathname.startsWith('/relay/') && url.pathname !== '/relay/prepare' && request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket upgrade required', { status: 400 });
  if (request.method === 'POST' || request.method === 'PUT') {
    const limit = url.pathname === '/start' ? MAX_START_BYTES : url.pathname === '/ingest' ? MAX_INGEST_BYTES : url.pathname === '/api/annotation' ? MAX_REACTION_BYTES : 0;
    const contentType = request.headers.get('Content-Type')?.split(';')[0];
    if (url.pathname === '/start' && contentType !== 'application/json') return new Response('Use application/json', { status: 415 });
    if (url.pathname === '/ingest' && contentType !== 'application/octet-stream') return new Response('Use application/octet-stream', { status: 415 });
    if (url.pathname === '/api/annotation' && contentType !== 'image/png') return new Response('Use image/png', { status: 415 });
    const body = await limitedBody(request, limit);
    if (!body) return new Response(limit ? 'Request body exceeds the allowed limit' : 'This route does not accept a body', { status: limit ? 413 : 400 });
    request = new Request(request, { body: limit ? body : null });
  }
  return ctx.exports.MediaContainer.getByName(principal).fetch(internalRequest(request, publisher ? undefined : principal, publisher));
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const local = Boolean(env.LOCAL_DOCKER_ORIGIN) && isLoopback(request);
    try { return secureResponse(await handle(request, env, ctx), local); }
    catch (error) {
      console.error({ event: 'request_failed', path: new URL(request.url).pathname, error: error instanceof Error ? error.name : 'UnknownError', ...(local && error instanceof Error ? { detail: error.message } : {}) });
      return secureResponse(new Response('The video service could not connect. Stop and try a new session.', { status: 502 }), local);
    }
  },
} satisfies ExportedHandler<Env>;
