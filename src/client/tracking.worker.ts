import type { FaceLandmarker } from '@mediapipe/tasks-vision';
declare const Vision: typeof import('@mediapipe/tasks-vision');
let landmarker: FaceLandmarker | null = null;

self.onmessage = async (event: MessageEvent) => {
  if (event.data.type === 'init') {
    try {
      importScripts('/mediapipe/vision_bundle.js');
      const files = await Vision.FilesetResolver.forVisionTasks('/mediapipe/wasm');
      landmarker = await Vision.FaceLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: '/mediapipe/face_landmarker.task', delegate: 'CPU' },
        runningMode: 'VIDEO', numFaces: 1,
        outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true,
        minFaceDetectionConfidence: .55, minFacePresenceConfidence: .55, minTrackingConfidence: .55,
      });
      self.postMessage({ type: 'ready' });
    } catch (error) { self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) }); }
  }
  if (event.data.type === 'frame') {
    const frame: ImageBitmap = event.data.frame;
    try {
      if (!landmarker) return;
      const result = landmarker.detectForVideo(frame, event.data.timestamp);
      const coefficients = Object.fromEntries((result.faceBlendshapes[0]?.categories ?? []).map(c => [c.categoryName, c.score]));
      self.postMessage({ type: 'sample', coefficients, matrix: result.facialTransformationMatrixes[0]?.data ?? [], timestamp: event.data.timestamp, found: result.faceLandmarks.length > 0 });
    } catch (error) { self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) }); }
    finally { frame.close(); }
  }
  if (event.data.type === 'close') { landmarker?.close(); landmarker = null; self.close(); }
};
