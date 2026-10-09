// Hand-placed fixes for Pokémon the detector gets wrong. Every value is a
// fraction of the artwork (0..1), like src/data/shapes.json:
//   head:  [x, y, width, height] of the head box
//   eyes:  [[x, y, width], ...] eye centres, left to right
//   mouth: [x, y, width] mouth centre
// Re-run `npm run build:shapes` after editing; detections are cached, so it is quick.
export default {
  1: { head: [0.04, 0.28, 0.62, 0.58] }, // Bulbasaur: not the bulb
  18: { head: [0.56, 0.28, 0.38, 0.3] }, // Pidgeot: not the wing
  61: { head: [0.3, 0.06, 0.6, 0.45] }, // Poliwhirl: eyes on top of the round body
  65: { head: [0.33, 0.1, 0.4, 0.35] }, // Alakazam: not the spoons
  111: { head: [0.05, 0.12, 0.5, 0.7] }, // Rhyhorn
  206: { head: [0.02, 0.42, 0.4, 0.55] }, // Dunsparce
  248: { head: [0.08, 0.02, 0.48, 0.36] }, // Tyranitar: not the torso
  258: { head: [0.06, 0.3, 0.62, 0.5], eyes: [[0.25, 0.58, 0.04], [0.41, 0.58, 0.04]], mouth: [0.34, 0.67, 0.12] }, // Mudkip
  264: { head: [0.03, 0.3, 0.3, 0.32] }, // Linoone: lying flat, head on the left
  384: { head: [0.04, 0.26, 0.34, 0.32] }, // Rayquaza: not the coils
  656: { head: [0.2, 0.02, 0.55, 0.5], eyes: [[0.36, 0.25, 0.12], [0.66, 0.27, 0.12]], mouth: [0.45, 0.5, 0.2] }, // Froakie
  722: { eyes: [[0.3, 0.34, 0.06], [0.57, 0.34, 0.06]], mouth: [0.45, 0.43, 0.06] }, // Rowlet: beak, not the bow tie
};
