import type { Match, Reason } from './pokemon.ts';
import type { Silhouette } from './silhouette.ts';

const W = 1080;
const H = 1350;

const INK = '#2b2622';
const PENCIL = '#6f655a';
const RED = '#b8322a';
const BLUE = '#2a4aa0';
const HAND = '"Kalam", cursive';
const TYPED = '"Courier Prime", monospace';
const DISPLAY = '"Libre Caslon Display", Georgia, serif';

function rand(seed: number) {
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
}

/** Draws the result as a journal page and returns it as a PNG blob. */
export async function renderShareCard(opts: {
  photo: HTMLCanvasElement;
  crop: { x: number; y: number; s: number };
  match: Match;
  silhouette: Silhouette;
  reasons: Reason[];
  observation: string;
  date: string;
}): Promise<Blob> {
  await Promise.all([
    document.fonts.load(`400 40px ${HAND}`),
    document.fonts.load(`700 40px ${HAND}`),
    document.fonts.load(`400 40px ${TYPED}`),
    document.fonts.load(`700 40px ${TYPED}`),
    document.fonts.load(`400 40px ${DISPLAY}`),
  ]);
  const { photo, crop, match, silhouette, reasons } = opts;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const r = rand(match.pokemon.id + 7);

  // Paper, grain, rules and margin.
  ctx.fillStyle = '#f6f0e2';
  ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 9000; i++) {
    ctx.fillStyle = `rgba(90,70,40,${r() * 0.06})`;
    ctx.fillRect(r() * W, r() * H, 1.5, 1.5);
  }
  ctx.strokeStyle = 'rgba(70,110,170,0.2)';
  ctx.lineWidth = 1.5;
  for (let y = 150; y < H; y += 44) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(184,50,42,0.45)';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(92, 0);
  ctx.lineTo(92, H);
  ctx.stroke();

  // Masthead
  ctx.fillStyle = INK;
  ctx.font = `400 46px ${DISPLAY}`;
  ctx.fillText('PokéMatch', 120, 84);
  ctx.font = `400 22px ${TYPED}`;
  ctx.fillStyle = PENCIL;
  ctx.textAlign = 'right';
  ctx.fillText(`OBSERVATION No. ${opts.observation}  ·  ${opts.date.toUpperCase()}`, W - 60, 84);
  ctx.textAlign = 'left';
  ctx.fillStyle = INK;
  ctx.fillRect(120, 108, W - 180, 3);

  // Polaroid of the subject
  ctx.save();
  ctx.translate(310, 420);
  ctx.rotate(-0.06);
  ctx.shadowColor = 'rgba(60,40,20,0.3)';
  ctx.shadowBlur = 24;
  ctx.shadowOffsetY = 8;
  ctx.fillStyle = '#fbf8f1';
  ctx.fillRect(-170, -190, 340, 400);
  ctx.shadowColor = 'transparent';
  ctx.filter = 'sepia(0.22) saturate(0.85)';
  ctx.drawImage(photo, crop.x, crop.y, crop.s, crop.s, -150, -170, 300, 300);
  ctx.filter = 'none';
  ctx.fillStyle = BLUE;
  ctx.font = `400 34px ${HAND}`;
  ctx.textAlign = 'center';
  ctx.fillText('subject', 0, 180);
  ctx.fillStyle = 'rgba(226,212,170,0.85)';
  ctx.rotate(0.1);
  ctx.fillRect(-60, -210, 120, 36);
  ctx.restore();

  // Specimen plate with the Pokémon printed on it
  ctx.save();
  ctx.translate(790, 410);
  ctx.rotate(0.03);
  ctx.shadowColor = 'rgba(60,40,20,0.2)';
  ctx.shadowBlur = 14;
  ctx.shadowOffsetY = 4;
  ctx.fillStyle = '#efe6d2';
  ctx.fillRect(-200, -200, 400, 400);
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = INK;
  for (const [x, y, dx, dy] of [
    [-200, -200, 1, 1],
    [200, -200, -1, 1],
    [-200, 200, 1, -1],
    [200, 200, -1, -1],
  ]) {
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + dx * 38, y);
    ctx.lineTo(x, y + dy * 38);
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'multiply';
  ctx.drawImage(silhouette.image, -180, -180, 360, 360);
  ctx.restore();

  // Hand-drawn arrow from subject to specimen
  ctx.save();
  ctx.strokeStyle = BLUE;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(470, 300);
  ctx.bezierCurveTo(520, 250, 560, 260, 588, 300);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(570, 296);
  ctx.lineTo(590, 302);
  ctx.lineTo(592, 282);
  ctx.stroke();
  ctx.restore();

  // Verdict
  ctx.fillStyle = BLUE;
  ctx.font = `400 40px ${HAND}`;
  const nth = (n: number) => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');
  ctx.fillText(
    match.rank === 1 ? 'Subject most closely resembles' : `Compared with (${nth(match.rank)} closest of 1025)`,
    120,
    720,
  );
  ctx.fillStyle = INK;
  let size = 150;
  ctx.font = `400 ${size}px ${DISPLAY}`;
  while (ctx.measureText(match.pokemon.name).width > 640 && size > 70) {
    size -= 6;
    ctx.font = `400 ${size}px ${DISPLAY}`;
  }
  ctx.fillText(match.pokemon.name, 112, 720 + size * 0.95);

  // Circular score stamp
  ctx.save();
  ctx.translate(890, 790);
  ctx.rotate(-0.16);
  ctx.strokeStyle = RED;
  ctx.fillStyle = RED;
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(0, 0, 105, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(0, 0, 92, 0, Math.PI * 2);
  ctx.stroke();
  ctx.textAlign = 'center';
  ctx.font = `400 84px ${DISPLAY}`;
  ctx.fillText(String(match.similarity), 0, 22);
  ctx.font = `700 20px ${TYPED}`;
  ctx.fillText('% MATCH', 0, 58);
  ctx.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 260; i++) {
    ctx.globalAlpha = 0.4 + r() * 0.6;
    ctx.beginPath();
    ctx.arc((r() - 0.5) * 220, (r() - 0.5) * 220, r() * 2.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // Supporting observations
  const top = 720 + size * 0.95 + 80;
  reasons.slice(0, 3).forEach((reason, i) => {
    const y = top + i * 78;
    ctx.strokeStyle = RED;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.ellipse(140, y - 12, 21, 20, 0.2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = RED;
    ctx.font = `700 30px ${HAND}`;
    ctx.textAlign = 'center';
    ctx.fillText(String(i + 1), 140, y - 1);
    ctx.textAlign = 'left';
    ctx.font = `400 34px ${HAND}`;
    ctx.fillStyle = BLUE;
    const you = `${reason.you[0].toUpperCase()}${reason.you.slice(1)}`;
    ctx.fillText(`${you}, `, 184, y);
    const w = ctx.measureText(`${you}, `).width;
    ctx.fillStyle = RED;
    ctx.fillText(`like ${match.pokemon.name}’s ${reason.them.replace(/^an? /, '')}`, 184 + w, y);
  });

  ctx.fillStyle = PENCIL;
  ctx.font = `400 22px ${TYPED}`;
  ctx.fillText('478 landmarks plotted  ·  10 traits measured  ·  1025 species consulted', 120, H - 56);

  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Export failed'))), 'image/png'),
  );
}
