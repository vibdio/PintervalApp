import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.argv.includes('--dev') ? 5173 : (process.env.PORT || 3000);

// Simple in-memory cache (per-process)
const cache = new Map();

// Helper: fetch with timeout and optional abort
async function fetchWithTimeout(url, { timeoutMs = 10000, signal } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const composite = signal
    ? new AbortController()
    : controller;

  if (signal) {
    signal.addEventListener('abort', () => composite.abort(), { once: true });
    setTimeout(() => {}, 0); // keep event loop alive
  }
  try {
    const res = await fetch(url, { signal: signal || controller.signal, headers: {
      'user-agent': 'Mozilla/5.0 PintervalBot/1.0 (+https://example.local)'
    }});
    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

function normalizePinsFromPidgets(json) {
  // old pidgets JSON format: { data: { pins: [ { images: { '236x': { url }, 'orig': { url } }, id, link, description } ] } }
  const pins = (json?.data?.pins) || [];
  return pins.map(p => {
    const img = p.images?.orig?.url || p.images?.['736x']?.url || p.images?.['600x']?.url || p.images?.['236x']?.url;
    return {
      id: String(p.id || p.pin_id || img || Math.random()),
      title: p.description || '',
      link: p.link || p.domain || null,
      image: img
    };
  }).filter(p => !!p.image);
}

// Very naive HTML fallback (tries to extract i.pinimg.com URLs)
function extractPinsFromHtml(html) {
  const urls = new Set();
  const regex = /https?:\/\/i\.pinimg\.com\/[^\"\'\s)]+/g;
  let m;
  while ((m = regex.exec(html)) !== null) {
    urls.add(m[0]);
  }
  return Array.from(urls).slice(0, 120).map((u, i) => ({
    id: String(i + 1),
    title: '',
    link: null,
    image: u
  }));
}

app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const limit = Number(req.query.limit || 60);
  const useMock = process.env.USE_MOCK === '1';

  if (!q) {
    return res.status(400).json({ ok: false, error: 'q is required' });
  }

  const cacheKey = `search:${q}:${limit}`;
  if (cache.has(cacheKey)) {
    return res.json({ ok: true, source: 'cache', items: cache.get(cacheKey) });
  }

  if (useMock) {
    const sample = (await import('../public/mock/sample.json', { assert: { type: 'json' }})).default;
    const items = sample.items.slice(0, limit);
    cache.set(cacheKey, items);
    return res.json({ ok: true, source: 'mock', items });
  }

  // 1) Try pidgets (widgets host)
  try {
    const url = `https://widgets.pinterest.com/v3/pidgets/search/pins/?q=${encodeURIComponent(q)}&limit=${Math.min(limit, 120)}`;
    const res1 = await fetchWithTimeout(url, { timeoutMs: 12000 });
    if (res1.ok) {
      const json = await res1.json();
      const items = normalizePinsFromPidgets(json).slice(0, limit);
      if (items.length) {
        cache.set(cacheKey, items);
        return res.json({ ok: true, source: 'pidgets', items });
      }
    }
  } catch (e) {
    // fall through
  }

  // 2) Try pidgets (api host)
  try {
    const url = `https://api.pinterest.com/v3/pidgets/search/pins/?q=${encodeURIComponent(q)}&limit=${Math.min(limit, 120)}`;
    const res2 = await fetchWithTimeout(url, { timeoutMs: 12000 });
    if (res2.ok) {
      const json = await res2.json();
      const items = normalizePinsFromPidgets(json).slice(0, limit);
      if (items.length) {
        cache.set(cacheKey, items);
        return res.json({ ok: true, source: 'pidgets2', items });
      }
    }
  } catch (e) {
    // fall through
  }

  // 3) Fallback: HTML search page scraping (best-effort)
  try {
    const url = `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(q)}`;
    const res3 = await fetchWithTimeout(url, { timeoutMs: 12000 });
    if (res3.ok) {
      const html = await res3.text();
      const items = extractPinsFromHtml(html).slice(0, limit);
      if (items.length) {
        cache.set(cacheKey, items);
        return res.json({ ok: true, source: 'html', items });
      }
    }
  } catch (e) {
    // fall through
  }

  // 4) Final fallback: mock
  const sample = (await import('../public/mock/sample.json', { assert: { type: 'json' }})).default;
  const items = sample.items.slice(0, limit);
  cache.set(cacheKey, items);
  res.json({ ok: true, source: 'mock-fallback', items });
});

// Serve static files
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Pinterval server running on http://localhost:${PORT}`);
});
