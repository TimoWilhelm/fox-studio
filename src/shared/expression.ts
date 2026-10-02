export interface Pose {
  blinkLeft: number; blinkRight: number; squintLeft: number; squintRight: number;
  gazeX: number; gazeY: number; mouth: number;
  smile: number; smileLeft: number; smileRight: number;
  brow: number; browLeft: number; browRight: number;
  yaw: number; pitch: number; roll: number;
}
export const neutralPose = (): Pose => ({
  blinkLeft: 0, blinkRight: 0, squintLeft: 0, squintRight: 0, gazeX: 0, gazeY: 0,
  mouth: 0, smile: 0, smileLeft: 0, smileRight: 0, brow: 0, browLeft: 0, browRight: 0,
  yaw: 0, pitch: 0, roll: 0,
});
export interface FaceSample { coefficients: Record<string, number>; matrix: number[]; timestamp: number; found: boolean }
export const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, Number.isFinite(value) ? value : 0));

export function mapFace(sample: FaceSample): Pose {
  // Clamp each coefficient before combining it, so one bad channel cannot poison another.
  const c = (name: string) => clamp(sample.coefficients[name] ?? 0);
  const m = sample.matrix;
  const validMatrix = m.length === 16 && m.every(Number.isFinite);
  const yaw = validMatrix ? Math.atan2(m[8], m[10]) : 0;
  const pitch = validMatrix ? Math.atan2(-m[9], Math.hypot(m[8], m[10])) : 0;
  const roll = validMatrix ? Math.atan2(m[1], m[0]) : 0;
  const smileLeft = clamp(c('mouthSmileLeft') * 1.5);
  const smileRight = clamp(c('mouthSmileRight') * 1.5);
  const brow = c('browInnerUp');
  return {
    blinkLeft: clamp(c('eyeBlinkLeft') * 1.3),
    blinkRight: clamp(c('eyeBlinkRight') * 1.3),
    squintLeft: c('eyeSquintLeft'), squintRight: c('eyeSquintRight'),
    gazeX: clamp((c('eyeLookInLeft') - c('eyeLookOutLeft') + c('eyeLookOutRight') - c('eyeLookInRight')) / 2, -1, 1),
    gazeY: clamp((c('eyeLookUpLeft') + c('eyeLookUpRight') - c('eyeLookDownLeft') - c('eyeLookDownRight')) / 2, -1, 1),
    mouth: clamp(c('jawOpen') * 1.7),
    smile: clamp((c('mouthSmileLeft') + c('mouthSmileRight')) / 2 * 1.5), smileLeft, smileRight,
    brow,
    browLeft: clamp(brow * .65 + c('browOuterUpLeft') * .7 - c('browDownLeft') * .7, -1, 1),
    browRight: clamp(brow * .65 + c('browOuterUpRight') * .7 - c('browDownRight') * .7, -1, 1),
    yaw: clamp(yaw, -.6, .6), pitch: clamp(pitch, -.45, .45), roll: clamp(roll, -.45, .45),
  };
}

export class PoseSmoother {
  private current = neutralPose();
  private target = neutralPose();
  private lastSample = -Infinity;
  private lastTick: number | null = null;
  private center = { yaw: 0, pitch: 0, roll: 0 };
  private lastRaw = neutralPose();
  update(sample: FaceSample) {
    if (!sample.found || !Number.isFinite(sample.timestamp)) { this.lastSample = -Infinity; return; }
    this.lastSample = sample.timestamp;
    this.lastRaw = mapFace(sample);
    this.target = { ...this.lastRaw, yaw: clamp(this.lastRaw.yaw - this.center.yaw, -.6, .6), pitch: clamp(this.lastRaw.pitch - this.center.pitch, -.45, .45), roll: clamp(this.lastRaw.roll - this.center.roll, -.45, .45) };
  }
  recenter() { this.center = { yaw: this.lastRaw.yaw, pitch: this.lastRaw.pitch, roll: this.lastRaw.roll }; }
  tick(now: number): Pose {
    const dt = this.lastTick === null ? 1000 / 30 : Math.max(0, now - this.lastTick);
    this.lastTick = now;
    const found = this.tracked(now);
    const target = found ? this.target : neutralPose();
    for (const key of Object.keys(target) as (keyof Pose)[]) {
      const speed = key.startsWith('blink') ? 35 : found ? 14 : 6;
      this.current[key] += (target[key] - this.current[key]) * (1 - Math.exp(-speed * dt / 1000));
    }
    return { ...this.current };
  }
  tracked(now: number) { return now >= this.lastSample && now - this.lastSample < 650; }
  reset() { this.current = neutralPose(); this.target = neutralPose(); this.lastRaw = neutralPose(); this.center = { yaw: 0, pitch: 0, roll: 0 }; this.lastSample = -Infinity; this.lastTick = null; }
}
