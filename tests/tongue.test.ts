import { describe, expect, it } from 'vitest';
import { detectVisibleTongue, type MouthLandmark, type PixelFrame } from '../src/shared/tongue';

function mouth(rotation = 0) {
  const transform = (x: number, y: number) => ({ x: (.5 + (x - .5) * Math.cos(rotation) - (y - .55) * Math.sin(rotation)), y: (.55 + (x - .5) * Math.sin(rotation) + (y - .55) * Math.cos(rotation)) });
  const landmarks: MouthLandmark[] = [];
  landmarks[78] = transform(.2, .55); landmarks[308] = transform(.8, .55);
  landmarks[13] = transform(.5, .35); landmarks[14] = transform(.5, .75);
  return landmarks;
}
function image(color: number[] | null = null, rotation = 0): PixelFrame {
  const data = new Uint8ClampedArray(100 * 100 * 4);
  for (let row = 0; row < 100; row++) for (let column = 0; column < 100; column++) {
    const horizontal = 50 + (column - 50) * Math.cos(rotation) + (row - 55) * Math.sin(rotation);
    const vertical = 55 - (column - 50) * Math.sin(rotation) + (row - 55) * Math.cos(rotation);
    const tongue = color && horizontal >= 38 && horizontal < 62 && vertical >= 53 && vertical < 72;
    data.set(tongue ? [...color, 255] : [25, 15, 20, 255], (row * 100 + column) * 4);
  }
  return { width: 100, height: 100, data };
}
describe('browser-local visible tongue detection', () => {
  it('detects a connected pink tongue inside an open mouth', () => {
    expect(detectVisibleTongue(image([215, 95, 120]), mouth())).toBeGreaterThan(.5);
  });
  it('follows rolled mouth landmarks', () => {
    for (const rotation of [-.4, .4]) expect(detectVisibleTongue(image([215, 95, 120], rotation), mouth(rotation))).toBeGreaterThan(.5);
  });
  it('does not substitute jaw opening, teeth, or warm skin for a tongue', () => {
    for (const color of [null, [230, 230, 225], [210, 140, 90]]) expect(detectVisibleTongue(image(color), mouth())).toBe(0);
  });
  it('ignores closed lips, lip-color frames and isolated pink pixels', () => {
    const landmarks = mouth(); landmarks[14] = { x: .5, y: .37 };
    expect(detectVisibleTongue(image([215, 95, 120]), landmarks)).toBe(0);
    const lips = image();
    for (let index = 0; index < lips.data.length; index += 4) lips.data.set([215, 95, 120, 255], index);
    expect(detectVisibleTongue(lips, mouth())).toBe(0);
    const fleck = image(); fleck.data.set([215, 95, 120, 255], (60 * 100 + 50) * 4);
    expect(detectVisibleTongue(fleck, mouth())).toBe(0);
  });
  it('ignores lipstick outside the inner mouth', () => {
    const lips = image();
    for (let row = 75; row < 85; row++) for (let column = 20; column < 80; column++) lips.data.set([215, 95, 120, 255], (row * 100 + column) * 4);
    expect(detectVisibleTongue(lips, mouth())).toBe(0);
  });
  it('returns neutral for missing, nonfinite, offscreen or invalid inputs', () => {
    expect(detectVisibleTongue(image(), [])).toBe(0);
    for (const coordinate of [NaN, Infinity, -.1, 1.1]) {
      const landmarks = mouth(); landmarks[13].x = coordinate;
      expect(detectVisibleTongue(image(), landmarks)).toBe(0);
    }
    expect(detectVisibleTongue({ width: 0, height: 100, data: image().data }, mouth())).toBe(0);
    expect(detectVisibleTongue({ width: 100, height: 100, data: new Uint8ClampedArray(2) }, mouth())).toBe(0);
  });
});
