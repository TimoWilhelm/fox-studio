import { describe, expect, it } from 'vitest';
import { AvatarAnimator, torsoLimits } from '../src/shared/animation';
import { neutralPose, PoseSmoother } from '../src/shared/expression';

describe('sleep/wake controller', () => {
  it('starts asleep, remains asleep in startup, and wakes into the current tracking pose', () => {
    const animator = new AvatarAnimator();
    const tracked = { ...neutralPose(), mouth: .8, blinkLeft: .3, gazeX: .7 };
    expect(animator.tick(tracked, 0, false, false).blinkLeft).toBe(1);
    expect(animator.tick(tracked, 1000, false, false).mouth).toBe(0);
    expect(animator.state).toBe('asleep');
    animator.tick(tracked, 1100, true, false);
    expect(animator.state).toBe('waking');
    const halfway = animator.tick(tracked, 1300, true, false);
    expect(halfway.mouth).toBeCloseTo(.4);
    expect(halfway.blinkLeft).toBeCloseTo(.65);
    const awake = animator.tick({ ...tracked, mouth: .6 }, 1500, true, false);
    expect(awake.mouth).toBe(.6); expect(awake.gazeX).toBe(.7);
    expect(animator.state).toBe('awake');
  });
  it('reverses from the entire current rendered pose without snapping or restarting from an endpoint', () => {
    const animator = new AvatarAnimator();
    const pose = { ...neutralPose(), yaw: .6, roll: .4, mouth: 1 };
    animator.tick(pose, 0, true, false);
    const waking = animator.tick(pose, 180, true, false);
    expect(animator.tick(neutralPose(), 180, false, false)).toEqual(waking);
    expect(animator.state).toBe('sleeping');
    const sleeping = animator.tick(neutralPose(), 260, false, false);
    expect(sleeping.mouth).toBeLessThan(waking.mouth);
    expect(animator.tick(pose, 260, true, false)).toEqual(sleeping);
    animator.tick(pose, 660, true, false); expect(animator.state).toBe('awake');
    const awake = animator.tick(pose, 700, true, false);
    expect(animator.tick(neutralPose(), 700, false, false)).toEqual(awake);
    const asleep = animator.tick(neutralPose(), 1100, false, false);
    expect(asleep.blinkRight).toBe(1); expect(asleep.mouth).toBe(0); expect(asleep.earDrop).toBe(1);
  });
  it('follows the head with a 120 ms time constant and bounds torso motion', () => {
    const animator = new AvatarAnimator();
    animator.tick(neutralPose(), 0, true, false);
    animator.tick(neutralPose(), 400, true, false);
    const pose = { ...neutralPose(), yaw: .6, roll: .45, pitch: .45 };
    const first = animator.tick(pose, 520, true, false);
    expect(first.torsoYaw).toBeCloseTo(torsoLimits.yaw * (1 - Math.exp(-1)));
    for (let t = 540; t < 3000; t += 20) {
      const result = animator.tick(pose, t, true, false);
      expect(Math.abs(result.torsoYaw)).toBeLessThanOrEqual(torsoLimits.yaw);
      expect(Math.abs(result.torsoPitch)).toBeLessThanOrEqual(torsoLimits.pitch);
      expect(Math.abs(result.torsoRoll)).toBeLessThanOrEqual(torsoLimits.roll);
    }
  });
  it('keeps face loss neutral and awake while connected', () => {
    const animator = new AvatarAnimator(), smoother = new PoseSmoother();
    smoother.update({ found: true, timestamp: 0, matrix: [], coefficients: { jawOpen: .8 } });
    for (let t = 0; t <= 3000; t += 30) animator.tick(smoother.tick(t), t, true, false);
    const result = animator.tick(smoother.tick(3030), 3030, true, false);
    expect(animator.state).toBe('awake'); expect(result.mouth).toBeLessThan(.001);
    expect(result.blinkLeft).toBe(0); expect(result.earDrop).toBe(0);
  });
  it('removes decorative breathing and completes reduced-motion transitions in 150 ms', () => {
    const animator = new AvatarAnimator();
    for (let t = 0; t < 1000; t += 25) expect(animator.tick(neutralPose(), t, false, true).breath).toBe(0);
    animator.tick(neutralPose(), 1000, true, true);
    animator.tick(neutralPose(), 1150, true, true); expect(animator.state).toBe('awake');
    const result = animator.tick({ ...neutralPose(), mouth: .9, blinkLeft: .7 }, 1200, true, true);
    expect(result.mouth).toBe(.9); expect(result.blinkLeft).toBe(.7);
    animator.tick(neutralPose(), 1200, false, true);
    animator.tick(neutralPose(), 1350, false, true); expect(animator.state).toBe('asleep');
  });
});
