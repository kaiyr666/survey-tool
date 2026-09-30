// Renders a results page to a 1920×1080 PNG with the Canvas 2D API (no dependencies).
import { desiredOrder, leaderIds, barWidth, percent } from './logic.js';

const THEMES = {
  light: { bg: '#fbfbfd', text: '#1d1d1f', text2: '#515154', text3: '#6e6e73', bar: '#0c5b3a', muted: 'rgba(12,91,58,0.4)', neutral: 'rgba(110,110,115,0.42)', pill: '#0c5b3a', pillText: '#ffffff', accent: '#0c5b3a' },
  dark: { bg: '#000000', text: '#f5f5f7', text2: '#d2d2d7', text3: '#a1a1a6', bar: '#34c77b', muted: 'rgba(52,199,123,0.4)', neutral: 'rgba(161,161,166,0.4)', pill: '#34c77b', pillText: '#00140a', accent: '#34c77b' },
};
const FONT = 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif';

function wrap(ctx, text, maxWidth, maxLines = 3) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width <= maxWidth || !line) line = test;
    else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1]} ${lines.slice(maxLines).join(' ')}`;
    return kept;
  }
  return lines;
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, h / 2, w / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export async function renderResultsPng(results, question, themeName = 'light') {
  if (document.fonts?.ready) await document.fonts.ready;
  const th = THEMES[themeName] || THEMES.light;
  const W = 1920, H = 1080, PAD = 72;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = th.bg;
  ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = 'alphabetic';

  // Header
  ctx.fillStyle = th.text3;
  ctx.font = `600 22px ${FONT}`;
  ctx.fillText(results.session?.title || '', PAD, 76);
  ctx.font = `600 30px ${FONT}`;
  ctx.fillStyle = th.text2;
  const label = 'Completed:';
  ctx.fillText(label, PAD, 132);
  let x = PAD + ctx.measureText(label).width + 10;
  ctx.font = `800 52px ${FONT}`;
  ctx.fillStyle = th.text;
  ctx.fillText(String(results.completed), x, 132);
  x += ctx.measureText(String(results.completed)).width + 40;
  ctx.font = `500 28px ${FONT}`;
  ctx.fillStyle = th.text3;
  ctx.fillText(`Joined: ${results.connected}`, x, 132);

  // Question
  ctx.font = `700 54px ${FONT}`;
  ctx.fillStyle = th.text;
  const qLines = wrap(ctx, question.text, W - PAD * 2, 2);
  let y = 230;
  for (const l of qLines) { ctx.fillText(l, PAD, y); y += 62; }
  ctx.font = `500 30px ${FONT}`;
  ctx.fillStyle = th.text3;
  ctx.fillText(`Answered: ${question.answered}`, PAD, y + 4);
  y += 50;

  // Chart
  const multi = question.type === 'multi' && question.max > 1;
  const order = desiredOrder(question).map((id) => question.options.find((o) => o.id === id));
  const leaders = leaderIds(question);
  const maxVotes = Math.max(0, ...question.options.map((o) => o.votes));
  const labelW = 608, gap = 32, barX = PAD + labelW + gap, trackW = W - PAD - barX;
  const bottom = H - (multi ? 110 : 60);
  const rowH = Math.min(96, (bottom - y) / order.length);
  const tags = results.annotations || [];

  order.forEach((o, i) => {
    const cy = y + rowH * i + rowH / 2 + (o.pinned_last ? 12 : 0);
    ctx.font = `500 32px ${FONT}`;
    ctx.fillStyle = th.text;
    ctx.textAlign = 'right';
    const lines = wrap(ctx, o.text, labelW, 2);
    const lh = 37;
    lines.forEach((l, k) => ctx.fillText(l, PAD + labelW, cy + 11 - ((lines.length - 1) * lh) / 2 + k * lh));
    ctx.textAlign = 'left';

    const bw = Math.max(8, (barWidth(o.votes, maxVotes) / 100) * trackW);
    ctx.fillStyle = o.pinned_last ? th.neutral : leaders.has(o.id) ? th.bar : th.muted;
    roundRect(ctx, barX, cy - 26, bw, 52, 10);
    ctx.fill();

    let vx = barX + bw + 20;
    ctx.font = `700 36px ${FONT}`;
    ctx.fillStyle = th.text;
    const vText = `${o.votes} · ${percent(o.votes, question.answered)}%`;
    ctx.fillText(vText, vx, cy + 13);
    vx += ctx.measureText(vText).width + 14;
    for (const t of tags.filter((a) => a.option_id === o.id)) {
      ctx.font = `700 22px ${FONT}`;
      const tw = ctx.measureText(t.label).width + 32;
      ctx.fillStyle = th.pill;
      roundRect(ctx, vx, cy - 20, tw, 40, 20);
      ctx.fill();
      ctx.fillStyle = th.pillText;
      ctx.fillText(t.label, vx + 16, cy + 8);
      vx += tw + 10;
    }
  });

  if (multi) {
    ctx.font = `500 24px ${FONT}`;
    ctx.fillStyle = th.text3;
    ctx.fillText('Up to two options could be chosen, so the percentages add up to more than 100%', PAD, H - 56);
  }

  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

export function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
