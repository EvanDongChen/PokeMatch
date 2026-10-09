import { FaceLandmarker } from '@mediapipe/tasks-vision';

type Connection = (typeof FaceLandmarker.FACE_LANDMARKS_TESSELATION)[number];
import type { FaceAnalysis } from './face.ts';
import { OUTLINE_RAYS, type Point, type Silhouette } from './silhouette.ts';
import type { TraitKey } from './traits.ts';

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

const COLORS = {
  oval: '#ffffff',
  eyes: '#5ee7ff',
  brows: '#ffcb05',
  lips: '#ff5c8a',
  mesh: '#9aa4ff',
};

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
  photoIn: 350,
  scanStart: 250,
  scanEnd: 1900,
  contoursEnd: 2400,
  searchStart: 2300,
  searchEnd: 4700,
  morphStart: 4700,
  flight: 1150,
  morphSpread: 800,
  revealStart: 6750,
  linksStart: 7150,
  end: 8100,
};

export type Phase = 'scan' | 'search' | 'morph' | 'reveal' | 'done';

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const progress = (t: number, a: number, b: number) => clamp01((t - a) / (b - a));
const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
const easeOut = (x: number) => 1 - (1 - x) ** 3;
const easeOutBack = (x: number) => 1 + 2.4 * (x - 1) ** 3 + 1.4 * (x - 1) ** 2;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

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
  winnerLabel: string;
  accent: string;
  links: { key: TraitKey; label: string }[];
  /** 'full' runs the whole sequence; 'morph' only re-maps to a new Pokémon. */
  mode: 'full' | 'morph';
  onPhase?: (phase: Phase) => void;
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
  private accent = '#ffcb05';
  private shown: Silhouette[] = [];
  private schedule: { at: number; sil: Silhouette }[] = [];
  private mode: 'full' | 'morph' = 'full';
  private clock = 0;
  private last = 0;
  private frame = 0;
  private phase: Phase = 'done';
  private onPhase?: (phase: Phase) => void;
  private resolveDone: (() => void) | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
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

  /** Square crop of the photo around the face, in photo pixels. */
  get faceCrop() {
    return this.crop;
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

  /** Plays the sequence; resolves when the reveal has finished. */
  play(opts: PlayOptions): Promise<void> {
    cancelAnimationFrame(this.frame);
    this.resolveDone?.();
    this.mode = opts.mode;
    this.accent = opts.accent;
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

    if (this.phase === 'done' && this.resolveDone) {
      this.resolveDone();
      this.resolveDone = null;
    }
    // Keep animating gently after the reveal (pulses along the links).
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

    // Bounding box and centre of the face oval in crop space.
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
      const target = {
        x: box.x + box.w * lerp(0.12, 0.88, u) + (rand() - 0.5) * 0.02,
        y: box.y + box.h * lerp(0.1, 0.9, v) + (rand() - 0.5) * 0.02,
      };
      return nearestInterior(target);
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
      const featured = color !== COLORS.mesh;
      return {
        index,
        color,
        src,
        dst: dst[index],
        // A wave that leaves from the side nearest the Pokémon.
        delay: (1 - src.x) * T.morphSpread * 0.6 + rand() * T.morphSpread * 0.4,
        arc: (rand() - 0.5) * 0.9,
        size: featured ? 1.9 : 1.3,
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
      return { label: labels.join(' + '), src: centroid(idx.map((i) => pts[i])), dst: centroid(idx.map((i) => dst[i])) };
    });
  }

  // --------------------------------------------------------------- drawing

  private layout() {
    const w = this.width;
    const h = this.height;
    if (w >= 640) {
      const s = Math.min(h * 0.8, w * 0.36);
      const gap = (w - 2 * s) / 3.2;
      return { face: { x: gap, y: (h - s) / 2 - 8, s }, mon: { x: w - gap - s, y: (h - s) / 2 - 8, s }, wide: true };
    }
    const s = Math.min(w * 0.64, h * 0.36);
    return { face: { x: (w - s) / 2, y: 28, s }, mon: { x: (w - s) / 2, y: h - 44 - s, s }, wide: false };
  }

  private toFace(b: Box, p: Point) {
    return { x: b.x + p.x * b.s, y: b.y + p.y * b.s };
  }

  private toMon(b: Box, p: Point) {
    const pad = b.s * 0.08;
    return { x: b.x + pad + p.x * (b.s - 2 * pad), y: b.y + pad + p.y * (b.s - 2 * pad) };
  }

  private particlePos(p: Particle, t: number, face: Box, mon: Box, wide: boolean) {
    const start = this.toFace(face, p.src);
    const k = progress(t, T.morphStart + p.delay, T.morphStart + p.delay + T.flight);
    if (k <= 0 || !this.winner) return { ...start, k: 0 };
    const end = this.toMon(mon, p.dst);
    const e = easeInOut(k);
    // Quadratic bezier with a sideways bulge so paths fan out.
    const mx = (start.x + end.x) / 2;
    const my = (start.y + end.y) / 2;
    const bulge = (wide ? Math.abs(end.x - start.x) : Math.abs(end.y - start.y)) * p.arc;
    const ctrl = wide ? { x: mx, y: my + bulge } : { x: mx + bulge, y: my };
    const x = (1 - e) ** 2 * start.x + 2 * (1 - e) * e * ctrl.x + e * e * end.x;
    const y = (1 - e) ** 2 * start.y + 2 * (1 - e) * e * ctrl.y + e * e * end.y;
    return { x, y, k };
  }

  private roundRect(b: Box, r = 22) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.roundRect(b.x, b.y, b.s, b.s, r);
  }

  private brackets(b: Box, color: string, alpha: number) {
    const ctx = this.ctx;
    const len = b.s * 0.09;
    const o = 8;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    const corners: [number, number, number, number][] = [
      [b.x - o, b.y - o, 1, 1],
      [b.x + b.s + o, b.y - o, -1, 1],
      [b.x - o, b.y + b.s + o, 1, -1],
      [b.x + b.s + o, b.y + b.s + o, -1, -1],
    ];
    for (const [x, y, dx, dy] of corners) {
      ctx.beginPath();
      ctx.moveTo(x, y + dy * len);
      ctx.lineTo(x, y);
      ctx.lineTo(x + dx * len, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  private label(text: string, x: number, y: number, color: string, alpha = 1, align: CanvasTextAlign = 'center') {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = '600 11px "JetBrains Mono", ui-monospace, monospace';
    ctx.letterSpacing = '2px';
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  private draw(t: number) {
    const ctx = this.ctx;
    const { face, mon, wide } = this.layout();
    ctx.clearRect(0, 0, this.width, this.height);
    if (!this.photo) return;

    const morph = progress(t, T.morphStart, T.morphStart + T.morphSpread + T.flight);
    const reveal = progress(t, T.revealStart, T.revealStart + 700);
    const scanned = this.mode === 'morph' ? 1 : progress(t, T.scanStart, T.scanEnd);

    // Panels
    for (const b of [face, mon]) {
      this.roundRect(b);
      ctx.fillStyle = 'rgba(255,255,255,0.035)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.09)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    this.brackets(face, '#5ee7ff', 0.8);
    this.brackets(mon, this.accent, 0.8);

    // Photo
    // The photo dims while its points fly away, then mostly recovers.
    const photoAlpha =
      (this.mode === 'morph' ? 1 : easeOut(progress(t, 0, T.photoIn))) * (1 - 0.55 * morph * (1 - 0.6 * reveal));
    ctx.save();
    this.roundRect(face);
    ctx.clip();
    ctx.globalAlpha = photoAlpha;
    ctx.drawImage(this.photo, this.crop.x, this.crop.y, this.crop.s, this.crop.s, face.x, face.y, face.s, face.s);
    const shade = ctx.createLinearGradient(0, face.y, 0, face.y + face.s);
    shade.addColorStop(0, 'rgba(7,7,16,0.15)');
    shade.addColorStop(1, 'rgba(7,7,16,0.55)');
    ctx.fillStyle = shade;
    ctx.fillRect(face.x, face.y, face.s, face.s);
    ctx.restore();

    // Scan line
    if (this.mode === 'full' && t > T.scanStart && t < T.scanEnd + 200) {
      const y = face.y + face.s * easeInOut(scanned);
      const alpha = 1 - progress(t, T.scanEnd, T.scanEnd + 200);
      ctx.save();
      this.roundRect(face);
      ctx.clip();
      const glow = ctx.createLinearGradient(0, y - 70, 0, y);
      glow.addColorStop(0, 'rgba(94,231,255,0)');
      glow.addColorStop(1, `rgba(94,231,255,${0.28 * alpha})`);
      ctx.fillStyle = glow;
      ctx.fillRect(face.x, y - 70, face.s, 70);
      ctx.fillStyle = `rgba(190,248,255,${alpha})`;
      ctx.shadowColor = '#5ee7ff';
      ctx.shadowBlur = 16;
      ctx.fillRect(face.x, y - 1, face.s, 2);
      ctx.restore();
    }

    // Positions of every landmark (on the face, or in flight).
    const revealedAt = (p: Point) => scanned >= clamp01(p.y);
    const pos = this.particles.length
      ? this.particles.map((p) => this.particlePos(p, t, face, mon, wide))
      : this.points.map((p) => ({ ...this.toFace(face, p), k: 0 }));

    // Mesh: faint before the morph, stretching across while particles fly.
    const meshAlpha = (morph > 0 ? 0.13 : 0.16) * (1 - reveal);
    if (meshAlpha > 0.01) {
      ctx.save();
      ctx.strokeStyle = `rgba(154,164,255,${meshAlpha})`;
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      for (const { start, end } of TESSELATION) {
        if (!revealedAt(this.points[start]) || !revealedAt(this.points[end])) continue;
        ctx.moveTo(pos[start].x, pos[start].y);
        ctx.lineTo(pos[end].x, pos[end].y);
      }
      ctx.stroke();
      ctx.restore();
    }

    // Glowing feature contours once the scan completes.
    const contourAlpha =
      (this.mode === 'full' ? easeOut(progress(t, T.scanEnd - 100, T.contoursEnd)) : 1) * (1 - morph);
    if (contourAlpha > 0.01) {
      ctx.save();
      ctx.globalAlpha = contourAlpha;
      ctx.lineWidth = 1.6;
      ctx.shadowBlur = 10;
      for (const [set, color] of [
        [OVAL, COLORS.oval],
        [EYES, COLORS.eyes],
        [BROWS, COLORS.brows],
        [LIPS, COLORS.lips],
      ] as const) {
        const members = new Set<number>(set);
        ctx.strokeStyle = color;
        ctx.shadowColor = color;
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

    // Pokémon panel: search flicker, then silhouette, then reveal.
    this.drawMon(t, mon, reveal);

    // Particles
    const particleFade = 1 - progress(t, T.revealStart + 150, T.revealStart + 900);
    if (particleFade > 0) {
      ctx.save();
      const list = this.particles.length
        ? this.particles
        : this.points.map((src, index) => ({ index, src, color: COLORS.mesh, size: 1.3 }) as Particle);
      for (const p of list) {
        const src = this.points[p.index];
        if (!revealedAt(src)) continue;
        const q = pos[p.index];
        // Pop in just after the scan line passes.
        const pop = this.mode === 'full' ? progress(scanned, src.y, src.y + 0.06) : 1;
        const inFlight = q.k > 0 && q.k < 1;
        const r = p.size * (pop < 1 ? 1 + (1 - pop) * 1.8 : 1) * (inFlight ? 1.25 : 1);
        ctx.globalAlpha = particleFade * Math.min(1, pop * 1.4) * (q.k >= 1 ? 0.85 : 1);
        ctx.fillStyle = p.color;
        if (inFlight) {
          // Comet trail pointing back along the path.
          const back = this.particlePos(p, t - 70, face, mon, wide);
          ctx.strokeStyle = p.color;
          ctx.lineWidth = r * 1.1;
          ctx.globalAlpha *= 0.5;
          ctx.beginPath();
          ctx.moveTo(back.x, back.y);
          ctx.lineTo(q.x, q.y);
          ctx.stroke();
          ctx.globalAlpha /= 0.5;
        }
        ctx.beginPath();
        ctx.arc(q.x, q.y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    // Labelled links between matching features.
    this.drawLinks(t, face, mon);

    // Captions
    const capY = face.y + face.s + 26;
    this.label(
      this.mode === 'full' && scanned < 1 ? `SCANNING · ${Math.round(scanned * 478)} PTS` : 'SUBJECT · 478 LANDMARKS',
      face.x + face.s / 2,
      capY,
      'rgba(190,248,255,0.85)',
    );
    let monCaption = '';
    if (t >= T.revealStart) monCaption = this.winnerLabel;
    else if (t >= T.morphStart) monCaption = 'MAPPING FEATURES…';
    else if (t >= T.searchStart) {
      const current = this.currentCandidate(t);
      monCaption = current ? `SEARCHING · ${this.searchCount(t)} / 1025` : 'SEARCHING…';
    } else monCaption = 'AWAITING SCAN';
    this.label(monCaption, mon.x + mon.s / 2, mon.y + mon.s + 26, this.accent, t >= T.searchStart ? 1 : 0.5);

    // Flash on reveal
    if (t >= T.revealStart && t < T.revealStart + 600) {
      const f = 1 - progress(t, T.revealStart, T.revealStart + 600);
      const c = { x: mon.x + mon.s / 2, y: mon.y + mon.s / 2 };
      const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, mon.s * 0.9);
      g.addColorStop(0, `rgba(255,255,255,${0.85 * f})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(mon.x - mon.s, mon.y - mon.s, mon.s * 3, mon.s * 3);
    }
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

  private drawMon(t: number, mon: Box, reveal: number) {
    const ctx = this.ctx;
    const pad = mon.s * 0.08;
    const art = { x: mon.x + pad, y: mon.y + pad, s: mon.s - 2 * pad };

    // Coloured glow behind the panel
    const glowStrength = t >= T.searchStart ? 0.35 + 0.4 * reveal : 0.12;
    const g = ctx.createRadialGradient(
      mon.x + mon.s / 2, mon.y + mon.s / 2, 0,
      mon.x + mon.s / 2, mon.y + mon.s / 2, mon.s * 0.6,
    );
    g.addColorStop(0, this.hexAlpha(this.accent, glowStrength));
    g.addColorStop(1, this.hexAlpha(this.accent, 0));
    ctx.save();
    this.roundRect(mon);
    ctx.clip();
    ctx.fillStyle = g;
    ctx.fillRect(mon.x, mon.y, mon.s, mon.s);
    ctx.restore();

    if (t < T.searchStart) {
      ctx.save();
      ctx.font = `700 ${mon.s * 0.4}px "Space Grotesk", system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.fillText('?', mon.x + mon.s / 2, mon.y + mon.s / 2);
      ctx.restore();
      return;
    }

    const showWinner = t >= T.searchEnd - 450 || this.mode === 'morph';
    const current = showWinner ? this.winner : this.currentCandidate(t);
    if (!current) return;

    // Shadow form, with an outline that traces itself as the oval lands.
    if (reveal < 1) {
      ctx.save();
      ctx.globalAlpha = 1 - reveal;
      ctx.shadowColor = this.accent;
      ctx.shadowBlur = 24;
      ctx.drawImage(current.shadow, art.x, art.y, art.s, art.s);
      ctx.restore();
    }

    if (current === this.winner && t >= T.morphStart) {
      const trace = easeInOut(progress(t, T.morphStart + 700, T.revealStart));
      const pts = current.outline.map((p) => ({ x: art.x + p.x * art.s, y: art.y + p.y * art.s }));
      ctx.save();
      ctx.strokeStyle = this.accent;
      ctx.shadowColor = this.accent;
      ctx.shadowBlur = 12;
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.9 * (1 - reveal * 0.75);
      const count = Math.floor(pts.length * trace);
      if (count > 1) {
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < count; i++) ctx.lineTo(pts[i].x, pts[i].y);
        if (trace >= 1) ctx.closePath();
        ctx.stroke();
      }
      ctx.restore();
    }

    if (reveal > 0 && this.winner) {
      const scale = lerp(0.82, 1, easeOutBack(reveal));
      const s = art.s * scale;
      ctx.save();
      ctx.globalAlpha = reveal;
      ctx.shadowColor = 'rgba(0,0,0,0.45)';
      ctx.shadowBlur = 24;
      ctx.shadowOffsetY = 10;
      ctx.drawImage(this.winner.image, art.x + (art.s - s) / 2, art.y + (art.s - s) / 2, s, s);
      ctx.restore();

      // Ring burst
      const ring = progress(t, T.revealStart, T.revealStart + 900);
      if (ring < 1) {
        ctx.save();
        ctx.strokeStyle = this.accent;
        ctx.globalAlpha = 1 - ring;
        ctx.lineWidth = 3 * (1 - ring) + 0.5;
        ctx.beginPath();
        ctx.arc(mon.x + mon.s / 2, mon.y + mon.s / 2, mon.s * (0.3 + 0.55 * easeOut(ring)), 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  private drawLinks(t: number, face: Box, mon: Box) {
    if (!this.winner || t < T.linksStart) return;
    const ctx = this.ctx;
    const grow = easeInOut(progress(t, T.linksStart, T.linksStart + 800));
    const { wide } = this.layout();

    const curves = this.links.map((link) => {
      const a = this.toFace(face, link.src);
      const b = this.toMon(mon, link.dst);
      const ctrl1 = wide ? { x: lerp(a.x, b.x, 0.45), y: a.y } : { x: a.x, y: lerp(a.y, b.y, 0.45) };
      const ctrl2 = wide ? { x: lerp(a.x, b.x, 0.55), y: b.y } : { x: b.x, y: lerp(a.y, b.y, 0.55) };
      const at = (u: number) => ({
        x: (1 - u) ** 3 * a.x + 3 * (1 - u) ** 2 * u * ctrl1.x + 3 * (1 - u) * u * u * ctrl2.x + u ** 3 * b.x,
        y: (1 - u) ** 3 * a.y + 3 * (1 - u) ** 2 * u * ctrl1.y + 3 * (1 - u) * u * u * ctrl2.y + u ** 3 * b.y,
      });
      return { a, b, at, mid: at(0.5) };
    });

    // Push label pills apart so they never overlap.
    const axis = wide ? 'y' : 'x';
    const minGap = wide ? 28 : 0;
    const order = curves.map((_, i) => i).sort((i, j) => curves[i].mid[axis] - curves[j].mid[axis]);
    const labelPos = curves.map((c) => ({ ...c.mid }));
    if (wide) {
      for (let k = 1; k < order.length; k++) {
        const prev = labelPos[order[k - 1]];
        const cur = labelPos[order[k]];
        if (cur.y - prev.y < minGap) cur.y = prev.y + minGap;
      }
    } else {
      // Stacked layout: flow labels into centred rows across the gap.
      ctx.save();
      ctx.font = '600 10.5px "JetBrains Mono", ui-monospace, monospace';
      ctx.letterSpacing = '1.5px';
      const widths = this.links.map((l) => ctx.measureText(l.label.toUpperCase()).width + 20);
      ctx.restore();
      const maxRow = this.width - 32;
      const rows: number[][] = [[]];
      let rowW = 0;
      for (const idx of order) {
        if (rows.at(-1)!.length && rowW + widths[idx] + 8 > maxRow) {
          rows.push([]);
          rowW = 0;
        }
        rows.at(-1)!.push(idx);
        rowW += widths[idx] + 8;
      }
      const gapTop = face.y + face.s + 42;
      const gapBottom = mon.y - 14;
      const startY = (gapTop + gapBottom) / 2 - ((rows.length - 1) * 26) / 2;
      rows.forEach((row, r) => {
        const total = row.reduce((s, idx) => s + widths[idx], 0) + (row.length - 1) * 8;
        let x = this.width / 2 - total / 2;
        for (const idx of row) {
          labelPos[idx] = { x: x + widths[idx] / 2, y: startY + r * 26 };
          x += widths[idx] + 8;
        }
      });
    }

    // Pills are drawn after every line so lines never cross over them.
    const pills: (() => void)[] = [];

    curves.forEach(({ a, b, at }, i) => {
      const link = this.links[i];

      ctx.save();
      const grad = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
      grad.addColorStop(0, '#5ee7ff');
      grad.addColorStop(1, this.accent);
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.85;
      ctx.setLineDash([4, 5]);
      ctx.beginPath();
      const steps = 40;
      for (let s = 0; s <= steps * grow; s++) {
        const p = at(s / steps);
        if (s === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
      ctx.setLineDash([]);

      // End points
      for (const [p, color, show] of [
        [a, '#5ee7ff', true],
        [b, this.accent, grow >= 1],
      ] as const) {
        if (!show) continue;
        ctx.fillStyle = color;
        ctx.shadowColor = color;
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      // A pulse travelling along the link, forever.
      if (grow >= 1) {
        const u = ((t - T.linksStart) / 1800 + i * 0.33) % 1;
        const p = at(u);
        ctx.fillStyle = '#fff';
        ctx.shadowColor = '#fff';
        ctx.shadowBlur = 12;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }

      // Label pill at the midpoint, staggered so they don't overlap.
      const labelAlpha = progress(t, T.linksStart + 500 + i * 120, T.linksStart + 900 + i * 120);
      ctx.restore();
      if (labelAlpha > 0) {
        pills.push(() => {
          const { x: lx, y: ly } = labelPos[i];
          ctx.save();
          ctx.globalAlpha = labelAlpha;
          ctx.font = '600 10.5px "JetBrains Mono", ui-monospace, monospace';
          ctx.letterSpacing = '1.5px';
          const text = link.label.toUpperCase();
          const w = ctx.measureText(text).width + 20;
          ctx.fillStyle = 'rgba(12,12,24,0.92)';
          ctx.strokeStyle = this.hexAlpha(this.accent, 0.6);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.roundRect(lx - w / 2, ly - 11, w, 22, 11);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = '#fff';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(text, lx, ly + 0.5);
          ctx.restore();
        });
      }
    });
    for (const draw of pills) draw();
  }

  private hexAlpha(hex: string, alpha: number) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
  }
}
