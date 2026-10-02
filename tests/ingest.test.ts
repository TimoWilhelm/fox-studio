import { describe, expect, it, vi } from 'vitest';
import { OrderedIngest } from '../src/client/ingest';
const flush = () => new Promise(resolve => setImmediate(resolve));
describe('ordered WebM ingest', () => {
  it('serializes uploads without losing order', async () => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const sent: number[] = []; const send = vi.fn(async (blob: Blob) => { sent.push(blob.size); await gate; });
    const queue = new OrderedIngest(send, vi.fn());
    queue.enqueue(new Blob(['a'])); queue.enqueue(new Blob(['bb'])); queue.enqueue(new Blob(['ccc']));
    expect(send).toHaveBeenCalledTimes(1); release(); await flush(); expect(sent).toEqual([1, 2, 3]); expect(queue.bufferedBytes).toBe(0);
  });
  it('stops on overflow and oversize rather than dropping chunks', async () => {
    const fatal = vi.fn(); const send = vi.fn(() => new Promise<void>(() => {}));
    const queue = new OrderedIngest(send, fatal, 3); queue.enqueue(new Blob(['aa'])); queue.enqueue(new Blob(['bb'])); queue.enqueue(new Blob(['c']));
    expect(fatal).toHaveBeenCalledTimes(1); expect(send).toHaveBeenCalledTimes(1); expect(queue.bufferedBytes).toBe(0);
    const oversized = new OrderedIngest(send, fatal); oversized.enqueue(new Blob([new Uint8Array(1024 * 1024 + 1)])); expect(fatal).toHaveBeenCalledTimes(2);
  });
  it('aborts a failed stream, never retries a broken WebM sequence', async () => {
    const fatal = vi.fn(); const send = vi.fn(async () => { throw new Error('Network lost'); });
    const queue = new OrderedIngest(send, fatal); queue.enqueue(new Blob(['a'])); queue.enqueue(new Blob(['b'])); await flush();
    expect(send).toHaveBeenCalledTimes(1); expect(fatal).toHaveBeenCalledTimes(1); queue.close(); expect(queue.bufferedBytes).toBe(0);
  });
});
