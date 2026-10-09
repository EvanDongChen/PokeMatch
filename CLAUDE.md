# PokeMatch

## Commits

- Commit often: one commit per finished, working step, without waiting to be asked.
- I am the sole author. Never add `Co-Authored-By` or any other attribution lines to commit messages or PR descriptions.
- Commit to `main` locally. Don't push unless asked; pushing deploys the site.

## Working on the project

- `npm run dev` for the site; `npx tsc --noEmit` to typecheck.
- `npm run build:shapes` rebuilds `src/data/shapes.json`: each Pokémon's head, eyes and mouth come from an object detector (cached in `.cache/`), with hand fixes in `scripts/head-overrides.json`. Edit those with the tool at `/tools/features.html` (dev server only).
- On this Windows machine, if a build fails with "Cannot find native binding", run `npm i --no-save @rolldown/binding-win32-x64-msvc@<rolldown version>`. Don't commit that change.
