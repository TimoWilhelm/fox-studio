import { DurableObject } from 'cloudflare:workers';
import { MAX_SESSION_SECONDS } from '../shared/pipeline';

export const ADMISSION_INSTANCE = 'fox-studio-admission-v1';
const PREPARE_MS = 120_000;
const RUN_MS = (MAX_SESSION_SECONDS + 420) * 1000;
const RATE_MS = 600_000;
type Lease = { instance: string; expires_at: number };

// Coordinates the small, fixed encoder budget. Video and relay traffic go directly to each visitor's MediaContainer.
export class SessionAdmission extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS leases (instance TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS verification_limits (bucket TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires_at INTEGER NOT NULL)`);
  }
  async checkVerification(bucket: string): Promise<boolean> {
    const now = Date.now(), sql = this.ctx.storage.sql;
    sql.exec('DELETE FROM verification_limits WHERE expires_at <= ?', now);
    const rows = sql.exec<{ attempts: number }>('SELECT attempts FROM verification_limits WHERE bucket = ?', bucket).toArray();
    if ((rows[0]?.attempts ?? 0) >= 10) return false;
    if (!rows.length && sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM verification_limits').one().count >= 5000) return false;
    sql.exec('INSERT INTO verification_limits (bucket, attempts, expires_at) VALUES (?, 1, ?) ON CONFLICT(bucket) DO UPDATE SET attempts = attempts + 1', bucket, now + RATE_MS);
    await this.scheduleNext();
    return true;
  }
  async acquire(instance: string): Promise<boolean> {
    const sql = this.ctx.storage.sql;
    if (sql.exec('SELECT instance FROM leases').toArray().length) return false;
    sql.exec('INSERT INTO leases (instance, expires_at) VALUES (?, ?)', instance, Date.now() + PREPARE_MS);
    await this.scheduleNext();
    return true;
  }
  async commit(instance: string): Promise<boolean> {
    const sql = this.ctx.storage.sql;
    const lease = sql.exec<Lease>('SELECT instance, expires_at FROM leases WHERE instance = ?', instance).toArray()[0];
    if (!lease || lease.expires_at <= Date.now()) return false;
    sql.exec('UPDATE leases SET expires_at = ? WHERE instance = ?', Date.now() + RUN_MS, instance);
    await this.scheduleNext();
    return true;
  }
  async release(instance: string): Promise<void> {
    this.ctx.storage.sql.exec('DELETE FROM leases WHERE instance = ?', instance);
    await this.scheduleNext();
  }
  async alarm(): Promise<void> {
    const sql = this.ctx.storage.sql;
    sql.exec('DELETE FROM verification_limits WHERE expires_at <= ?', Date.now());
    const expired = sql.exec<Lease>('SELECT instance, expires_at FROM leases WHERE expires_at <= ?', Date.now()).toArray();
    for (const lease of expired) {
      try {
        // Capacity stays reserved until the encoder has actually stopped.
        await this.ctx.exports.MediaContainer.getByName(lease.instance).abortSession(lease.instance);
      } catch {
        sql.exec('UPDATE leases SET expires_at = ? WHERE instance = ?', Date.now() + 60_000, lease.instance);
      }
    }
    await this.scheduleNext();
  }
  private async scheduleNext() {
    const next = this.ctx.storage.sql.exec<{ deadline: number | null }>('SELECT MIN(expires_at) AS deadline FROM (SELECT expires_at FROM leases UNION ALL SELECT expires_at FROM verification_limits)').one().deadline;
    if (next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, next));
  }
}
