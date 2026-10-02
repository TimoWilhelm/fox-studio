import { useCallback, useEffect, useRef, useState } from 'react';
import { PoseSmoother } from '../shared/expression';
import { FoxRenderer, backgrounds, modelCredit, type Background } from './fox';
import { FaceTracker } from './tracker';
import { VideoSession, unsupportedReason } from './session';
import { buildPipeline, DEFAULT_EFFECTS, remoteLooks, type RemoteEffects, type RemoteLook } from '../shared/pipeline';
import type { Reaction } from './reaction';

type Status = 'idle' | 'verifying' | 'camera' | 'model' | 'connecting' | 'waiting' | 'live' | 'stopping';
const statusLabel: Record<Status, string> = { idle: 'Not connected', verifying: 'Connecting…', camera: 'Connecting…', model: 'Connecting…', connecting: 'Connecting…', waiting: 'Connecting…', live: 'Connected', stopping: 'Stopping…' };
const statusDetail: Partial<Record<Status, string>> = {
  verifying: 'Verifying browser…', camera: 'Opening camera…', model: 'Loading face tracking…',
  connecting: 'Starting Streamline…', waiting: 'Waiting for video…',
};

function Icon({ kind }: { kind: 'play' | 'stop' | 'cancel' | 'expand' | 'center' }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === 'play' ? <path d="m9 5 10 7-10 7Z" fill="currentColor" stroke="none" /> :
      kind === 'stop' ? <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" /> :
      kind === 'cancel' ? <path d="m6 6 12 12M18 6 6 18" /> :
      kind === 'expand' ? <path d="M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5" /> :
      <><circle cx="12" cy="12" r="6" /><path d="M12 2v5m0 10v5M2 12h5m10 0h5" /></>}
  </svg>;
}

export function App() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const returnVideo = useRef<HTMLVideoElement>(null);
  const sleepingCanvas = useRef<HTMLCanvasElement>(null);
  const verification = useRef<HTMLDivElement>(null);
  const cameraVideo = useRef<HTMLVideoElement>(null);
  const camera = useRef<MediaStream | null>(null);
  const tracker = useRef<FaceTracker | null>(null);
  const session = useRef<VideoSession | null>(null);
  const smoother = useRef(new PoseSmoother());
  const generation = useRef(0);
  const active = useRef(false);
  const connected = useRef(false);
  const cameraChange = useRef(0);
  const backgroundRef = useRef<Background>('paper');
  const [background, setBackground] = useState<Background>('paper');
  const [status, setStatus] = useState<Status>('idle');
  const [tracking, setTracking] = useState(false);
  const [error, setError] = useState('');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [device, setDevice] = useState('');
  const [avatarReady, setAvatarReady] = useState(false);
  const [unsupported, setUnsupported] = useState<string | null>(null);
  const [recentered, setRecentered] = useState(false);
  const [effects, setEffects] = useState<RemoteEffects>(DEFAULT_EFFECTS);
  const [reaction, setReaction] = useState<Reaction>('none');
  const [reacting, setReacting] = useState(false);
  const recenterTimer = useRef(0);
  const stopping = useRef<Promise<void> | null>(null);

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices) return;
    try { setDevices((await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput')); } catch {}
  }, []);

  const stop = useCallback(async (message?: string) => {
    if (stopping.current) { await stopping.current; return; }
    generation.current++; active.current = false; connected.current = false; setStatus('stopping');
    setReaction('none'); setReacting(false);
    tracker.current?.close(); tracker.current = null;
    camera.current?.getTracks().forEach(track => track.stop()); camera.current = null;
    if (cameraVideo.current) { cameraVideo.current.pause(); cameraVideo.current.srcObject = null; }
    smoother.current.reset(); setTracking(false);
    const current = session.current; session.current = null;
    stopping.current = (async () => {
      try { await current?.close(); }
      catch { setError('Camera stopped. Server cleanup is pending. Reload before starting again.'); }
      finally { setStatus('idle'); stopping.current = null; }
      if (message) setError(message);
    })();
    await stopping.current;
  }, []);

  useEffect(() => {
    setUnsupported(unsupportedReason()); void refreshDevices();
    const renderers: FoxRenderer[] = [];
    try {
      renderers.push(new FoxRenderer(canvas.current!));
      renderers.push(new FoxRenderer(sleepingCanvas.current!, { width: 640, height: 360 }));
    }
    catch { renderers.forEach(renderer => { void renderer.ready.catch(() => {}); renderer.dispose(); }); setUnsupported('Enable hardware acceleration, then reload in Chrome or Edge.'); return; }
    const [renderer, sleepingRenderer] = renderers;
    let mounted = true;
    void Promise.all(renderers.map(renderer => renderer.ready)).then(() => { if (mounted) setAvatarReady(true); }).catch(() => { if (mounted) { renderers.forEach(renderer => renderer.dispose()); setUnsupported('Fox could not load. Reload to try again.'); } });
    navigator.mediaDevices?.addEventListener('devicechange', refreshDevices);
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const contextLost = (event: Event) => {
      event.preventDefault();
      setUnsupported('3D rendering paused. Reload to restore it.');
      void stop('3D rendering paused. Reload to restore it.');
    };
    const elements = [canvas.current!, sleepingCanvas.current!];
    elements.forEach(element => element.addEventListener('webglcontextlost', contextLost));
    let frameId = 0, lastDraw = 0;
    const render = (time: number) => {
      if (time - lastDraw >= 1000 / 30 && canvas.current) {
        lastDraw = time;
        const found = smoother.current.tracked(time);
        const pose = smoother.current.tick(time);
        renderer.draw(pose, time, backgroundRef.current, connected.current, motion.matches);
        if (!connected.current) sleepingRenderer.draw(pose, time, backgroundRef.current, false, motion.matches);
        setTracking(found);
        if (active.current && cameraVideo.current) void tracker.current?.frame(cameraVideo.current, time);
      }
      frameId = requestAnimationFrame(render);
    };
    frameId = requestAnimationFrame(render);
    const unload = () => { void stop(); };
    window.addEventListener('pagehide', unload);
    return () => { mounted = false; elements.forEach(element => element.removeEventListener('webglcontextlost', contextLost)); renderers.forEach(renderer => renderer.dispose()); cancelAnimationFrame(frameId); clearTimeout(recenterTimer.current); navigator.mediaDevices?.removeEventListener('devicechange', refreshDevices); window.removeEventListener('pagehide', unload); void stop(); };
  }, [refreshDevices, stop]);

  const start = async (selectedDevice = device) => {
    if (active.current || unsupported) return;
    if (stopping.current) await stopping.current;
    const run = ++generation.current;
    active.current = true; setError(''); setStatus('verifying');
    try {
      const videoSession = new VideoSession(returnVideo.current!, () => { if (run === generation.current) { connected.current = true; setStatus('live'); } }, failure => { if (run === generation.current) void stop(failure.message); });
      session.current = videoSession;
      await videoSession.authorize(verification.current!);
      if (run !== generation.current) return;
      setStatus('camera');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...(selectedDevice ? { deviceId: { exact: selectedDevice } } : { facingMode: 'user' }), width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } });
      if (run !== generation.current) { stream.getTracks().forEach(track => track.stop()); return; }
      camera.current = stream;
      for (const track of stream.getTracks()) track.onended = () => { if (run === generation.current) void stop('Camera disconnected. Choose another and Start again.'); };
      cameraVideo.current!.srcObject = stream; await cameraVideo.current!.play();
      await refreshDevices();
      if (run !== generation.current) return;
      setStatus('model');
      const faceTracker = new FaceTracker(sample => smoother.current.update(sample), failure => { if (run === generation.current) void stop(failure.message); });
      tracker.current = faceTracker; await faceTracker.init();
      if (run !== generation.current) return;
      setStatus('connecting');
      await videoSession.start(canvas.current!, effects);
      if (run === generation.current && !connected.current) setStatus('waiting');
    } catch (failure) {
      if (run !== generation.current) return;
      const name = failure instanceof Error ? failure.name : '';
      const message = name === 'NotAllowedError' ? 'Allow the camera in your browser’s address bar, then try Start.' : name === 'NotFoundError' ? 'No camera found. Connect a webcam, then try Start.' : name === 'NotReadableError' ? 'Camera is busy. Close other camera apps, then try Start.' : name === 'OverconstrainedError' ? 'Camera unavailable. Choose another, then try Start.' : failure instanceof Error ? failure.message : 'Could not start. Reload and try again.';
      await stop(message);
    }
  };

  const changeCamera = async (value: string) => {
    const change = ++cameraChange.current;
    const restart = active.current;
    await stop();
    if (change !== cameraChange.current) return;
    setDevice(value);
    if (restart) await start(value);
  };
  const sendReaction = async (value: Reaction) => {
    if (!connected.current || !session.current || reacting) return;
    const run = generation.current;
    setReacting(true);
    try {
      await session.current.react(value);
      if (run === generation.current) setReaction(value);
    } catch {
      if (run === generation.current) setError('Overlay failed. Try the reaction again.');
    } finally { if (run === generation.current) setReacting(false); }
  };
  const starting = status !== 'idle' && status !== 'live' && status !== 'stopping';
  const running = starting || status === 'live';
  return (
    <div className="studio">
      <header className="topbar">
        <h1><img src="/fox.svg" alt="" />Fox Studio</h1>
      </header>
      <main>
        {(error || unsupported) && (
          <div className="error-banner" role="alert">
            <p>{error || unsupported}</p>
            {error && !unsupported && <button aria-label="Dismiss error" onClick={() => setError('')}>×</button>}
          </div>
        )}
        <section className="workspace" aria-label="Video studio">
          <article className="preview main-preview">
            <div className="preview-header">
              <div className={`session-status ${status === 'live' ? 'connected' : ''} ${starting || status === 'stopping' ? 'busy' : ''}`} role="status" aria-live="polite" aria-atomic="true">
                <i aria-hidden="true" />
                <div className="status-copy">
                  <h2>{statusLabel[status]}</h2>
                  {statusDetail[status] && <span className="status-detail">{statusDetail[status]}</span>}
                  {status === 'live' && !tracking && <span className="status-detail">Face not found</span>}
                </div>
              </div>
              <div className="preview-actions">
                <div className="swatches" role="group" aria-label="Background">
                  {backgrounds.map(bg => <button key={bg.id} className={`swatch ${background === bg.id ? 'selected' : ''}`}
                    style={{ '--swatch': bg.color } as React.CSSProperties} aria-label={bg.label} aria-pressed={background === bg.id} title={bg.label}
                    onClick={() => { setBackground(bg.id); backgroundRef.current = bg.id; }} />)}
                </div>
                <button className="icon-button" title="Recenter" aria-label="Recenter" disabled={!tracking || !running}
                  onClick={() => { smoother.current.recenter(); setRecentered(true); clearTimeout(recenterTimer.current); recenterTimer.current = window.setTimeout(() => setRecentered(false), 1600); }}>
                  {recentered ? <span aria-hidden="true">✓</span> : <Icon kind="center" />}
                </button>
                <button className="icon-button" title="Fullscreen" aria-label="Fullscreen fox output"
                  onClick={() => void canvas.current?.requestFullscreen().catch(() => setError('Fullscreen unavailable. Try Chrome or Edge.'))}>
                  <Icon kind="expand" />
                </button>
              </div>
            </div>
            <div className="canvas-stage">
              <canvas ref={canvas} width="1280" height="720" aria-label="3D fox avatar" />
            </div>
            <section className="controls" aria-label="Studio controls">
              <div className="camera-control">
                <label className="sr-only" htmlFor="camera">Camera</label>
                <select id="camera" value={device} onChange={event => void changeCamera(event.target.value)} disabled={status === 'stopping'}>
                  <option value="">Default camera</option>
                  {devices.map((d, i) => <option key={d.deviceId || i} value={d.deviceId}>{d.label || `Camera ${i + 1}`}</option>)}
                </select>
              </div>
              <button className={`start-button ${running ? 'stop-button' : ''}`} onClick={() => running ? void stop() : void start()}
                disabled={!avatarReady || Boolean(unsupported) || status === 'stopping'}>
                <Icon kind={starting ? 'cancel' : status === 'live' ? 'stop' : 'play'} />
                {starting ? 'Cancel' : status === 'live' ? 'Stop' : 'Start'}
              </button>
            </section>
            <div className="verification" ref={verification} />
          </article>
          <article className="preview return-preview">
            <div className="preview-header"><h2>Streamline return</h2></div>
            <div className={`return-stage ${status === 'live' ? 'connected' : ''}`}>
              <video ref={returnVideo} playsInline muted autoPlay aria-label="Actual Streamline encoded return feed" />
              <div className="return-placeholder" aria-label="Sleeping fox" aria-hidden={status === 'live'}>
                <canvas ref={sleepingCanvas} width="640" height="360" aria-label="Sleeping 3D fox" />
              </div>
            </div>
            <section className="remote-effects" aria-labelledby="effects-heading">
              <h3 id="effects-heading">Remote effects</h3>
              <fieldset disabled={status !== 'idle'} aria-describedby={status !== 'idle' ? 'effects-hint' : undefined}>
                <legend className="sr-only">Pipeline settings</legend>
                <div className="effect-row">
                  <label htmlFor="remote-look">Look</label>
                  <select id="remote-look" value={effects.look} onChange={event => setEffects({ ...effects, look: event.target.value as RemoteLook })}>
                    {remoteLooks.map(look => <option key={look.id} value={look.id}>{look.label}</option>)}
                  </select>
                </div>
                <label className="effect-row logo-control" title="Small watermark in the bottom-right corner">
                  <span>Streamline logo</span>
                  <input type="checkbox" checked={effects.logo} onChange={event => setEffects({ ...effects, logo: event.target.checked })} />
                </label>
              </fieldset>
              {status !== 'idle' && <p id="effects-hint" className="effects-hint">Stop to change the look or logo.</p>}
              <div className="effect-row">
                <span>Reaction</span>
                <div className="reaction-buttons" role="group" aria-label="Live return overlay" aria-busy={reacting}>
                  {([
                    ['none', 'Clear reaction', '×'], ['hearts', 'Hearts', '♡'], ['sparkles', 'Sparkles', '✧'],
                  ] as const).map(([id, label, symbol]) => <button key={id} type="button" aria-label={label} title={status === 'live' ? label : 'Start to add a reaction'} aria-pressed={reaction === id}
                    disabled={status !== 'live' || reacting} onClick={() => void sendReaction(id)}><span aria-hidden="true">{symbol}</span></button>)}
                </div>
              </div>
              <details className="pipeline-code">
                <summary>Pipeline</summary>
                <pre>{JSON.stringify(buildPipeline(effects), null, 2)}</pre>
              </details>
            </section>
          </article>
        </section>
      </main>
      <footer className="studio-footer">
        <a href={modelCredit.url} target="_blank" rel="noopener noreferrer">{modelCredit.label}</a>
        <span aria-hidden="true">·</span>
        <a href="https://github.com/TimoWilhelm/fox-studio" target="_blank" rel="noopener noreferrer" aria-label="Fox Studio on GitHub">GitHub</a>
      </footer>
      <video ref={cameraVideo} className="camera-input" playsInline muted aria-hidden="true" />
    </div>
  );
}
