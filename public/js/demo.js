// Landing page: scroll reveals, live KPIs, demo QR and the embedded live screen.
import { rpc, isConfigured, participantUrl, shortUrl } from './api.js';
import { qrSvg } from './qr.js';

// Reveal on scroll
const io = 'IntersectionObserver' in window
  ? new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
  }, { threshold: 0.12 })
  : null;
document.querySelectorAll('.reveal').forEach((el, i) => {
  el.style.transitionDelay = `${Math.min(i % 4, 3) * 70}ms`;
  if (io) io.observe(el); else el.classList.add('in');
});

// Demo QR
document.getElementById('demo-qr').innerHTML = qrSvg(participantUrl());
document.getElementById('demo-url').textContent = shortUrl();

// Demo PIN hint (only shown when configured for public demos)
const pin = window.LIVEPOLL_CONFIG?.demoPin;
if (pin) document.getElementById('pin-note').textContent = `Demo PIN: ${pin}`;

// Live screen preview, scaled into the laptop
const frame = document.getElementById('screen-frame');
const loadFrame = () => { if (frame.src === 'about:blank' || !frame.src.includes('/screen')) frame.src = '/screen'; };
if (io) {
  const fio = new IntersectionObserver((e) => { if (e[0].isIntersecting) { loadFrame(); fio.disconnect(); } });
  fio.observe(frame);
} else loadFrame();

// Live numbers
const animate = (el, to) => {
  const from = Number(el.dataset.v || 0);
  el.dataset.v = String(to);
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / 600);
    el.textContent = String(Math.round(from + (to - from) * (1 - Math.pow(1 - t, 3))));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
};
async function kpis() {
  if (!isConfigured()) return;
  try {
    const r = await rpc('get_results');
    if (!r?.session) return;
    animate(document.getElementById('k-joined'), r.connected);
    animate(document.getElementById('k-completed'), r.completed);
  } catch { /* offline: keep dashes */ }
}
kpis();
setInterval(() => { if (document.visibilityState === 'visible') kpis(); }, 5000);
