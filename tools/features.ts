// Dev tool: fix where each Pokémon's head, eyes and mouth are, with a live
// preview of the face tracing. Open /tools/features.html with `npm run dev`.
// Saves go through the dev server (see vite.config.ts) to
// scripts/head-overrides.json and src/data/shapes.json.
import { POKEDEX, SHAPES, artworkUrl } from '../src/pokemon.ts';
import { buildSilhouette } from '../src/silhouette.ts';
import { Stage } from '../src/stage.ts';
import { analyzeFace, type FaceAnalysis } from '../src/face.ts';

/** [x, y, width] of an eye or mouth centre, as fractions of the artwork. */
type Feature = number[];
interface Edit {
  head: number[];
  eyes: Feature[];
  mouth: Feature | null;
}
interface Fix {
  note?: string;
  head?: number[];
  eyes?: number[][];
  mouth?: number[] | null;
}
type Target = { kind: 'eye'; i: number } | { kind: 'mouth' } | { kind: 'head' };
interface Drag {
  target: Target;
  mode: 'move' | 'resize' | 'corner';
  corner: number;
  from: { u: number; v: number };
  orig: Edit;
}

const COLORS = { head: '#b8322a', eye: '#2a5bd7', mouth: '#1f8a3b' };
const FACE_KEY = 'pokematch-editor-face';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('canvas');
const ctx = canvas.getContext('2d')!;
const copy = (e: Edit): Edit => structuredClone(e);
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

let overrides: Record<string, Fix> = await (await fetch('/__overrides')).json();

// ------------------------------------------------------------------- state

/** What shapes.json says now (detections with any saved fixes applied). */
function saved(id: number): Edit {
  const h = SHAPES.get(id)!.head;
  return { head: [...h.box], eyes: (h.eyes ?? []).map((e) => [...e]), mouth: h.mouth ? [...h.mouth] : null };
}

const params = new URLSearchParams(location.hash.slice(1));
let filter = params.get('filter') ?? 'all';
let id = Number(params.get('id')) || 1;
let edit = saved(id);
let base = copy(edit);
let selected: Target | null = null;
let drag: Drag | null = null;
let art: HTMLImageElement | null = null;
let dots: { dst: { x: number; y: number }; color: string }[] = [];

const dirty = () => !same(edit, base) || $<HTMLInputElement>('note').value !== (overrides[id]?.note ?? '');

// ------------------------------------------------------------------ filters

const FILTERS: Record<string, (id: number) => boolean> = {
  all: () => true,
  edited: (id) => id in overrides,
  'no-eyes': (id) => !SHAPES.get(id)!.head.eyes?.length,
  'one-eye': (id) => SHAPES.get(id)!.head.eyes?.length === 1,
  'no-mouth': (id) => !SHAPES.get(id)!.head.mouth,
};
const list = () => POKEDEX.filter((p) => FILTERS[filter](p.id)).map((p) => p.id);

$('names').replaceChildren(
  ...POKEDEX.map((p) => Object.assign(document.createElement('option'), { value: `${p.id} ${p.name}` })),
);
$<HTMLSelectElement>('filter').value = filter;

function go(next: number) {
  if (dirty() && !confirm('Discard unsaved changes?')) return;
  id = next;
  edit = saved(id);
  base = copy(edit);
  selected = null;
  dots = [];
  $<HTMLInputElement>('note').value = overrides[id]?.note ?? '';
  history.replaceState(null, '', `#id=${id}&filter=${filter}`);
  const ids = list();
  const at = ids.indexOf(id);
  $('count').textContent = at >= 0 ? `${at + 1} / ${ids.length}` : `not in this list (${ids.length})`;
  const p = POKEDEX.find((p) => p.id === id)!;
  $('title').textContent = `No. ${id} ${p.name}`;
  art = null;
  const img = new Image();
  img.onload = () => {
    if (id === p.id) {
      art = img;
      draw();
    }
  };
  img.src = artworkUrl(id);
  updateStatus();
  draw();
  schedulePreview();
}

function step(by: number) {
  const ids = list();
  if (ids.length === 0) return;
  const at = ids.indexOf(id);
  go(ids[at < 0 ? 0 : (at + by + ids.length) % ids.length]);
}

$('prev').addEventListener('click', () => step(-1));
$('next').addEventListener('click', () => step(1));
$<HTMLSelectElement>('filter').addEventListener('change', (e) => {
  filter = (e.target as HTMLSelectElement).value;
  const ids = list();
  if (!ids.includes(id) && ids.length) go(ids[0]);
  else go(id);
});
$<HTMLInputElement>('find').addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  const q = input.value.trim().toLowerCase();
  const p = POKEDEX.find((p) => String(p.id) === q.split(' ')[0] || p.name.toLowerCase() === q || `${p.id} ${p.name}`.toLowerCase() === q);
  if (p) go(p.id);
  input.value = '';
});

// ------------------------------------------------------------------ drawing

function size() {
  const s = canvas.clientWidth;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (canvas.width !== Math.round(s * dpr)) {
    canvas.width = canvas.height = Math.round(s * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return s;
}

function draw() {
  const s = size();
  ctx.clearRect(0, 0, s, s);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, s, s);
  if (art) ctx.drawImage(art, 0, 0, s, s);

  if ($<HTMLInputElement>('preview').checked && !drag) {
    for (const d of dots) {
      ctx.fillStyle = d.color;
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.arc(d.dst.x * s, d.dst.y * s, d.color === '#7d7266' ? 0.9 : 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  const [hx, hy, hw, hh] = edit.head;
  const headSel = selected?.kind === 'head';
  ctx.strokeStyle = COLORS.head;
  ctx.lineWidth = headSel ? 2.5 : 1.5;
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(hx * s, hy * s, hw * s, hh * s);
  ctx.setLineDash([]);
  ctx.fillStyle = COLORS.head;
  for (const [cx, cy] of corners()) ctx.fillRect(cx * s - 4, cy * s - 4, 8, 8);

  const circle = ([x, y, w]: Feature, color: string, isSel: boolean) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = isSel ? 3 : 2;
    ctx.beginPath();
    ctx.arc(x * s, y * s, Math.max(2, (w / 2) * s), 0, Math.PI * 2);
    if (isSel) {
      ctx.fillStyle = color + '22';
      ctx.fill();
    }
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x * s, y * s, 2.5, 0, Math.PI * 2);
    ctx.fill();
  };
  edit.eyes.forEach((e, i) => circle(e, COLORS.eye, selected?.kind === 'eye' && selected.i === i));
  if (edit.mouth) circle(edit.mouth, COLORS.mouth, selected?.kind === 'mouth');
}

const corners = () => {
  const [x, y, w, h] = edit.head;
  return [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
};

// ------------------------------------------------------------------ editing

function feature(t: Target): Feature | null {
  return t.kind === 'eye' ? edit.eyes[t.i] : t.kind === 'mouth' ? edit.mouth : null;
}

/** What is under the pointer, and whether it grabs the middle or the rim. */
function hit(u: number, v: number): Omit<Drag, 'from' | 'orig'> | null {
  const s = canvas.clientWidth;
  const tol = 7 / s;
  const targets: Target[] = [...edit.eyes.map((_, i) => ({ kind: 'eye', i }) as Target), ...(edit.mouth ? [{ kind: 'mouth' } as Target] : [])];
  for (const t of targets) {
    const [x, y, w] = feature(t)!;
    const d = Math.hypot(u - x, v - y);
    const r = Math.max(2 / s, w / 2);
    if (Math.abs(d - r) < tol) return { target: t, mode: 'resize', corner: -1 };
    if (d < r) return { target: t, mode: 'move', corner: -1 };
  }
  const corner = corners().findIndex(([cx, cy]) => Math.abs(u - cx) < tol * 1.4 && Math.abs(v - cy) < tol * 1.4);
  if (corner >= 0) return { target: { kind: 'head' }, mode: 'corner', corner };
  const [hx, hy, hw, hh] = edit.head;
  if (u > hx && u < hx + hw && v > hy && v < hy + hh) return { target: { kind: 'head' }, mode: 'move', corner: -1 };
  return null;
}

const pointer = (e: PointerEvent | WheelEvent) => {
  const r = canvas.getBoundingClientRect();
  return { u: (e.clientX - r.left) / r.width, v: (e.clientY - r.top) / r.height };
};

canvas.addEventListener('pointerdown', (e) => {
  const at = pointer(e);
  const h = hit(at.u, at.v);
  selected = h?.target ?? null;
  $<HTMLButtonElement>('remove').disabled = !selected || selected.kind === 'head';
  if (h) {
    drag = { ...h, from: at, orig: copy(edit) };
    canvas.setPointerCapture(e.pointerId);
  }
  draw();
});

canvas.addEventListener('pointermove', (e) => {
  const at = pointer(e);
  if (!drag) {
    const h = hit(at.u, at.v);
    canvas.style.cursor = !h ? 'default' : h.mode === 'move' ? 'move' : h.mode === 'corner' ? 'nwse-resize' : 'ew-resize';
    return;
  }
  const du = at.u - drag.from.u;
  const dv = at.v - drag.from.v;
  const t = drag.target;
  if (t.kind === 'head') {
    const [x, y, w, h] = drag.orig.head;
    if (drag.mode === 'move') edit.head = [x + du, y + dv, w, h];
    else {
      // Move the grabbed corner; the opposite one stays put.
      let [x0, y0, x1, y1] = [x, y, x + w, y + h];
      if (drag.corner === 0 || drag.corner === 3) x0 += du;
      else x1 += du;
      if (drag.corner === 0 || drag.corner === 1) y0 += dv;
      else y1 += dv;
      edit.head = [Math.min(x0, x1), Math.min(y0, y1), Math.max(0.02, Math.abs(x1 - x0)), Math.max(0.02, Math.abs(y1 - y0))];
    }
  } else {
    const [x, y, w] = (t.kind === 'eye' ? drag.orig.eyes[t.i] : drag.orig.mouth)!;
    const next = drag.mode === 'move' ? [x + du, y + dv, w] : [x, y, Math.max(0.01, 2 * Math.hypot(at.u - x, at.v - y))];
    if (t.kind === 'eye') edit.eyes[t.i] = next;
    else edit.mouth = next;
  }
  updateStatus();
  draw();
});

const endDrag = () => {
  if (!drag) return;
  drag = null;
  // Keep eyes ordered left to right, as the tracing expects.
  const sel = selected?.kind === 'eye' ? edit.eyes[selected.i] : null;
  edit.eyes.sort((a, b) => a[0] - b[0]);
  if (sel) selected = { kind: 'eye', i: edit.eyes.indexOf(sel) };
  draw();
  schedulePreview();
};
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

canvas.addEventListener(
  'wheel',
  (e) => {
    const at = pointer(e);
    const h = hit(at.u, at.v);
    if (!h || h.target.kind === 'head') return;
    e.preventDefault();
    const f = feature(h.target)!;
    f[2] = Math.max(0.01, f[2] * (e.deltaY < 0 ? 1.08 : 1 / 1.08));
    updateStatus();
    draw();
    schedulePreview();
  },
  { passive: false },
);

function addEye() {
  if (edit.eyes.length >= 2) return alert('A Pokémon can have at most two eyes here. Remove one first.');
  const [hx, hy, hw, hh] = edit.head;
  const x = edit.eyes.length ? Math.min(hx + hw * 0.9, edit.eyes[0][0] + hw * 0.3) : hx + hw * 0.35;
  edit.eyes.push([x, hy + hh * 0.4, hw * 0.12]);
  edit.eyes.sort((a, b) => a[0] - b[0]);
  changed();
}
function addMouth() {
  if (edit.mouth) return;
  const [hx, hy, hw, hh] = edit.head;
  edit.mouth = [hx + hw / 2, hy + hh * 0.7, hw * 0.25];
  selected = { kind: 'mouth' };
  changed();
}
function removeSelected() {
  if (selected?.kind === 'eye') edit.eyes.splice(selected.i, 1);
  else if (selected?.kind === 'mouth') edit.mouth = null;
  else return;
  selected = null;
  $<HTMLButtonElement>('remove').disabled = true;
  changed();
}
function changed() {
  updateStatus();
  draw();
  schedulePreview();
}

$('add-eye').addEventListener('click', addEye);
$('add-mouth').addEventListener('click', addMouth);
$('remove').addEventListener('click', removeSelected);
$('note').addEventListener('input', updateStatus);

// ---------------------------------------------------------------- saving

function updateStatus() {
  const el = $('status');
  const fixed = id in overrides;
  el.classList.toggle('dirty', dirty());
  el.textContent = dirty() ? 'Unsaved changes' : fixed ? 'Fixed by hand' : 'As detected';
  $<HTMLButtonElement>('save').disabled = !dirty();
  $<HTMLButtonElement>('undo').disabled = !dirty();
  $<HTMLButtonElement>('revert').disabled = !fixed;
}

async function post(fix: Fix | null) {
  const res = await fetch('/__overrides', { method: 'POST', body: JSON.stringify({ id, fix }) });
  if (!res.ok) throw new Error(await res.text());
}

async function save() {
  if (!dirty()) return;
  // Only what was changed by hand is stored; the rest keeps tracking the detector.
  const fix: Fix = { ...overrides[id] };
  const note = $<HTMLInputElement>('note').value.trim();
  if (note) fix.note = note;
  else delete fix.note;
  if (!same(edit.head, base.head)) fix.head = edit.head.map(r3);
  if (!same(edit.eyes, base.eyes)) fix.eyes = edit.eyes.map((e) => e.map(r3));
  if (!same(edit.mouth, base.mouth)) fix.mouth = edit.mouth ? edit.mouth.map(r3) : null;
  const empty = Object.keys(fix).every((k) => k === 'note');
  $('status').textContent = 'Saving…';
  await post(empty && !fix.note ? null : fix);
  overrides = await (await fetch('/__overrides')).json();
  base = copy(edit);
  updateStatus();
  // shapes.json changed, so Vite reloads this page; the hash brings it back here.
}

$('save').addEventListener('click', save);
$('undo').addEventListener('click', () => {
  edit = copy(base);
  $<HTMLInputElement>('note').value = overrides[id]?.note ?? '';
  changed();
});
$('revert').addEventListener('click', async () => {
  if (!confirm('Delete the hand fix and go back to what the detector found? This rebuilds the shapes (about a minute).')) return;
  await post(null);
  overrides = await (await fetch('/__overrides')).json();
  base = copy(edit);
  rebuild();
});

async function rebuild() {
  const btn = $<HTMLButtonElement>('rebuild');
  const log = $('log');
  btn.disabled = true;
  btn.textContent = 'Rebuilding…';
  log.hidden = false;
  log.textContent = 'Re-measuring every Pokémon. The page reloads when it is done.';
  const res = await fetch('/__rebuild', { method: 'POST' });
  log.textContent = await res.text();
  btn.disabled = false;
  btn.textContent = 'Rebuild shapes';
}
$('rebuild').addEventListener('click', rebuild);

window.addEventListener('beforeunload', (e) => {
  if (dirty()) e.preventDefault();
});

// --------------------------------------------------------------- preview

const stage = new Stage(document.createElement('canvas'));
let hasFace = false;

function useFace(width: number, height: number, points: { x: number; y: number }[]) {
  // The stage only needs the photo's size and the landmarks to map.
  stage.setFace({ width, height } as HTMLCanvasElement, { points } as FaceAnalysis);
  hasFace = true;
  $('face-status').textContent = 'Face loaded. Its eyes (blue) and lips (red) should sit on the Pokémon’s.';
}

try {
  const stored = JSON.parse(sessionStorage.getItem(FACE_KEY) ?? 'null');
  if (stored) useFace(stored.width, stored.height, stored.points);
} catch {
  // No saved face.
}

$<HTMLInputElement>('face-file').addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  $('face-status').textContent = 'Finding the face…';
  const bitmap = await createImageBitmap(file);
  const photo = Object.assign(document.createElement('canvas'), { width: bitmap.width, height: bitmap.height });
  photo.getContext('2d')!.drawImage(bitmap, 0, 0);
  const face = await analyzeFace(photo);
  if (!face) {
    $('face-status').textContent = 'No face found in that photo. Try a clear, front-facing one.';
    return;
  }
  const saved = { width: photo.width, height: photo.height, points: face.points };
  try {
    sessionStorage.setItem(FACE_KEY, JSON.stringify(saved));
  } catch {
    // The preview still works until the page reloads.
  }
  useFace(saved.width, saved.height, saved.points);
  schedulePreview();
});

let previewTimer = 0;
let previewRun = 0;
function schedulePreview() {
  clearTimeout(previewTimer);
  if (!hasFace) return;
  previewTimer = window.setTimeout(async () => {
    const run = ++previewRun;
    const head = { ...SHAPES.get(id)!.head, box: edit.head, eyes: edit.eyes, mouth: edit.mouth ?? undefined };
    const sil = await buildSilhouette(id, head);
    if (run !== previewRun) return;
    dots = stage.previewMapping(sil);
    draw();
  }, 120);
}
$('preview').addEventListener('change', draw);

// ---------------------------------------------------------------- keyboard

window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    save();
    return;
  }
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.key === 'ArrowLeft') step(-1);
  else if (e.key === 'ArrowRight') step(1);
  else if (e.key === 'Delete' || e.key === 'Backspace') removeSelected();
  else if (e.key === 'p' || e.key === 'P') {
    const box = $<HTMLInputElement>('preview');
    box.checked = !box.checked;
    draw();
  }
});

new ResizeObserver(draw).observe(canvas);
$<HTMLInputElement>('note').value = overrides[id]?.note ?? '';
go(id);
