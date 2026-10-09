import { FaceLandmarker } from '@mediapipe/tasks-vision';
import { analyzeVideoFrame, loadVideoLandmarker, type FaceAnalysis } from './face.ts';
import { faceTraits, TRAITS, type TraitVector } from './traits.ts';
import { rankMatches, type Match } from './pokemon.ts';

/** Weight of each new frame in the running trait average. */
const SMOOTHING = 0.22;
/** Frames a new Pokémon must stay on top before it replaces the current one. */
const HOLD_FRAMES = 8;
/** Frames without a face before the reading is cleared. */
const LOST_FRAMES = 20;

const TESSELATION = FaceLandmarker.FACE_LANDMARKS_TESSELATION;
const FEATURES: [typeof TESSELATION, string][] = [
  [FaceLandmarker.FACE_LANDMARKS_FACE_OVAL, 'rgba(251,248,241,0.9)'],
  [FaceLandmarker.FACE_LANDMARKS_LEFT_EYE, '#9db7ff'],
  [FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE, '#9db7ff'],
  [FaceLandmarker.FACE_LANDMARKS_LEFT_EYEBROW, 'rgba(251,248,241,0.9)'],
  [FaceLandmarker.FACE_LANDMARKS_RIGHT_EYEBROW, 'rgba(251,248,241,0.9)'],
  [FaceLandmarker.FACE_LANDMARKS_LIPS, '#ff9a8f'],
];

export type LiveListener = (match: Match | null, traits: TraitVector | null) => void;

/**
 * Tracks the face in a live video, draws its mesh on an overlay canvas and
 * reports the closest Pokémon as the expression changes.
 */
export class LiveMirror {
  private running = false;
  private frame = 0;
  private lastVideoTime = -1;
  private smoothed: TraitVector | null = null;
  private current: Match | null = null;
  private challenger = 0;
  private challengerFrames = 0;
  private lostFrames = 0;

  constructor(
    private video: HTMLVideoElement,
    private overlay: HTMLCanvasElement,
    private listener: LiveListener,
  ) {}

  async start() {
    this.stop();
    this.running = true;
    let landmarker: FaceLandmarker;
    try {
      landmarker = await loadVideoLandmarker();
    } catch (err) {
      console.warn('Live tracking unavailable', err);
      return;
    }
    if (!this.running) return;

    const tick = () => {
      if (!this.running) return;
      const v = this.video;
      if (v.readyState >= 2 && v.currentTime !== this.lastVideoTime) {
        this.lastVideoTime = v.currentTime;
        this.process(analyzeVideoFrame(landmarker, v, performance.now()));
      }
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.frame);
    this.overlay.getContext('2d')?.clearRect(0, 0, this.overlay.width, this.overlay.height);
    this.smoothed = null;
    this.current = null;
    this.challengerFrames = 0;
    this.lostFrames = 0;
    this.lastVideoTime = -1;
  }

  private process(face: FaceAnalysis | null) {
    this.draw(face);
    if (!face) {
      if (++this.lostFrames === LOST_FRAMES) {
        this.smoothed = null;
        this.current = null;
        this.listener(null, null);
      }
      return;
    }
    this.lostFrames = 0;

    const traits = faceTraits(face.measures);
    if (!this.smoothed) this.smoothed = traits;
    else for (const t of TRAITS) this.smoothed[t.key] += SMOOTHING * (traits[t.key] - this.smoothed[t.key]);

    const [best] = rankMatches(this.smoothed, 1);
    if (!this.current || best.pokemon.id === this.current.pokemon.id) {
      this.current = best;
      this.challengerFrames = 0;
    } else if (best.pokemon.id === this.challenger) {
      if (++this.challengerFrames >= HOLD_FRAMES) {
        this.current = best;
        this.challengerFrames = 0;
      }
    } else {
      this.challenger = best.pokemon.id;
      this.challengerFrames = 1;
    }
    this.listener(this.current, this.smoothed);
  }

  private draw(face: FaceAnalysis | null) {
    const { videoWidth: w, videoHeight: h } = this.video;
    if (this.overlay.width !== w || this.overlay.height !== h) {
      this.overlay.width = w;
      this.overlay.height = h;
    }
    const ctx = this.overlay.getContext('2d')!;
    ctx.clearRect(0, 0, w, h);
    if (!face) return;
    const pts = face.points;
    const unit = Math.max(1, w / 640);

    ctx.lineWidth = 0.7 * unit;
    ctx.strokeStyle = 'rgba(251,248,241,0.28)';
    ctx.beginPath();
    for (const { start, end } of TESSELATION) {
      ctx.moveTo(pts[start].x, pts[start].y);
      ctx.lineTo(pts[end].x, pts[end].y);
    }
    ctx.stroke();

    ctx.lineWidth = 1.6 * unit;
    ctx.lineJoin = 'round';
    for (const [connections, color] of FEATURES) {
      ctx.strokeStyle = color;
      ctx.beginPath();
      for (const { start, end } of connections) {
        ctx.moveTo(pts[start].x, pts[start].y);
        ctx.lineTo(pts[end].x, pts[end].y);
      }
      ctx.stroke();
    }
  }
}
