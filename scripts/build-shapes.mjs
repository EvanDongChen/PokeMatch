// Measures the silhouette of every Pokémon's official artwork, and of its
// head, eyes and mouth, and writes src/data/shapes.json. Artwork is cached in
// .cache/artwork/ and detections in .cache/ (the first run takes a while).
// Run with `npm run build:shapes` (after build:pokedex).
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { PNG } from 'pngjs';

const DEX = new URL('../src/data/pokedex.json', import.meta.url);
const OUT = new URL('../src/data/shapes.json', import.meta.url);
const CACHE = new URL('../.cache/artwork/', import.meta.url);
const HEADS = new URL('../.cache/heads.json', import.meta.url);
/**
 * Hand-placed fixes, edited with tools/features.html. Each entry may give
 * head: [x, y, w, h], eyes: [[x, y, w], ...] and mouth: [x, y, w] | null,
 * as fractions of the artwork.
 */
const OVERRIDES_FILE = new URL('./head-overrides.json', import.meta.url);
const FEATURES = new URL('../.cache/features.json', import.meta.url);
const ART = (id) =>
  `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${id}.png`;
const CONCURRENCY = 16;
const ALPHA = 60;
const RAYS = 180;

/** Zero-shot object detector used to find heads, and what it is asked to find. */
const HEAD_MODEL = 'Xenova/owlvit-base-patch32';
const HEAD_LABELS = ['a head', 'a face'];
/** Detections scoring below this are ignored. */
const MIN_DETECTION = 0.03;
/** A detection covering more of the figure than this has boxed the whole creature. */
const MAX_HEAD_COVER = 0.6;
/** Face boxes are grown by this factor to take in the whole head. */
const FACE_TO_HEAD = 1.25;
/** What is looked for inside each head: eyes first, then the mouth. */
const FEATURE_LABELS = ['an eye', 'a mouth'];
/** Margin around the head box when searching it for eyes and a mouth. */
const FEATURE_MARGIN = 0.1;
/**
 * Eye and mouth detections scoring below these are ignored. Eyes score low
 * (around 0.02) even when the box is right, so the bar is low.
 */
const MIN_EYE = 0.012;
const MIN_MOUTH = 0.02;
/** A second eye must score at least this fraction of the first. */
const SECOND_EYE = 0.35;

async function artwork(id) {
  const file = new URL(`${id}.png`, CACHE);
  try {
    await access(file);
  } catch {
    const res = await fetch(ART(id));
    if (!res.ok) throw new Error(`${res.status} ${ART(id)}`);
    await writeFile(file, Buffer.from(await res.arrayBuffer()));
  }
  return PNG.sync.read(await readFile(file));
}

/** Andrew's monotone chain; returns hull area of a point set. */
function hullArea(points) {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (const p of pts.reverse()) {
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), p) <= 0) upper.pop();
    upper.push(p);
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  let area = 0;
  for (let i = 0; i < hull.length; i++) {
    const [x1, y1] = hull[i];
    const [x2, y2] = hull[(i + 1) % hull.length];
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area) / 2;
}

/** Shape measurements of the pixels where `solid(x, y)` is true. */
function outlineStats(solid, W, H) {
  let area = 0, sx = 0, sy = 0;
  let minX = W, maxX = 0, minY = H, maxY = 0;
  const boundary = [];
  const rowWidth = new Array(H).fill(0);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!solid(x, y)) continue;
      area++;
      sx += x;
      sy += y;
      rowWidth[y]++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (!solid(x - 1, y) || !solid(x + 1, y) || !solid(x, y - 1) || !solid(x, y + 1)) boundary.push([x, y]);
    }
  }
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const cx = sx / area;
  const cy = sy / area;

  // Farthest solid pixel along rays from the centroid.
  const radii = [];
  for (let i = 0; i < RAYS; i++) {
    const a = (i / RAYS) * Math.PI * 2;
    let last = 0;
    for (let r = 0; r < Math.max(W, H); r += 1) {
      if (solid(Math.round(cx + Math.cos(a) * r), Math.round(cy + Math.sin(a) * r))) last = r;
    }
    radii.push(last);
  }
  const meanR = radii.reduce((s, r) => s + r, 0) / RAYS;
  const sdR = Math.sqrt(radii.reduce((s, r) => s + (r - meanR) ** 2, 0) / RAYS);
  // Jaggedness: deviation from a smoothed radial profile (spikes, horns, limbs).
  let jag = 0;
  for (let i = 0; i < RAYS; i++) {
    let smooth = 0;
    for (let k = -8; k <= 8; k++) smooth += radii[(i + k + RAYS) % RAYS];
    jag += Math.abs(radii[i] - smooth / 17);
  }

  const band = (from, to) => {
    const ys = rowWidth.slice(minY + Math.floor(h * from), minY + Math.ceil(h * to));
    return ys.reduce((s, v) => s + v, 0) / Math.max(1, ys.length);
  };
  const maxRow = Math.max(...rowWidth);

  return {
    stats: {
      aspect: round(h / w), // > 1 tall, < 1 wide
      fill: round(area / (w * h)), // bounding-box coverage
      circularity: round((4 * Math.PI * area) / boundary.length ** 2),
      solidity: round(area / hullArea(boundary)), // low = limbs, spikes, gaps
      radialCV: round(sdR / meanR), // elongation / protrusions
      jagged: round(jag / RAYS / meanR),
      base: round(band(0.8, 1) / maxRow), // width near the bottom
      top: round(band(0, 0.2) / maxRow), // width near the top
    },
    box: { x: minX, y: minY, w, h },
    rowWidth,
    maxRow,
  };
}

const round = (v) => Math.round(v * 1000) / 1000;

/** Body shapes whose whole silhouette is essentially a head. */
const ALL_HEAD = new Set(['ball', 'blob']);
/** The head is taken as the solid pixels within this many head radii of its centre. */
const HEAD_REACH = 1.4;
/** How strongly blobs higher up are preferred as the head. */
const HEIGHT_BIAS = 2;
/** Smallest head thickness, as a fraction of the thickest part of the body. */
const MIN_HEAD = 0.4;

/** Distance (in pixels) from every solid pixel to the background (chamfer 3-4). */
function distanceTransform(solid, W, H) {
  const d = new Float32Array(W * H);
  const BIG = 1e9;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) d[y * W + x] = solid(x, y) ? BIG : 0;
  const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : d[y * W + x]);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!d[i]) continue;
      d[i] = Math.min(d[i], at(x - 1, y) + 3, at(x, y - 1) + 3, at(x - 1, y - 1) + 4, at(x + 1, y - 1) + 4);
    }
  }
  for (let y = H - 1; y >= 0; y--) {
    for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x;
      if (!d[i]) continue;
      d[i] = Math.min(d[i], at(x + 1, y) + 3, at(x, y + 1) + 3, at(x + 1, y + 1) + 4, at(x - 1, y + 1) + 4);
    }
  }
  for (let i = 0; i < d.length; i++) d[i] /= 3;
  return d;
}

/**
 * Picks the head: the centre of the largest round blob, preferring blobs high
 * up and near the middle so raised fists, wings and tails lose out.
 */
function findHead(solid, W, H, box) {
  const d = distanceTransform(solid, W, H);
  const cx = box.x + box.w / 2;
  // Ears, horns and tails are thin; a head is at least this thick.
  let minR = 4;
  for (const v of d) minR = Math.max(minR, v * MIN_HEAD);
  let best = null;
  for (let y = box.y; y < box.y + box.h; y++) {
    for (let x = box.x; x < box.x + box.w; x++) {
      const r = d[y * W + x];
      if (r < minR) continue;
      // Only local maxima of the distance field (centres of inscribed circles).
      let peak = true;
      for (let dy = -2; dy <= 2 && peak; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (d[(y + dy) * W + x + dx] > r) {
            peak = false;
            break;
          }
        }
      }
      if (!peak) continue;
      const v = (y - box.y) / box.h;
      const off = Math.abs(x - cx) / box.w;
      const score = r * (1 - v) ** HEIGHT_BIAS * (1 - off) ** 2;
      if (!best || score > best.score) best = { x, y, r, score };
    }
  }
  return best;
}

/** The largest 4-connected blob of solid pixels inside a box. */
function blobInBox(solid, W, H, x0, y0, x1, y1) {
  const inside = (x, y) => x >= x0 && x < x1 && y >= y0 && y < y1 && solid(x, y);
  const label = new Int32Array(W * H);
  let best = 0;
  let bestSize = 0;
  let next = 1;
  for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) {
      if (label[y * W + x] || !inside(x, y)) continue;
      const id = next++;
      let size = 0;
      const stack = [[x, y]];
      label[y * W + x] = id;
      while (stack.length) {
        const [px, py] = stack.pop();
        size++;
        for (const [nx, ny] of [[px - 1, py], [px + 1, py], [px, py - 1], [px, py + 1]]) {
          if (nx < 0 || ny < 0 || nx >= W || ny >= H || label[ny * W + nx] || !inside(nx, ny)) continue;
          label[ny * W + nx] = id;
          stack.push([nx, ny]);
        }
      }
      if (size > bestSize) {
        best = id;
        bestSize = size;
      }
    }
  }
  return (x, y) => x >= 0 && y >= 0 && x < W && y < H && best > 0 && label[y * W + x] === best;
}

/**
 * The head box from the detector, in pixels, or null when it found nothing
 * convincing or boxed most of the creature.
 */
function detectedHead(detections, box, W, H) {
  const best = detections?.[0];
  if (!best || best.score < MIN_DETECTION) return null;
  let [x0, y0, x1, y1] = best.box;
  if (best.label === 'a face') {
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const hw = ((x1 - x0) / 2) * FACE_TO_HEAD, hh = ((y1 - y0) / 2) * FACE_TO_HEAD;
    [x0, y0, x1, y1] = [cx - hw, cy - hh, cx + hw, cy + hh];
  }
  [x0, x1] = [Math.round(x0 * W), Math.round(x1 * W)];
  [y0, y1] = [Math.round(y0 * H), Math.round(y1 * H)];
  const overlapW = Math.max(0, Math.min(x1, box.x + box.w) - Math.max(x0, box.x));
  const overlapH = Math.max(0, Math.min(y1, box.y + box.h) - Math.max(y0, box.y));
  if ((overlapW * overlapH) / (box.w * box.h) > MAX_HEAD_COVER) return null;
  return { x0, y0, x1, y1 };
}

/** Solid pixels within `reach` of (cx, cy) that connect to it. */
function headMask(solid, W, H, cx, cy, reach) {
  const inside = (x, y) => solid(x, y) && (x - cx) ** 2 + (y - cy) ** 2 <= reach * reach;
  const mask = new Uint8Array(W * H);
  const stack = [[cx, cy]];
  mask[cy * W + cx] = 1;
  while (stack.length) {
    const [x, y] = stack.pop();
    for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
      if (nx < 0 || ny < 0 || nx >= W || ny >= H || mask[ny * W + nx] || !inside(nx, ny)) continue;
      mask[ny * W + nx] = 1;
      stack.push([nx, ny]);
    }
  }
  return (x, y) => x >= 0 && y >= 0 && x < W && y < H && mask[y * W + x] === 1;
}

/** How each head was found, for the summary. */
const sources = { override: 0, detector: 0, heuristic: 0, whole: 0 };

function measure({ width: W, height: H, data }, shape, detections, override) {
  const solid = (x, y) => x >= 0 && y >= 0 && x < W && y < H && data[(y * W + x) * 4 + 3] > ALPHA;
  const whole = outlineStats(solid, W, H);
  const { box } = whole;

  // The head: a hand-placed box, else the detector's box, else the largest
  // round blob high up, or the whole thing for round blobs.
  const inBox = ({ x0, y0, x1, y1 }) => outlineStats(blobInBox(solid, W, H, x0, y0, x1, y1), W, H);
  const detected = detectedHead(detections, box, W, H);
  let head;
  if (override) {
    const [x, y, w, h] = override;
    head = inBox({ x0: Math.round(x * W), y0: Math.round(y * H), x1: Math.round((x + w) * W), y1: Math.round((y + h) * H) });
    sources.override++;
  } else if (ALL_HEAD.has(shape)) {
    head = whole;
    sources.whole++;
  } else if (detected) {
    head = inBox(detected);
    sources.detector++;
  } else {
    const found = findHead(solid, W, H, box);
    head = found ? outlineStats(headMask(solid, W, H, found.x, found.y, found.r * HEAD_REACH), W, H) : whole;
    sources.heuristic++;
  }

  return {
    ...whole.stats,
    head: {
      ...head.stats,
      // Normalised to the artwork, for drawing.
      box: [head.box.x / W, head.box.y / H, head.box.w / W, head.box.h / H].map(round),
    },
    headShare: round(head.box.h / box.h), // how much of the height is head
  };
}

let detectorPromise = null;

/** Loads the detector on first use, so cached runs never touch it. */
async function detector() {
  detectorPromise ??= import('@huggingface/transformers').then(async ({ pipeline, RawImage }) => {
    const run = await pipeline('zero-shot-object-detection', HEAD_MODEL, { dtype: 'q8' });
    return { run, RawImage };
  });
  return detectorPromise;
}

/**
 * Runs the detector on a region of the artwork, flattened onto white (the
 * model expects an opaque picture). Boxes come back as fractions of the whole
 * artwork, best first.
 */
async function detect(png, labels, region = { x: 0, y: 0, w: png.width, h: png.height }, keep = 5) {
  const { run, RawImage } = await detector();
  const { x: rx, y: ry, w: rw, h: rh } = region;
  const rgb = new Uint8ClampedArray(rw * rh * 3).fill(255);
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const sx = rx + x, sy = ry + y;
      if (sx < 0 || sy < 0 || sx >= png.width || sy >= png.height) continue;
      const k = sy * png.width + sx;
      const a = png.data[k * 4 + 3] / 255;
      for (let c = 0; c < 3; c++) rgb[(y * rw + x) * 3 + c] = png.data[k * 4 + c] * a + 255 * (1 - a);
    }
  }
  const found = await run(new RawImage(rgb, rw, rh, 3), labels, { threshold: 0.01, percentage: true });
  const toArt = (v, offset, span, full) => round((offset + v * span) / full);
  return labels.flatMap((label) =>
    found
      .filter((d) => d.label === label)
      .sort((a, b) => b.score - a.score)
      .slice(0, keep)
      .map(({ score, box: b }) => ({
        label,
        score: round(score),
        box: [
          toArt(b.xmin, rx, rw, png.width),
          toArt(b.ymin, ry, rh, png.height),
          toArt(b.xmax, rx, rw, png.width),
          toArt(b.ymax, ry, rh, png.height),
        ],
      })),
  );
}

/** Reads a detection cache, or starts a new one if it was made with other settings. */
async function loadCache(file, labels) {
  try {
    const saved = JSON.parse(await readFile(file, 'utf8'));
    saved.items ??= saved.heads; // caches from before eyes and mouths were found
    delete saved.heads;
    if (saved.model === HEAD_MODEL && saved.labels.join() === labels.join()) return saved;
  } catch {
    // No cache yet.
  }
  return { model: HEAD_MODEL, labels, items: {} };
}

/** Runs `fn` for every Pokémon missing from a cache, saving as it goes. */
async function fillCache(file, cache, todo, what, fn) {
  if (todo.length === 0) return;
  console.log(`Finding ${what} in ${todo.length} artworks (cached after this)…`);
  for (const [i, p] of todo.entries()) {
    cache.items[p.id] = await fn(p);
    if ((i + 1) % 50 === 0 || i === todo.length - 1) {
      console.log(`  ${i + 1}/${todo.length}`);
      await writeFile(file, JSON.stringify(cache));
    }
  }
}

/**
 * Head detections for every artwork. Keeps the top few per Pokémon so the
 * choice can be re-tuned for free.
 */
async function detectHeads(dex) {
  const cache = await loadCache(HEADS, HEAD_LABELS);
  const todo = dex.filter((p) => !cache.items[p.id]);
  await fillCache(HEADS, cache, todo, 'heads', async (p) => detect(await artwork(p.id), HEAD_LABELS));
  return cache.items;
}

/**
 * The square searched for eyes and a mouth: the head box with some margin, in
 * pixels. Zooming in on the head lets the detector see small eyes.
 */
function featureRegion([x, y, w, h], W, H) {
  const size = Math.max(w * W, h * H) * (1 + 2 * FEATURE_MARGIN);
  const cx = (x + w / 2) * W, cy = (y + h / 2) * H;
  return { x: Math.round(cx - size / 2), y: Math.round(cy - size / 2), w: Math.round(size), h: Math.round(size) };
}

/** Eye and mouth detections inside each head, re-run when a head box changes. */
async function detectFeatures(dex, shapes) {
  const cache = await loadCache(FEATURES, FEATURE_LABELS);
  const boxOf = new Map(shapes.map((s) => [s.id, s.head.box.join()]));
  const todo = dex.filter((p) => cache.items[p.id]?.head !== boxOf.get(p.id));
  await fillCache(FEATURES, cache, todo, 'eyes and mouths', async (p) => {
    const png = await artwork(p.id);
    const head = shapes.find((s) => s.id === p.id).head.box;
    return { head: boxOf.get(p.id), found: await detect(png, FEATURE_LABELS, featureRegion(head, png.width, png.height), 8) };
  });
  return cache.items;
}

const centre = ([x0, y0, x1, y1]) => [(x0 + x1) / 2, (y0 + y1) / 2];
const inside = ([x, y], [x0, y0, x1, y1]) => x >= x0 && x <= x1 && y >= y0 && y <= y1;

/**
 * Picks up to two eyes and a mouth from the detections, each as a centre and
 * a width (fractions of the artwork). Eyes must sit inside the head, not on
 * top of each other, and level-ish; the mouth must be below the eyes.
 */
function pickFeatures(found, [hx, hy, hw, hh]) {
  const head = [hx - hw * 0.05, hy - hh * 0.05, hx + hw * 1.05, hy + hh * 1.05];
  // Eyes are small; a grinning mouth can span most of the head.
  const fits = (d, maxW) => {
    const [x0, y0, x1, y1] = d.box;
    return inside(centre(d.box), head) && x1 - x0 < hw * maxW && y1 - y0 < hh * 0.6;
  };
  const eyes = [];
  for (const d of found.filter((d) => d.label === FEATURE_LABELS[0] && d.score >= MIN_EYE && fits(d, 0.6))) {
    const [x, y] = centre(d.box);
    const w = d.box[2] - d.box[0];
    if (eyes.length === 0) eyes.push({ x, y, w, score: d.score });
    else {
      const [first] = eyes;
      const apart = Math.abs(x - first.x) > Math.max(w, first.w) * 0.8;
      const level = Math.abs(y - first.y) < hh * 0.25;
      if (apart && level && d.score >= first.score * SECOND_EYE) eyes.push({ x, y, w, score: d.score });
    }
    if (eyes.length === 2) break;
  }
  eyes.sort((a, b) => a.x - b.x);

  const eyeLine = eyes.length ? Math.max(...eyes.map((e) => e.y)) : hy;
  // With two eyes, the mouth is no further below them than they are apart.
  const eyeGap = eyes.length === 2 ? eyes[1].x - eyes[0].x : Infinity;
  const mouth = found
    .filter((d) => d.label === FEATURE_LABELS[1] && d.score >= MIN_MOUTH && fits(d, 0.9))
    .map((d) => ({ x: centre(d.box)[0], y: centre(d.box)[1], w: d.box[2] - d.box[0], score: d.score }))
    .find((m) => m.y > eyeLine && m.y - eyeLine < eyeGap && !eyes.some((e) => Math.hypot(m.x - e.x, m.y - e.y) < e.w * 0.6));

  const out = {};
  if (eyes.length) out.eyes = eyes.map(({ x, y, w }) => [x, y, w].map(round));
  if (mouth) out.mouth = [mouth.x, mouth.y, mouth.w].map(round);
  return out;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
        if (++done % 100 === 0) console.log(`  ${done}/${items.length}`);
      }
    }),
  );
  return results;
}

await mkdir(CACHE, { recursive: true });
const dex = JSON.parse(await readFile(DEX, 'utf8'));
const OVERRIDES = JSON.parse(await readFile(OVERRIDES_FILE, 'utf8'));
const heads = await detectHeads(dex);
console.log(`Measuring ${dex.length} silhouettes…`);
const shapes = await mapLimit(dex, CONCURRENCY, async (p) => ({
  id: p.id,
  ...measure(await artwork(p.id), p.shape, heads[p.id], OVERRIDES[p.id]?.head),
}));
console.log('Heads from:', sources);

// Eyes and mouth inside each head, so the face's features land on them.
const features = await detectFeatures(dex, shapes);
let withEyes = 0, withMouth = 0;
for (const s of shapes) {
  const fix = OVERRIDES[s.id] ?? {};
  Object.assign(s.head, pickFeatures(features[s.id].found, s.head.box));
  if (fix.eyes) s.head.eyes = fix.eyes;
  // A null mouth means "this Pokémon has no visible mouth".
  if (fix.mouth !== undefined) s.head.mouth = fix.mouth ?? undefined;
  if (s.head.eyes) withEyes++;
  if (s.head.mouth) withMouth++;
}
console.log(`Eyes found in ${withEyes}, mouths in ${withMouth} of ${shapes.length}`);

await writeFile(OUT, JSON.stringify(shapes));
console.log(`Wrote ${shapes.length} shapes to ${OUT.pathname}`);
