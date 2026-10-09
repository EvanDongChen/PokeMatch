import {
  FaceLandmarker,
  type FaceLandmarkerResult,
  type NormalizedLandmark,
} from '@mediapipe/tasks-vision';

// Everything the face model needs is served with the site, so it works on
// flaky networks. The SIMD build covers every current browser.
import wasmLoaderPath from '@mediapipe/tasks-vision/vision_wasm_internal.js?url';
import wasmBinaryPath from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url';

const WASM: Parameters<typeof FaceLandmarker.createFromOptions>[0] = { wasmLoaderPath, wasmBinaryPath };
const MODEL_URL = `${import.meta.env.BASE_URL}models/face_landmarker.task`;

/** MediaPipe face-mesh landmark indices used for measurement. */
const L = {
  foreheadTop: 10,
  glabella: 9,
  nasion: 168,
  subnasale: 2,
  upperLip: 0,
  lowerLip: 17,
  chin: 152,
  cheekR: 234,
  cheekL: 454,
  jawR: 172,
  jawL: 397,
  chinR: 176,
  chinL: 400,
  mouthR: 61,
  mouthL: 291,
  eyeROuter: 33,
  eyeRInner: 133,
  eyeRTop: 159,
  eyeRBottom: 145,
  eyeLOuter: 263,
  eyeLInner: 362,
  eyeLTop: 386,
  eyeLBottom: 374,
  browR: 52,
  browL: 282,
  noseTip: 1,
} as const;

/** Outline drawn over the photo while analysing. */
export const FACE_OVAL = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152,
  148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109, 10,
];

export type MeasureKey =
  | 'widthHeight'
  | 'jawRatio'
  | 'chinAngle'
  | 'chinLength'
  | 'eyeWidth'
  | 'eyeOpen'
  | 'eyeWide'
  | 'eyeGap'
  | 'noseLength'
  | 'mouthWidth'
  | 'lipHeight'
  | 'browGap'
  | 'browDown'
  | 'foreheadHeight'
  | 'browInnerUp'
  | 'smile'
  | 'jawOpen';

export type Measures = Record<MeasureKey, number>;

export interface FaceAnalysis {
  measures: Measures;
  /** Landmarks in pixel space of the analysed image. */
  points: { x: number; y: number }[];
  /** Rough head turn, 0 = facing camera, ~1 = profile. */
  yaw: number;
  faceCount: number;
}

/** Faces turned further than this give unreliable proportions. */
export const MAX_YAW = 0.35;

let landmarkerPromise: Promise<FaceLandmarker> | null = null;

export function loadLandmarker(): Promise<FaceLandmarker> {
  landmarkerPromise ??= FaceLandmarker.createFromOptions(WASM, {
    baseOptions: { modelAssetPath: MODEL_URL },
    runningMode: 'IMAGE',
    numFaces: 4,
    outputFaceBlendshapes: true,
  });
  landmarkerPromise.catch(() => (landmarkerPromise = null));
  return landmarkerPromise;
}

type Vec3 = [number, number, number];

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function angleAt(vertex: Vec3, a: Vec3, b: Vec3): number {
  const u = [a[0] - vertex[0], a[1] - vertex[1], a[2] - vertex[2]];
  const v = [b[0] - vertex[0], b[1] - vertex[1], b[2] - vertex[2]];
  const dot = u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  return Math.acos(dot / (Math.hypot(...u) * Math.hypot(...v)));
}

function faceArea(lm: NormalizedLandmark[]): number {
  let minX = 1, maxX = 0, minY = 1, maxY = 0;
  for (const p of lm) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  return (maxX - minX) * (maxY - minY);
}

let videoLandmarkerPromise: Promise<FaceLandmarker> | null = null;

/** A second landmarker in VIDEO mode, which tracks between frames for live use. */
export function loadVideoLandmarker(): Promise<FaceLandmarker> {
  videoLandmarkerPromise ??= FaceLandmarker.createFromOptions(WASM, {
    baseOptions: { modelAssetPath: MODEL_URL },
    runningMode: 'VIDEO',
    numFaces: 1,
    outputFaceBlendshapes: true,
  });
  videoLandmarkerPromise.catch(() => (videoLandmarkerPromise = null));
  return videoLandmarkerPromise;
}

/** Detects the largest face in the image and measures its proportions. */
export async function analyzeFace(
  image: HTMLImageElement | HTMLCanvasElement,
): Promise<FaceAnalysis | null> {
  const landmarker = await loadLandmarker();
  return measure(landmarker.detect(image), image.width, image.height);
}

/** Measures the face in the current video frame. Timestamps must increase. */
export function analyzeVideoFrame(
  landmarker: FaceLandmarker,
  video: HTMLVideoElement,
  timestamp: number,
): FaceAnalysis | null {
  return measure(landmarker.detectForVideo(video, timestamp), video.videoWidth, video.videoHeight);
}

function measure(result: FaceLandmarkerResult, w: number, h: number): FaceAnalysis | null {
  if (result.faceLandmarks.length === 0) return null;

  let best = 0;
  result.faceLandmarks.forEach((lm, i) => {
    if (faceArea(lm) > faceArea(result.faceLandmarks[best])) best = i;
  });
  const lm = result.faceLandmarks[best];
  const blend: Record<string, number> = {};
  for (const c of result.faceBlendshapes[best]?.categories ?? []) blend[c.categoryName] = c.score;

  // Landmarks are normalised per axis; convert to a uniform pixel scale.
  // MediaPipe's z uses roughly the same scale as x.
  const P =(i: number): Vec3 => [lm[i].x * w, lm[i].y * h, lm[i].z * w];
  const D = (a: number, b: number) => dist(P(a), P(b));
  const avg = (a: number, b: number) => (a + b) / 2;
  const bs = (name: string) => blend[name] ?? 0;

  const faceW = D(L.cheekR, L.cheekL);
  const faceH = D(L.foreheadTop, L.chin);
  const eyeW = avg(D(L.eyeROuter, L.eyeRInner), D(L.eyeLOuter, L.eyeLInner));
  const eyeH = avg(D(L.eyeRTop, L.eyeRBottom), D(L.eyeLTop, L.eyeLBottom));

  const measures: Measures = {
    widthHeight: faceW / faceH,
    jawRatio: D(L.jawR, L.jawL) / faceW,
    chinAngle: angleAt(P(L.chin), P(L.chinR), P(L.chinL)),
    chinLength: D(L.lowerLip, L.chin) / faceH,
    eyeWidth: eyeW / faceW,
    eyeOpen: eyeH / eyeW,
    eyeWide: avg(bs('eyeWideLeft'), bs('eyeWideRight')),
    eyeGap: D(L.eyeRInner, L.eyeLInner) / faceW,
    noseLength: D(L.nasion, L.subnasale) / faceH,
    mouthWidth: D(L.mouthR, L.mouthL) / faceW,
    lipHeight: D(L.upperLip, L.lowerLip) / faceH,
    browGap: avg(D(L.browR, L.eyeRTop), D(L.browL, L.eyeLTop)) / faceH,
    browDown: avg(bs('browDownLeft'), bs('browDownRight')),
    foreheadHeight: D(L.foreheadTop, L.glabella) / faceH,
    browInnerUp: bs('browInnerUp'),
    smile: avg(bs('mouthSmileLeft'), bs('mouthSmileRight')),
    jawOpen: bs('jawOpen'),
  };

  // Nose tip offset from the cheek midpoint, relative to half face width.
  const mid = (P(L.cheekR)[0] + P(L.cheekL)[0]) / 2;
  const yaw = Math.min(1, Math.abs(P(L.noseTip)[0] - mid) / (faceW / 2));

  return {
    measures,
    points: lm.map((p) => ({ x: p.x * w, y: p.y * h })),
    yaw,
    faceCount: result.faceLandmarks.length,
  };
}
