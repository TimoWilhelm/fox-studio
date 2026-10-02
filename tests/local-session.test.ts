import { describe, expect, it, vi } from 'vitest';
import { LocalDockerSession } from '../src/server/local-session';
import { PIPELINE } from '../src/shared/pipeline';
const req = (path: string, id?: string, body?: unknown, principal = 'owner') => new Request(`http://127.0.0.1:5173${path}`, { method: path === '/metrics' ? 'GET' : 'POST', headers: { 'X-Streamline-Principal': principal, 'X-Streamline-Session-ID': id ?? '', Origin: 'http://127.0.0.1:5173' }, ...(body ? { body: JSON.stringify(body) } : {}) });
describe('local Docker lifecycle', () => {
  it('fences stale sessions and refuses another principal', async () => {
    const local = new LocalDockerSession('http://127.0.0.1:8788');
    const id = (await (await local.fetch(req('/relay/prepare'))).json()).session_id;
    expect((await local.fetch(req('/relay/prepare', undefined, undefined, 'spoof'))).status).toBe(409);
    expect((await local.fetch(req('/metrics', 'old-session'))).status).toBe(409);
    expect((await local.fetch(req('/start', id, { ...PIPELINE, session_id: 'old-session' }))).status).toBe(409);
  });
  it('stops the engine after a failed start and clears ownership', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('failed', { status: 500 })).mockResolvedValue(new Response('stopped'));
    const local = new LocalDockerSession('http://127.0.0.1:8788', fetcher);
    const id = (await (await local.fetch(req('/relay/prepare'))).json()).session_id;
    expect((await local.fetch(req('/start', id, { ...PIPELINE, session_id: id }))).status).toBe(500);
    expect(new URL((fetcher.mock.calls[1][0] as Request).url).pathname).toBe('/stop');
    expect((await local.fetch(req('/metrics', id))).status).toBe(409);
  });
  it('stops the prior run before a replacement and starts a session only once', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
    const local = new LocalDockerSession('http://127.0.0.1:8788', fetcher);
    const id = (await (await local.fetch(req('/relay/prepare'))).json()).session_id;
    await local.fetch(req('/start', id, { ...PIPELINE, session_id: id }));
    expect((await local.fetch(req('/start', id, { ...PIPELINE, session_id: id }))).status).toBe(409);
    const next = (await (await local.fetch(req('/relay/prepare'))).json()).session_id;
    expect(next).not.toBe(id); expect(new URL((fetcher.mock.calls[1][0] as Request).url).pathname).toBe('/stop');
  });
  it('forwards annotations only for the running session and owning visitor', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
    const local = new LocalDockerSession('http://127.0.0.1:8788', fetcher);
    const id = (await (await local.fetch(req('/relay/prepare'))).json()).session_id;
    const annotation = (session = id, principal = 'owner') => new Request('http://127.0.0.1:5173/api/annotation', { method: 'PUT', body: 'png', headers: { 'Content-Type': 'image/png', 'X-Streamline-Principal': principal, 'X-Streamline-Session-ID': session } });
    expect((await local.fetch(annotation())).status).toBe(409);
    await local.fetch(req('/start', id, { ...PIPELINE, session_id: id }));
    expect((await local.fetch(annotation('stale'))).status).toBe(409);
    expect((await local.fetch(annotation(id, 'other'))).status).toBe(409);
    expect((await local.fetch(annotation())).status).toBe(200);
    const forwarded = fetcher.mock.calls.at(-1)![0] as Request;
    expect(forwarded.method).toBe('PUT');
    expect(new URL(forwarded.url).pathname).toBe('/api/annotation');
    await local.fetch(req('/stop', id));
    expect((await local.fetch(annotation())).status).toBe(409);
  });
});
