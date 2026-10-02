import { MAX_CHUNK_BYTES } from '../shared/pipeline';

export class OrderedIngest {
  private chunks: Blob[] = [];
  private bytes = 0;
  private sending = false;
  private closed = false;
  private abort = new AbortController();
  constructor(private send: (blob: Blob, signal: AbortSignal) => Promise<void>, private onFatal: (error: Error) => void, private maxBytes = 8 * 1024 * 1024) {}
  enqueue(blob: Blob) {
    if (this.closed || !blob.size) return;
    if (blob.size > MAX_CHUNK_BYTES) { this.fail(new Error('Video chunk too large. Try Start again.')); return; }
    if (this.bytes + blob.size > this.maxBytes) { this.fail(new Error('Connection too slow. Try Start on a faster connection.')); return; }
    this.chunks.push(blob); this.bytes += blob.size;
    void this.pump();
  }
  private async pump() {
    if (this.sending || this.closed) return;
    this.sending = true;
    try {
      while (this.chunks.length && !this.closed) {
        const blob = this.chunks[0];
        await this.send(blob, AbortSignal.any([this.abort.signal, AbortSignal.timeout(15_000)]));
        this.chunks.shift(); this.bytes -= blob.size;
      }
    } catch (error) { if (!this.closed) this.fail(new Error('Video upload failed. Try Start to reconnect.')); }
    finally { this.sending = false; }
  }
  private fail(error: Error) { this.close(); this.onFatal(error); }
  close() { this.closed = true; this.abort.abort(); this.chunks = []; this.bytes = 0; }
  get bufferedBytes() { return this.bytes; }
}
