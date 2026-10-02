import type { FaceSample } from '../shared/expression';

export class FaceTracker {
  private worker: Worker | null = null;
  private ready = false;
  private busy = false;
  private lastSent = 0;
  private initTimer = 0;
  private pendingReject?: (error: Error) => void;
  constructor(private onSample: (sample: FaceSample) => void, private onError: (error: Error) => void) {}
  init(): Promise<void> {
    return new Promise((resolve, reject) => {
      const worker = new Worker('/tracking-worker.js');
      this.worker = worker;
      const timeout = this.initTimer = window.setTimeout(() => { this.pendingReject = undefined; this.close(); reject(new Error('Face model timed out. Reload and try again.')); }, 30_000);
      this.pendingReject = reject;
      worker.onmessage = event => {
        if (this.worker !== worker) return;
        if (event.data.type === 'ready') { clearTimeout(timeout); this.ready = true; this.pendingReject = undefined; resolve(); }
        if (event.data.type === 'sample') { this.busy = false; this.onSample(event.data); }
        if (event.data.type === 'error') {
          clearTimeout(timeout); this.busy = false;
          const error = new Error('Face tracking could not start. Reload or try Chrome.');
          if (!this.ready) reject(error); else this.onError(error);
        }
      };
      worker.onerror = () => { clearTimeout(timeout); const error = new Error('Face tracking unavailable. Reload or try Chrome.'); reject(error); this.onError(error); };
      worker.postMessage({ type: 'init' });
    });
  }
  async frame(video: HTMLVideoElement, now: number) {
    const worker = this.worker;
    if (!worker || !this.ready || this.busy || now - this.lastSent < 50 || video.readyState < 2) return;
    this.busy = true; this.lastSent = now;
    try {
      const frame = await createImageBitmap(video, { resizeWidth: 640, resizeHeight: 360, resizeQuality: 'low' });
      if (this.worker !== worker) { frame.close(); return; }
      worker.postMessage({ type: 'frame', frame, timestamp: now }, [frame]);
    } catch { this.busy = false; this.onError(new Error('Camera unreadable. Choose another camera.')); }
  }
  close() {
    clearTimeout(this.initTimer);
    this.ready = false; this.busy = false;
    this.pendingReject?.(new Error('Tracking canceled')); this.pendingReject = undefined;
    this.worker?.postMessage({ type: 'close' }); this.worker?.terminate(); this.worker = null;
  }
}
