import { loadEnvFile } from 'node:process';
import { bindings, defineConfig, defineContainer, exports } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

try { loadEnvFile('.env'); } catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

const appOrigin = new URL(process.env.APP_ORIGIN || 'https://fox.example').origin;
if (!appOrigin.startsWith('https://')) throw new Error('APP_ORIGIN must use HTTPS.');

const container = defineContainer({
  name: 'fox-studio-media',
  image: { dockerfile: './vendor/streamline/container/Dockerfile', buildContext: './vendor/streamline/container' },
  instanceType: 'standard-4',
  maxInstances: 1,
  observability: { enabled: true, logs: { enabled: true } },
});

export default defineConfig(({ mode }) => ({
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID || undefined,
	containers: [container],
	worker: {
		name: "fox-studio",
		compatibilityDate: "2026-10-02",
		compatibilityFlags: ['global_fetch_strictly_public', 'enable_request_signal', 'request_signal_passthrough'],
		entrypoint,
		workersDev: true,
		previewUrls: false,
		assets: { runWorkerFirst: true, notFoundHandling: 'single-page-application' },
		observability: { enabled: true, redactQueryString: true, logs: { enabled: true }, traces: { enabled: true } },
		exports: { MediaContainer: exports.durableObject({ storage: 'sqlite', container }), SessionAdmission: exports.durableObject({ storage: 'sqlite' }) },
		env: {
			ASSETS: bindings.assets(),
			ALLOWED_ORIGINS: bindings.text(mode === 'development' ? 'http://127.0.0.1:5173,http://localhost:5173' : appOrigin),
			MAX_SESSION_DURATION_SECONDS: bindings.text('1800'),
			TURNSTILE_SITEKEY: bindings.text(process.env.TURNSTILE_SITEKEY || ''),
			TURNSTILE_HOSTNAMES: bindings.text(mode === 'development' ? 'localhost,127.0.0.1' : new URL(appOrigin).hostname),
			TURNSTILE_SECRET: mode === 'development' ? bindings.text('local-only') : bindings.secret(),
			SESSION_SECRET: mode === 'development' ? bindings.text('local-fox-session-key-only-for-loopback-development') : bindings.secret(),
			PUBLISHER_SECRET: mode === 'development' ? bindings.text('local-unused') : bindings.secret(),
			LOCAL_DOCKER_ORIGIN: bindings.text(mode === 'development' ? 'http://127.0.0.1:8788' : ''),
		},
	},
}));
