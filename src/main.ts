import { analyzeFace, loadLandmarker, MAX_YAW, type FaceAnalysis } from './face.ts';
import { TRAITS, faceTraits, type TraitVector } from './traits.ts';
import { POKEDEX, rankMatches, explainMatch, artworkUrl, type Match } from './pokemon.ts';
import { loadSilhouette } from './silhouette.ts';
import { Stage, type Phase } from './stage.ts';
import { renderRadar } from './radar.ts';
import { renderShareCard } from './share.ts';

const MAX_SIDE = 1024;

const TYPE_COLORS: Record<string, string> = {
  normal: '#a8a77a', fire: '#ee8130', water: '#6390f0', electric: '#d6b11a', grass: '#5fa83a',
  ice: '#5fb8b4', fighting: '#c22e28', poison: '#a33ea1', ground: '#c09a3e', flying: '#8a6fe0',
  psychic: '#f95587', bug: '#8a9a16', rock: '#a08a2a', ghost: '#735797', dragon: '#6f35fc',
  dark: '#705746', steel: '#8a8aa6', fairy: '#d06aa0',
};

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const titleCase = (s: string) => s[0].toUpperCase() + s.slice(1);
const dexNo = (id: number) => `No. ${String(id).padStart(4, '0')}`;

// -------------------------------------------------------------------- screens

const screens = ['pick', 'camera', 'session'] as const;
type Screen = (typeof screens)[number];

function show(screen: Screen) {
  for (const s of screens) $(`screen-${s}`).hidden = s !== screen;
  if (screen !== 'camera') stopCamera();
  window.scrollTo({ top: 0, behavior: reducedMotion ? 'auto' : 'smooth' });
}

let toastTimer = 0;
function toast(message: string) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), 5000);
}

document.querySelectorAll<HTMLImageElement>('.specimen img').forEach((img) => (img.src = artworkUrl(+img.dataset.id!)));

// ---------------------------------------------------------------- image input

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

async function handleFile(file: File | undefined | null) {
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    toast('That file isn’t a photograph. A JPG or PNG, please.');
    return;
  }
  try {
    const bitmap = await createImageBitmap(file);
    const canvas = toCanvas(bitmap, bitmap.width, bitmap.height);
    bitmap.close();
    await start(canvas);
  } catch (err) {
    console.error(err);
    show('pick');
    toast('Couldn’t read that image. Try a different photo.');
  }
}

const fileInput = $<HTMLInputElement>('file-input');
fileInput.addEventListener('change', () => {
  handleFile(fileInput.files?.[0]);
  fileInput.value = '';
});

const dropzone = $('dropzone');
for (const target of [dropzone, document.body]) {
  target.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (!$('screen-pick').hidden) dropzone.classList.add('dragging');
  });
}
document.body.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) dropzone.classList.remove('dragging');
});
document.body.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragging');
  if (!$('screen-pick').hidden) handleFile(e.dataTransfer?.files[0]);
});

window.addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
  if (item && !$('screen-pick').hidden) handleFile(item.getAsFile());
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
  if (!navigator.mediaDevices?.getUserMedia) {
    toast('This browser has no camera access. Choose a photo instead.');
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
    toast('Couldn’t open the camera. Check the permission, or choose a photo instead.');
  }
});

$('camera-cancel').addEventListener('click', () => show('pick'));

$('capture-btn').addEventListener('click', async () => {
  if (!video.videoWidth) return;
  const countdown = $('countdown');
  countdown.hidden = false;
  for (const n of ['3', '2', '1']) {
    countdown.textContent = n;
    countdown.classList.remove('tick');
    void countdown.offsetWidth;
    countdown.classList.add('tick');
    await new Promise((r) => setTimeout(r, 700));
    if (!stream) return; // cancelled
  }
  countdown.hidden = true;
  $('screen-camera').classList.add('flash');
  setTimeout(() => $('screen-camera').classList.remove('flash'), 400);
  start(toCanvas(video, video.videoWidth, video.videoHeight, true));
});

// ------------------------------------------------------------------- session

const stage = new Stage($<HTMLCanvasElement>('stage'));

interface Session {
  photo: HTMLCanvasElement;
  face: FaceAnalysis;
  traits: TraitVector;
  matches: Match[];
  selected: number;
  observation: string;
  date: string;
}
let session: Session | null = null;

/** Observation numbers count up per browser, just for flavour. */
function nextObservation(): string {
  let n = 1 + Math.floor(Math.random() * 40);
  try {
    n = Number(localStorage.getItem('pokematch-obs') ?? n) + 1;
    localStorage.setItem('pokematch-obs', String(n));
  } catch {
    // Storage blocked; a random number is fine.
  }
  return String(n).padStart(4, '0');
}

function setStep(phase: Phase) {
  const order: Phase[] = ['scan', 'search', 'morph', 'reveal', 'done'];
  const current = order.indexOf(phase);
  document.querySelectorAll<HTMLElement>('#steps li').forEach((li) => {
    const idx = order.indexOf(li.dataset.phase as Phase);
    li.classList.toggle('active', idx === current);
    li.classList.toggle('complete', idx < current);
  });
}

function buildReadout(traits: TraitVector) {
  $('readout-grid').replaceChildren(
    ...TRAITS.map((t, i) => {
      const row = document.createElement('div');
      row.className = 'measure';
      row.style.setProperty('--delay', `${300 + i * 130}ms`);
      row.style.setProperty('--value', String(traits[t.key]));
      row.innerHTML = `<span class="measure-label"></span><span class="measure-scale"></span><span class="measure-value"></span>`;
      row.querySelector('.measure-label')!.textContent = t.label.toLowerCase();
      row.querySelector('.measure-value')!.textContent = String(Math.round(traits[t.key] * 100));
      return row;
    }),
  );
  $('readout').classList.remove('filled');
  requestAnimationFrame(() => requestAnimationFrame(() => $('readout').classList.add('filled')));
}

async function start(photo: HTMLCanvasElement) {
  show('session');
  stage.preview(photo);
  $('skip-btn').hidden = true;
  $('results').hidden = true;
  $('readout').hidden = false;
  $('readout-grid').replaceChildren();
  $('readout-status').textContent = 'loading the measuring kit…';
  setStep('scan');

  const observation = nextObservation();
  const date = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  $('obs-no').textContent = observation;
  $('obs-date').textContent = date;

  let face: FaceAnalysis | null;
  try {
    await loadLandmarker();
    $('readout-status').textContent = 'measuring…';
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    face = await analyzeFace(photo);
  } catch (err) {
    console.error(err);
    show('pick');
    toast('The face model wouldn’t load. Check the connection and try again.');
    return;
  }
  if (!face) {
    show('pick');
    toast('I couldn’t find a face in that one. Try a clearer photo, facing forward.');
    return;
  }

  const traits = faceTraits(face.measures);
  const matches = rankMatches(traits);
  session = { photo, face, traits, matches, selected: 0, observation, date };
  buildReadout(traits);
  $('readout-status').textContent = '';

  stage.setFace(photo, face);
  await runStage(matches[0], 'full');
}

async function runStage(match: Match, mode: 'full' | 'morph') {
  if (!session) return;
  const reasons = explainMatch(session.traits, match);

  // Silhouettes flashed during the search: random Pokémon, then the runners-up.
  const flicker = new Set<number>();
  if (mode === 'full') {
    while (flicker.size < 10) flicker.add(1 + Math.floor(Math.random() * POKEDEX.length));
    session.matches.forEach((m) => flicker.add(m.pokemon.id));
    flicker.delete(match.pokemon.id);
  }

  $('skip-btn').hidden = false;
  if (mode === 'full') renderResults(session.selected);
  const scrollAtStart = window.scrollY;

  await stage.play({
    mode: reducedMotion ? 'morph' : mode,
    candidates: [...flicker].map(loadSilhouette),
    winner: loadSilhouette(match.pokemon.id),
    winnerLabel: `${dexNo(match.pokemon.id)} ${match.pokemon.name}`,
    links: reasons.map((r) => ({ key: r.trait.key, label: r.trait.label })),
    onPhase: (phase) => {
      setStep(phase);
      if (phase === 'reveal' && mode === 'full') revealResults();
    },
  });
  $('skip-btn').hidden = true;
  if (mode === 'full') {
    revealResults();
    // Lead the eye to the conclusion, unless the viewer has already scrolled.
    if (Math.abs(window.scrollY - scrollAtStart) < 40 && !$('screen-session').hidden) {
      setTimeout(() => $('steps').scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' }), 600);
    }
  }
}

function revealResults() {
  if (!$('results').hidden) return;
  $('readout').hidden = true;
  $('results').hidden = false;
  countUp(session!.matches[session!.selected].similarity);
}

$('skip-btn').addEventListener('click', () => stage.skip());

// -------------------------------------------------------------------- results

function typeStamp(type: string) {
  const el = document.createElement('span');
  el.className = 'type';
  el.textContent = type;
  el.style.setProperty('--type', TYPE_COLORS[type] ?? '#777');
  return el;
}

let countFrame = 0;
function countUp(value: number) {
  const label = $('gauge-value');
  cancelAnimationFrame(countFrame);
  const startTime = performance.now();
  const duration = reducedMotion ? 1 : 900;
  const step = (now: number) => {
    const k = Math.min(1, (now - startTime) / duration);
    label.textContent = String(Math.round(value * (1 - (1 - k) ** 3)));
    if (k < 1) countFrame = requestAnimationFrame(step);
  };
  countFrame = requestAnimationFrame(step);
}

function renderResults(index: number) {
  if (!session) return;
  session.selected = index;
  const { traits, matches, face } = session;
  const match = matches[index];
  const { pokemon } = match;
  const isTop = index === 0;

  const notices: string[] = [];
  if (face.faceCount > 1) notices.push(`Note: ${face.faceCount} faces in the photo. I measured the largest.`);
  if (face.yaw > MAX_YAW) notices.push('Subject’s head was turned. A straight-on photo gives a more reliable reading.');
  $('notice').hidden = notices.length === 0;
  $('notice').textContent = notices.join(' ');

  document.title = `${pokemon.name} · PokéMatch`;

  // Index card
  const card = $('specimen-card');
  card.classList.remove('deal');
  void card.offsetWidth;
  card.classList.add('deal');
  $('card-no').textContent = dexNo(pokemon.id);
  $('card-types').replaceChildren(...pokemon.types.map(typeStamp));
  $('card-art').classList.remove('loaded');
  $<HTMLImageElement>('card-art').src = artworkUrl(pokemon.id);
  $<HTMLImageElement>('card-art').alt = pokemon.name;
  $('card-name').textContent = pokemon.name;
  $('card-height').textContent = `${pokemon.height} m`;
  $('card-weight').textContent = `${pokemon.weight} kg`;

  // Verdict
  document.querySelector('.verdict-lead')!.textContent = isTop
    ? 'Subject most closely resembles'
    : `Candidate no. ${index + 1} for comparison`;
  $('mon-name').textContent = `${pokemon.name}.`;

  const reasons = explainMatch(traits, match);
  const aligned = TRAITS.filter((t) => Math.abs(traits[t.key] - match.traits[t.key]) < 0.2).length;
  $('mon-blurb').textContent =
    `Agrees closely on ${aligned} of 10 measures` +
    (reasons[0] ? `. Strongest likeness is the ${reasons[0].trait.label.toLowerCase()}.` : '.');

  $('reasons').replaceChildren(
    ...(reasons.length
      ? reasons.map((r, i) => {
          const li = document.createElement('li');
          li.style.setProperty('--i', String(i));
          li.innerHTML = `<span class="obs-tag"></span><span class="obs-text"><mark></mark>, <span class="them"></span></span>`;
          li.querySelector('.obs-tag')!.textContent = r.trait.label;
          li.querySelector('mark')!.textContent = titleCase(r.you);
          li.querySelector('.them')!.textContent = `like ${pokemon.name}’s ${r.them.replace(/^an? /, '')}`;
          return li;
        })
      : [Object.assign(document.createElement('li'), { textContent: 'An even match across every measure.' })]),
  );

  $('legend-mon').textContent = pokemon.name;
  renderRadar($('radar'), traits, match.traits);

  const runners = $('runners');
  if (runners.childElementCount !== matches.length || index === 0) {
    runners.replaceChildren(
      ...matches.map((m, i) => {
        const btn = document.createElement('button');
        btn.className = 'runner';
        btn.innerHTML = `<img alt=""><span class="runner-name"></span><span class="runner-score">${m.similarity}%</span>`;
        btn.querySelector('img')!.src = artworkUrl(m.pokemon.id);
        btn.querySelector('.runner-name')!.textContent = `${dexNo(m.pokemon.id)} ${m.pokemon.name}`;
        btn.addEventListener('click', () => selectMatch(i));
        return btn;
      }),
    );
  }
  runners.querySelectorAll('.runner').forEach((b, i) => b.classList.toggle('selected', i === index));
}

function selectMatch(index: number) {
  if (!session || index === session.selected) return;
  renderResults(index);
  countUp(session.matches[index].similarity);
  $('stage').scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' });
  runStage(session.matches[index], 'morph');
}

$('replay-btn').addEventListener('click', () => {
  if (!session) return;
  $('stage').scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' });
  runStage(session.matches[session.selected], 'full');
});

$('again-btn').addEventListener('click', () => {
  session = null;
  document.title = 'PokéMatch';
  show('pick');
});

// Camera shortcuts: space or enter to snap, escape to go back.
window.addEventListener('keydown', (e) => {
  if ($('screen-camera').hidden || e.repeat) return;
  if (e.key === 'Escape') show('pick');
  else if ((e.key === ' ' || e.key === 'Enter') && document.activeElement?.id !== 'camera-cancel') {
    e.preventDefault();
    $('capture-btn').click();
  }
});

// Fade images in as they arrive instead of popping.
document.addEventListener(
  'load',
  (e) => e.target instanceof HTMLImageElement && e.target.classList.add('loaded'),
  true,
);
document.querySelectorAll('img').forEach((img) => img.complete && img.naturalWidth && img.classList.add('loaded'));

$('download-btn').addEventListener('click', async () => {
  if (!session) return;
  const btn = $<HTMLButtonElement>('download-btn');
  btn.disabled = true;
  try {
    const match = session.matches[session.selected];
    const blob = await renderShareCard({
      photo: session.photo,
      crop: stage.faceCrop,
      match,
      silhouette: await loadSilhouette(match.pokemon.id),
      reasons: explainMatch(session.traits, match),
      observation: session.observation,
      date: session.date,
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `pokematch-${match.pokemon.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (err) {
    console.error(err);
    toast('Couldn’t save the page as an image.');
  } finally {
    btn.disabled = false;
  }
});

// Start downloading the model straight away so analysis feels instant.
loadLandmarker().catch((err) => console.warn('Face model preload failed', err));
