import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.argv.includes('--dev') ? 5173 : (process.env.PORT || 3000);

// Simple in-memory cache (per-process)
const cache = new Map();

/* ============================================================
   Pinterest OAuth2 用設定
============================================================ */
const CLIENT_ID = process.env.PINTEREST_CLIENT_ID;
const CLIENT_SECRET = process.env.PINTEREST_CLIENT_SECRET;
const REDIRECT_URI = process.env.PINTEREST_REDIRECT_URI;

// 動的アクセストークン保持（本番ではDB保存推奨）
let dynamicAccessToken = null;

/* --------------------------
   1) Pinterest 認可画面へ
-------------------------- */
app.get('/auth/login', (req, res) => {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: 'pins:read' // 最低限の読み取り権限
  });
  res.redirect(`https://www.pinterest.com/oauth/?${params.toString()}`);
});

/* ----------------------------------------
   2) Callback で code 受取 → Token 取得
---------------------------------------- */
app.get('/auth/callback', async (req, res) => {
  const code = req.query.code;

  if (!code) {
    return res.status(400).send('Missing authorization code');
  }

  try {
    const tokenRes = await fetch('https://api.pinterest.com/v5/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI
      })
    });

    const json = await tokenRes.json();

    if (!tokenRes.ok) {
      console.error('Pinterest OAuth token error:', json);
      return res.status(500).json(json);
    }

    dynamicAccessToken = json.access_token;

    return res.send(`
      <h1>Pinterest Access Token を取得しました！</h1>
      <p>サーバー側で保存されています。</p>
      <p><a href="/">トップに戻る</a></p>
    `);
  } catch (err) {
    console.error('Pinterest OAuth token request failed', err);
    return res.status(500).send('Failed to retrieve token');
  }
});

/* ============================================================
   ユーティリティ
============================================================ */

/**
 * Fetch helper with timeout.
 */
async function fetchWithTimeout(url, opt = {}) {
  const { timeoutMs = 10000, headers = {}, method = 'GET', body } = opt;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal
    });
    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

/**
 * Try to extract an image URL from a Pinterest v5 Pin object.
 */
function pickImageUrlFromPin(pin) {
  if (!pin || typeof pin !== 'object') return null;

  const mediaImages = pin.media && pin.media.images;
  if (mediaImages && typeof mediaImages === 'object') {
    const variants = Object.values(mediaImages);
    for (const v of variants) {
      if (v && typeof v === 'object' && typeof v.url === 'string') {
        return v.url;
      }
    }
  }

  const images = pin.images;
  if (images && typeof images === 'object') {
    const preferredOrder = [
      'orig', '1200x', '1000x', '800x', '600x', '400x', '236x', '150x150'
    ];
    for (const key of preferredOrder) {
      if (images[key] && typeof images[key].url === 'string') {
        return images[key].url;
      }
    }
    for (const v of Object.values(images)) {
      if (v && typeof v === 'object' && typeof v.url === 'string') {
        return v.url;
      }
    }
  }

  if (typeof pin.image_url === 'string') return pin.image_url;
  if (typeof pin.thumbnail_url === 'string') return pin.thumbnail_url;

  if (typeof pin.link === 'string' && /^https?:\/\/i\.pinimg\.com\//.test(pin.link)) {
    return pin.link;
  }

  return null;
}

/**
 * Normalize Pinterest v5 response
 */
function normalizePinsFromPinterest(json) {
  const items = Array.isArray(json?.items) ? json.items : [];
  return items
    .map((p) => {
      const image = pickImageUrlFromPin(p);
      return {
        id: String(p.id || image || Math.random()),
        title: p.title || p.description || p.alt_text || '',
        link: p.link || null,
        image
      };
    })
    .filter((p) => !!p.image);
}

/* ============================================================
   Pinterest API /api/search
============================================================ */
app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const rawLimit = Number(req.query.limit || 60);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(rawLimit, 1), 120)
    : 60;

  const useMock = process.env.USE_MOCK === '1';

  if (!q) {
    return res.status(400).json({ ok: false, error: 'q is required' });
  }

  const cacheKey = `${q}::${limit}::${useMock ? 'mock' : 'live'}`;

  if (!useMock && cache.has(cacheKey)) {
    const items = cache.get(cacheKey);
    return res.json({ ok: true, source: 'cache', items });
  }

  if (useMock) {
    try {
      const sample = (await import('../public/mock/sample.json', {
        assert: { type: 'json' }
      })).default;
      const items = Array.isArray(sample.items)
        ? sample.items.slice(0, limit)
        : [];
      cache.set(cacheKey, items);
      return res.json({ ok: true, source: 'mock', items });
    } catch (e) {
      console.error('[Pinterval] Failed to load mock data', e);
      return res.status(500).json({ ok: false, error: 'Failed to load mock data' });
    }
  }

  /* ------------------------------
     ここだけ変更：
     OAuth トークン優先で使用する
  ------------------------------ */
  const accessToken =
    dynamicAccessToken || process.env.PINTEREST_ACCESS_TOKEN;

  if (!accessToken) {
    console.error('[Pinterval] Missing access token.');
    return res.status(500).json({
      ok: false,
      error: 'Pinterest Access Token が設定されていません。/auth/login で認証してください。'
    });
  }

  const searchParams = new URLSearchParams();
  searchParams.set('query', q);
  const pageSize = Math.min(limit, 50);
  searchParams.set('page_size', String(pageSize));

  const endpoint = `https://api.pinterest.com/v5/search/pins?${searchParams.toString()}`;

  try {
    const pinterestRes = await fetchWithTimeout(endpoint, {
      timeoutMs: 10000,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`
      }
    });

    const text = await pinterestRes.text();

    if (!pinterestRes.ok) {
      console.error('[Pinterval] Pinterest API error', pinterestRes.status, text);
      return res.status(pinterestRes.status || 502).json({
        ok: false,
        error: 'Pinterest API error',
        status: pinterestRes.status
      });
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      console.error('[Pinterval] Failed to parse Pinterest JSON', e);
      return res.status(502).json({ ok: false, error: 'Failed to parse Pinterest response' });
    }

    const normalized = normalizePinsFromPinterest(json);
    const items = normalized.slice(0, limit);

    cache.set(cacheKey, items);
    return res.json({ ok: true, source: 'pinterest-v5', items });
  } catch (e) {
    console.error('[Pinterval] Pinterest API request failed', e);
    return res.status(502).json({ ok: false, error: 'Pinterest API request failed' });
  }
});

/* ============================================================
   静的ファイル提供
============================================================ */
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Pinterval server running on http://localhost:${PORT}`);
});
