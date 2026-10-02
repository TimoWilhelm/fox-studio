import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import react from '@vitejs/plugin-react';
import { syncAssets } from './scripts/sync-assets.mjs';

await syncAssets();

export default defineConfig({
	plugins: [react(), cloudflare()],
	server: { host: '127.0.0.1', port: 5173 },
});
