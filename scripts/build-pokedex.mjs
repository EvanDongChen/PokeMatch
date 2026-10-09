// Fetches every Pokémon species from PokéAPI and writes a compact dataset
// to src/data/pokedex.json. Run with `npm run build:pokedex`.
import { writeFile, mkdir } from 'node:fs/promises';

const API = 'https://pokeapi.co/api/v2';
const OUT = new URL('../src/data/pokedex.json', import.meta.url);
const CONCURRENCY = 16;

async function getJson(url, attempt = 1) {
  const res = await fetch(url);
  if (!res.ok) {
    if (attempt < 4) {
      await new Promise((r) => setTimeout(r, 500 * attempt));
      return getJson(url, attempt + 1);
    }
    throw new Error(`${res.status} ${url}`);
  }
  return res.json();
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
      if (++done % 100 === 0) console.log(`  ${done}/${items.length}`);
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

async function fetchSpecies({ url }) {
  const species = await getJson(url);
  const variety = species.varieties.find((v) => v.is_default) ?? species.varieties[0];
  const mon = await getJson(variety.pokemon.url);
  const stat = (name) => mon.stats.find((s) => s.stat.name === name).base_stat;
  return {
    id: species.id,
    name: species.names.find((n) => n.language.name === 'en')?.name ?? species.name,
    types: mon.types.sort((a, b) => a.slot - b.slot).map((t) => t.type.name),
    color: species.color?.name ?? null,
    shape: species.shape?.name ?? null,
    height: mon.height / 10, // metres
    weight: mon.weight / 10, // kilograms
    stats: [
      stat('hp'),
      stat('attack'),
      stat('defense'),
      stat('special-attack'),
      stat('special-defense'),
      stat('speed'),
    ],
    baby: species.is_baby,
    legendary: species.is_legendary || species.is_mythical,
  };
}

const list = await getJson(`${API}/pokemon-species?limit=5000`);
console.log(`Fetching ${list.results.length} species…`);
const dex = await mapLimit(list.results, CONCURRENCY, fetchSpecies);
dex.sort((a, b) => a.id - b.id);

await mkdir(new URL('.', OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(dex));
console.log(`Wrote ${dex.length} Pokémon to ${OUT.pathname}`);
