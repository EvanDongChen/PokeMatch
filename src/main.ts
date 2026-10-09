import { analyzeFace, loadLandmarker, MAX_YAW, type FaceAnalysis } from './face.ts';
import { TRAITS, faceTraits, type TraitVector } from './traits.ts';
import { POKEDEX, rankMatches, explainMatch, artworkUrl, type Match } from './pokemon.ts';
import { loadSilhouette } from './silhouette.ts';
import { Stage, type Phase } from './stage.ts';
import { renderRadar } from './radar.ts';
import { renderShareCard } from './share.ts';

const MAX_SIDE = 1024;

const TYPE_COLORS: Record<string, string> = {
  normal: '#a8a77a', fire: '#ee8130', water: '#6390f0', electric: '#f7d02c', grass: '#7ac74c',
  ice: '#96d9d6', fighting: '#c22e28', poison: '#a33ea1', ground: '#e2bf65', flying: '#a98ff3',
  psychic: '#f95587', bug: '#a6b91a', rock: '#b6a136', ghost: '#735797', dragon: '#6f35fc',
  dark: '#705746', steel: '#b7b7ce', fairy: '#d685ad',
};

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const accentOf = (m: Match) => TYPE_COLORS[m.pokemon.types[0]] ?? '#ffcb05';
const titleCase = (s: string) => s[0].toUpperCase() + s.slice(1);
const dexNo = (id: number) => `#${String(id).padStart(4, '0')}`;

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

// ------------------------------------------------------------- landing visual

const HERO_IDS = [25, 143, 39, 54, 94, 133, 7, 1, 4, 52, 79, 175];
document.querySelectorAll<HTMLImageElement>('.orbit img').forEach((img, i, all) => {
  // Offset so no Pokémon sits directly under the caption.
  const a = ((i + 0.5) / all.length) * Math.PI * 2;
  img.style.left = `${50 + 44 * Math.sin(a)}%`;
  img.style.top = `${50 - 44 * Math.cos(a)}%`;
  img.src = artworkUrl(+img.dataset.id!);
});

(function cycleHero() {
  const img = $<HTMLImageElement>('hero-mon');
  const caption = $('hero-caption');
  let i = 0;
  const next = () => {
    if ($('screen-pick').hidden) return;
    const id = HERO_IDS[i++ % HERO_IDS.length];
    img.classList.remove('revealed');
    caption.textContent = "WHO'S THAT POKÉMON?";
    img.onload = () => {
      img.classList.add('shown');
      setTimeout(() => {
        img.classList.add('revealed');
        caption.textContent = `IT'S ${POKEDEX[id - 1].name.toUpperCase()}!`;
      }, 1300);
    };
    img.src = artworkUrl(id);
  };
  next();
  setInterval(next, 3200);
})();

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
    toast('That file isn’t an image. Try a JPG or PNG photo.');
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
    toast('Camera isn’t available in this browser. Upload a photo instead.');
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
    toast('Couldn’t open the camera. Check the permission, or upload a photo instead.');
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
}
let session: Session | null = null;

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
      const cell = document.createElement('div');
      cell.className = 'meter';
      cell.style.setProperty('--delay', `${250 + i * 140}ms`);
      cell.style.setProperty('--value', String(traits[t.key]));
      cell.innerHTML = `<span class="meter-label"></span><span class="meter-value"></span><span class="meter-bar"><i></i></span>`;
      cell.querySelector('.meter-label')!.textContent = t.label;
      cell.querySelector('.meter-value')!.textContent = `${Math.round(traits[t.key] * 100)}`;
      return cell;
    }),
  );
  $('readout').classList.remove('filled');
  requestAnimationFrame(() => requestAnimationFrame(() => $('readout').classList.add('filled')));
}

async function start(photo: HTMLCanvasElement) {
  show('session');
  $('results').hidden = true;
  $('readout').hidden = false;
  $('readout-status').textContent = 'loading model…';
  setStep('scan');

  let face: FaceAnalysis | null;
  try {
    await loadLandmarker();
    $('readout-status').textContent = 'mapping…';
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    face = await analyzeFace(photo);
  } catch (err) {
    console.error(err);
    show('pick');
    toast('The face model failed to load. Check your connection and try again.');
    return;
  }
  if (!face) {
    show('pick');
    toast('No face found in that photo. Try a clearer, front-facing shot.');
    return;
  }

  const traits = faceTraits(face.measures);
  const matches = rankMatches(traits);
  session = { photo, face, traits, matches, selected: 0 };
  buildReadout(traits);
  $('readout-status').textContent = 'measuring…';

  stage.setFace(photo, face);
  await runStage(matches[0], 'full');
}

async function runStage(match: Match, mode: 'full' | 'morph') {
  if (!session) return;
  const accent = accentOf(match);
  document.documentElement.style.setProperty('--accent', accent);
  const reasons = explainMatch(session.traits, match);
  // Silhouettes flashed during the search: random Pokémon, then the runners-up.
  const flicker = new Set<number>();
  if (mode === 'full') {
    while (flicker.size < 10) flicker.add(1 + Math.floor(Math.random() * POKEDEX.length));
    session.matches.forEach((m) => m !== match && flicker.add(m.pokemon.id));
    flicker.delete(match.pokemon.id);
  }
  const candidates = [...flicker].map(loadSilhouette);

  $('skip-btn').hidden = false;
  if (mode === 'full') renderResults(0);

  await stage.play({
    mode: reducedMotion ? 'morph' : mode,
    candidates,
    winner: loadSilhouette(match.pokemon.id),
    winnerLabel: `${dexNo(match.pokemon.id)} · ${match.pokemon.name.toUpperCase()}`,
    accent,
    links: reasons.map((r) => ({ key: r.trait.key, label: r.trait.label })),
    onPhase: (phase) => {
      setStep(phase);
      if (phase === 'search') $('readout-status').textContent = 'complete';
      if (phase === 'reveal' && mode === 'full') revealResults();
    },
  });
  $('skip-btn').hidden = true;
  if (mode === 'full') revealResults();
}

function revealResults() {
  if (!$('results').hidden) return;
  $('readout').hidden = true;
  $('results').hidden = false;
  animateGauge(session!.matches[session!.selected].similarity);
}

$('skip-btn').addEventListener('click', () => stage.skip());

// -------------------------------------------------------------------- results

function typeChip(type: string) {
  const el = document.createElement('span');
  el.className = 'type';
  el.textContent = titleCase(type);
  el.style.setProperty('--type', TYPE_COLORS[type] ?? '#888');
  return el;
}

let gaugeFrame = 0;
function animateGauge(value: number) {
  const fill = $('gauge-fill') as unknown as SVGCircleElement;
  const label = $('gauge-value');
  const circumference = 2 * Math.PI * 52;
  fill.style.strokeDasharray = `${circumference}`;
  cancelAnimationFrame(gaugeFrame);
  const startTime = performance.now();
  const duration = reducedMotion ? 1 : 1100;
  const step = (now: number) => {
    const k = Math.min(1, (now - startTime) / duration);
    const e = 1 - (1 - k) ** 3;
    fill.style.strokeDashoffset = `${circumference * (1 - (value / 100) * e)}`;
    label.textContent = String(Math.round(value * e));
    if (k < 1) gaugeFrame = requestAnimationFrame(step);
  };
  gaugeFrame = requestAnimationFrame(step);
}

function renderResults(index: number) {
  if (!session) return;
  session.selected = index;
  const { traits, matches, face } = session;
  const match = matches[index];
  const { pokemon } = match;
  const accent = accentOf(match);
  const isTop = index === 0;
  document.documentElement.style.setProperty('--accent', accent);

  const notices: string[] = [];
  if (face.faceCount > 1) notices.push(`Found ${face.faceCount} faces, so matched the largest one.`);
  if (face.yaw > MAX_YAW) notices.push('Your head looks turned. A straight-on photo gives a more accurate match.');
  $('notice').hidden = notices.length === 0;
  $('notice').textContent = notices.join(' ');

  // Holo card
  const holo = $('holo');
  holo.style.setProperty('--type', accent);
  holo.style.setProperty('--type2', TYPE_COLORS[pokemon.types[1] ?? pokemon.types[0]] ?? accent);
  holo.classList.remove('deal');
  void holo.offsetWidth;
  holo.classList.add('deal');
  $('holo-name').textContent = pokemon.name;
  $('holo-score').textContent = `${match.similarity}%`;
  $<HTMLImageElement>('holo-art').src = artworkUrl(pokemon.id);
  $<HTMLImageElement>('holo-art').alt = pokemon.name;
  $('holo-types').replaceChildren(...pokemon.types.map(typeChip));
  $('holo-id').textContent = `${dexNo(pokemon.id)} · ${pokemon.height} m · ${pokemon.weight} kg`;

  const reasons = explainMatch(traits, match);
  $('holo-traits').replaceChildren(
    ...reasons.map((r) => {
      const li = document.createElement('li');
      li.textContent = titleCase(r.them);
      return li;
    }),
  );

  $('match-eyebrow').textContent = isTop ? 'Your Pokémon match' : `Match #${index + 1}`;
  $('mon-name').textContent = isTop ? `You’re ${pokemon.name}!` : pokemon.name;

  const aligned = TRAITS.filter((t) => Math.abs(traits[t.key] - match.traits[t.key]) < 0.2).length;
  $('mon-blurb').textContent =
    `Closely aligned on ${aligned} of 10 traits` + (reasons[0] ? `, with the strongest link in ${reasons[0].trait.label.toLowerCase()}.` : '.');

  $('reasons').replaceChildren(
    ...(reasons.length
      ? reasons.map((r, i) => {
          const li = document.createElement('li');
          li.style.setProperty('--i', String(i));
          li.innerHTML = `<span class="reason-tag"></span><span class="reason-text"><span class="r-you"></span><span class="arrow">→</span><span class="r-mon"></span></span>`;
          li.querySelector('.reason-tag')!.textContent = r.trait.label;
          li.querySelector('.r-you')!.textContent = `You: ${r.you}`;
          li.querySelector('.r-mon')!.textContent = `${pokemon.name}: ${r.them}`;
          return li;
        })
      : [Object.assign(document.createElement('li'), { textContent: 'A well-balanced match across every trait.' })]),
  );

  $('legend-mon').textContent = pokemon.name;
  renderRadar($('radar'), traits, match.traits, accent);

  const runners = $('runners');
  if (runners.childElementCount !== matches.length || index === 0) {
    runners.replaceChildren(
      ...matches.map((m, i) => {
        const btn = document.createElement('button');
        btn.className = 'runner';
        btn.style.setProperty('--type', accentOf(m));
        btn.innerHTML = `<span class="runner-rank">${i + 1}</span><img alt=""><span class="runner-name"></span><span class="runner-score">${m.similarity}%</span>`;
        btn.querySelector('img')!.src = artworkUrl(m.pokemon.id);
        btn.querySelector('.runner-name')!.textContent = m.pokemon.name;
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
  animateGauge(session.matches[index].similarity);
  $('stage').scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' });
  runStage(session.matches[index], 'morph');
}

$('replay-btn').addEventListener('click', () => {
  if (!session) return;
  $('stage').scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' });
  runStage(session.matches[session.selected], 'full').then(() => animateGauge(session!.matches[session!.selected].similarity));
});

$('again-btn').addEventListener('click', () => {
  session = null;
  document.documentElement.style.removeProperty('--accent');
  show('pick');
});

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
      accent: accentOf(match),
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `pokematch-${match.pokemon.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (err) {
    console.error(err);
    toast('Couldn’t create the card image.');
  } finally {
    btn.disabled = false;
  }
});

// Holographic tilt
const holo = $('holo');
holo.addEventListener('pointermove', (e) => {
  const r = holo.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width;
  const y = (e.clientY - r.top) / r.height;
  holo.style.setProperty('--mx', `${x * 100}%`);
  holo.style.setProperty('--my', `${y * 100}%`);
  holo.style.setProperty('--rx', `${(0.5 - y) * 18}deg`);
  holo.style.setProperty('--ry', `${(x - 0.5) * 22}deg`);
  holo.classList.add('active');
});
holo.addEventListener('pointerleave', () => {
  holo.classList.remove('active');
  holo.style.setProperty('--rx', '0deg');
  holo.style.setProperty('--ry', '0deg');
});

// Start downloading the model straight away so analysis feels instant.
loadLandmarker().catch((err) => console.warn('Face model preload failed', err));
