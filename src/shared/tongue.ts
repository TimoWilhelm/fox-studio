import { clamp } from './expression';

export interface MouthLandmark { x: number; y: number }
export interface PixelFrame { width: number; height: number; data: Uint8ClampedArray }

export function detectVisibleTongue(frame: PixelFrame, landmarks: readonly MouthLandmark[]): number {
  const points = [landmarks[78], landmarks[308], landmarks[13], landmarks[14]];
  if (points.some(point => !point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1)) return 0;
  if (!Number.isInteger(frame.width) || !Number.isInteger(frame.height) || frame.width < 1 || frame.height < 1 || frame.data.length !== frame.width * frame.height * 4) return 0;
  const [left, right, upper, lower] = points.map(point => ({ x: point.x * frame.width, y: point.y * frame.height }));
  const mouthWidth = Math.hypot(right.x - left.x, right.y - left.y);
  if (mouthWidth < 12) return 0;
  const axis = { x: (right.x - left.x) / mouthWidth, y: (right.y - left.y) / mouthWidth };
  const vertical = { x: -axis.y, y: axis.x };
  const mouthHeight = (lower.x - upper.x) * vertical.x + (lower.y - upper.y) * vertical.y;
  if (mouthHeight < 3 || mouthHeight / mouthWidth < .08 || mouthHeight / mouthWidth > 1.2) return 0;
  const columns = 24, rows = 16;
  const mask = new Uint8Array(columns * rows), visited = new Uint8Array(mask.length);
  const brightness = new Float32Array(mask.length);
  let valid = 0, dark = 0, darkBrightness = 0;
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const horizontal = ((column + .5) / columns - .5) * .65;
      const height = .15 + (row + .5) / rows * .7;
      if ((horizontal / .36) ** 2 + ((height - .5) / .43) ** 2 > 1) continue;
      const pixelX = Math.floor(upper.x + axis.x * horizontal * mouthWidth + vertical.x * height * mouthHeight);
      const pixelY = Math.floor(upper.y + axis.y * horizontal * mouthWidth + vertical.y * height * mouthHeight);
      if (pixelX < 0 || pixelX >= frame.width || pixelY < 0 || pixelY >= frame.height) continue;
      const offset = (pixelY * frame.width + pixelX) * 4;
      const [red, green, blue, alpha] = frame.data.subarray(offset, offset + 4);
      if (alpha < 128) continue;
      const index = row * columns + column;
      const luminance = (red + green + blue) / 3;
      brightness[index] = luminance;
      valid++;
      if (red > 75 && green > 25 && blue > 20 && red > green * 1.3 && red > blue * 1.18 && blue > green * .8) mask[index] = 1;
      else if (luminance < 95) { dark++; darkBrightness += luminance; }
    }
  }
  if (valid < 100 || dark < valid * .12) return 0;
  let best = 0;
  for (let index = 0; index < mask.length; index++) {
    if (!mask[index] || visited[index]) continue;
    const queue = [index]; visited[index] = 1;
    let columnSum = 0, rowSum = 0, totalBrightness = 0;
    let minColumn = columns, maxColumn = 0, minRow = rows, maxRow = 0;
    for (let position = 0; position < queue.length; position++) {
      const current = queue[position], column = current % columns, row = Math.floor(current / columns);
      columnSum += column; rowSum += row; totalBrightness += brightness[current];
      minColumn = Math.min(minColumn, column); maxColumn = Math.max(maxColumn, column);
      minRow = Math.min(minRow, row); maxRow = Math.max(maxRow, row);
      const neighbors = [column > 0 ? current - 1 : -1, column < columns - 1 ? current + 1 : -1, row > 0 ? current - columns : -1, row < rows - 1 ? current + columns : -1];
      for (const neighbor of neighbors) {
        if (neighbor >= 0 && mask[neighbor] && !visited[neighbor]) { visited[neighbor] = 1; queue.push(neighbor); }
      }
    }
    const area = queue.length / valid;
    const centerColumn = (columnSum / queue.length + .5) / columns;
    const centerRow = (rowSum / queue.length + .5) / rows;
    if (area < .12 || centerColumn < .25 || centerColumn > .75 || centerRow < .4 || (maxColumn - minColumn + 1) / columns < .25 || (maxRow - minRow + 1) / rows < .2) continue;
    const contrast = totalBrightness / queue.length - darkBrightness / dark;
    best = Math.max(best, clamp((area - .1) / .45) * clamp((contrast - 12) / 45));
  }
  return best;
}
