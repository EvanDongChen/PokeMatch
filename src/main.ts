import { analyzeFace, loadLandmarker, FACE_OVAL, MAX_YAW, type FaceAnalysis } from './face.ts';
import { TRAITS, faceTraits, type TraitVector } from './traits.ts';
import { rankMatches, explainMatch, artworkUrl, type Match } from './pokemon.ts';

const MAX_SIDE = 1024;

const TYPE_COLORS: Record<string, string> = {
  normal: '#a8a77a', fire: '#ee8130', water: '#6390f0', electric: '#f7d02c', grass: '#7ac74c',
  ice: '#96d9d6', fighting: '#c22e28', poison: '#a33ea1', ground: '#e2bf65', flying: '#a98ff3',
  psychic: '#f95587', bug: '#a6b91a', rock: '#b6a136', ghost: '#735797', dragon: '#6f35fc',
  dark: '#705746', steel: '#b7b7ce', fairy: '#d685ad',
};

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const screens = ['pick', 'camera', 'analyse', 'result'] as const;
type Screen = (typeof screens)[number];

function show(screen: Screen) {
  for (const s of screens) $(`screen-${s}`).hidden = s !== screen;
  if (screen !== 'camera') stopCamera();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function showError(message: string | null) {
  const el = $('error');
  el.hidden = !message;
  el.textContent = message ?? '';
}

// ---------------------------------------------------------------- image input

/** Draws an image source onto a canvas, scaled down so its longest side ≤ MAX_SIDE. */
function toCanvas(source: CanvasImageSource, width: number, height: number, mirror = false) {
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d')!;
  if (mirror) {
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function handleFile(file: File | undefined) {
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    showError('That file isn’t an image. Try a JPG or PNG photo.');
    return;
  }
  showError(null);
  try {
    const bitmap = await createImageBitmap(file);
    const canvas = toCanvas(bitmap, bitmap.width, bitmap.height);
    bitmap.close();
    await run(canvas);
  } catch (err) {
    console.error(err);
    show('pick');
    showError('Couldn’t read that image. Try a different photo.');
  }
}

const fileInput = $<HTMLInputElement>('file-input');
fileInput.addEventListener('change', () => {
  handleFile(fileInput.files?.[0]);
  fileInput.value = '';
});

const dropzone = $('dropzone');
dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('dragging');
});
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragging'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragging');
  handleFile(e.dataTransfer?.files[0]);
});

// Paste a photo from the clipboard.
window.addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
  if (item && !$('screen-pick').hidden) handleFile(item.getAsFile() ?? undefined);
});

// --------------------------------------------------------------------- camera

const video = $<HTMLVideoElement>('camera-video');
let stream: MediaStream | null = null;

function stopCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
}

$('camera-btn').addEventListener('click', async () => {
  showError(null);
  if (!navigator.mediaDevices?.getUserMedia) {
    showError('Camera isn’t available in this browser. Upload a photo instead.');
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 960 } },
      audio: false,
    });
    video.srcObject = stream;
    show('camera');
  } catch (err) {
    console.error(err);
    showError('Couldn’t open the camera. Check the permission, or upload a photo instead.');
  }
});

$('camera-cancel').addEventListener('click', () => show('pick'));

$('capture-btn').addEventListener('click', () => {
  if (!video.videoWidth) return;
  // Mirror the capture so it looks like the selfie preview.
  const canvas = toCanvas(video, video.videoWidth, video.videoHeight, true);
  run(canvas);
});

// ------------------------------------------------------------------- analysis

function drawFace(target: HTMLCanvasElement, photo: HTMLCanvasElement, face: FaceAnalysis | null) {
  target.width = photo.width;
  target.height = photo.height;
  const ctx = target.getContext('2d')!;
  ctx.drawImage(photo, 0, 0);
  if (!face) return;

  const lw = Math.max(2, photo.width / 300);
  ctx.lineWidth = lw;
  ctx.strokeStyle = 'rgba(255, 222, 0, 0.9)';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
  ctx.shadowBlur = lw * 2;
  ctx.beginPath();
  FACE_OVAL.forEach((i, n) => {
    const p = face.points[i];
    if (n === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  });
  ctx.stroke();

  ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.shadowBlur = 0;
  for (const [n, p] of face.points.entries()) {
    if (n % 3 !== 0) continue;
    ctx.beginPath();
    ctx.arc(p.x, p.y, lw * 0.6, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Crops the analysed canvas around the face for the result card. */
function cropToFace(photo: HTMLCanvasElement, face: FaceAnalysis): HTMLCanvasElement {
  const xs = face.points.map((p) => p.x);
  const ys = face.points.map((p) => p.y);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const size = Math.min(
    Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * 1.6,
    photo.width,
    photo.height,
  );
  const x = Math.max(0, Math.min(photo.width - size, cx - size / 2));
  const y = Math.max(0, Math.min(photo.height - size, cy - size / 2));
  const out = document.createElement('canvas');
  out.width = out.height = Math.round(Math.min(size, 600));
  out.getContext('2d')!.drawImage(photo, x, y, size, size, 0, 0, out.width, out.height);
  return out;
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run(photo: HTMLCanvasElement) {
  showError(null);
  show('analyse');
  const canvas = $<HTMLCanvasElement>('analyse-canvas');
  const status = $('analyse-status');
  drawFace(canvas, photo, null);
  canvas.parentElement!.classList.add('scanning');

  let face: FaceAnalysis | null;
  try {
    status.textContent = 'Loading face model…';
    await loadLandmarker();
    status.textContent = 'Mapping 478 facial landmarks…';
    await nextFrame();
    face = await analyzeFace(photo);
  } catch (err) {
    console.error(err);
    show('pick');
    showError('The face model failed to load. Check your connection and try again.');
    return;
  }

  if (!face) {
    show('pick');
    showError('No face found in that photo. Try a clearer, front-facing shot.');
    return;
  }

  drawFace(canvas, photo, face);
  status.textContent = 'Measuring proportions and searching 1025 Pokémon…';
  await wait(900);
  canvas.parentElement!.classList.remove('scanning');

  const traits = faceTraits(face.measures);
  const matches = rankMatches(traits);
  renderResult(cropToFace(photo, face), face, traits, matches);
}

// -------------------------------------------------------------------- results

const titleCase = (s: string) => s[0].toUpperCase() + s.slice(1);

function typeChip(type: string) {
  const el = document.createElement('span');
  el.className = 'type';
  el.textContent = titleCase(type);
  el.style.setProperty('--type', TYPE_COLORS[type] ?? '#888');
  return el;
}

function renderResult(photo: HTMLCanvasElement, face: FaceAnalysis, traits: TraitVector, matches: Match[]) {
  const resultCanvas = $<HTMLCanvasElement>('result-canvas');
  resultCanvas.width = photo.width;
  resultCanvas.height = photo.height;
  resultCanvas.getContext('2d')!.drawImage(photo, 0, 0);

  const notices: string[] = [];
  if (face.faceCount > 1) notices.push(`Found ${face.faceCount} faces, so matched the largest one.`);
  if (face.yaw > MAX_YAW) notices.push('Your head looks turned. A straight-on photo gives a more accurate match.');
  $('notice').hidden = notices.length === 0;
  $('notice').textContent = notices.join(' ');

  const select = (index: number) => {
    renderMatch(traits, matches[index], index === 0);
    runners.querySelectorAll('button').forEach((b, i) => b.classList.toggle('selected', i === index));
  };

  const runners = $('runners');
  runners.replaceChildren(
    ...matches.map((m, i) => {
      const btn = document.createElement('button');
      btn.className = 'runner';
      btn.innerHTML = `<img alt="" loading="lazy"><span class="runner-name"></span><span class="runner-score">${m.similarity}%</span>`;
      btn.querySelector('img')!.src = artworkUrl(m.pokemon.id);
      btn.querySelector('.runner-name')!.textContent = m.pokemon.name;
      btn.addEventListener('click', () => {
        select(i);
        $('mon-figure').scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      return btn;
    }),
  );

  select(0);
  show('result');
}

function renderMatch(face: TraitVector, match: Match, isTop: boolean) {
  const { pokemon } = match;
  const color = TYPE_COLORS[pokemon.types[0]] ?? '#888';

  const art = $<HTMLImageElement>('mon-art');
  art.src = artworkUrl(pokemon.id);
  art.alt = pokemon.name;
  $('mon-figure').style.setProperty('--type', color);
  $('mon-caption').textContent = `#${String(pokemon.id).padStart(4, '0')}`;
  $('match-eyebrow').textContent = isTop ? 'Your Pokémon match' : 'Runner-up match';
  $('mon-name').textContent = isTop ? `You’re ${pokemon.name}!` : pokemon.name;
  $('mon-types').replaceChildren(...pokemon.types.map(typeChip));
  $('mon-score').textContent = `${match.similarity}%`;
  $('legend-mon').textContent = pokemon.name;

  const reasons = explainMatch(face, match);
  $('reasons').replaceChildren(
    ...(reasons.length
      ? reasons.map((r) => {
          const li = document.createElement('li');
          li.innerHTML = `<span class="reason-label"></span><span>You have <b class="r-you"></b>, and ${pokemon.name} has <b class="r-mon"></b>.</span>`;
          li.querySelector('.reason-label')!.textContent = r.trait.label;
          li.querySelector('.r-you')!.textContent = r.you;
          li.querySelector('.r-mon')!.textContent = r.them;
          return li;
        })
      : [Object.assign(document.createElement('li'), { textContent: 'A well-balanced match across every trait.' })]),
  );

  $('traits').replaceChildren(
    ...TRAITS.map((t) => {
      const row = document.createElement('div');
      row.className = 'trait';
      row.innerHTML = `
        <div class="trait-label"></div>
        <div class="trait-track">
          <span class="trait-gap"></span>
          <i class="marker mon"></i>
          <i class="marker you"></i>
        </div>
        <div class="trait-ends"><span></span><span></span></div>`;
      row.querySelector('.trait-label')!.textContent = t.label;
      const [low, high] = row.querySelectorAll('.trait-ends span');
      low.textContent = t.face[0].replace(/^an? /, '');
      high.textContent = t.face[1].replace(/^an? /, '');
      const you = face[t.key] * 100;
      const mon = match.traits[t.key] * 100;
      row.querySelector<HTMLElement>('.marker.you')!.style.left = `${you}%`;
      row.querySelector<HTMLElement>('.marker.mon')!.style.left = `${mon}%`;
      const gap = row.querySelector<HTMLElement>('.trait-gap')!;
      gap.style.left = `${Math.min(you, mon)}%`;
      gap.style.width = `${Math.abs(you - mon)}%`;
      return row;
    }),
  );
}

$('again-btn').addEventListener('click', () => show('pick'));

// Start downloading the model straight away so analysis feels instant.
loadLandmarker().catch((err) => console.warn('Face model preload failed', err));
