import { defineConfig, type Plugin } from 'vite';
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import type { IncomingMessage } from 'node:http';

const OVERRIDES = 'scripts/head-overrides.json';
const SHAPES = 'src/data/shapes.json';

type Override = { note?: string; head?: number[]; eyes?: number[][]; mouth?: number[] | null };

const body = (req: IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });

/** One line per Pokémon, in Pokédex order, so diffs stay readable. */
function formatOverrides(all: Record<string, Override>) {
  const lines = Object.keys(all)
    .sort((a, b) => +a - +b)
    .map((id) => `  ${JSON.stringify(id)}: ${JSON.stringify(all[id])}`);
  return `{\n${lines.join(',\n')}\n}\n`;
}

/**
 * Dev-only API for tools/features.html: saves hand fixes to the head, eyes
 * and mouth, applies them to shapes.json straight away, and can re-run
 * build:shapes to re-measure moved heads.
 */
function featureEditor(): Plugin {
  return {
    name: 'feature-editor',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__overrides', async (req, res) => {
        if (req.method === 'GET') {
          res.setHeader('Content-Type', 'application/json');
          res.end(await readFile(OVERRIDES, 'utf8'));
          return;
        }
        // POST { id, fix }: fix replaces the Pokémon's entry; null removes it.
        const { id, fix } = JSON.parse(await body(req)) as { id: number; fix: Override | null };
        const all = JSON.parse(await readFile(OVERRIDES, 'utf8')) as Record<string, Override>;
        if (fix) all[id] = fix;
        else delete all[id];
        await writeFile(OVERRIDES, formatOverrides(all));

        // Apply to shapes.json now; head outlines are re-measured on rebuild.
        if (fix) {
          const shapes = JSON.parse(await readFile(SHAPES, 'utf8')) as { id: number; head: Record<string, unknown> }[];
          const head = shapes.find((s) => s.id === id)!.head;
          if (fix.head) head.box = fix.head;
          if (fix.eyes) head.eyes = fix.eyes;
          if (fix.mouth !== undefined) {
            if (fix.mouth) head.mouth = fix.mouth;
            else delete head.mouth;
          }
          await writeFile(SHAPES, JSON.stringify(shapes));
        }
        res.end('ok');
      });

      server.middlewares.use('/__rebuild', (_req, res) => {
        const run = spawn(process.execPath, ['scripts/build-shapes.mjs']);
        let log = '';
        run.stdout.on('data', (d) => (log += d));
        run.stderr.on('data', (d) => (log += d));
        run.on('close', (code) => {
          res.statusCode = code === 0 ? 200 : 500;
          res.end(log);
        });
      });
    },
  };
}

export default defineConfig({
  // Relative asset paths, so the build works at github.io/PokeMatch/ or any other sub-path.
  base: './',
  plugins: [featureEditor()],
});
