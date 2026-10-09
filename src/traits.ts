import type { MeasureKey, Measures } from './face.ts';
import { CALIBRATION } from './calibration.ts';

export type TraitKey =
  | 'round'
  | 'jaw'
  | 'sharp'
  | 'eyes'
  | 'spacing'
  | 'nose'
  | 'mouth'
  | 'brow'
  | 'forehead'
  | 'smile';

/** Trait scores as percentiles: 0 = lowest, 0.5 = average, 1 = highest. */
export type TraitVector = Record<TraitKey, number>;

export interface Trait {
  key: TraitKey;
  label: string;
  /** How much this trait counts when matching. */
  weight: number;
  /** Weighted mix of face measures; z-scores are combined then re-standardised. */
  recipe: [MeasureKey, number][];
  /** Spread of the combined z-score across the calibration set. */
  spread: number;
  face: [low: string, high: string];
  mon: [low: string, high: string];
}

export const TRAITS: Trait[] = [
  {
    key: 'round',
    label: 'Roundness',
    weight: 1.3,
    recipe: [['widthHeight', 1]],
    spread: 0.977,
    face: ['a long, oval face', 'a wide, round face'],
    mon: ['a lean, slender build', 'a round, chunky build'],
  },
  {
    key: 'jaw',
    label: 'Jaw strength',
    weight: 1,
    recipe: [['jawRatio', 1], ['chinAngle', 0.4]],
    spread: 1.083,
    face: ['a soft, tapered jaw', 'a strong, square jaw'],
    mon: ['a delicate frame', 'a sturdy, blocky frame'],
  },
  {
    key: 'sharp',
    label: 'Chin sharpness',
    weight: 1,
    recipe: [['chinLength', 1], ['chinAngle', -0.6]],
    spread: 0.787,
    face: ['a short, rounded chin', 'a long, pointed chin'],
    mon: ['a soft, rounded outline', 'a sharp, pointed outline'],
  },
  {
    key: 'eyes',
    label: 'Eye size',
    weight: 1.1,
    recipe: [['eyeWidth', 1], ['eyeOpen', 0.6], ['eyeWide', 0.3]],
    spread: 1.177,
    face: ['narrow, focused eyes', 'big, bright eyes'],
    mon: ['an imposing presence', 'small, cute proportions'],
  },
  {
    key: 'spacing',
    label: 'Eye spacing',
    weight: 0.8,
    recipe: [['eyeGap', 1]],
    spread: 0.999,
    face: ['close-set eyes', 'wide-set eyes'],
    mon: ['forward-facing features', 'wide-set, critter-like features'],
  },
  {
    key: 'nose',
    label: 'Nose length',
    weight: 0.7,
    recipe: [['noseLength', 1]],
    spread: 0.997,
    face: ['a short, button nose', 'a long, elegant nose'],
    mon: ['a compact body', 'a tall, long silhouette'],
  },
  {
    key: 'mouth',
    label: 'Mouth size',
    weight: 0.8,
    // Smiling widens the mouth and an open jaw parts the lips, so subtract
    // those expression effects (regression weights from calibration data).
    recipe: [['mouthWidth', 1], ['smile', -0.88], ['lipHeight', 0.5], ['jawOpen', -0.28]],
    spread: 0.448,
    face: ['a small, neat mouth', 'a wide, full mouth'],
    mon: ['a tiny mouth', 'a big, chompy mouth'],
  },
  {
    key: 'brow',
    label: 'Brow intensity',
    weight: 0.9,
    recipe: [['browGap', -1], ['browDown', 0.5]],
    spread: 1.223,
    face: ['high, relaxed brows', 'low, intense brows'],
    mon: ['a gentle temperament', 'a fierce attitude'],
  },
  {
    key: 'forehead',
    label: 'Forehead',
    weight: 0.6,
    recipe: [['foreheadHeight', 1], ['browInnerUp', 0.3]],
    spread: 0.884,
    face: ['a low brow line', 'a tall forehead'],
    mon: ['brawn over brains', 'big-brain psychic energy'],
  },
  {
    key: 'smile',
    label: 'Smile',
    weight: 1,
    recipe: [['smile', 1], ['jawOpen', 0.2]],
    spread: 1.058,
    face: ['a cool, serious look', 'a big, beaming smile'],
    mon: ['a moody, mysterious vibe', 'a cheerful, friendly vibe'],
  },
];

/** Standard normal CDF (Abramowitz & Stegun 7.1.26). */
export function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/** Combined (unscaled) z-score for one trait. */
export function traitZ(trait: Trait, measures: Measures): number {
  let sum = 0;
  let norm = 0;
  for (const [key, w] of trait.recipe) {
    const { mean, sd } = CALIBRATION[key];
    const z = Math.max(-3, Math.min(3, (measures[key] - mean) / sd));
    sum += w * z;
    norm += w * w;
  }
  return sum / Math.sqrt(norm);
}

export function faceTraits(measures: Measures): TraitVector {
  const out = {} as TraitVector;
  for (const t of TRAITS) out[t.key] = normalCdf(traitZ(t, measures) / t.spread);
  return out;
}
