interface TurnstileAPI {
  render(container: HTMLElement, options: { sitekey: string; action: string; appearance: 'interaction-only'; theme: 'auto'; size: 'flexible'; callback: (token: string) => void; 'error-callback': () => void; 'expired-callback': () => void; 'timeout-callback': () => void }): string;
  remove(widgetId: string): void;
}
declare global { interface Window { turnstile?: TurnstileAPI } }
let loading: Promise<TurnstileAPI> | null = null;

function loadTurnstile(): Promise<TurnstileAPI> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    const timer = window.setTimeout(() => fail(), 15_000);
    const fail = () => { clearTimeout(timer); script.remove(); loading = null; reject(new Error('Verification unavailable. Check your connection and try Start again.')); };
    script.onerror = fail;
    script.onload = () => { clearTimeout(timer); if (window.turnstile) resolve(window.turnstile); else fail(); };
    document.head.append(script);
  });
  return loading;
}

export async function turnstileToken(container: HTMLElement, sitekey: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  let widgetId: string | undefined;
  let api: TurnstileAPI | undefined;
  try {
    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      const finish = (operation: () => void) => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal.removeEventListener('abort', cancel); operation();
      };
      const cancel = () => finish(() => reject(new DOMException('Canceled', 'AbortError')));
      const timer = window.setTimeout(() => finish(() => reject(new Error('Verification timed out. Try Start again.'))), 60_000);
      signal.addEventListener('abort', cancel, { once: true });
      const fail = () => finish(() => reject(new Error('Verification failed. Try Start again.')));
      void loadTurnstile().then(loaded => {
        if (settled) return;
        if (signal.aborted) { cancel(); return; }
        api = loaded;
        widgetId = api.render(container, { sitekey, action: 'start_session', appearance: 'interaction-only', theme: 'auto', size: 'flexible',
          callback: token => finish(() => resolve(token)), 'error-callback': fail, 'expired-callback': fail, 'timeout-callback': fail });
      }).catch(error => finish(() => reject(error)));
    });
  } finally {
    if (widgetId !== undefined) api?.remove(widgetId);
  }
}
