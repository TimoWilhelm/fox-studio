import { describe, expect, it } from 'vitest';
import { PUBLISHED_STREAMLINE_IMAGE, streamlineImage } from '../src/shared/streamline-image';

describe('published Streamline image selection', () => {
  it('defaults to the verified digest-pinned published engine', () => {
    expect(streamlineImage()).toBe(PUBLISHED_STREAMLINE_IMAGE);
    expect(streamlineImage('')).toBe(PUBLISHED_STREAMLINE_IMAGE);
    expect(streamlineImage()).toMatch(/@sha256:[a-f0-9]{64}$/);
  });
  it('accepts an explicitly pinned upstream or account-specific registry image', () => {
    const image = `ghcr.io/cloudflare/streamline@sha256:${'a'.repeat(64)}`;
    expect(streamlineImage(image)).toBe(image);
  });
  it('rejects mutable tags, malformed digests, protocols and Dockerfile paths', () => {
    for (const reference of ['streamline:latest', 'streamline:0.1.0', 'streamline@sha256:abc', './Dockerfile', `https://${PUBLISHED_STREAMLINE_IMAGE}`, `${PUBLISHED_STREAMLINE_IMAGE} trailing`]) expect(() => streamlineImage(reference)).toThrow('digest-pinned');
  });
});
