import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetch } from 'undici';   // ← これが最重要（安定版 fetch）

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.argv.includes('--dev') ? 5173 : (process.env.PORT || 3000);

// Simple in-memory cache
const cache = new Map();

/* ============================================================
   Pinterest OAuth2 用設定
============================================================ */
console.log("ENV CHECK:", {
  CLIENT_ID: process.env.PINTEREST_CLIENT_ID,
  CLIENT_SECRET: process.env.PINTEREST_CLIENT_SECRET,
  REDIRECT_URI: process.env.PINTEREST_REDIRECT_URI
});

const CLIENT_ID = process.env.PINTEREST_CLIENT_ID;
const CLIENT_SECRET = process.env.PINTEREST_CLIENT_SECRET;
const REDIRECT_URI = process.env.PINTEREST_REDIRECT_URI;

// OAuth で取得した token をメモリに保持
let dynamicAccessToken = null;

/* --------------------------
   1) Pinterest 認可画面へ
-------------------------- */
app.get('/auth/login', (req, res) => {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: 'boards:read,pins:read' // ←重要！
  });


  res.redirect(`https://www.pinterest.com/oauth/?${params.toString()}`);
});

/* ----------------------------------------
   2) Callback → code を token に交換
---------------------------------------- */
app.get('/auth/callback', async (req, res) => {
  const code = req.query.code;

  console.log("▼ Received OAuth code:", code);

  if (!code) {
    return res.status(400).send("Missing authorization code");
  }

  try {
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI
    });

    console.log("▼ Sending token request body:", params.toString());

    const tokenRes = await fetch("https://api.pinterest.com/v5/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json"
      },
      body: params.toString()
    });

    const text = await tokenRes.text(); // ← JSON でなく raw で取得
    console.log("▼ Pinterest raw response:", text);
    console.log("▼ Status:", tokenRes.status);

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { parseError: true, raw: text };
    }

    if (!tokenRes.ok) {
      console.error("▼ Pinterest token error (parsed):", data);
      return res.status(500).send(text);
    }

    dynamicAccessToken = data.access_token;

    return res.send(`
      <h1>Access Token Get!</h1>
      <p>${data.access_token}</p>
    `);

  } catch (err) {
    console.error("▼ OAuth callback fatal error:", err);
    res.status(500).send("OAuth callback failed");
  }
});


/* ============================================================
   Utility functions
============================================================ */
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
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

function pickImageUrlFromPin(pin) {
  if (!pin || typeof pin !== "object") return null;

  const mediaImages = pin.media?.images;
  if (mediaImages) {
    for (const v of Object.values(mediaImages)) {
      if (v?.url) return v.url;
    }
  }

  const images = pin.images;
  if (images) {
    const preferred = ['orig','1200x','1000x','800x','600x','400x','236x','150x150'];
    for (const key of preferred) {
      if (images[key]?.url) return images[key].url;
    }
    for (const v of Object.values(images)) {
      if (v?.url) return v.url;
    }
  }

  if (pin.image_url) return pin.image_url;
  if (pin.thumbnail_url) return pin.thumbnail_url;

  return null;
}

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
   /api/search (Pinterest API v5)
============================================================ */
app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const rawLimit = Number(req.query.limit || 60);
  const limit = Math.min(Math.max(rawLimit, 1), 120);

  if (!q) {
    return res.status(400).json({ ok: false, error: "q is required" });
  }

  const accessToken =
    dynamicAccessToken || process.env.PINTEREST_ACCESS_TOKEN;

  if (!accessToken) {
    return res.status(500).json({
      ok: false,
      error: "Access Token がありません。/auth/login で認証してください。"
    });
  }

  const params = new URLSearchParams({
    query: q,
    page_size: String(Math.min(limit, 50))
  });

  try {
    const endpoint = `https://api.pinterest.com/v5/search/pins?${params.toString()}`;
    const pinterestRes = await fetchWithTimeout(endpoint, {
      timeoutMs: 10000,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`
      }
    });

    const text = await pinterestRes.text();

    if (!pinterestRes.ok) {
      console.error("Pinterest API error:", pinterestRes.status, text);
      return res.status(502).json({
        ok: false,
        error: "Pinterest API error",
        status: pinterestRes.status
      });
    }

    const json = JSON.parse(text);
    const normalized = normalizePinsFromPinterest(json);
    const items = normalized.slice(0, limit);

    return res.json({ ok: true, source: "pinterest-v5", items });

  } catch (err) {
    console.error("Pinterest API request failed:", err);
    return res.status(502).json({ ok: false, error: "Pinterest API request failed" });
  }
});

/* ============================================================
   静的ファイル
============================================================ */
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Pinterval server running on http://localhost:${PORT}`);
});
