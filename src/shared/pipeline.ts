import type { StreamOperation } from '@cloudflare/streamline/client';

export const WIDTH = 1280;
export const HEIGHT = 720;
export const FPS = 30;
export const MAX_SESSION_SECONDS = 1800;
export const MAX_CHUNK_BYTES = 1024 * 1024;
export const MAX_REACTION_BYTES = 256 * 1024;
export const remoteLooks = [
  { id: 'original', label: 'Original' },
  { id: 'mono', label: 'Mono' },
  { id: 'vivid', label: 'Vivid' },
  { id: 'soft', label: 'Soft' },
] as const;
export type RemoteLook = typeof remoteLooks[number]['id'];
export interface RemoteEffects { look: RemoteLook; logo: boolean }
export const DEFAULT_EFFECTS: RemoteEffects = { look: 'original', logo: false };

export function buildPipeline({ look }: RemoteEffects = DEFAULT_EFFECTS) {
  const filters: Record<RemoteLook, StreamOperation[]> = {
    original: [],
    mono: [{ op: 'filter', params: { preset: 'saturation', amount: 0 } }],
    vivid: [
      { op: 'filter', params: { preset: 'saturation', amount: 1.5 } },
      { op: 'filter', params: { preset: 'contrast', amount: 1.12 } },
    ],
    soft: [
      { op: 'filter', params: { preset: 'blur', amount: 1.5 } },
      { op: 'filter', params: { preset: 'brightness', amount: 0.04 } },
    ],
  };
  const pipeline: StreamOperation[] = [...filters[look]];
  pipeline.push(
    { op: 'overlay', params: { image: 'annotation', position: 'full' } },
    { op: 'encode', params: { codec: 'h264', preset: 'veryfast', bitrate: '2500k', resolution: '1280x720', fps: FPS, gop: 60 } },
  );
  return { input: { type: 'webcam' as const }, pipeline, output: { mode: 'websocket' as const, format: 'fmp4' as const } };
}
export const PIPELINE = buildPipeline();
const allowedPipelines = remoteLooks.map(({ id: look }) => buildPipeline({ look, logo: false }));

export class PolicyError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

function sameValue(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((v, i) => sameValue(actual[i], v));
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
    const a = actual as Record<string, unknown>;
    const e = expected as Record<string, unknown>;
    return Object.keys(a).length === Object.keys(e).length && Object.entries(e).every(([key, value]) => sameValue(a[key], value));
  }
  return actual === expected;
}

export function validatePipeline(body: Record<string, unknown>) {
  const { session_id, ...config } = body;
  const allowed = allowedPipelines.find(pipeline => sameValue(config, pipeline));
  if (!allowed) throw new PolicyError('Choose a supported Fox Studio pipeline.');
  if (typeof session_id !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(session_id)) throw new PolicyError('A prepared session is required.');
  return { ...allowed, session_id };
}
