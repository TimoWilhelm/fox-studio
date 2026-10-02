import { SignJWT, jwtVerify } from 'jose';
import { MAX_SESSION_SECONDS } from '../shared/pipeline';

export const VISITOR_TTL_SECONDS = MAX_SESSION_SECONDS + 420;
export const SESSION_ACTION = 'start_session';
export const SESSION_AUDIENCE = 'fox-studio-session';
export const INSTANCE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export async function verifyTurnstile(token: unknown, request: Request, settings: { secret: string; hostnames: string }, fetcher: typeof fetch = fetch): Promise<boolean> {
  if (typeof token !== 'string' || !token || token.length > 2048 || !settings.secret) return false;
  const allowed = new Set(settings.hostnames.split(',').map(host => host.trim()).filter(Boolean));
  if (!allowed.size || !allowed.has(new URL(request.url).hostname)) return false;
  try {
    const body = new URLSearchParams({ secret: settings.secret, response: token });
    const ip = request.headers.get('CF-Connecting-IP');
    if (ip) body.set('remoteip', ip);
    const response = await fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return false;
    const result = await response.json() as { success?: unknown; action?: unknown; hostname?: unknown };
    return result.success === true && result.action === SESSION_ACTION && typeof result.hostname === 'string' && result.hostname === new URL(request.url).hostname && allowed.has(result.hostname);
  } catch { return false; }
}

export async function issueVisitor(secret: string, origin: string): Promise<string> {
  if (!secret) throw new Error('Session signing secret missing');
  return new SignJWT({ kind: 'visitor' }).setProtectedHeader({ alg: 'HS256' }).setSubject(crypto.randomUUID())
    .setIssuer(origin).setAudience(SESSION_AUDIENCE).setIssuedAt().setExpirationTime(`${VISITOR_TTL_SECONDS}s`)
    .sign(new TextEncoder().encode(secret));
}

export async function visitorPrincipal(request: Request, secret: string): Promise<string | null> {
  const url = new URL(request.url);
  // WebSockets cannot set a custom header. Only the viewer accepts a query capability.
  const token = request.headers.get('X-Fox-Session') ?? (url.pathname === '/relay/view' ? url.searchParams.get('visitor_token') : null);
  if (!secret || !token || token.length > 2048) return null;
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), { algorithms: ['HS256'], issuer: url.origin, audience: SESSION_AUDIENCE });
    if (payload.kind !== 'visitor' || typeof payload.sub !== 'string' || !INSTANCE_PATTERN.test(payload.sub) || typeof payload.exp !== 'number' || typeof payload.iat !== 'number' || payload.exp - payload.iat > VISITOR_TTL_SECONDS) return null;
    return payload.sub;
  } catch { return null; }
}

export async function privateBucket(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
}

export async function publisherAuthorized(request: Request, secret: string): Promise<boolean> {
  const supplied = request.headers.get('X-Fox-Publisher-Key');
  if (!secret || !supplied || supplied.length > 256) return false;
  const [left, right] = await Promise.all([secret, supplied].map(value => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
  const a = new Uint8Array(left), b = new Uint8Array(right);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}
