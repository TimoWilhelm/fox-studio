# Third-party provenance

- **Streamline:** `@cloudflare/streamline@0.1.0` and its unmodified container source at [commit 6ad50d2](https://github.com/cloudflare/streamline/tree/6ad50d2754073504e1ab647796c0d59e2641aca0). Apache 2.0; licenses and the session contract are included. The bundled wordmark comes from the same source. The image uses Debian's FFmpeg packages and their notices.
- **Streamline demo:** the local Docker adapter and ordered ingest/playback flow are adapted from [cloudflare/streamline-demo](https://github.com/cloudflare/streamline-demo). Apache 2.0; license included.
- **Fox:** Quaternius's [Fox](https://poly.pizza/m/Bc97C66HKi), CC0 1.0. The original GLB is preserved; its checksum and runtime adaptations are recorded in [model provenance](../public/models/quaternius-fox.provenance.json).
- **MediaPipe:** runtime and WASM are copied from the version pinned in `package-lock.json`. The bundled [Face Landmarker model](https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task) is version 1, float16. Apache 2.0; see [notice](../public/mediapipe/NOTICE.md) and the adjacent license.
- **Three.js:** `0.186.1`, including `OutlineEffect`. MIT; see [license](../public/licenses/three.txt).
