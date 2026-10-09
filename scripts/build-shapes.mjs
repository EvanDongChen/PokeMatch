// Measures the silhouette of every Pokémon's official artwork and writes
// src/data/shapes.json. Artwork is cached in .cache/artwork/.
// Run with `npm run build:shapes` (after build:pokedex).
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { PNG } from 'pngjs';

const DEX = new URL('../src/data/pokedex.json', import.meta.url);
const OUT = new URL('../src/data/shapes.json', import.meta.url);
const CACHE = new URL('../.cache/artwork/', import.meta.url);
const ART = (id) =>
  `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${id}.png`;
const CONCURRENCY = 16;
const ALPHA = 60;
const RAYS = 180;

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

function measure({ width: W, height: H, data }) {
  const solid = (x, y) => x >= 0 && y >= 0 && x < W && y < H && data[(y * W + x) * 4 + 3] > ALPHA;

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

  const round = (v) => Math.round(v * 1000) / 1000;
  return {
    aspect: round(h / w), // > 1 tall, < 1 wide
    fill: round(area / (w * h)), // bounding-box coverage
    circularity: round((4 * Math.PI * area) / boundary.length ** 2),
    solidity: round(area / hullArea(boundary)), // low = limbs, spikes, gaps
    radialCV: round(sdR / meanR), // elongation / protrusions
    jagged: round(jag / RAYS / meanR),
    base: round(band(0.8, 1) / maxRow), // width near the bottom
    top: round(band(0, 0.2) / maxRow), // width near the top
  };
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
console.log(`Measuring ${dex.length} silhouettes…`);
const shapes = await mapLimit(dex, CONCURRENCY, async (p) => ({ id: p.id, ...measure(await artwork(p.id)) }));
await writeFile(OUT, JSON.stringify(shapes));
console.log(`Wrote ${shapes.length} shapes to ${OUT.pathname}`);
