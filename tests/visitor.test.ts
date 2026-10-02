import { describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';
import { INSTANCE_PATTERN, SESSION_AUDIENCE, SESSION_ACTION, issueVisitor, visitorPrincipal, verifyTurnstile, privateBucket, publisherAuthorized } from '../src/server/visitor';
const origin = 'https://fox.example', secret = 'a-long-test-only-session-secret';
const request = new Request(`${origin}/api/session`);
describe('Turnstile verification', () => {
  const settings = { secret: 'test-secret', hostnames: 'fox.example' };
  it('requires success, the exact Start action and the deployment hostname', async () => {
    for (const result of [{ success: false, action: SESSION_ACTION, hostname: 'fox.example' }, { success: true, action: 'login', hostname: 'fox.example' }, { success: true, action: SESSION_ACTION, hostname: 'localhost' }, { success: true, action: SESSION_ACTION, hostname: 'evil.example' }, { success: 'true', action: SESSION_ACTION, hostname: 'fox.example' }]) {
      expect(await verifyTurnstile('token', request, settings, vi.fn().mockResolvedValue(Response.json(result)))).toBe(false);
    }
    const fetcher = vi.fn().mockResolvedValue(Response.json({ success: true, action: SESSION_ACTION, hostname: 'fox.example' }));
    expect(await verifyTurnstile('token', request, settings, fetcher)).toBe(true);
    expect(fetcher.mock.calls[0][0]).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    expect((fetcher.mock.calls[0][1].body as URLSearchParams).get('response')).toBe('token');
  });
  it('fails closed on bad tokens, HTTP errors, JSON failures and network outages', async () => {
    const fetcher = vi.fn();
    for (const token of [undefined, '', 5, 'x'.repeat(2049)]) expect(await verifyTurnstile(token, request, settings, fetcher)).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    for (const response of [new Response('fail', { status: 500 }), new Response('not JSON')]) expect(await verifyTurnstile('token', request, settings, vi.fn().mockResolvedValue(response))).toBe(false);
    expect(await verifyTurnstile('token', request, settings, vi.fn().mockRejectedValue(new Error('network')))).toBe(false);
    expect(await verifyTurnstile('token', request, { ...settings, hostnames: '' }, fetcher)).toBe(false);
  });
});
describe('Expiring visitor capabilities', () => {
  it('assigns a unique identity for each attempt and cannot be forged with headers', async () => {
    const first = await issueVisitor(secret, origin), second = await issueVisitor(secret, origin);
    const read = (token: string) => visitorPrincipal(new Request(`${origin}/metrics`, { headers: { 'X-Fox-Session': token } }), secret);
    const a = await read(first), b = await read(second);
    expect(a).toMatch(INSTANCE_PATTERN); expect(a).not.toBe(b);
    expect(await visitorPrincipal(new Request(`${origin}/metrics`, { headers: { 'X-Streamline-Principal': a!, 'Cf-Access-Jwt-Assertion': 'spoof' } }), secret)).toBeNull();
    expect(await read(first.slice(0, -10) + 'corrupted')).toBeNull();
    expect(await visitorPrincipal(new Request('https://other.example/metrics', { headers: { 'X-Fox-Session': first } }), secret)).toBeNull();
    expect(await visitorPrincipal(new Request(`${origin}/metrics`, { headers: { 'X-Fox-Session': first } }), 'another-key')).toBeNull();
  });
  it('rejects expired permits and only allows query tokens for the viewer WebSocket', async () => {
    const token = await issueVisitor(secret, origin);
    expect(await visitorPrincipal(new Request(`${origin}/relay/view?visitor_token=${token}`), secret)).toMatch(INSTANCE_PATTERN);
    expect(await visitorPrincipal(new Request(`${origin}/stop?visitor_token=${token}`), secret)).toBeNull();
    const expired = await new SignJWT({ kind: 'visitor' }).setProtectedHeader({ alg: 'HS256' }).setSubject(crypto.randomUUID()).setIssuer(origin).setAudience(SESSION_AUDIENCE).setIssuedAt(1).setExpirationTime(2).sign(new TextEncoder().encode(secret));
    expect(await visitorPrincipal(new Request(`${origin}/metrics`, { headers: { 'X-Fox-Session': expired } }), secret)).toBeNull();
  });
  it('keeps publisher authorization separate and hashes rate-limit identities', async () => {
    expect(await publisherAuthorized(new Request(`${origin}/relay/publish`, { headers: { 'X-Fox-Publisher-Key': secret } }), secret)).toBe(true);
    expect(await publisherAuthorized(new Request(`${origin}/relay/publish`, { headers: { 'X-Fox-Publisher-Key': 'spoof' } }), secret)).toBe(false);
    expect(await publisherAuthorized(new Request(`${origin}/relay/publish`), secret)).toBe(false);
    const bucket = await privateBucket('192.0.2.1', secret);
    expect(bucket).toHaveLength(64); expect(bucket).not.toContain('192.0.2.1');
    expect(await privateBucket('192.0.2.2', secret)).not.toBe(bucket);
  });
});
