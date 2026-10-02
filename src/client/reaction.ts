import { WIDTH, HEIGHT, MAX_REACTION_BYTES } from '../shared/pipeline';

export type Reaction = 'none' | 'hearts' | 'sparkles';

// This separate transparent image is composited by Streamline, never onto the fox canvas.
export async function reactionPng(reaction: Reaction, logo: boolean, signal: AbortSignal): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH; canvas.height = HEIGHT;
  try {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Overlay unavailable. Reload and try again.');
    if (logo) {
      const response = await fetch('/streamline-logo.png', { signal });
      if (!response.ok) throw new Error('Logo could not load. Reload and try again.');
      const image = await createImageBitmap(await response.blob());
      try {
        signal.throwIfAborted();
        const width = 180, height = width * image.height / image.width;
        const padding = 10, right = 22, bottom = 22;
        const x = WIDTH - right - width, y = HEIGHT - bottom - height;
        ctx.fillStyle = 'rgba(20, 23, 25, .68)';
        ctx.beginPath(); ctx.roundRect(x - padding, y - padding, width + padding * 2, height + padding * 2, 9); ctx.fill();
        ctx.globalAlpha = .88; ctx.drawImage(image, x, y, width, height); ctx.globalAlpha = 1;
      } finally { image.close(); }
    }
    const marks = [[150, 170, 52, -.2], [250, 100, 30, .15], [1100, 520, 44, .2], [1010, 610, 28, -.15]];
    if (reaction !== 'none') for (const [x, y, size, tilt] of marks) {
      ctx.save(); ctx.translate(x, y); ctx.rotate(tilt); ctx.scale(size, size);
      ctx.beginPath();
      if (reaction === 'hearts') {
        ctx.moveTo(0, .85);
        ctx.bezierCurveTo(-1.5, -.05, -.85, -1.1, 0, -.45);
        ctx.bezierCurveTo(.85, -1.1, 1.5, -.05, 0, .85);
        ctx.fillStyle = '#ef7691';
      } else {
        ctx.moveTo(0, -1); ctx.quadraticCurveTo(.15, -.15, .85, 0);
        ctx.quadraticCurveTo(.15, .15, 0, 1); ctx.quadraticCurveTo(-.15, .15, -.85, 0);
        ctx.quadraticCurveTo(-.15, -.15, 0, -1);
        ctx.fillStyle = '#f6bf48';
      }
      ctx.closePath(); ctx.strokeStyle = '#fffaf3'; ctx.lineWidth = .12; ctx.lineJoin = 'round';
      ctx.stroke(); ctx.fill(); ctx.restore();
    }
    const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Overlay could not be created. Try again.')), 'image/png'));
    signal.throwIfAborted();
    if (png.size > MAX_REACTION_BYTES) throw new Error('Overlay is too large. Reload and try again.');
    return png;
  } finally { canvas.width = 0; canvas.height = 0; }
}
