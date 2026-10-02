import { test, expect, type Page } from '@playwright/test';
async function expectLive(page: Page) {
  await expect.poll(async () => {
    if (await page.getByRole('alert').isVisible()) throw new Error(await page.getByRole('alert').innerText());
    return (await page.getByRole('status').innerText()).includes('Connected');
  }, { timeout: 60_000 }).toBe(true);
}
test('deterministic fox canvas returns H.264 video and supports repeat Start/Stop', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Fox Studio' })).toBeVisible();
  await expect(page.getByLabel('Sleeping fox')).toBeVisible();
  const canvas = page.getByLabel('3D fox avatar');
  expect(await canvas.evaluate((c: HTMLCanvasElement) => c.getContext('webgl2') instanceof WebGL2RenderingContext)).toBe(true);
  const frame = await canvas.evaluate((c: HTMLCanvasElement) => c.toDataURL());
  await expect.poll(() => canvas.evaluate((c: HTMLCanvasElement) => c.toDataURL())).not.toBe(frame);
  for (let run = 0; run < 2; run++) {
    await page.getByRole('button', { name: 'Start' }).click();
    await expectLive(page);
    await expect(canvas).toHaveAttribute('data-avatar-state', 'awake');
    await page.screenshot({ path: 'test-results/fox-studio-connected.png' });
    await expect(page.getByLabel('Sleeping fox')).toBeHidden();
    const video = page.getByLabel('Actual Streamline encoded return feed');
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: 30_000 }).toBe(1280);
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.getVideoPlaybackQuality().totalVideoFrames), { timeout: 30_000 }).toBeGreaterThan(5);
    await page.getByRole('button', { name: 'Stop' }).click();
    await expect(page.getByRole('status')).toContainText('Not connected');
    await expect(canvas).toHaveAttribute('data-avatar-state', 'asleep');
    expect(await page.locator('.camera-input').evaluate((v: HTMLVideoElement) => v.srcObject)).toBeNull();
    expect(await video.getAttribute('src')).toBeNull();
    await expect(page.getByLabel('Sleeping fox')).toBeVisible();
  }
});
test('failed ingest releases the camera and a fresh session recovers', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start' }).click();
  await expectLive(page);
  await expect(page.getByLabel('3D fox avatar')).toHaveAttribute('data-avatar-state', 'awake');
  await page.route('**/ingest', route => route.fulfill({ status: 502, body: 'Simulated connection failure' }));
  await expect(page.getByRole('alert')).toContainText('Video upload failed', { timeout: 60_000 });
  await expect(page.getByRole('status')).toContainText('Not connected');
  await expect(page.getByLabel('3D fox avatar')).toHaveAttribute('data-avatar-state', 'asleep');
  expect(await page.locator('.camera-input').evaluate((v: HTMLVideoElement) => v.srcObject)).toBeNull();
  await page.unroute('**/ingest');
  await page.getByRole('button', { name: 'Start' }).click();
  await expectLive(page);
  await page.getByRole('button', { name: 'Stop' }).click();
});
test('camera changes stop the prior session and release all tracks and workers', async ({ page }) => {
  await page.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    (window as any).cameraTracks = [];
    navigator.mediaDevices.getUserMedia = async constraints => {
      const stream = await original(constraints);
      (window as any).cameraTracks.push(...stream.getTracks()); return stream;
    };
  });
  await page.goto('/'); await page.getByRole('button', { name: 'Start' }).click();
  await expectLive(page);
  await page.getByRole('combobox', { name: 'Camera' }).selectOption({ index: 1 });
  await expectLive(page);
  await expect.poll(() => page.evaluate(() => (window as any).cameraTracks.length)).toBe(2);
  expect(await page.evaluate(() => (window as any).cameraTracks[0].readyState)).toBe('ended');
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByRole('status')).toContainText('Not connected');
  expect(await page.evaluate(() => (window as any).cameraTracks.every((track: MediaStreamTrack) => track.readyState === 'ended'))).toBe(true);
  await expect.poll(() => page.workers().length).toBe(0);
});
test('model failure and canceling startup release the camera', async ({ page }) => {
  await page.goto('/');
  await page.route('**/mediapipe/face_landmarker.task', route => route.fulfill({ status: 404, body: 'Missing model' }));
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByRole('alert')).toContainText('Face tracking could not start', { timeout: 35_000 });
  expect(await page.locator('.camera-input').evaluate((v: HTMLVideoElement) => v.srcObject)).toBeNull();
  await expect.poll(() => page.workers().length).toBe(0);
  await page.unroute('**/mediapipe/face_landmarker.task');
  await page.getByRole('button', { name: 'Start' }).click();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('status')).toContainText('Not connected');
  expect(await page.locator('.camera-input').evaluate((v: HTMLVideoElement) => v.srcObject)).toBeNull();
});
test('permission failure gives an actionable message', async ({ page }) => {
  await page.addInitScript(() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('denied', 'NotAllowedError'); }; });
  await page.goto('/'); await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByRole('alert')).toContainText('Allow the camera');
});
test('rejects CSRF, oversized ingest and invalid pipelines', async ({ page }) => {
  await page.goto('/');
  const origin = new URL(page.url()).origin;
  expect((await page.request.post('/api/session', { headers: { Origin: 'https://evil.example' }, data: {} })).status()).toBe(403);
  const { token } = await (await page.request.post('/api/session', { headers: { Origin: origin }, data: {} })).json();
  const auth = { Origin: origin, 'X-Fox-Session': token };
  expect((await page.request.post('/relay/prepare', { headers: { ...auth, Origin: 'https://evil.example' } })).status()).toBe(403);
  const { session_id } = await (await page.request.post('/relay/prepare', { headers: auth })).json();
  expect((await page.request.post('/start', { headers: auth, data: { session_id, input: { type: 'hls', url: 'https://evil.example' }, pipeline: [], output: { mode: 'websocket' } } })).status()).toBe(400);
  expect((await page.request.post('/ingest', { headers: { ...auth, 'Content-Type': 'application/octet-stream', 'X-Streamline-Session-ID': session_id }, data: Buffer.alloc(1024 * 1024 + 1) })).status()).toBe(413);
  expect((await page.request.get('/metrics', { headers: { ...auth, 'X-Streamline-Session-ID': 'stale' } })).status()).toBe(409);
  await page.request.post('/stop', { headers: { ...auth, 'X-Streamline-Session-ID': session_id } });
});

test('reduced motion and mobile controls remain accessible', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeVisible();
  await expect(page.getByLabel('Sleeping 3D fox')).toHaveAttribute('data-avatar-state', 'asleep');
  await expect(page.locator('.return-placeholder img')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Night', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Night', exact: true })).toHaveAttribute('aria-pressed', 'true');
});
test('lost WebGL context stops camera and stream and shows a recovery action', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expectLive(page);
  await page.getByLabel('3D fox avatar').evaluate((canvas: HTMLCanvasElement) => {
    canvas.getContext('webgl2')!.getExtension('WEBGL_lose_context')!.loseContext();
  });
  await expect(page.getByRole('alert')).toContainText('Reload to restore it');
  await expect(page.getByRole('status')).toContainText('Not connected');
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeDisabled();
  expect(await page.locator('.camera-input').evaluate((v: HTMLVideoElement) => v.srcObject)).toBeNull();
  await expect.poll(() => page.workers().length).toBe(0);
});

test('connection status replaces the Fox heading with controls beneath the canvas', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('contentinfo').getByRole('link', { name: 'Fox by Quaternius' })).toHaveAttribute('href', 'https://poly.pizza/m/Bc97C66HKi');
  await expect(page.getByRole('contentinfo').getByRole('link', { name: 'Fox Studio on GitHub' })).toHaveAttribute('href', 'https://github.com/TimoWilhelm/fox-studio');
  await expect(page.getByLabel('3D fox avatar')).toHaveAttribute('data-model', 'quaternius-fox');
  await expect(page.getByLabel('Sleeping 3D fox')).toHaveAttribute('data-model', 'quaternius-fox');
  await expect(page.locator('.return-placeholder img')).toHaveCount(0);
  await expect(page.getByText('Demo', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Tracking', { exact: true })).toHaveCount(0);
  await expect(page.locator('time')).toHaveCount(0);
  await expect(page.getByRole('status')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Fox', exact: true })).toHaveCount(0);
  await expect(page.getByRole('status').getByRole('heading')).toHaveText('Not connected');
  const main = await page.locator('.canvas-stage').boundingBox();
  const status = await page.getByRole('status').boundingBox();
  const controls = await page.getByRole('region', { name: 'Studio controls' }).boundingBox();
  const returned = await page.locator('.return-stage').boundingBox();
  expect(status!.y + status!.height).toBeLessThan(main!.y);
  expect(status!.x).toBe(main!.x);
  expect(controls!.y).toBeGreaterThan(main!.y + main!.height);
  expect(main!.width / returned!.width).toBeCloseTo(3, 1);
  const footer = await page.getByRole('contentinfo').boundingBox();
  expect(footer!.y).toBeGreaterThan(controls!.y + controls!.height);
  expect(footer!.y).toBeGreaterThan(returned!.y + returned!.height);
  await expect(page.getByText('Face not found')).toHaveCount(0);
  await expect(page.getByLabel('3D fox avatar')).toHaveAttribute('data-avatar-state', 'asleep');
});

test('startup stays asleep and Cancel prevents a delayed start from waking or retaining the camera', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let reached!: () => void;
  const prepared = new Promise<void>(resolve => { reached = resolve; });
  await page.route('**/relay/prepare', async route => { reached(); await held; await route.continue().catch(() => {}); });
  await page.goto('/'); await page.getByRole('button', { name: 'Start', exact: true }).click();
  await prepared;
  await expect(page.getByRole('status').getByRole('heading')).toHaveText('Connecting…');
  await expect(page.getByRole('status')).toContainText('Starting Streamline…');
  await expect(page.getByRole('status')).toHaveClass(/busy/);
  expect(await page.getByRole('status').locator('i').evaluate(element => getComputedStyle(element).animationName)).toBe('connection-spin');
  await page.screenshot({ path: 'test-results/fox-studio-connecting.png' });
  await expect(page.getByLabel('3D fox avatar')).toHaveAttribute('data-avatar-state', 'asleep');
  await expect(page.getByText('Face not found')).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click(); release();
  await expect(page.getByRole('status')).toHaveText('Not connected');
  await expect(page.getByLabel('3D fox avatar')).toHaveAttribute('data-avatar-state', 'asleep');
  expect(await page.locator('.camera-input').evaluate((video: HTMLVideoElement) => video.srcObject)).toBeNull();
  await expect.poll(() => page.workers().length).toBe(0);
  await page.unroute('**/relay/prepare');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expectLive(page);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Not connected');
});

test('camera disconnection sleeps and releases the connected session', async ({ page }) => {
  await page.goto('/'); await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expectLive(page);
  await page.locator('.camera-input').evaluate((video: HTMLVideoElement) => {
    (video.srcObject as MediaStream).getVideoTracks()[0].dispatchEvent(new Event('ended'));
  });
  await expect(page.getByRole('alert')).toContainText('Camera disconnected');
  await expect(page.getByRole('status')).toHaveText('Not connected');
  await expect(page.getByLabel('3D fox avatar')).toHaveAttribute('data-avatar-state', 'asleep');
  expect(await page.locator('.camera-input').evaluate((video: HTMLVideoElement) => video.srcObject)).toBeNull();
  await expect.poll(() => page.workers().length).toBe(0);
});

test('a failed fox download gives a reload action without opening the camera', async ({ page }) => {
  await page.route('**/models/quaternius-fox.glb', route => route.fulfill({ status: 503, body: '' }));
  await page.goto('/');
  await expect(page.getByRole('alert')).toHaveText('Fox could not load. Reload to try again.');
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeDisabled();
  await expect(page.getByRole('status')).toHaveText('Not connected');
  expect(await page.locator('.camera-input').evaluate((video: HTMLVideoElement) => video.srcObject)).toBeNull();
  expect(page.workers()).toHaveLength(0);
});


test('separate visitors cannot control another session or consume its encoder slot', async ({ page, context }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expectLive(page);
  const other = await context.newPage();
  await other.goto('/');
  await other.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(other.getByRole('alert')).toContainText('Studio busy');
  await expect(other.getByRole('status')).toHaveText('Not connected');
  expect(await other.locator('.camera-input').evaluate((video: HTMLVideoElement) => video.srcObject)).toBeNull();
  await expect(page.getByRole('status')).toContainText('Connected');
  // Another freshly verified visitor cannot read or stop the live session, even with a claimed owner header.
  const origin = new URL(page.url()).origin;
  const { token } = await (await other.request.post('/api/session', { headers: { Origin: origin }, data: {} })).json();
  expect((await other.request.get('/metrics', { headers: { 'X-Fox-Session': token, 'X-Streamline-Principal': 'local-fox-owner', 'X-Streamline-Session-ID': 'stolen' } })).status()).toBe(409);
  expect((await other.request.post('/stop', { headers: { Origin: origin, 'X-Fox-Session': token, 'X-Streamline-Session-ID': 'stolen' } })).status()).toBe(204);
  await expect(page.getByRole('status')).toContainText('Connected');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await other.getByRole('button', { name: 'Start', exact: true }).click();
  await expectLive(other);
  await other.getByRole('button', { name: 'Stop', exact: true }).click();
  await other.close();
});

test('Turnstile cancellation removes the widget and never opens the camera', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 320, height: 844 });
  await page.route('**/api/config', route => route.fulfill({ json: { localDocker: false, turnstileSitekey: 'test-only' } }));
  await page.route('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit', route => route.fulfill({ contentType: 'application/javascript', body: `window.turnstile = { render(container) { const node = document.createElement('div'); node.textContent = 'Test verification pending'; container.append(node); return 'test-widget'; }, remove() { document.querySelector('.verification').replaceChildren(); } };` }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByText('Test verification pending')).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Verifying browser…');
  expect(await page.getByRole('status').locator('i').evaluate(element => getComputedStyle(element).animationName)).toBe('none');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await page.screenshot({ path: 'test-results/fox-studio-connecting-mobile.png' });
  expect(await page.locator('.camera-input').evaluate((video: HTMLVideoElement) => video.srcObject)).toBeNull();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Not connected');
  await expect(page.locator('.verification')).toBeEmpty();
  await expect.poll(() => page.workers().length).toBe(0);
});

test('connection status stays pending until the return video actually plays', async ({ page }) => {
  await page.addInitScript(() => {
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      if (this.getAttribute('aria-label') === 'Actual Streamline encoded return feed') return Promise.resolve();
      return play.call(this);
    };
    window.addEventListener('fox-test-playback', () => {
      HTMLMediaElement.prototype.play = play;
      void document.querySelector<HTMLVideoElement>('.return-stage video')!.play();
    }, { once: true });
  });
  await page.goto('/');
  await page.getByLabel('Actual Streamline encoded return feed').evaluate((video: HTMLVideoElement) => { video.autoplay = false; });
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  try {
    await expect(page.getByRole('status')).toContainText('Waiting for video…', { timeout: 30_000 });
    await expect(page.getByRole('status').getByRole('heading')).toHaveText('Connecting…');
    await expect(page.getByLabel('3D fox avatar')).toHaveAttribute('data-avatar-state', 'asleep');
    await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new Event('fox-test-playback')));
    await expectLive(page);
    await expect(page.getByRole('status')).not.toHaveClass(/busy/);
    await expect(page.getByRole('status')).not.toContainText('Waiting for video…');
  } finally {
    const stop = page.getByRole('button', { name: /^(Cancel|Stop)$/ });
    if (await stop.isVisible()) await stop.click();
    await expect(page.getByRole('status')).toHaveText('Not connected');
  }
});

test('a failed server verification shows a retry without opening the camera', async ({ page }) => {
  await page.route('**/api/config', route => route.fulfill({ json: { localDocker: false, turnstileSitekey: 'test-only' } }));
  await page.route('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit', route => route.fulfill({ contentType: 'application/javascript', body: `window.turnstile = { render(container, options) { queueMicrotask(() => options.callback('invalid-token')); return 'test-widget'; }, remove() { document.querySelector('.verification').replaceChildren(); } };` }));
  await page.route('**/api/session', route => route.fulfill({ status: 403, body: 'Verification failed. Try Start again.' }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Verification failed. Try Start again.');
  expect(await page.locator('.camera-input').evaluate((video: HTMLVideoElement) => video.srcObject)).toBeNull();
  await expect(page.getByRole('status')).toHaveText('Not connected');
  await expect(page.locator('.verification')).toBeEmpty();
});
