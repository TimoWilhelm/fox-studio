import { test, expect } from '@playwright/test';

test('deterministic facial poses render without WebGL errors or clipping', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/');
  const poses = [
    { name: 'sleep', pose: {} },
    { name: 'snooze', pose: {} },
    { name: 'neutral', pose: {} },
    { name: 'left-wink', pose: { blinkLeft: .65, browLeft: .5, gazeX: -.5 } },
    { name: 'right-wink', pose: { blinkRight: .65, browRight: .5, gazeX: .5 } },
    { name: 'smile', pose: { mouth: .75, smile: .9, smileLeft: .9, smileRight: .9, browLeft: .5, browRight: .5 } },
    { name: 'turn', pose: { yaw: .6, pitch: -.45, roll: .45, gazeX: -.6, squintRight: .7 } },
  ];
  await page.evaluate(async () => {
    const { FoxRenderer } = await import('/src/client/fox.ts');
    const canvas = document.createElement('canvas'); canvas.id = 'pose-output';
    canvas.style.cssText = 'position:fixed;inset:0;width:1280px;height:720px;z-index:100';
    document.body.append(canvas);
    (window as any).poseRenderer = new FoxRenderer(canvas);
    await (window as any).poseRenderer.ready;
  });
  for (const { name, pose } of poses) {
    await page.evaluate(async ({ pose, name }) => {
      const { neutralPose } = await import('/src/shared/expression.ts');
      const renderer = (window as any).poseRenderer;
      renderer.draw({ ...neutralPose(), ...pose }, 0, 'paper', !['sleep', 'snooze'].includes(name), name !== 'snooze');
      renderer.draw({ ...neutralPose(), ...pose }, 1700, 'paper', !['sleep', 'snooze'].includes(name), name !== 'snooze');
    }, { pose, name });
    if (name === 'left-wink' || name === 'right-wink') {
      const eyes = await page.evaluate(() => {
        const renderer = (window as any).poseRenderer;
        renderer.rig.root.updateMatrixWorld(true);
        return renderer.rig.eyeDetails.map((eye: any) => ({
          screenX: eye.eye.getWorldPosition(eye.eye.position.clone()).project(renderer.camera).x,
          closed: eye.lid.visible && !eye.eye.visible,
        }));
      });
      const closed = eyes.find((eye: { closed: boolean }) => eye.closed);
      expect(closed).toBeTruthy();
      expect(eyes.filter((eye: { closed: boolean }) => eye.closed)).toHaveLength(1);
      expect(closed.screenX * (name === 'left-wink' ? -1 : 1)).toBeGreaterThan(0);
    }
    await page.locator('#pose-output').screenshot({ path: `test-results/fox-pose-${name}.png` });
  }
  const resources = await page.evaluate(() => {
    const renderer = (window as any).poseRenderer;
    const before = { ...renderer.renderer.info.memory };
    const outlined = renderer.outlineMaterials.size;
    renderer.dispose();
    return { before, after: { ...renderer.renderer.info.memory }, outlined };
  });
  expect(resources.before.textures).toBeGreaterThan(0);
  expect(resources.outlined).toBeGreaterThan(0);
  expect(resources.after.textures).toBe(0);
  expect(resources.after.geometries).toBe(0);
  expect(errors).toEqual([]);
});
