import { clamp, neutralPose, type Pose } from './expression';

export type AvatarState = 'asleep' | 'waking' | 'awake' | 'sleeping';
export interface AvatarFrame extends Pose {
  torsoYaw: number; torsoPitch: number; torsoRoll: number;
  earDrop: number; breath: number;
}
export const torsoLimits = { yaw: 8 * Math.PI / 180, roll: 6 * Math.PI / 180, pitch: 4 * Math.PI / 180 };

function sleepingFrame(now: number, reducedMotion: boolean): AvatarFrame {
  const breath = reducedMotion ? 0 : Math.sin(now / 1000 * 1.65) * .012;
  return {
    ...neutralPose(), blinkLeft: 1, blinkRight: 1, browLeft: -.14, browRight: -.14,
    pitch: .13, roll: -.045, yaw: .02,
    torsoYaw: 0, torsoPitch: .025, torsoRoll: -.01, earDrop: 1, breath,
  };
}

/** One controller owns the complete rendered pose, including interrupted sleep/wake blends. */
export class AvatarAnimator {
  private current: AvatarFrame = sleepingFrame(0, false);
  private from = { ...this.current };
  private awake = false;
  private reducedMotion = false;
  private transitionStart = -Infinity;
  private lastTick: number | null = null;
  private torso = { yaw: 0, pitch: 0, roll: 0 };
  state: AvatarState = 'asleep';

  tick(pose: Pose, now: number, connected: boolean, reducedMotion: boolean): AvatarFrame {
    const dt = this.lastTick === null ? 1000 / 30 : Math.max(0, now - this.lastTick);
    this.lastTick = now;
    const follow = 1 - Math.exp(-dt / 120);
    for (const key of ['yaw', 'pitch', 'roll'] as const) {
      const target = clamp(pose[key] * (key === 'yaw' ? .28 : .25), -torsoLimits[key], torsoLimits[key]);
      this.torso[key] += (target - this.torso[key]) * follow;
    }
    if (connected !== this.awake || reducedMotion !== this.reducedMotion) {
      this.from = { ...this.current };
      this.transitionStart = now;
      this.awake = connected;
      this.reducedMotion = reducedMotion;
    }
    const target: AvatarFrame = this.awake ? {
      ...pose, torsoYaw: this.torso.yaw, torsoPitch: this.torso.pitch, torsoRoll: this.torso.roll,
      earDrop: 0, breath: 0,
    } : sleepingFrame(now, reducedMotion);
    const progress = Number.isFinite(this.transitionStart) ? clamp((now - this.transitionStart) / (reducedMotion ? 150 : 400)) : 1;
    const blend = progress * progress * (3 - 2 * progress);
    for (const key of Object.keys(target) as (keyof AvatarFrame)[]) {
      this.current[key] = this.from[key] + (target[key] - this.from[key]) * blend;
    }
    this.state = progress < 1 ? (this.awake ? 'waking' : 'sleeping') : (this.awake ? 'awake' : 'asleep');
    return { ...this.current };
  }
}
