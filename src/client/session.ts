import { createStreamline, type StreamlineSession } from '@cloudflare/streamline/client';
import { FPS, MAX_SESSION_SECONDS, buildPipeline, DEFAULT_EFFECTS, type RemoteEffects } from '../shared/pipeline';
import { OrderedIngest } from './ingest';
import { RelayPlayback } from './playback';
import { turnstileToken } from './turnstile';
import { reactionPng, type Reaction } from './reaction';

export function unsupportedReason(): string | null {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) return 'Camera needs HTTPS. Open the secure studio address.';
  if (!window.Worker || !window.OffscreenCanvas || !window.createImageBitmap) return 'Face tracking unavailable. Use Chrome or Edge.';
  if (!HTMLCanvasElement.prototype.captureStream || !window.MediaRecorder || !MediaRecorder.isTypeSupported('video/webm;codecs=vp8')) return 'Video encoding unavailable. Use Chrome or Edge.';
  if (!window.MediaSource || !MediaSource.isTypeSupported('video/mp4; codecs="avc1.42C01F"')) return 'Video playback unavailable. Use Chrome or Edge.';
  return null;
}

export class VideoSession {
  private session: StreamlineSession | null = null;
  private visitorToken: string | null = null;
  private localDocker = false;
  private recorder: MediaRecorder | null = null;
  private canvasStream: MediaStream | null = null;
  private ingest: OrderedIngest | null = null;
  private playback: RelayPlayback;
  private abort = new AbortController();
  private expiry = 0;
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private annotationBusy = false;
  private logo = false;
  constructor(video: HTMLVideoElement, private onReady: () => void, private onFailure: (error: Error) => void) {
    this.playback = new RelayPlayback(video, onReady, error => this.fail(error));
  }
  async authorize(container: HTMLElement) {
    const configResponse = await fetch('/api/config', { signal: this.abort.signal });
    if (!configResponse.ok) throw new Error('Studio unavailable. Reload and try again.');
    const config = await configResponse.json() as { localDocker: boolean; turnstileSitekey: string | null };
    this.localDocker = config.localDocker;
    if (!config.localDocker && !config.turnstileSitekey) throw new Error('Verification unavailable. Try again shortly.');
    const token = config.localDocker ? null : await turnstileToken(container, config.turnstileSitekey!, this.abort.signal);
    const response = await fetch('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }), signal: this.abort.signal });
    if (!response.ok) throw new Error(await response.text());
    this.visitorToken = (await response.json() as { token: string }).token;
    this.abort.signal.throwIfAborted();
  }
  private authenticatedFetch(input: RequestInfo | URL, init?: RequestInit) {
    const headers = new Headers(init?.headers);
    if (this.visitorToken) headers.set('X-Fox-Session', this.visitorToken);
    return fetch(input, { ...init, headers });
  }
  async start(canvas: HTMLCanvasElement, effects: RemoteEffects = DEFAULT_EFFECTS) {
    try {
      if (!this.visitorToken) throw new Error('Verification required. Try Start again.');
      const client = createStreamline({ baseUrl: location.origin, fetcher: (input, init) => this.authenticatedFetch(input, init) });
      const prepared = await client.sessions.create({ signal: this.abort.signal });
      if (this.closed) {
        await prepared.stop({ requestId: crypto.randomUUID(), keepalive: true, signal: AbortSignal.timeout(10_000) });
        throw new Error('Session canceled');
      }
      this.session = prepared;
      await this.playback.init();
      if (!this.localDocker) await this.playback.connect(this.session.id!, this.visitorToken!);
      await this.session.start(buildPipeline(effects), { signal: this.abort.signal });
      if (this.closed) throw new Error('Session canceled');
      this.logo = effects.logo;
      if (this.logo) await this.react('none');
      this.abort.signal.throwIfAborted();
      this.canvasStream = canvas.captureStream(FPS);
      this.ingest = new OrderedIngest((blob, signal) => this.session!.ingest(blob, { signal }), error => this.fail(error));
      this.recorder = new MediaRecorder(this.canvasStream, { mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 2_500_000 });
      this.recorder.ondataavailable = event => this.ingest?.enqueue(event.data);
      this.recorder.onerror = () => this.fail(new Error('Canvas encoding failed. Start a new session in Chrome or Edge.'));
      this.recorder.start(250); this.playback.watch();
      this.expiry = window.setTimeout(() => this.fail(new Error('Your 30-minute session finished. Start again for another session.')), MAX_SESSION_SECONDS * 1000);
      if (this.localDocker) {
        const deadline = performance.now() + 15_000;
        for (;;) {
          this.abort.signal.throwIfAborted();
          const metrics = await this.session.metrics({ signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(2000)]) }) as { running?: boolean; reconnectBufferBytes?: number };
          if (metrics.running || (metrics.reconnectBufferBytes ?? 0) > 0) break;
          if (performance.now() >= deadline) throw new Error('Encoder unavailable. Check Docker, then try Start.');
          await new Promise(resolve => window.setTimeout(resolve, 100));
        }
        await this.playback.connect(this.session.id!, this.visitorToken!);
      }
    } catch (error) { await this.close(); throw error; }
  }
  async react(reaction: Reaction) {
    if (this.closed || !this.session || this.annotationBusy) throw new Error('Wait for the return feed, then try again.');
    this.annotationBusy = true;
    const current = this.session;
    try {
      const png = await reactionPng(reaction, this.logo, this.abort.signal);
      this.abort.signal.throwIfAborted();
      await current.annotation(png, { signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(10_000)]) });
    } finally { this.annotationBusy = false; }
  }
  private fail(error: Error) { if (this.closed) return; void this.close(); this.onFailure(error); }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true; this.abort.abort(); clearTimeout(this.expiry);
    this.ingest?.close(); this.ingest = null;
    if (this.recorder) { this.recorder.ondataavailable = null; this.recorder.onerror = null; if (this.recorder.state !== 'inactive') this.recorder.stop(); this.recorder = null; }
    this.canvasStream?.getTracks().forEach(track => track.stop()); this.canvasStream = null;
    this.playback.close();
    this.closePromise = (async () => {
      try {
        if (this.session?.id) await this.session.stop({ requestId: crypto.randomUUID(), keepalive: true, signal: AbortSignal.timeout(10_000) });
        else if (this.visitorToken) {
          const response = await this.authenticatedFetch('/stop', { method: 'POST', keepalive: true, signal: AbortSignal.timeout(10_000) });
          if (!response.ok) throw new Error('Session cleanup pending');
        }
      } finally { this.session = null; this.visitorToken = null; }
    })();
    return this.closePromise;
  }
  get bufferedBytes() { return this.ingest?.bufferedBytes ?? 0; }
}
