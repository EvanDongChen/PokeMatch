// Dev tool: computes mean / standard deviation of every face measure over a
// batch of portraits. Open /tools/calibrate.html with `npm run dev`.
import { analyzeFace, MAX_YAW, type MeasureKey } from '../src/face.ts';

const input = document.querySelector<HTMLInputElement>('#files')!;
const out = document.querySelector<HTMLPreElement>('#out')!;

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

input.addEventListener('change', async () => {
  const rows: Record<MeasureKey, number>[] = [];
  const yaws: number[] = [];
  let skipped = 0;
  for (const [i, file] of [...(input.files ?? [])].entries()) {
    out.textContent = `Analysing ${i + 1}/${input.files!.length}…`;
    const face = await analyzeFace(await loadImage(file));
    if (face) yaws.push(+face.yaw.toFixed(3));
    if (!face || face.yaw > MAX_YAW) skipped++;
    else rows.push(face.measures);
  }

  const stats: Record<string, { mean: number; sd: number }> = {};
  for (const key of Object.keys(rows[0]) as MeasureKey[]) {
    const values = rows.map((r) => r[key]);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1));
    stats[key] = { mean: +mean.toPrecision(4), sd: +sd.toPrecision(3) };
  }

  (window as unknown as { calibration: unknown }).calibration = { n: rows.length, skipped, stats, rows, yaws };
  out.textContent = `// ${rows.length} faces (${skipped} skipped)\n` + JSON.stringify(stats, null, 2);
});
