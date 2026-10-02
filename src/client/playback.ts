export class RelayPlayback {
  private mediaSource: MediaSource | null = null;
  private sourceBuffer: SourceBuffer | null = null;
  private socket: WebSocket | null = null;
  private queue: ArrayBuffer[] = [];
  private queuedBytes = 0;
  private objectUrl: string | null = null;
  private closed = false;
  private lastPayload = performance.now();
  private watchdog = 0;
  private pendingTimer = 0;
  private rejectPending?: (reason: Error) => void;
  private playbackReady = () => { if (!this.closed && this.video.videoWidth) this.onReady(); };
  private playbackError = () => this.fail(new Error('Video playback failed. Try Chrome or Edge.'));
  constructor(private video: HTMLVideoElement, private onReady: () => void, private onFailure: (error: Error) => void) {
    video.addEventListener('playing', this.playbackReady);
    video.addEventListener('error', this.playbackError);
  }
  async init() {
    this.mediaSource = new MediaSource();
    this.objectUrl = URL.createObjectURL(this.mediaSource); this.video.src = this.objectUrl;
    await new Promise<void>((resolve, reject) => {
      const timer = this.pendingTimer = window.setTimeout(() => reject(new Error('Video playback unavailable. Try Chrome or Edge.')), 10_000);
      this.rejectPending = reject;
      this.mediaSource!.addEventListener('sourceopen', () => {
        clearTimeout(timer);
        if (this.closed) { reject(new Error('Playback canceled')); return; }
        try {
          this.sourceBuffer = this.mediaSource!.addSourceBuffer('video/mp4; codecs="avc1.42C01F"');
          this.sourceBuffer.mode = 'segments';
          this.sourceBuffer.addEventListener('updateend', () => { this.pump(); this.play(); });
          this.sourceBuffer.addEventListener('error', () => this.fail(new Error('Video playback failed. Try Start again.')));
          this.rejectPending = undefined; resolve();
        } catch { reject(new Error('Video playback unavailable. Try Chrome or Edge.')); }
      }, { once: true });
    });
  }
  async connect(sessionId: string, visitorToken: string) {
    const url = new URL('/relay/view', location.origin);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('session_id', sessionId);
    url.searchParams.set('visitor_token', visitorToken);
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url); this.socket = socket; socket.binaryType = 'arraybuffer';
      let opened = false;
      const timer = this.pendingTimer = window.setTimeout(() => { socket.close(); reject(new Error('Connection timed out. Try Start again.')); }, 15_000);
      this.rejectPending = reject;
      socket.onopen = () => { clearTimeout(timer); opened = true; this.rejectPending = undefined; resolve(); };
      socket.onmessage = event => {
        if (this.closed) return;
        if (typeof event.data === 'string') {
          try { if (JSON.parse(event.data).type === 'eos') this.fail(new Error('Session ended. Try Start to reconnect.')); } catch {}
          return;
        }
        const data = event.data as ArrayBuffer;
        this.lastPayload = performance.now();
        if (this.queuedBytes + data.byteLength > 8 * 1024 * 1024) { this.fail(new Error('Playback fell behind. Try Start again.')); return; }
        this.queue.push(data); this.queuedBytes += data.byteLength; this.pump();
      };
      socket.onclose = () => { clearTimeout(timer); if (!opened) reject(new Error('Return unavailable. Try Start again.')); else if (!this.closed) this.fail(new Error('Connection closed. Try Start to reconnect.')); };
      socket.onerror = () => { if (!opened) { clearTimeout(timer); reject(new Error('Return unavailable. Check the video service.')); } };
    });
  }
  watch() {
    this.lastPayload = performance.now();
    this.watchdog = window.setInterval(() => { if (performance.now() - this.lastPayload > 25_000) this.fail(new Error('No video returned. Check the connection, then try Start.')); }, 1000);
  }
  private pump() {
    const buffer = this.sourceBuffer;
    if (!buffer || buffer.updating || this.closed) return;
    try {
      if (buffer.buffered.length && this.video.currentTime > 20 && buffer.buffered.start(0) < this.video.currentTime - 12) { buffer.remove(0, this.video.currentTime - 10); return; }
      const chunk = this.queue.shift();
      if (chunk) { this.queuedBytes -= chunk.byteLength; buffer.appendBuffer(chunk); }
    } catch { this.fail(new Error('Video playback failed. Try Start again.')); }
  }
  private play() {
    const buffer = this.sourceBuffer;
    if (!buffer?.buffered.length || this.closed) return;
    const start = buffer.buffered.start(0), end = buffer.buffered.end(buffer.buffered.length - 1);
    if (end - start > .2) {
      if (this.video.currentTime < start || end - this.video.currentTime > 4) this.video.currentTime = Math.max(start, end - .5);
      if (this.video.paused) void this.video.play().catch(() => this.fail(new Error('Click Start again to allow the return video to play.')));
    }
  }
  private fail(error: Error) { if (this.closed) return; this.close(); this.onFailure(error); }
  close() {
    this.closed = true; clearInterval(this.watchdog); clearTimeout(this.pendingTimer);
    this.video.removeEventListener('playing', this.playbackReady);
    this.video.removeEventListener('error', this.playbackError);
    this.rejectPending?.(new Error('Playback canceled')); this.rejectPending = undefined;
    if (this.socket) { this.socket.onclose = null; this.socket.onerror = null; this.socket.onmessage = null; this.socket.close(); this.socket = null; }
    this.queue = []; this.queuedBytes = 0;
    this.video.pause(); this.video.removeAttribute('src'); this.video.load();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null; this.sourceBuffer = null; this.mediaSource = null;
  }
}
