import type { Match, Reason } from './pokemon.ts';
import type { Silhouette } from './silhouette.ts';

const W = 1080;
const H = 1350;

/** Draws a shareable result card and returns it as a PNG blob. */
export async function renderShareCard(opts: {
  photo: HTMLCanvasElement;
  crop: { x: number; y: number; s: number };
  match: Match;
  silhouette: Silhouette;
  reasons: Reason[];
  accent: string;
}): Promise<Blob> {
  await document.fonts.ready;
  const { photo, crop, match, silhouette, reasons, accent } = opts;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;

  // Background
  ctx.fillStyle = '#07070f';
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W * 0.7, H * 0.32, 0, W * 0.7, H * 0.32, W * 0.75);
  glow.addColorStop(0, accent + 'aa');
  glow.addColorStop(1, accent + '00');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
  const glow2 = ctx.createRadialGradient(W * 0.15, H * 0.2, 0, W * 0.15, H * 0.2, W * 0.5);
  glow2.addColorStop(0, 'rgba(94,231,255,0.35)');
  glow2.addColorStop(1, 'rgba(94,231,255,0)');
  ctx.fillStyle = glow2;
  ctx.fillRect(0, 0, W, H);

  // Grid
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth = 1;
  for (let x = 0; x < W; x += 54) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
  }
  for (let y = 0; y < H; y += 54) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }

  // Header
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.font = '600 28px "JetBrains Mono", monospace';
  ctx.letterSpacing = '6px';
  ctx.fillText('POKÉMATCH', 72, 100);
  ctx.textAlign = 'right';
  ctx.fillText(`#${String(match.pokemon.id).padStart(4, '0')}`, W - 72, 100);
  ctx.textAlign = 'left';
  ctx.letterSpacing = '0px';

  // Photo bubble
  const pr = 150;
  const px = 72 + pr;
  const py = 300;
  ctx.save();
  ctx.beginPath();
  ctx.arc(px, py, pr, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(photo, crop.x, crop.y, crop.s, crop.s, px - pr, py - pr, pr * 2, pr * 2);
  ctx.restore();
  ctx.strokeStyle = '#5ee7ff';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(px, py, pr + 8, 0, Math.PI * 2);
  ctx.stroke();

  // Artwork
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 40;
  ctx.shadowOffsetY = 20;
  ctx.drawImage(silhouette.image, 400, 110, 620, 620);
  ctx.restore();

  // Name + score
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = '600 30px "JetBrains Mono", monospace';
  ctx.letterSpacing = '5px';
  ctx.fillText('MY POKÉMON MATCH IS', 72, 820);
  ctx.letterSpacing = '0px';
  ctx.fillStyle = '#fff';
  let size = 120;
  ctx.font = `700 ${size}px "Space Grotesk", sans-serif`;
  while (ctx.measureText(match.pokemon.name).width > W - 144 && size > 60) {
    size -= 6;
    ctx.font = `700 ${size}px "Space Grotesk", sans-serif`;
  }
  ctx.fillText(match.pokemon.name, 68, 830 + size * 0.9);

  ctx.font = '700 56px "Space Grotesk", sans-serif';
  ctx.fillStyle = accent;
  const scoreY = 830 + size * 0.9 + 80;
  ctx.fillText(`${match.similarity}% match`, 72, scoreY);

  // Reasons
  ctx.font = '500 32px "Space Grotesk", sans-serif';
  reasons.slice(0, 3).forEach((r, i) => {
    const y = scoreY + 80 + i * 58;
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(86, y - 11, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    const text = `${r.you[0].toUpperCase()}${r.you.slice(1)} → ${r.them}`;
    ctx.fillText(text, 112, y);
  });

  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.font = '500 24px "JetBrains Mono", monospace';
  ctx.fillText('478 landmarks · 10 traits · 1025 Pokémon', 72, H - 64);

  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Export failed'))), 'image/png'),
  );
}
