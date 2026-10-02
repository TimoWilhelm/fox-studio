import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('cloudflare:workers', () => ({ DurableObject: class { constructor(public ctx: DurableObjectState, public env: Env) {} } }));
import { SessionAdmission } from '../src/server/admission';
let database: DatabaseSync, admission: SessionAdmission, ctx: DurableObjectState;
const abortSession = vi.fn();
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-02T20:00:00Z'));
  database = new DatabaseSync(':memory:');
  ctx = { storage: { sql: { exec(sql: string, ...bindings: Array<string | number>) {
    const rows = sql.startsWith('CREATE') ? (database.exec(sql), []) : database.prepare(sql).all(...bindings);
    return { toArray: () => rows, one: () => { if (rows.length !== 1) throw new Error('Expected one row'); return rows[0]; } };
  } }, setAlarm: vi.fn(async () => {}), deleteAlarm: vi.fn(async () => {}) }, exports: { MediaContainer: { getByName: vi.fn(() => ({ abortSession })) } } } as unknown as DurableObjectState;
  admission = new SessionAdmission(ctx, {} as Env);
  abortSession.mockReset().mockImplementation(async instance => { await admission.release(instance); });
});
afterEach(() => { database.close(); vi.useRealTimers(); });
describe('Encoder admission with persistent SQLite state', () => {
  it('reserves one encoder atomically and only releases the matching visitor', async () => {
    expect(await admission.acquire('alice')).toBe(true);
    expect(await admission.acquire('bob')).toBe(false);
    await admission.release('bob');
    expect(await admission.acquire('bob')).toBe(false);
    await admission.release('alice');
    expect(await admission.acquire('bob')).toBe(true);
  });
  it('retains isolation and capacity across object reconstruction', async () => {
    await admission.acquire('alice');
    admission = new SessionAdmission(ctx, {} as Env);
    expect(await admission.acquire('bob')).toBe(false);
    expect(await admission.commit('bob')).toBe(false);
    expect(await admission.commit('alice')).toBe(true);
  });
  it('cleans abandoned preparation before handing the slot to a different visitor', async () => {
    await admission.acquire('alice');
    vi.setSystemTime(Date.now() + 121_000);
    expect(await admission.commit('alice')).toBe(false);
    expect(await admission.acquire('bob')).toBe(false);
    await admission.alarm();
    expect(abortSession).toHaveBeenCalledWith('alice');
    expect(await admission.acquire('bob')).toBe(true);
  });
  it('holds capacity during cleanup failure and retries instead of overlapping encoders', async () => {
    await admission.acquire('alice');
    vi.setSystemTime(Date.now() + 121_000);
    abortSession.mockRejectedValueOnce(new Error('Temporary stop failure'));
    await admission.alarm();
    expect(await admission.acquire('bob')).toBe(false);
    expect(ctx.storage.setAlarm).toHaveBeenLastCalledWith(Date.now() + 60_000);
    vi.setSystemTime(Date.now() + 61_000); await admission.alarm();
    expect(await admission.acquire('bob')).toBe(true);
  });
  it('bounds verification attempts and expires stored buckets', async () => {
    for (let i = 0; i < 10; i++) expect(await admission.checkVerification('ip-hash')).toBe(true);
    expect(await admission.checkVerification('ip-hash')).toBe(false);
    expect(await admission.checkVerification('other-hash')).toBe(true);
    vi.setSystemTime(Date.now() + 601_000); await admission.alarm();
    expect(database.prepare('SELECT COUNT(*) AS count FROM verification_limits').get()?.count).toBe(0);
    expect(await admission.checkVerification('ip-hash')).toBe(true);
  });
});
