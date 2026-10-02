export function internalRequest(request: Request, principal?: string, publisher = false): Request {
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (['content-type', 'origin', 'upgrade', 'connection', 'x-ingest-request-id', 'x-streamline-session-id', 'x-stop-request-id'].includes(name.toLowerCase()) || name.toLowerCase().startsWith('sec-websocket-') || (publisher && name.toLowerCase() === 'authorization')) headers.set(name, value);
  }
  if (principal) headers.set('X-Streamline-Principal', principal);
  const url = new URL(request.url);
  url.searchParams.delete('visitor_token');
  return new Request(new Request(url, request), { headers });
}

export async function limitedBody(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (Number(request.headers.get('Content-Length')) > limit) { await request.body?.cancel().catch(() => {}); return null; }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export function isLoopback(request: Request) {
  return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(request.url).hostname);
}

export function secureResponse(response: Response, localDevelopment = false): Response {
  if (response.status === 101) return response;
  const secured = new Response(response.body, response);
  secured.headers.set('Cache-Control', 'no-store');
  secured.headers.set('X-Content-Type-Options', 'nosniff');
  secured.headers.set('Referrer-Policy', 'no-referrer');
  secured.headers.set('Permissions-Policy', 'camera=(self), microphone=(), fullscreen=(self)');
  secured.headers.set('Content-Security-Policy', `default-src 'self'; script-src 'self' https://challenges.cloudflare.com 'wasm-unsafe-eval'${localDevelopment ? " 'unsafe-inline'" : ''}; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; frame-src https://challenges.cloudflare.com; connect-src 'self' https://challenges.cloudflare.com ws://localhost:* ws://127.0.0.1:* wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`);
  return secured;
}
