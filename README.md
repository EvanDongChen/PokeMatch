# PokeMatch

Upload or snap a photo and find out which of the 1025 Pokémon matches your facial structure.

Everything runs in the browser. Photos are never uploaded anywhere.

## Running it

```sh
npm install
npm run dev      # http://localhost:5173
npm run build    # production build in dist/
```

## Deployment

Pushing to `main` builds the site and publishes it to GitHub Pages ([.github/workflows/deploy.yml](.github/workflows/deploy.yml)). In the repo settings, under **Pages**, the source must be set to **GitHub Actions**. You can also run the workflow by hand from the Actions tab.

## How matching works

1. **Face landmarks.** [MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker) finds 478 3D landmarks plus expression scores (smile, brow raise and so on). If there are several faces, the largest is used.
2. **Measurements.** About 17 ratios, such as face width/height, jaw width, chin angle, eye size and spacing, nose length, mouth width and brow gap ([src/face.ts](src/face.ts)).
3. **Traits.** The measurements are z-scored against stats from 134 synthetic portraits ([src/calibration.ts](src/calibration.ts)). They are then combined into 10 traits, each given as a percentile ([src/traits.ts](src/traits.ts)). Expression effects, such as a smile widening the mouth, are regressed out of the structural traits.
4. **Pokémon traits.** Each Pokémon is scored on the same 10 traits, then converted to percentiles across the Pokédex ([src/pokemon.ts](src/pokemon.ts)). The scores blend two sources:
   - **Its head:** roundness, solidity, spikiness, elongation and top/bottom width, measured from the head in the official artwork ([src/data/shapes.json](src/data/shapes.json)). Your face is compared with the Pokémon's head, not its whole body. Heads are found at build time by a zero-shot object detector ([OWL-ViT](https://huggingface.co/Xenova/owlvit-base-patch32)), with a shape heuristic as a fallback and hand-placed boxes for any it gets wrong. The same detector finds the eyes and mouth inside each head, so when your face is traced onto the Pokémon, your eyes and lips land on its eyes and mouth.
   - **Its data:** stats, types, height/weight, body shape and colour.

   For example, a round face lines up with ball-shaped heads, a square jaw with blocky ones, and a big smile with fairy/normal types.
5. **Match.** The app ranks Pokémon by weighted distance between the two trait vectors. A small "hubness" correction stops Pokémon with very average traits from winning too often.

On the camera screen, the same pipeline runs on every video frame (smoothed over time), so the match changes live as you pull faces.

## Maintenance

- `npm run build:pokedex` re-fetches [src/data/pokedex.json](src/data/pokedex.json) from [PokéAPI](https://pokeapi.co), for example when new Pokémon are released.
- `npm run build:shapes` finds each Pokémon's head and re-measures the artwork into [src/data/shapes.json](src/data/shapes.json). Run it after `build:pokedex`. The artwork and head detections are cached in `.cache/`. The first run downloads the detector (about 150 MB) and takes around 15 minutes; later runs take about a minute.
- If a head, eyes or mouth are still wrong, add a fix to [scripts/head-overrides.mjs](scripts/head-overrides.mjs) and re-run `build:shapes`.
- `/tools/calibrate.html` (with `npm run dev`) recomputes face calibration stats from a batch of portraits.
