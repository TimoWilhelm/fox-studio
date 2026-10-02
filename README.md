# Fox Studio

A 3D fox avatar driven by your webcam. Face tracking stays in your browser; only the rendered canvas goes through [Cloudflare Streamline](https://github.com/cloudflare/streamline) for the H.264 return preview.

[Try it](https://fox-studio.tiwicf.workers.dev)

## Development

Requires Node.js 22.18+, npm, Docker, and desktop Chrome or Edge. Start Docker, then:

```sh
npm ci
npm run docker:start
npm run dev
```

Open http://127.0.0.1:5173 and allow camera access. Use Start/Stop to connect, Recenter to reset your head position, and `npm run docker:stop` to stop the local encoder.

Choose a remote look and logo before Start. Add heart or sparkle overlays live. Streamline applies these to the return feed; the main fox stays local. Expand **Pipeline** to see the configuration.

## Deploy

Copy `.env.example` to `.env` and set your Cloudflare account, Worker URL, and Turnstile site key. Register that URL's hostname in Turnstile.

Create an ignored `.secrets.json` with `TURNSTILE_SECRET` and independently generated `SESSION_SECRET` and `PUBLISHER_SECRET` values. Keep all three server-side.

```sh
npx cf auth login
npm run build
npx cf deploy --prebuilt --secrets-file .secrets.json
```

Sessions are isolated, require Turnstile verification, and expire after 30 minutes. One `standard-4` container serves one active session at a time.

## Checks

```sh
npm run typecheck
npm test
npx playwright install chromium
npm run test:e2e  # with the local app and Docker running
npx cf deploy --dry-run --prebuilt
```

## Credits

[Fox by Quaternius](https://poly.pizza/m/Bc97C66HKi) (CC0), [Three.js](https://threejs.org/) (MIT), and [MediaPipe](https://github.com/google-ai-edge/mediapipe) (Apache 2.0). App code is MIT; vendored code keeps its original licenses. See [third-party provenance](vendor/PROVENANCE.md).
