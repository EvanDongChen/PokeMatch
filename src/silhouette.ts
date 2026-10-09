import { artworkUrl, SHAPES } from './pokemon.ts';

/** Points are normalised to the artwork square: 0..1 on both axes. */
export interface Point {
  x: number;
  y: number;
}

export interface Silhouette {
  image: HTMLImageElement;
  /** Solid black version of the artwork ("Who's that Pokémon?"). */
  shadow: HTMLCanvasElement;
  /** The rest describes the head, where the subject's face is mapped. */
  centroid: Point;
  /** Outline points, one per ray, ordered by angle around the centroid. */
  outline: Point[];
  /** Random points inside the head. */
  interior: Point[];
  /** Bounding box of the head. */
  box: { x: number; y: number; w: number; h: number };
  /** The eyes (left to right) and mouth found in the artwork, if any. */
  eyes: Feature[];
  mouth: Feature | null;
}

/** A facial feature's centre and width, as fractions of the artwork. */
export interface Feature {
  x: number;
  y: number;
  w: number;
}

const MASK_SIZE = 192;
export const OUTLINE_RAYS = 180;
const INTERIOR_SAMPLES = 700;

const cache = new Map<number, Promise<Silhouette>>();

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load ${src}`));
    img.src = src;
  });
}

/** Small deterministic PRNG so the same Pokémon always samples the same points. */
function rng(seed: number) {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
}

async function build(id: number): Promise<Silhouette> {
  const image = await loadImage(artworkUrl(id));

  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = maskCanvas.height = MASK_SIZE;
  const mctx = maskCanvas.getContext('2d', { willReadFrequently: true })!;
  mctx.drawImage(image, 0, 0, MASK_SIZE, MASK_SIZE);
  const { data } = mctx.getImageData(0, 0, MASK_SIZE, MASK_SIZE);
  // Only the head's bounding box counts (with a pixel of slack).
  const head = SHAPES.get(id)?.head;
  const [hx, hy, hw, hh] = (head?.box ?? [0, 0, 1, 1]).map((v) => v * MASK_SIZE);
  const feature = ([x, y, w]: number[]): Feature => ({ x, y, w });
  const solid = (x: number, y: number) =>
    x >= Math.floor(hx) - 1 &&
    y >= Math.floor(hy) - 1 &&
    x <= Math.ceil(hx + hw) &&
    y <= Math.ceil(hy + hh) &&
    x >= 0 && y >= 0 && x < MASK_SIZE && y < MASK_SIZE &&
    data[(y * MASK_SIZE + x) * 4 + 3] > 60;

  const filled: number[] = [];
  let sx = 0, sy = 0, minX = MASK_SIZE, minY = MASK_SIZE, maxX = 0, maxY = 0;
  for (let y = 0; y < MASK_SIZE; y++) {
    for (let x = 0; x < MASK_SIZE; x++) {
      if (!solid(x, y)) continue;
      filled.push(y * MASK_SIZE + x);
      sx += x;
      sy += y;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  const n = Math.max(1, filled.length);
  const cx = sx / n;
  const cy = sy / n;

  // Cast a ray from the centroid at each angle and keep the farthest solid pixel.
  const reach = MASK_SIZE * 0.75;
  const outline: Point[] = [];
  for (let i = 0; i < OUTLINE_RAYS; i++) {
    const a = (i / OUTLINE_RAYS) * Math.PI * 2;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    let last = 0;
    for (let r = 0; r < reach; r += 0.75) {
      if (solid(Math.round(cx + dx * r), Math.round(cy + dy * r))) last = r;
    }
    outline.push({ x: (cx + dx * last) / MASK_SIZE, y: (cy + dy * last) / MASK_SIZE });
  }

  const rand = rng(id * 7919 + 13);
  const interior: Point[] = [];
  for (let i = 0; i < INTERIOR_SAMPLES && filled.length; i++) {
    const p = filled[Math.floor(rand() * filled.length)];
    interior.push({
      x: ((p % MASK_SIZE) + rand()) / MASK_SIZE,
      y: (Math.floor(p / MASK_SIZE) + rand()) / MASK_SIZE,
    });
  }

  const shadow = document.createElement('canvas');
  shadow.width = shadow.height = 512;
  const sctx = shadow.getContext('2d')!;
  sctx.drawImage(image, 0, 0, 512, 512);
  sctx.globalCompositeOperation = 'source-in';
  sctx.fillStyle = '#2b2622';
  sctx.fillRect(0, 0, 512, 512);

  return {
    image,
    shadow,
    centroid: { x: cx / MASK_SIZE, y: cy / MASK_SIZE },
    outline,
    interior,
    eyes: head?.eyes?.map(feature) ?? [],
    mouth: head?.mouth ? feature(head.mouth) : null,
    box: {
      x: minX / MASK_SIZE,
      y: minY / MASK_SIZE,
      w: (maxX - minX + 1) / MASK_SIZE,
      h: (maxY - minY + 1) / MASK_SIZE,
    },
  };
}

export function loadSilhouette(id: number): Promise<Silhouette> {
  let p = cache.get(id);
  if (!p) {
    p = build(id);
    p.catch(() => cache.delete(id));
    cache.set(id, p);
  }
  return p;
}
