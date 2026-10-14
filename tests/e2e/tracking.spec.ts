import { test, expect } from '@playwright/test';

test('the bundled tracking worker detects a tongue independently of jaw opening', async ({ page, context }) => {
  await context.route('**/mediapipe/vision_bundle.js', route => route.fulfill({
    contentType: 'application/javascript', body: `
      const landmarks = [];
      landmarks[78] = { x: .2, y: .55 }; landmarks[308] = { x: .8, y: .55 };
      landmarks[13] = { x: .5, y: .35 }; landmarks[14] = { x: .5, y: .75 };
      let frames = 0;
      self.Vision = {
        FilesetResolver: { forVisionTasks: async () => ({}) },
        FaceLandmarker: { createFromOptions: async () => ({
          detectForVideo: () => ({ faceLandmarks: [landmarks], faceBlendshapes: [{ categories: [{ categoryName: 'jawOpen', score: frames++ === 2 ? 0 : .5 }] }], facialTransformationMatrixes: [] }),
          close() {},
        }) },
      };
    `,
  }));
  await page.goto('/');
  const samples = await page.evaluate(async () => {
    const worker = new Worker('/tracking-worker.js');
    const receive = () => new Promise<{ type: string; tongue: number; coefficients: Record<string, number> }>((resolve, reject) => {
      worker.onmessage = event => event.data.type === 'error' ? reject(new Error(event.data.message)) : resolve(event.data);
      worker.onerror = event => reject(new Error(event.message));
    });
    try {
      const ready = receive(); worker.postMessage({ type: 'init' }); await ready;
      const samples = [];
      for (const visible of [false, true, true, false]) {
        const canvas = new OffscreenCanvas(100, 100), context = canvas.getContext('2d')!;
        context.fillStyle = 'rgb(25, 15, 20)'; context.fillRect(0, 0, 100, 100);
        if (visible) { context.fillStyle = 'rgb(215, 95, 120)'; context.fillRect(38, 53, 24, 19); }
        const frame = canvas.transferToImageBitmap();
        const sample = receive(); worker.postMessage({ type: 'frame', frame, timestamp: samples.length * 50 }, [frame]);
        samples.push(await sample);
      }
      return samples;
    } finally { worker.postMessage({ type: 'close' }); worker.terminate(); }
  });
  expect(samples.map(sample => sample.coefficients.jawOpen)).toEqual([.5, .5, 0, .5]);
  expect(samples[0].tongue).toBe(0); expect(samples[1].tongue).toBeGreaterThan(.5); expect(samples[2].tongue).toBeGreaterThan(.5); expect(samples[3].tongue).toBe(0);
});
