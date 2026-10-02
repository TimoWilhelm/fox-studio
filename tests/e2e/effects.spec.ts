import { test, expect, type Page } from '@playwright/test';

test.beforeEach(({ page }) => { page.setDefaultTimeout(20_000); });
test.afterEach(async ({ page }) => {
  const stop = page.getByRole('button', { name: /^(Stop|Cancel)$/ });
  if (await stop.isVisible()) {
    await stop.click();
    await expect(page.getByRole('status')).toHaveText('Not connected');
  }
});

async function pixels(page: Page, source: 'video' | 'canvas', region: number[]) {
  return page.evaluate(({ source, region }) => {
    const input = document.querySelector(source === 'video' ? '.return-stage video' : '.canvas-stage canvas') as HTMLVideoElement | HTMLCanvasElement;
    const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64;
    const ctx = canvas.getContext('2d')!;
    const [x, y, w, h] = region;
    ctx.drawImage(input, x, y, w, h, 0, 0, 64, 64);
    const data = ctx.getImageData(0, 0, 64, 64).data;
    let difference = 0, white = 0, brightness = 0;
    for (let i = 0; i < data.length; i += 4) {
      difference += Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]);
      if (Math.min(data[i], data[i + 1], data[i + 2]) > 220) white++;
      brightness += (data[i] + data[i + 1] + data[i + 2]) / 3;
    }
    return { chroma: difference / (64 * 64), whiteFraction: white / (64 * 64), brightness: brightness / (64 * 64) };
  }, { source, region });
}
async function chroma(page: Page, source: 'video' | 'canvas', region: number[]) { return (await pixels(page, source, region)).chroma; }
async function expectLive(page: Page) {
  await expect.poll(async () => {
    if (await page.getByRole('alert').isVisible()) throw new Error(await page.getByRole('alert').innerText());
    return (await page.getByRole('status').innerText()).includes('Connected');
  }, { timeout: 60_000 }).toBe(true);
}

test('remote filters, logo and live annotations appear in decoded video without changing the fox canvas', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Night', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Hearts', exact: true })).toBeDisabled();
  await page.getByLabel('Look', { exact: true }).selectOption('mono');
  await page.getByLabel('Streamline logo', { exact: true }).check();
  await page.getByText('Pipeline', { exact: true }).click();
  await expect(page.locator('.pipeline-code pre')).toContainText('"saturation"');
  const startRequest = page.waitForRequest(request => new URL(request.url()).pathname === '/start');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  const startBody = (await startRequest).postDataJSON();
  expect(startBody.pipeline.map((op: { op: string }) => op.op)).toEqual(['filter', 'overlay', 'encode']);
  await expectLive(page);
  await expect(page.getByLabel('Look', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('Streamline logo', { exact: true })).toBeDisabled();
  const face = [350, 200, 500, 450];
  await expect.poll(() => chroma(page, 'video', face)).toBeLessThan(4);
  expect(await chroma(page, 'canvas', face)).toBeGreaterThan(12);
  // The small bottom-right watermark remains readable on every backdrop, including monochrome output.
  const logo = [1078, 652, 180, 45];
  const localWhite = (await pixels(page, 'canvas', logo)).whiteFraction;
  await expect.poll(async () => (await pixels(page, 'video', logo)).whiteFraction).toBeGreaterThan(localWhite + .03);
  const corner = [100, 120, 100, 100];
  const localCorner = await chroma(page, 'canvas', corner);
  await expect.poll(() => chroma(page, 'video', corner)).toBeLessThan(4);
  for (const name of ['Hearts', 'Sparkles']) {
    const upload = page.waitForResponse(response => new URL(response.url()).pathname === '/api/annotation');
    await page.getByRole('button', { name, exact: true }).click();
    const response = await upload;
    expect(response.request().method()).toBe('PUT');
    expect(response.request().headers()['content-type']).toBe('image/png');
    expect(response.ok()).toBe(true);
    await expect(page.getByRole('button', { name, exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => chroma(page, 'video', corner), { timeout: 15_000 }).toBeGreaterThan(12);
    expect(await chroma(page, 'canvas', corner)).toBeCloseTo(localCorner, 1);
    if (name === 'Hearts') await page.screenshot({ path: 'test-results/remote-effects-hearts.png' });
    await page.getByRole('button', { name: 'Clear reaction', exact: true }).click();
    await expect.poll(() => chroma(page, 'video', corner), { timeout: 15_000 }).toBeLessThan(4);
    await expect.poll(async () => (await pixels(page, 'video', logo)).whiteFraction).toBeGreaterThan(.03);
  }
  for (const background of ['Paper', 'Night', 'Peach', 'Night', 'Sage', 'Night']) {
    const previous = (await pixels(page, 'video', [10, 10, 30, 30])).brightness;
    await page.getByRole('button', { name: background, exact: true }).click();
    await expect.poll(async () => Math.abs((await pixels(page, 'video', [10, 10, 30, 30])).brightness - previous), { timeout: 15_000 }).toBeGreaterThan(50);
    await expect.poll(async () => (await pixels(page, 'video', logo)).whiteFraction).toBeGreaterThan(.03);
    await page.screenshot({ path: `test-results/watermark-${background.toLowerCase()}.png` });
  }
  await page.screenshot({ path: 'test-results/remote-effects.png' });
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Not connected');
  await expect(page.getByLabel('Look', { exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Clear reaction', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('effect controls fit narrow screens and a stopped upload cannot change the next session', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const effects = page.getByRole('region', { name: 'Remote effects' });
  await expect(effects).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.getByLabel('Look', { exact: true }).selectOption('soft');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expectLive(page);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/annotation', async route => { await held; await route.continue().catch(() => {}); });
  const pending = page.waitForRequest('**/api/annotation');
  await page.getByRole('button', { name: 'Hearts', exact: true }).click();
  await pending;
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Not connected');
  release();
  await page.unroute('**/api/annotation');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByLabel('Look', { exact: true }).selectOption('vivid');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expectLive(page);
  await expect(page.getByRole('button', { name: 'Clear reaction', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Not connected');
});
