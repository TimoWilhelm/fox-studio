import { describe, expect, it, vi } from 'vitest';
import { internalRequest, limitedBody, secureResponse } from '../src/server/security';
import { PIPELINE, buildPipeline, remoteLooks, validatePipeline } from '../src/shared/pipeline';
describe('Session and policy boundary', () => {
  it('strips user-provided credentials and derives the principal', () => {
    const request = internalRequest(new Request('https://fox.example/ingest', { headers: { Cookie: 'secret', 'CF-Access-Client-Secret': 'secret', 'Cf-Access-Jwt-Assertion': 'secret', 'X-Streamline-Principal': 'spoof' } }), 'verified');
    expect([...request.headers]).toEqual([['x-streamline-principal', 'verified']]);
  });
  it('permits the Turnstile script and frame while retaining the security policy', () => {
    const policy = secureResponse(new Response()).headers.get('Content-Security-Policy')!;
    expect(policy).toContain("script-src 'self' https://challenges.cloudflare.com");
    expect(policy).toContain('frame-src https://challenges.cloudflare.com');
    expect(policy).toContain("frame-ancestors 'none'");
  });
  it('enforces limits even without Content-Length', async () => {
    expect(await limitedBody(new Request('https://fox.example/ingest', { method: 'POST', body: new Uint8Array(1024 * 1024 + 1) }), 1024 * 1024)).toBeNull();
    expect((await limitedBody(new Request('https://fox.example/ingest', { method: 'POST', body: '1234' }), 4))?.length).toBe(4);
  });
  it('accepts only the curated pipelines and rejects injected relay configuration', () => {
    expect(validatePipeline({ ...PIPELINE, session_id: 'test' }).input.type).toBe('webcam');
    for (const config of [{ ...PIPELINE, input: { type: 'hls', url: 'https://example.com' } }, { ...PIPELINE, output: { mode: 'rtmp', profile: 'x' } }, { ...PIPELINE, output: { ...PIPELINE.output, relay: { url: 'wss://evil.com' } } }, { ...PIPELINE, pipeline: [{ op: 'filter', params: { command: 'x' } }] }]) expect(() => validatePipeline({ ...config, session_id: 'test' })).toThrow();
  });
  it('allows all looks with optional logo but rejects altered filters, extra operations and encoding changes', () => {
    for (const { id: look } of remoteLooks) for (const logo of [false, true]) {
      const config = buildPipeline({ look, logo });
      expect(validatePipeline({ ...config, session_id: 'test' })).toEqual({ ...config, session_id: 'test' });
    }
    const config = buildPipeline({ look: 'vivid', logo: true });
    for (const operation of [
      { op: 'filter', params: { preset: 'saturation', amount: 100 } },
      { op: 'filter', params: { preset: 'flip' } },
      { op: 'overlay', params: { image: 'https://example.com/image.png', position: 'full' } },
      { op: 'encode', params: { codec: 'h264', fps: 60 } },
    ]) {
      expect(() => validatePipeline({ ...config, pipeline: [...config.pipeline, operation], session_id: 'test' })).toThrow();
    }
    const altered = structuredClone(config);
    altered.pipeline[0] = { op: 'filter', params: { preset: 'saturation', amount: 1.6 } };
    expect(() => validatePipeline({ ...altered, session_id: 'test' })).toThrow();
    expect(() => validatePipeline({ ...config, debug: true, session_id: 'test' })).toThrow();
  });
});
