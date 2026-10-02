import { describe, expect, it } from 'vitest';
import { mapFace, neutralPose, PoseSmoother, type FaceSample } from '../src/shared/expression';
const face = (coefficients = {}, timestamp = 100): FaceSample => ({ coefficients, timestamp, matrix: [], found: true });
describe('fox expression mapping', () => {
  it('maps blinking, mouth, smile and brows with safe bounds', () => {
    const pose = mapFace(face({ eyeBlinkLeft: .8, eyeBlinkRight: .1, jawOpen: .5, mouthSmileLeft: .4, mouthSmileRight: .8, browInnerUp: .7 }));
    expect(pose.blinkLeft).toBe(1); expect(pose.blinkRight).toBeCloseTo(.13); expect(pose.mouth).toBeCloseTo(.85); expect(pose.smile).toBeCloseTo(.9);
    expect(mapFace(face({ jawOpen: NaN })).mouth).toBe(0);
  });
  it('maps gaze, squint and asymmetric brows and smiles independently', () => {
    const pose = mapFace(face({ eyeLookInLeft: .6, eyeLookOutRight: .4, eyeLookUpLeft: .5, eyeLookDownRight: .3, eyeSquintRight: .8, browOuterUpLeft: .9, browDownRight: .6, mouthSmileLeft: .6 }));
    expect(pose.gazeX).toBeCloseTo(.5); expect(pose.gazeY).toBeCloseTo(.1);
    expect(pose.squintRight).toBe(.8); expect(pose.squintLeft).toBe(0);
    expect(pose.browLeft).toBeGreaterThan(0); expect(pose.browRight).toBeLessThan(0);
    expect(pose.smileLeft).toBeCloseTo(.9); expect(pose.smileRight).toBe(0);
  });
  it('handles absent, negative, nonfinite coefficients and invalid matrices safely', () => {
    expect(mapFace(face())).toEqual(neutralPose());
    const pose = mapFace({ ...face({ eyeBlinkLeft: Infinity, mouthSmileLeft: NaN, mouthSmileRight: .6, eyeSquintLeft: -3, eyeLookUpLeft: 10 }), matrix: new Array(16).fill(NaN) });
    expect(Object.values(pose).every(Number.isFinite)).toBe(true);
    expect(pose.blinkLeft).toBe(0); expect(pose.smileRight).toBeCloseTo(.9);
    expect(pose.squintLeft).toBe(0); expect(pose.gazeY).toBe(.5); expect(pose.yaw).toBe(0);
  });
  it('smooths by elapsed time rather than the number of frames', () => {
    const tickAt = (interval: number) => {
      const smoother = new PoseSmoother(); smoother.update(face({ jawOpen: .5, eyeBlinkLeft: .6 }, 0));
      smoother.tick(0);
      for (let t = interval; t <= 300; t += interval) smoother.tick(t);
      return smoother.tick(300);
    };
    expect(tickAt(10).mouth).toBeCloseTo(tickAt(30).mouth, 10);
    expect(tickAt(10).blinkLeft).toBeCloseTo(tickAt(30).blinkLeft, 10);
  });
  it('smooths motion, responds rapidly to blinks and settles after face loss', () => {
    const smooth = new PoseSmoother(); smooth.update(face({ jawOpen: .6, eyeBlinkLeft: .8 }));
    const first = smooth.tick(100); expect(first.mouth).toBeGreaterThan(0); expect(first.mouth).toBeLessThan(1); expect(first.blinkLeft).toBeGreaterThan(first.mouth);
    smooth.update({ ...face({}, 150), found: false });
    for (let t = 200; t <= 2000; t += 50) smooth.tick(t);
    expect(smooth.tick(2050).mouth).toBeLessThan(.001); expect(smooth.tracked(2050)).toBe(false);
  });
  it('recenters head motion and resets between cameras', () => {
    const smooth = new PoseSmoother(); const sample = { ...face(), matrix: [1, .2, 0, 0, 0, 1, 0, 0, .3, 0, 1, 0, 0, 0, 0, 1] };
    smooth.update(sample); expect(smooth.tick(100).yaw).toBeGreaterThan(0); smooth.recenter(); smooth.update({ ...sample, timestamp: 200 });
    for (let t = 200; t <= 600; t += 20) smooth.tick(t);
    expect(smooth.tick(620).yaw).toBeLessThan(.002); smooth.reset(); expect(smooth.tick(630).yaw).toBe(0);
  });
});
