import { MAX_SESSION_SECONDS, PolicyError, validatePipeline } from '../shared/pipeline';

interface Reservation { id: string; principal: string; expires: number; started: boolean; consumed: boolean }

export class LocalDockerSession {
  private reservation: Reservation | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private origin: string, private fetcher: typeof fetch = (input, init) => fetch(input, init)) {}

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/relay/publish') return new Response('Local Docker uses direct output', { status: 404 });
    if (['/relay/prepare', '/start', '/stop'].includes(path)) {
      const result = this.tail.then(() => this.handle(request));
      this.tail = result.catch(() => {});
      return result;
    }
    return this.handle(request);
  }

  private async proxy(request: Request, path?: string): Promise<Response> {
    const target = new URL(request.url);
    const engine = new URL(this.origin);
    target.protocol = engine.protocol; target.host = engine.host;
    if (path) target.pathname = path;
    return this.fetcher(new Request(target, request));
  }

  private async clear(request: Request) {
    if (this.reservation?.started) {
      const headers = new Headers({ 'X-Streamline-Session-ID': this.reservation.id, Origin: request.headers.get('Origin') || new URL(request.url).origin });
      const stopped = await this.fetcher(new Request(`${this.origin}/stop`, { method: 'POST', headers, signal: AbortSignal.timeout(10_000) }));
      if (!stopped.ok) throw new Error('Could not stop local engine');
    }
    this.reservation = null;
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const principal = request.headers.get('X-Streamline-Principal');
    if (!principal) return new Response('Unauthorized', { status: 401 });
    if (this.reservation && Date.now() >= this.reservation.expires) await this.clear(request);
    if (url.pathname === '/relay/prepare') {
      if (this.reservation && this.reservation.principal !== principal) return new Response('Session belongs to another user', { status: 409 });
      await this.clear(request);
      this.reservation = { id: crypto.randomUUID(), principal, expires: Date.now() + 900_000, started: false, consumed: false };
      return Response.json({ session_id: this.reservation.id });
    }
    const session = this.reservation;
    if (!session || session.principal !== principal) return new Response('Session is no longer active', { status: 409 });
    const body = url.pathname === '/start' ? await request.json() as Record<string, unknown> : null;
    const id = body?.session_id ?? request.headers.get('X-Streamline-Session-ID') ?? url.searchParams.get('session_id');
    if (id !== session.id) return new Response('Session is no longer active', { status: 409 });
    if (url.pathname === '/start' && body) {
      if (session.consumed) return new Response('Create a fresh session to start again', { status: 409 });
      try {
        const config = validatePipeline(body);
        session.consumed = true;
        session.started = true;
        const response = await this.proxy(new Request(request, { body: JSON.stringify(config), signal: AbortSignal.timeout(25_000) }));
        if (!response.ok) { await this.clear(request); return response; }
        session.expires = Date.now() + MAX_SESSION_SECONDS * 1000;
        return response;
      } catch (error) {
        if (error instanceof PolicyError) return new Response(error.message, { status: error.status });
        await this.clear(request);
        throw error;
      }
    }
    if (url.pathname === '/stop') { await this.clear(request); return Response.json({ status: 'stopped' }); }
    if (!session.started) return new Response('Session has not started', { status: 409 });
    if (url.pathname === '/relay/view') return this.proxy(request, '/output');
    return this.proxy(request);
  }
}
