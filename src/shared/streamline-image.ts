export const PUBLISHED_STREAMLINE_IMAGE = 'registry.cloudflare.com/d64471fef208e0cf9687449dc8a5878b/fox-studio-media@sha256:277e2f23da91ccc4b1b7af88c19601ff9a350cc9713a6092cbcf2bed1a39f430';

export function streamlineImage(reference?: string): string {
  const image = reference || PUBLISHED_STREAMLINE_IMAGE;
  if (!/^(?:[a-z0-9.-]+(?::\d+)?\/)?[a-z0-9]+(?:[._/-][a-z0-9]+)*@sha256:[a-f0-9]{64}$/.test(image)) throw new Error('STREAMLINE_CONTAINER_IMAGE must be a digest-pinned registry image.');
  return image;
}
