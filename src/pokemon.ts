import dex from './data/pokedex.json' with { type: 'json' };
import shapes from './data/shapes.json' with { type: 'json' };
import { TRAITS, type TraitKey, type TraitVector } from './traits.ts';

export interface Pokemon {
  id: number;
  name: string;
  types: string[];
  color: string | null;
  shape: string | null;
  height: number;
  weight: number;
  /** hp, attack, defense, sp. attack, sp. defense, speed */
  stats: number[];
  baby: boolean;
  legendary: boolean;
}

export const POKEDEX = dex as Pokemon[];

export const artworkUrl = (id: number) =>
  `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${id}.png`;

const HP = 0, ATK = 1, DEF = 2, SPA = 3, SPD = 4, SPE = 5;

type Table = Record<string, number>;

/** Sum of bonuses for each of the Pokémon's types. */
const typeBonus = (p: Pokemon, table: Table) => p.types.reduce((s, t) => s + (table[t] ?? 0), 0);
const shapeBonus = (p: Pokemon, table: Table) => (p.shape ? table[p.shape] ?? 0 : 0);
const colorBonus = (p: Pokemon, table: Table) => (p.color ? table[p.color] ?? 0 : 0);
const total = (p: Pokemon) => p.stats.reduce((a, b) => a + b, 0);
const share = (p: Pokemon, ...idx: number[]) => idx.reduce((s, i) => s + p.stats[i], 0) / total(p);
const logBmi = (p: Pokemon) => Math.log(p.weight / Math.max(p.height, 0.1) ** 2);

/**
 * Raw score of each trait for a Pokémon. Only the ordering matters, as scores
 * are converted to percentiles across the whole Pokédex.
 */
const RAW: Record<TraitKey, (p: Pokemon) => number> = {
  round: (p) =>
    logBmi(p) +
    shapeBonus(p, {
      ball: 1.5, blob: 1.2, heads: 0.6, armor: 0.3, arms: 0.2, quadruped: 0.1,
      fish: -0.3, tentacles: -0.3, legs: -0.6, wings: -0.6, 'bug-wings': -0.8, squiggle: -1.2,
    }),

  jaw: (p) =>
    share(p, HP, DEF) * 10 +
    0.15 * Math.log(p.weight + 1) +
    typeBonus(p, { rock: 0.6, steel: 0.6, ground: 0.4, fighting: 0.4 }) +
    shapeBonus(p, { armor: 0.4, arms: 0.2, humanoid: 0.1 }),

  sharp: (p) =>
    share(p, ATK, SPE) * 10 -
    0.2 * logBmi(p) +
    typeBonus(p, { dragon: 0.5, dark: 0.4, flying: 0.3, electric: 0.2, steel: 0.2, ice: 0.2, bug: 0.1 }) +
    shapeBonus(p, { wings: 0.3, 'bug-wings': 0.3, squiggle: 0.3, ball: -0.6, blob: -0.6 }),

  eyes: (p) =>
    -0.8 * Math.log(p.height) +
    (p.baby ? 1 : 0) -
    (p.legendary ? 0.4 : 0) -
    (total(p) - 400) / 250 +
    typeBonus(p, { fairy: 0.6, normal: 0.3 }) +
    colorBonus(p, { pink: 0.4, yellow: 0.3, white: 0.2 }) +
    shapeBonus(p, { ball: 0.3 }),

  spacing: (p) =>
    share(p, SPD) * 4 +
    typeBonus(p, { water: 0.6, bug: 0.5, ground: 0.2, poison: 0.2, psychic: -0.3, fighting: -0.3 }) +
    shapeBonus(p, {
      fish: 1, 'bug-wings': 0.6, squiggle: 0.5, quadruped: 0.4, tentacles: 0.4, armor: 0.3,
      legs: 0.3, heads: 0.3, blob: 0.2, wings: 0.1, upright: -0.2, arms: -0.3, humanoid: -0.6,
    }),

  nose: (p) =>
    0.8 * Math.log(p.height) +
    typeBonus(p, { dragon: 0.3 }) +
    shapeBonus(p, { squiggle: 0.6, upright: 0.3, humanoid: 0.3, legs: 0.3, blob: -0.4, ball: -0.6 }),

  mouth: (p) =>
    share(p, ATK, HP) * 4 +
    0.1 * Math.log(p.weight + 1) +
    typeBonus(p, { water: 0.5, dark: 0.3, poison: 0.3, ground: 0.3, normal: 0.2 }) +
    shapeBonus(p, { fish: 0.5, blob: 0.5, heads: 0.4, ball: 0.3 }),

  brow: (p) =>
    share(p, ATK) * 10 -
    (p.baby ? 0.6 : 0) +
    (p.legendary ? 0.2 : 0) +
    typeBonus(p, {
      dark: 0.6, dragon: 0.5, fighting: 0.5, ghost: 0.2, fire: 0.2, steel: 0.1, normal: -0.1, fairy: -0.5,
    }) +
    colorBonus(p, { black: 0.3, red: 0.2, pink: -0.3 }),

  forehead: (p) =>
    share(p, SPA) * 10 +
    typeBonus(p, {
      psychic: 0.8, ghost: 0.3, fairy: 0.3, dragon: 0.1, rock: -0.2, ground: -0.2, fighting: -0.3,
    }) +
    shapeBonus(p, { heads: 0.4, humanoid: 0.3, ball: 0.2 }),

  smile: (p) =>
    share(p, HP) * 4 +
    (p.baby ? 0.4 : 0) -
    (p.legendary ? 0.2 : 0) +
    typeBonus(p, {
      fairy: 0.6, normal: 0.4, electric: 0.3, grass: 0.2, water: 0.1, rock: -0.1,
      dragon: -0.2, fighting: -0.2, poison: -0.3, steel: -0.3, ghost: -0.4, dark: -0.5,
    }) +
    colorBonus(p, { pink: 0.4, yellow: 0.3, white: 0.1, gray: -0.2, black: -0.3 }),
};

/** Converts raw scores to percentiles in [0, 1], averaging ties. */
function percentiles(values: number[]): number[] {
  const order = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(values.length);
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    const rank = (i + j) / 2 / (values.length - 1);
    for (let k = i; k <= j; k++) out[order[k][1]] = rank;
    i = j + 1;
  }
  return out;
}

/** Silhouette measurements of each artwork (scripts/build-shapes.mjs). */
interface Shape {
  aspect: number;
  fill: number;
  circularity: number;
  solidity: number;
  radialCV: number;
  jagged: number;
  base: number;
  top: number;
}
const SHAPES = new Map((shapes as ({ id: number } & Shape)[]).map((s) => [s.id, s]));

/**
 * How each trait shows up in the artwork's outline, and how much that counts
 * against the stats/type-based score above (0 = ignore the outline).
 */
const GEO: Partial<Record<TraitKey, { weight: number; score: (s: Shape) => number }>> = {
  // Ball-like, filled-in silhouettes.
  round: { weight: 0.55, score: (s) => s.circularity + 0.5 * s.fill - 0.3 * Math.abs(Math.log(s.aspect)) },
  // Chunky, solid shapes that stay wide at the bottom.
  jaw: { weight: 0.45, score: (s) => s.base + 0.6 * s.solidity },
  // Spikes, horns and a narrow, pointed bottom.
  sharp: { weight: 0.5, score: (s) => 3 * s.jagged + (1 - s.solidity) + 0.4 * (1 - s.base) },
  // Tall or stretched-out outlines.
  nose: { weight: 0.5, score: (s) => Math.log(s.aspect) + 0.5 * s.radialCV },
  // Wide at the top, like a big head.
  forehead: { weight: 0.3, score: (s) => s.top },
  // Compact, rounded shapes read as cute.
  eyes: { weight: 0.2, score: (s) => s.circularity - s.radialCV },
};

/** Trait percentiles for every Pokémon, in Pokédex order. */
export const POKEMON_TRAITS: TraitVector[] = (() => {
  const vectors = POKEDEX.map(() => ({}) as TraitVector);
  for (const { key } of TRAITS) {
    let values = percentiles(POKEDEX.map(RAW[key]));
    const geo = GEO[key];
    if (geo) {
      const outline = percentiles(POKEDEX.map((p) => geo.score(SHAPES.get(p.id)!)));
      values = percentiles(values.map((v, i) => (1 - geo.weight) * v + geo.weight * outline[i]));
    }
    values.forEach((v, i) => (vectors[i][key] = v));
  }
  return vectors;
})();

export interface Match {
  pokemon: Pokemon;
  traits: TraitVector;
  /** 0–100 */
  similarity: number;
  /** 1 = best match for this face, up to 1025. */
  rank: number;
}

const WEIGHT_SUM = TRAITS.reduce((s, t) => s + t.weight, 0);

/**
 * Pokémon with middling traits sit close to every face and would win far too
 * often ("hubs"). Each Pokémon's expected squared distance to a random face,
 * with uniform percentiles f, is Σ w·E[(f - p)²] = Σ w·(p² - p + 1/3). Hubs
 * have the smallest, so subtracting part of it evens out the field.
 */
export const HUB_CORRECTION = 0.3;
const EXPECTED_SQ = POKEMON_TRAITS.map(
  (traits) => TRAITS.reduce((s, t) => s + t.weight * (traits[t.key] ** 2 - traits[t.key] + 1 / 3), 0) / WEIGHT_SUM,
);
const MEAN_EXPECTED_SQ = EXPECTED_SQ.reduce((a, b) => a + b, 0) / EXPECTED_SQ.length;

/** Every Pokémon, ranked by how closely its traits match the face's traits. */
export function rankAll(face: TraitVector, hub = HUB_CORRECTION): Match[] {
  return POKEDEX.map((pokemon, i) => {
    const traits = POKEMON_TRAITS[i];
    let sq = 0;
    for (const t of TRAITS) sq += t.weight * (face[t.key] - traits[t.key]) ** 2;
    const score = sq / WEIGHT_SUM - hub * (EXPECTED_SQ[i] - MEAN_EXPECTED_SQ);
    return { pokemon, traits, score };
  })
    .sort((a, b) => a.score - b.score)
    .map(({ pokemon, traits, score }, i) => ({
      pokemon,
      traits,
      similarity: Math.min(99, Math.round(100 * (1 - Math.sqrt(Math.max(0, score))))),
      rank: i + 1,
    }));
}

/** The closest `count` Pokémon. */
export function rankMatches(face: TraitVector, count = 6, hub = HUB_CORRECTION): Match[] {
  return rankAll(face, hub).slice(0, count);
}

export interface Reason {
  trait: (typeof TRAITS)[number];
  you: string;
  them: string;
}

/** The traits that most strongly explain a match: shared and far from average. */
export function explainMatch(face: TraitVector, match: Match, count = 3): Reason[] {
  return TRAITS.filter((t) => Math.abs(face[t.key] - match.traits[t.key]) < 0.25)
    .map((t) => {
      const f = face[t.key];
      const m = match.traits[t.key];
      const sameSide = (f - 0.5) * (m - 0.5) > 0;
      const strength = sameSide ? Math.min(Math.abs(f - 0.5), Math.abs(m - 0.5)) : -1;
      return { t, f, m, strength };
    })
    .filter((x) => x.strength >= 0)
    .sort((a, b) => b.strength - a.strength)
    .slice(0, count)
    .map(({ t, f, m }) => ({
      trait: t,
      you: t.face[f > 0.5 ? 1 : 0],
      them: t.mon[m > 0.5 ? 1 : 0],
    }));
}
