import { TRAITS, type TraitVector } from './traits.ts';

const SIZE = 420;
const C = SIZE / 2;
const R = 140;
const NS = 'http://www.w3.org/2000/svg';

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

const angle = (i: number) => -Math.PI / 2 + (i / TRAITS.length) * Math.PI * 2;
const at = (i: number, r: number) => [C + Math.cos(angle(i)) * r, C + Math.sin(angle(i)) * r] as const;
const radius = (v: number) => R * (0.08 + 0.92 * v);

function polygon(values: TraitVector) {
  return TRAITS.map((t, i) => at(i, radius(values[t.key])).join(',')).join(' ');
}

/** Pen hatching used to fill each shape, like shading in a notebook. */
function hatch(id: string, color: string, rotate: number) {
  const pattern = el('pattern', {
    id,
    width: 7,
    height: 7,
    patternUnits: 'userSpaceOnUse',
    patternTransform: `rotate(${rotate})`,
  });
  pattern.append(el('line', { x1: 0, y1: 0, x2: 0, y2: 7, stroke: color, 'stroke-width': 1.1, 'stroke-opacity': 0.45 }));
  return pattern;
}

/** Renders a 10-axis radar chart comparing the subject with a Pokémon. */
export function renderRadar(host: HTMLElement, you: TraitVector, mon: TraitVector) {
  // Extra horizontal room so long axis labels aren't clipped.
  const svg = el('svg', { viewBox: `-60 -6 ${SIZE + 120} ${SIZE + 12}`, class: 'radar', role: 'img' });
  svg.setAttribute('aria-label', 'Radar chart comparing your traits with the Pokémon’s traits');

  const defs = el('defs', {});
  defs.append(hatch('hatch-you', '#2a4aa0', 45), hatch('hatch-mon', '#b8322a', -45));
  svg.append(defs);

  for (const f of [0.25, 0.5, 0.75, 1]) {
    svg.append(
      el('polygon', {
        points: TRAITS.map((_, i) => at(i, R * f).join(',')).join(' '),
        class: f === 1 ? 'radar-ring outer' : 'radar-ring',
      }),
    );
  }
  TRAITS.forEach((t, i) => {
    const [x, y] = at(i, R);
    svg.append(el('line', { x1: C, y1: C, x2: x, y2: y, class: 'radar-axis' }));
    const [lx, ly] = at(i, R + 24);
    const cos = Math.cos(angle(i));
    const label = el('text', {
      x: lx,
      y: ly,
      class: 'radar-label',
      'text-anchor': Math.abs(cos) < 0.2 ? 'middle' : cos > 0 ? 'start' : 'end',
      'dominant-baseline': 'middle',
    });
    label.textContent = t.label.toLowerCase();
    svg.append(label);
  });

  const shapes = el('g', { class: 'radar-shapes' });
  shapes.append(el('polygon', { points: polygon(mon), class: 'radar-mon' }), el('polygon', { points: polygon(you), class: 'radar-you' }));
  for (const [values, cls] of [
    [mon, 'radar-dot mon'],
    [you, 'radar-dot you'],
  ] as const) {
    TRAITS.forEach((t, i) => {
      const [x, y] = at(i, radius(values[t.key]));
      shapes.append(el('circle', { cx: x, cy: y, r: 2.8, class: cls }));
    });
  }
  svg.append(shapes);
  host.replaceChildren(svg);
}
