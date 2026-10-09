import { FaceLandmarker } from '@mediapipe/tasks-vision';
import type { FaceAnalysis } from './face.ts';
import { OUTLINE_RAYS, type Point, type Silhouette } from './silhouette.ts';
import type { TraitKey } from './traits.ts';

type Connection = (typeof FaceLandmarker.FACE_LANDMARKS_TESSELATION)[number];

// ------------------------------------------------------------------ landmarks

const uniq = (...sets: Connection[][]) => [...new Set(sets.flat().flatMap((c) => [c.start, c.end]))];

const OVAL = uniq(FaceLandmarker.FACE_LANDMARKS_FACE_OVAL);
const EYES = uniq(
  FaceLandmarker.FACE_LANDMARKS_LEFT_EYE,
  FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE,
  FaceLandmarker.FACE_LANDMARKS_LEFT_IRIS,
  FaceLandmarker.FACE_LANDMARKS_RIGHT_IRIS,
);
const BROWS = uniq(FaceLandmarker.FACE_LANDMARKS_LEFT_EYEBROW, FaceLandmarker.FACE_LANDMARKS_RIGHT_EYEBROW);
const LIPS = uniq(FaceLandmarker.FACE_LANDMARKS_LIPS);
const TESSELATION = FaceLandmarker.FACE_LANDMARKS_TESSELATION;
const CONTOURS = FaceLandmarker.FACE_LANDMARKS_CONTOURS;

/** Ink colours, matching the page's CSS tokens. */
const INK = '#2b2622';
const RED = '#b8322a';
const BLUE = '#2a4aa0';
const BROWN = '#6b4f35';
const GRAPHITE = '#7d7266';
const PHOTO_WHITE = '#fbf8f1';
const PLATE = '#efe6d2';

const COLORS = { oval: INK, eyes: BLUE, brows: BROWN, lips: RED, mesh: GRAPHITE };

const HAND = '"Kalam", "Comic Sans MS", cursive';
const TYPED = '"Courier Prime", "Courier New", monospace';

/** Landmarks that represent each trait, used for the labelled links. */
const TRAIT_POINTS: Record<TraitKey, number[]> = {
  round: OVAL,
  jaw: [172, 136, 150, 149, 176, 148, 152, 377, 400, 378, 379, 365, 397],
  sharp: [152, 148, 377, 176, 400, 175, 199],
  eyes: EYES,
  spacing: [133, 362, 168, 6],
  nose: [1, 2, 4, 5, 6, 98, 327, 168, 195, 197],
  mouth: LIPS,
  smile: LIPS,
  brow: BROWS,
  forehead: [10, 338, 297, 67, 109, 151, 9],
};

// --------------------------------------------------------------------- timing

/** Milliseconds on the stage clock. */
const T = {
  photoIn: 400,
  scanStart: 250,
  scanEnd: 1900,
  contoursEnd: 2400,
  searchStart: 2300,
  searchEnd: 4700,
  morphStart: 4700,
  flight: 1150,
  morphSpread: 800,
  revealStart: 6750,
  stamp: 7250,
  linksStart: 7400,
  end: 8400,
};

export type Phase = 'scan' | 'search' | 'morph' | 'reveal' | 'done';

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const progress = (t: number, a: number, b: number) => clamp01((t - a) / (b - a));
const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
const easeOut = (x: number) => 1 - (1 - x) ** 3;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Small tilts so the photo and plate look placed by hand. */
const FACE_TILT = -0.028;
const MON_TILT = 0.018;

interface Box {
  x: number;
  y: number;
  s: number;
}

interface Particle {
  index: number;
  color: string;
  /** Position in the face crop, 0..1. */
  src: Point;
  /** Position on the artwork, 0..1. */
  dst: Point;
  delay: number;
  arc: number;
  size: number;
}

interface Link {
  label: string;
  src: Point;
  dst: Point;
}

export interface PlayOptions {
  /** Pokémon flashed while "searching", in any order. */
  candidates: Promise<Silhouette>[];
  winner: Promise<Silhouette>;
  /** e.g. "No. 0134 Vaporeon" */
  winnerLabel: string;
  links: { key: TraitKey; label: string }[];
  /** 'full' runs the whole sequence; 'morph' only re-maps to a new Pokémon. */
  mode: 'full' | 'morph';
  onPhase?: (phase: Phase) => void;
}

function rotateAbout(p: Point, c: Point, angle: number): Point {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
}

/** A rubber stamp with ink gaps, rendered once and reused. */
function makeStamp(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 300;
  c.height = 104;
  const ctx = c.getContext('2d')!;
  ctx.strokeStyle = RED;
  ctx.fillStyle = RED;
  ctx.lineWidth = 5;
  ctx.strokeRect(6, 6, 288, 92);
  ctx.lineWidth = 2;
  ctx.strokeRect(15, 15, 270, 74);
  ctx.font = `700 46px ${TYPED}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('IDENTIFIED', 150, 55);
  // Knock out speckles so it reads as ink, not vector.
  ctx.globalCompositeOperation = 'destination-out';
  let seed = 42;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 260; i++) {
    ctx.globalAlpha = 0.3 + rand() * 0.7;
    ctx.beginPath();
    ctx.arc(rand() * 300, rand() * 104, rand() * 2.2, 0, Math.PI * 2);
    ctx.fill();
  }
  return c;
}

export class Stage {
  private ctx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private photo: HTMLCanvasElement | null = null;
  private crop = { x: 0, y: 0, s: 1 };
  private points: Point[] = [];
  private particles: Particle[] = [];
  private links: Link[] = [];
  private winner: Silhouette | null = null;
  private winnerLabel = '';
  private shown: Silhouette[] = [];
  private schedule: { at: number; sil: Silhouette }[] = [];
  private mode: 'full' | 'morph' = 'full';
  private clock = 0;
  private last = 0;
  private frame = 0;
  private phase: Phase = 'done';
  private onPhase?: (phase: Phase) => void;
  private resolveDone: (() => void) | null = null;
  private stamp = makeStamp();

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    // Redraw once the handwriting and typewriter fonts arrive.
    document.fonts.ready.then(() => this.phase === 'done' && this.draw(this.clock));
  }

  /** Square crop of the photo around the face, in photo pixels. */
  get faceCrop() {
    return this.crop;
  }

  private resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.phase === 'done' && this.photo) this.draw(this.clock);
  }

  /** Sets the analysed photo; landmark coordinates are in photo pixels. */
  setFace(photo: HTMLCanvasElement, face: FaceAnalysis) {
    this.photo = photo;
    const xs = face.points.map((p) => p.x);
    const ys = face.points.map((p) => p.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const size = Math.min(
      Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * 1.45,
      photo.width,
      photo.height,
    );
    this.crop = {
      x: Math.max(0, Math.min(photo.width - size, cx - size / 2)),
      y: Math.max(0, Math.min(photo.height - size, cy - size / 2)),
      s: size,
    };
    this.points = face.points.map((p) => ({
      x: (p.x - this.crop.x) / size,
      y: (p.y - this.crop.y) / size,
    }));
  }

  /** Plays the sequence; resolves when it has finished. */
  play(opts: PlayOptions): Promise<void> {
    cancelAnimationFrame(this.frame);
    this.resolveDone?.();
    this.mode = opts.mode;
    this.winnerLabel = opts.winnerLabel;
    this.onPhase = opts.onPhase;
    this.winner = null;
    this.shown = [];
    this.schedule = [];
    this.particles = [];
    this.links = [];
    this.clock = opts.mode === 'full' ? 0 : T.morphStart;

    for (const c of opts.candidates) c.then((s) => this.shown.push(s)).catch(() => {});
    opts.winner
      .then((sil) => {
        this.winner = sil;
        this.buildMapping(sil, opts.links);
      })
      .catch(() => this.skip());

    this.setPhase(opts.mode === 'full' ? 'scan' : 'morph');
    this.last = performance.now();
    this.frame = requestAnimationFrame(this.tick);
    return new Promise((resolve) => (this.resolveDone = resolve));
  }

  /** Jumps to the end of the sequence. */
  skip() {
    if (this.phase === 'done') return;
    this.clock = T.end;
    this.buildSchedule();
  }

  private setPhase(phase: Phase) {
    this.phase = phase;
    this.onPhase?.(phase);
  }

  private tick = (now: number) => {
    const dt = Math.min(64, now - this.last);
    this.last = now;
    // Hold the search until the winning artwork has loaded.
    const waiting = !this.winner && this.clock + dt >= T.searchEnd - 300;
    if (!waiting) this.clock += dt;

    const t = this.clock;
    if (this.mode === 'full' && t >= T.searchStart && this.schedule.length === 0) this.buildSchedule();

    const next: Phase =
      t >= T.end ? 'done' : t >= T.revealStart ? 'reveal' : t >= T.morphStart ? 'morph' : t >= T.searchStart ? 'search' : 'scan';
    if (next !== this.phase) this.setPhase(next);

    this.draw(t);

    if (this.phase === 'done') {
      this.resolveDone?.();
      this.resolveDone = null;
      return; // Static from here; resize() redraws.
    }
    this.frame = requestAnimationFrame(this.tick);
  };

  /** Slot-machine timings: quick flicks that slow down and land on the winner. */
  private buildSchedule() {
    const pool = this.shown.filter((s) => s !== this.winner);
    const times: number[] = [];
    let at = 0;
    for (let k = 0; k < pool.length; k++) {
      times.push(at);
      at += 60 * 1.22 ** k;
    }
    const span = T.searchEnd - 450 - T.searchStart;
    const scale = at > 0 ? Math.min(1, span / at) : 1;
    this.schedule = pool.map((sil, k) => ({ at: T.searchStart + times[k] * scale, sil }));
  }

  // --------------------------------------------------------------- mapping

  private buildMapping(sil: Silhouette, linkTraits: { key: TraitKey; label: string }[]) {
    const pts = this.points;
    const ovalSet = new Set(OVAL);
    const eyeSet = new Set(EYES);
    const browSet = new Set(BROWS);
    const lipSet = new Set(LIPS);

    const ovalPts = OVAL.map((i) => pts[i]);
    const minX = Math.min(...ovalPts.map((p) => p.x));
    const maxX = Math.max(...ovalPts.map((p) => p.x));
    const minY = Math.min(...ovalPts.map((p) => p.y));
    const maxY = Math.max(...ovalPts.map((p) => p.y));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;

    const outlineAt = (angle: number) => {
      const a = (angle + Math.PI * 2) % (Math.PI * 2);
      return sil.outline[Math.round((a / (Math.PI * 2)) * OUTLINE_RAYS) % OUTLINE_RAYS];
    };

    const nearestInterior = (target: Point) => {
      let best = sil.interior[0] ?? sil.centroid;
      let bestD = Infinity;
      for (const p of sil.interior) {
        const d = (p.x - target.x) ** 2 + (p.y - target.y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = p;
        }
      }
      return best;
    };

    const { box } = sil;
    let seed = 1234;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

    const dst: Point[] = pts.map((p, i) => {
      if (ovalSet.has(i)) return outlineAt(Math.atan2(p.y - cy, p.x - cx));
      // Place inner features at the same relative spot in the Pokémon's body.
      const u = (p.x - minX) / (maxX - minX);
      const v = (p.y - minY) / (maxY - minY);
      return nearestInterior({
        x: box.x + box.w * lerp(0.12, 0.88, u) + (rand() - 0.5) * 0.02,
        y: box.y + box.h * lerp(0.1, 0.9, v) + (rand() - 0.5) * 0.02,
      });
    });

    this.particles = pts.map((src, index) => {
      const color = ovalSet.has(index)
        ? COLORS.oval
        : eyeSet.has(index)
          ? COLORS.eyes
          : browSet.has(index)
            ? COLORS.brows
            : lipSet.has(index)
              ? COLORS.lips
              : COLORS.mesh;
      return {
        index,
        color,
        src,
        dst: dst[index],
        // A wave that leaves from the side nearest the Pokémon.
        delay: (1 - src.x) * T.morphSpread * 0.6 + rand() * T.morphSpread * 0.4,
        arc: (rand() - 0.5) * 0.9,
        size: color === COLORS.mesh ? 1.1 : 1.6,
      };
    });

    const centroid = (list: Point[]) => ({
      x: list.reduce((s, p) => s + p.x, 0) / list.length,
      y: list.reduce((s, p) => s + p.y, 0) / list.length,
    });
    // Traits that share landmarks (mouth size and smile) share one link.
    const merged = new Map<number[], string[]>();
    for (const { key, label } of linkTraits) {
      const set = TRAIT_POINTS[key];
      merged.set(set, [...(merged.get(set) ?? []), label]);
    }
    this.links = [...merged].map(([set, labels]) => {
      const idx = set.filter((i) => i < pts.length);
      return {
        label: labels.join(' & ').toLowerCase(),
        src: centroid(idx.map((i) => pts[i])),
        dst: centroid(idx.map((i) => dst[i])),
      };
    });
  }

  // --------------------------------------------------------------- drawing

  private layout() {
    const w = this.width;
    const h = this.height;
    if (w >= 640) {
      const s = Math.min(h * 0.66, w * 0.33);
      const gap = (w - 2 * s) / 3.2;
      const y = (h - s) / 2 - 22;
      return { face: { x: gap, y, s }, mon: { x: w - gap - s, y, s }, wide: true };
    }
    const s = Math.min(w * 0.6, h * 0.31);
    return { face: { x: (w - s) / 2, y: 30, s }, mon: { x: (w - s) / 2, y: h - 70 - s, s }, wide: false };
  }

  private center(b: Box): Point {
    return { x: b.x + b.s / 2, y: b.y + b.s / 2 };
  }

  private toFace(b: Box, p: Point) {
    return rotateAbout({ x: b.x + p.x * b.s, y: b.y + p.y * b.s }, this.center(b), FACE_TILT);
  }

  private toMon(b: Box, p: Point) {
    const pad = b.s * 0.07;
    return rotateAbout(
      { x: b.x + pad + p.x * (b.s - 2 * pad), y: b.y + pad + p.y * (b.s - 2 * pad) },
      this.center(b),
      MON_TILT,
    );
  }

  /** Runs `fn` in a frame rotated about the box centre. */
  private tilted(b: Box, angle: number, fn: () => void) {
    const c = this.center(b);
    this.ctx.save();
    this.ctx.translate(c.x, c.y);
    this.ctx.rotate(angle);
    this.ctx.translate(-c.x, -c.y);
    fn();
    this.ctx.restore();
  }

  private particlePos(p: Particle, t: number, face: Box, mon: Box, wide: boolean) {
    const start = this.toFace(face, p.src);
    const k = progress(t, T.morphStart + p.delay, T.morphStart + p.delay + T.flight);
    if (k <= 0 || !this.winner) return { ...start, k: 0 };
    const end = this.toMon(mon, p.dst);
    const e = easeInOut(k);
    const mx = (start.x + end.x) / 2;
    const my = (start.y + end.y) / 2;
    const bulge = (wide ? Math.abs(end.x - start.x) : Math.abs(end.y - start.y)) * p.arc;
    const ctrl = wide ? { x: mx, y: my + bulge } : { x: mx + bulge, y: my };
    const x = (1 - e) ** 2 * start.x + 2 * (1 - e) * e * ctrl.x + e * e * end.x;
    const y = (1 - e) ** 2 * start.y + 2 * (1 - e) * e * ctrl.y + e * e * end.y;
    return { x, y, k };
  }

  private text(text: string, x: number, y: number, font: string, color: string, alpha = 1, align: CanvasTextAlign = 'center') {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = font;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  private drawPolaroid(face: Box, photoAlpha: number) {
    const ctx = this.ctx;
    const pad = face.s * 0.045;
    const bottom = face.s * 0.15;
    this.tilted(face, FACE_TILT, () => {
      // Frame and its shadow on the page.
      ctx.save();
      ctx.shadowColor = 'rgba(60,40,20,0.22)';
      ctx.shadowBlur = 14;
      ctx.shadowOffsetY = 5;
      ctx.fillStyle = PHOTO_WHITE;
      ctx.fillRect(face.x - pad, face.y - pad, face.s + 2 * pad, face.s + pad + bottom);
      ctx.restore();

      ctx.save();
      ctx.globalAlpha = photoAlpha;
      ctx.filter = 'sepia(0.22) saturate(0.85) contrast(1.02)';
      ctx.drawImage(this.photo!, this.crop.x, this.crop.y, this.crop.s, this.crop.s, face.x, face.y, face.s, face.s);
      ctx.restore();
      if (photoAlpha < 1) {
        ctx.fillStyle = `rgba(251,248,241,${(1 - photoAlpha) * 0.9})`;
        ctx.fillRect(face.x, face.y, face.s, face.s);
      }

      this.text('subject', face.x + face.s / 2, face.y + face.s + bottom * 0.55, `400 ${Math.max(15, face.s * 0.06)}px ${HAND}`, BLUE, 0.9);

      // Masking tape across the top edge.
      const c = this.center(face);
      ctx.save();
      ctx.translate(c.x, face.y - pad);
      ctx.rotate(0.07);
      ctx.fillStyle = 'rgba(226,212,170,0.82)';
      ctx.fillRect(-face.s * 0.13, -face.s * 0.035, face.s * 0.26, face.s * 0.07);
      ctx.restore();
    });
  }

  private drawPlate(mon: Box) {
    const ctx = this.ctx;
    const pad = mon.s * 0.02;
    this.tilted(mon, MON_TILT, () => {
      ctx.save();
      ctx.shadowColor = 'rgba(60,40,20,0.15)';
      ctx.shadowBlur = 8;
      ctx.shadowOffsetY = 3;
      ctx.fillStyle = PLATE;
      ctx.fillRect(mon.x - pad, mon.y - pad, mon.s + 2 * pad, mon.s + 2 * pad);
      ctx.restore();
      ctx.strokeStyle = 'rgba(43,38,34,0.35)';
      ctx.lineWidth = 1;
      ctx.strokeRect(mon.x + mon.s * 0.03, mon.y + mon.s * 0.03, mon.s * 0.94, mon.s * 0.94);

      // Photo-mount corners
      const k = mon.s * 0.09;
      ctx.fillStyle = INK;
      const corners: [number, number, number, number][] = [
        [mon.x - pad, mon.y - pad, 1, 1],
        [mon.x + mon.s + pad, mon.y - pad, -1, 1],
        [mon.x - pad, mon.y + mon.s + pad, 1, -1],
        [mon.x + mon.s + pad, mon.y + mon.s + pad, -1, -1],
      ];
      for (const [x, y, dx, dy] of corners) {
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + dx * k, y);
        ctx.lineTo(x, y + dy * k);
        ctx.closePath();
        ctx.fill();
      }
    });
  }

  private draw(t: number) {
    const ctx = this.ctx;
    const { face, mon, wide } = this.layout();
    ctx.clearRect(0, 0, this.width, this.height);
    if (!this.photo) return;

    const morph = progress(t, T.morphStart, T.morphStart + T.morphSpread + T.flight);
    const reveal = progress(t, T.revealStart, T.revealStart + 700);
    const scanned = this.mode === 'morph' ? 1 : progress(t, T.scanStart, T.scanEnd);

    // The photo fades a little while its points are lifted off, then returns.
    const photoAlpha = (this.mode === 'morph' ? 1 : easeOut(progress(t, 0, T.photoIn))) * (1 - 0.6 * morph * (1 - 0.75 * reveal));
    this.drawPolaroid(face, photoAlpha);
    this.drawPlate(mon);

    // Pencil guide line sweeping down the photo.
    if (this.mode === 'full' && t > T.scanStart && t < T.scanEnd + 200) {
      const alpha = 1 - progress(t, T.scanEnd, T.scanEnd + 200);
      const y = easeInOut(scanned);
      const a = this.toFace(face, { x: -0.04, y });
      const b = this.toFace(face, { x: 1.04, y });
      ctx.save();
      ctx.globalAlpha = alpha * 0.8;
      ctx.strokeStyle = RED;
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.restore();
    }

    const revealedAt = (p: Point) => scanned >= clamp01(p.y);
    const pos = this.particles.length
      ? this.particles.map((p) => this.particlePos(p, t, face, mon, wide))
      : this.points.map((p) => ({ ...this.toFace(face, p), k: 0 }));

    // Graphite mesh
    const meshAlpha = (morph > 0 ? 0.16 : 0.2) * (1 - reveal);
    if (meshAlpha > 0.01) {
      ctx.save();
      ctx.strokeStyle = `rgba(80,70,60,${meshAlpha})`;
      ctx.lineWidth = 0.55;
      ctx.beginPath();
      for (const { start, end } of TESSELATION) {
        if (!revealedAt(this.points[start]) || !revealedAt(this.points[end])) continue;
        ctx.moveTo(pos[start].x, pos[start].y);
        ctx.lineTo(pos[end].x, pos[end].y);
      }
      ctx.stroke();
      ctx.restore();
    }

    // Inked feature contours once the plotting is done.
    const contourAlpha = (this.mode === 'full' ? easeOut(progress(t, T.scanEnd - 100, T.contoursEnd)) : 1) * (1 - morph);
    if (contourAlpha > 0.01) {
      ctx.save();
      ctx.globalAlpha = contourAlpha * 0.9;
      ctx.lineWidth = 1.4;
      ctx.lineJoin = 'round';
      for (const [set, color] of [
        [OVAL, COLORS.oval],
        [EYES, COLORS.eyes],
        [BROWS, COLORS.brows],
        [LIPS, COLORS.lips],
      ] as const) {
        const members = new Set<number>(set);
        ctx.strokeStyle = color;
        ctx.beginPath();
        for (const { start, end } of CONTOURS) {
          if (!members.has(start) || !members.has(end)) continue;
          ctx.moveTo(pos[start].x, pos[start].y);
          ctx.lineTo(pos[end].x, pos[end].y);
        }
        ctx.stroke();
      }
      ctx.restore();
    }

    this.drawSpecimen(t, mon, reveal);

    // Ink dots, with graphite trails while in flight.
    const dotFade = 1 - progress(t, T.revealStart + 100, T.revealStart + 800);
    if (dotFade > 0) {
      ctx.save();
      const list = this.particles.length
        ? this.particles
        : this.points.map((src, index) => ({ index, src, color: COLORS.mesh, size: 1.1 }) as Particle);
      for (const p of list) {
        const src = this.points[p.index];
        if (!revealedAt(src)) continue;
        const q = pos[p.index];
        const plotted = this.mode === 'full' ? progress(scanned, src.y, src.y + 0.04) : 1;
        const inFlight = q.k > 0 && q.k < 1;
        if (inFlight) {
          const back = this.particlePos(p, t - 90, face, mon, wide);
          ctx.globalAlpha = dotFade * 0.35;
          ctx.strokeStyle = p.color;
          ctx.lineWidth = 0.8;
          ctx.beginPath();
          ctx.moveTo(back.x, back.y);
          ctx.lineTo(q.x, q.y);
          ctx.stroke();
        }
        ctx.globalAlpha = dotFade * (q.k >= 1 ? 0.75 : 0.95);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(q.x, q.y, p.size * plotted, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    this.drawLinks(t, face, mon, wide);
    this.drawStamp(t, mon);

    // Figure captions
    const typed = `400 12px ${TYPED}`;
    const faceCap =
      this.mode === 'full' && scanned < 1
        ? `FIG. 1a  plotting… ${Math.round(scanned * 478)}/478`
        : 'FIG. 1a  subject, 478 landmarks';
    this.text(faceCap, face.x + face.s / 2, face.y + face.s * 1.15 + 24, typed, INK, 0.75);

    let monCap = 'FIG. 1b  awaiting comparison';
    if (t >= T.revealStart) monCap = `FIG. 1b  ${this.winnerLabel}`;
    else if (t >= T.morphStart) monCap = 'FIG. 1b  tracing features…';
    else if (t >= T.searchStart) monCap = `FIG. 1b  consulting index… ${this.searchCount(t)}/1025`;
    this.text(monCap, mon.x + mon.s / 2, mon.y + mon.s + 30, typed, INK, 0.75);
  }

  private currentCandidate(t: number): Silhouette | null {
    let current: Silhouette | null = null;
    for (const s of this.schedule) if (s.at <= t) current = s.sil;
    if (t >= T.searchEnd - 450 && this.winner) current = this.winner;
    return current;
  }

  private searchCount(t: number) {
    return Math.round(1025 * easeOut(progress(t, T.searchStart, T.searchEnd - 450)));
  }

  private drawSpecimen(t: number, mon: Box, reveal: number) {
    const ctx = this.ctx;
    const pad = mon.s * 0.07;
    const art = { x: mon.x + pad, y: mon.y + pad, s: mon.s - 2 * pad };

    if (t < T.searchStart && this.mode === 'full') {
      this.tilted(mon, MON_TILT, () =>
        this.text('?', mon.x + mon.s / 2, mon.y + mon.s / 2, `400 ${mon.s * 0.42}px ${HAND}`, GRAPHITE, 0.35),
      );
      return;
    }

    const showWinner = t >= T.searchEnd - 450 || this.mode === 'morph';
    const current = showWinner ? this.winner : this.currentCandidate(t);
    if (!current) return;

    this.tilted(mon, MON_TILT, () => {
      // Silhouette printed in ink, fading out as the colour print comes in.
      if (reveal < 1) {
        ctx.save();
        ctx.globalAlpha = (1 - reveal) * (current === this.winner ? 0.88 : 0.8);
        ctx.drawImage(current.shadow, art.x, art.y, art.s, art.s);
        ctx.restore();
      }

      // Red pen traces the outline as the face oval lands on it.
      if (current === this.winner && t >= T.morphStart) {
        const trace = easeInOut(progress(t, T.morphStart + 700, T.revealStart));
        const pts = current.outline.map((p) => ({ x: art.x + p.x * art.s, y: art.y + p.y * art.s }));
        const count = Math.floor(pts.length * trace);
        if (count > 1) {
          ctx.save();
          ctx.strokeStyle = RED;
          ctx.lineWidth = 1.8;
          ctx.lineJoin = 'round';
          ctx.globalAlpha = 0.9 * (1 - reveal);
          ctx.beginPath();
          ctx.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < count; i++) ctx.lineTo(pts[i].x, pts[i].y);
          if (trace >= 1) ctx.closePath();
          ctx.stroke();
          ctx.restore();
        }
      }

      // Colour print, multiplied into the paper.
      if (reveal > 0 && this.winner) {
        ctx.save();
        ctx.globalAlpha = easeOut(reveal);
        ctx.globalCompositeOperation = 'multiply';
        ctx.drawImage(this.winner.image, art.x, art.y, art.s, art.s);
        ctx.restore();
      }
    });
  }

  private drawStamp(t: number, mon: Box) {
    if (!this.winner || t < T.stamp) return;
    const k = progress(t, T.stamp, T.stamp + 220);
    const ctx = this.ctx;
    const w = Math.min(150, mon.s * 0.5);
    const h = (w * this.stamp.height) / this.stamp.width;
    const scale = lerp(1.5, 1, easeOut(k));
    ctx.save();
    ctx.translate(mon.x + mon.s * 0.8, mon.y + mon.s * 0.88);
    ctx.rotate(-0.16);
    ctx.scale(scale, scale);
    ctx.globalAlpha = 0.85 * k;
    ctx.globalCompositeOperation = 'multiply';
    ctx.drawImage(this.stamp, -w / 2, -h / 2, w, h);
    ctx.restore();
  }

  private drawLinks(t: number, face: Box, mon: Box, wide: boolean) {
    if (!this.winner || t < T.linksStart) return;
    const ctx = this.ctx;
    const grow = easeInOut(progress(t, T.linksStart, T.linksStart + 700));
    const font = `400 ${wide ? 18 : 16}px ${HAND}`;

    const curves = this.links.map((link, li) => {
      const a = this.toFace(face, link.src);
      const b = this.toMon(mon, link.dst);
      const c1 = wide ? { x: lerp(a.x, b.x, 0.45), y: a.y } : { x: a.x, y: lerp(a.y, b.y, 0.45) };
      const c2 = wide ? { x: lerp(a.x, b.x, 0.55), y: b.y } : { x: b.x, y: lerp(a.y, b.y, 0.55) };
      // A cubic with a slight hand tremor.
      const at = (u: number) => {
        const x = (1 - u) ** 3 * a.x + 3 * (1 - u) ** 2 * u * c1.x + 3 * (1 - u) * u * u * c2.x + u ** 3 * b.x;
        const y = (1 - u) ** 3 * a.y + 3 * (1 - u) ** 2 * u * c1.y + 3 * (1 - u) * u * u * c2.y + u ** 3 * b.y;
        const wobble = Math.sin(u * 19 + li * 2.1) * 0.9 * Math.sin(u * Math.PI);
        return { x: x + (wide ? 0 : wobble), y: y + (wide ? wobble : 0) };
      };
      return { a, b, at };
    });

    // Label positions: in the gap, pushed apart so they never overlap.
    ctx.save();
    ctx.font = font;
    const widths = this.links.map((l) => ctx.measureText(l.label).width + 12);
    ctx.restore();
    const labelPos: Point[] = curves.map((c) => c.at(0.5));
    if (wide) {
      const order = labelPos.map((_, i) => i).sort((i, j) => labelPos[i].y - labelPos[j].y);
      for (let k = 1; k < order.length; k++) {
        const prev = labelPos[order[k - 1]];
        const cur = labelPos[order[k]];
        if (cur.y - prev.y < 30) cur.y = prev.y + 30;
      }
    } else {
      const rows: number[][] = [[]];
      let rowW = 0;
      this.links.forEach((_, idx) => {
        if (rows.at(-1)!.length && rowW + widths[idx] + 10 > this.width - 32) {
          rows.push([]);
          rowW = 0;
        }
        rows.at(-1)!.push(idx);
        rowW += widths[idx] + 10;
      });
      const gapTop = face.y + face.s * 1.15 + 44;
      const gapBottom = mon.y - 10;
      const startY = (gapTop + gapBottom) / 2 - ((rows.length - 1) * 28) / 2;
      rows.forEach((row, r) => {
        const total = row.reduce((s, idx) => s + widths[idx], 0) + (row.length - 1) * 10;
        let x = this.width / 2 - total / 2;
        for (const idx of row) {
          labelPos[idx] = { x: x + widths[idx] / 2, y: startY + r * 28 };
          x += widths[idx] + 10;
        }
      });
    }

    curves.forEach(({ a, b, at }) => {
      ctx.save();
      ctx.strokeStyle = BLUE;
      ctx.lineWidth = 1.3;
      ctx.lineCap = 'round';
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      const steps = 48;
      const upto = Math.floor(steps * grow);
      for (let s = 0; s <= upto; s++) {
        const p = at(s / steps);
        if (s === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();

      // Circle the source feature, and an arrowhead at the Pokémon.
      ctx.beginPath();
      ctx.ellipse(a.x, a.y, 7, 6, 0.3, 0, Math.PI * 2);
      ctx.stroke();
      if (grow >= 1) {
        const p = at(0.96);
        const ang = Math.atan2(b.y - p.y, b.x - p.x);
        ctx.beginPath();
        ctx.moveTo(b.x - Math.cos(ang - 0.45) * 9, b.y - Math.sin(ang - 0.45) * 9);
        ctx.lineTo(b.x, b.y);
        ctx.lineTo(b.x - Math.cos(ang + 0.45) * 9, b.y - Math.sin(ang + 0.45) * 9);
        ctx.stroke();
      }
      ctx.restore();
    });

    // Handwritten notes with a highlighter swipe, drawn last so they sit on top.
    this.links.forEach((link, i) => {
      const alpha = progress(t, T.linksStart + 400 + i * 150, T.linksStart + 750 + i * 150);
      if (alpha <= 0) return;
      const { x, y } = labelPos[i];
      const w = widths[i];
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = 'rgba(255,214,64,0.55)';
      ctx.beginPath();
      ctx.moveTo(x - w / 2, y - 7);
      ctx.lineTo(x + w / 2 + 2, y - 10);
      ctx.lineTo(x + w / 2, y + 9);
      ctx.lineTo(x - w / 2 - 2, y + 11);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      this.text(link.label, x, y + 1, font, BLUE, alpha);
    });
  }
}
