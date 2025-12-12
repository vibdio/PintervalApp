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
    scope: 'boards:read,pins:read,boards:read_secret,pins:read_secret'
  });

  const url = `https://www.pinterest.com/oauth/?${params.toString()}`;
  res.redirect(url);
});



/* ----------------------------------------
   2) Callback → code を token に交換
---------------------------------------- */
app.get('/auth/callback', async (req, res) => {
  const code = req.query.code;

  try {
    const basicAuth = Buffer
      .from(`${CLIENT_ID}:${CLIENT_SECRET}`)
      .toString("base64");

    const params = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI
    });

    const tokenRes = await fetch("https://api.pinterest.com/v5/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": `Basic ${basicAuth}`,
        "Accept": "application/json"
      },
      body: params.toString()
    });

    const text = await tokenRes.text();
    console.log("Pinterest response:", text);

    if (!tokenRes.ok) {
      return res.status(400).send(text);
    }

    const data = JSON.parse(text);
    dynamicAccessToken = data.access_token;

    return res.redirect("https://pinterval.onrender.com");
  } catch (e) {
    console.error(e);
    res.status(500).send("OAuth error");
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

function pickBestImageVariant(images) {
  if (!images || typeof images !== "object") return null;

  let bestUrl = null;
  let bestScore = -1;

  for (const [key, value] of Object.entries(images)) {
    if (!value || !value.url) continue;

    let score = 0;
    const w = typeof value.width === "number" ? value.width : null;
    const h = typeof value.height === "number" ? value.height : null;

    if (w && h) {
      // width/height がある場合は解像度で評価
      score = w * h;
    } else {
      // フィールドに width/height が無い場合、キー名から数値を推測（例: "orig", "1200x", "600x900"）
      const m = String(key).match(/(\d+)/);
      if (m) {
        score = parseInt(m[1], 10);
      } else {
        // 数字が取れないもの（"orig" など）は適度に高めのスコアを与える
        score = 999999;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestUrl = value.url;
    }
  }

  return bestUrl;
}

function pickImageUrlFromPin(pin) {
  if (!pin || typeof pin !== "object") return null;

  // Pinterest API v5 の仕様上、media.images に複数バリアントが入るため
  // その中から「一番大きいもの」を選ぶ。
  const mediaImages = pin.media?.images;
  if (mediaImages) {
    const best = pickBestImageVariant(mediaImages);
    if (best) return best;
  }

  // 古い形式 / 互換フィールド images に対しても同様のロジックを適用
  const images = pin.images;
  if (images) {
    const best = pickBestImageVariant(images);
    if (best) return best;
  }

  // フォールバック
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

// Pinterest v5 API はページングに bookmark を使う。
// limit まで複数ページを取得して正規化して返す。
async function fetchPinsPaged({ endpointBase, accessToken, limit, timeoutMs = 10000 }) {
  const safeLimit = Math.min(Math.max(Number(limit) || 0, 1), 500);
  const pageSize = Math.min(safeLimit, 50);

  /** @type {Array<{id:string,title:string,link:string|null,image:string}>} */
  const out = [];
  const seen = new Set();

  let bookmark = null;
  let loops = 0;

  while (out.length < safeLimit && loops < 50) {
    loops += 1;

    const params = new URLSearchParams({ page_size: String(pageSize) });
    if (bookmark) params.set('bookmark', String(bookmark));

    const endpoint = `${endpointBase}?${params.toString()}`;
    const pinterestRes = await fetchWithTimeout(endpoint, {
      timeoutMs,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`
      }
    });

    if (!pinterestRes.ok) {
      const text = await pinterestRes.text().catch(() => '');
      const err = new Error(`Pinterest API error: ${pinterestRes.status}`);
      // @ts-ignore
      err.details = text;
      throw err;
    }

    const json = await pinterestRes.json();
    const normalized = normalizePinsFromPinterest(json);
    for (const p of normalized) {
      if (out.length >= safeLimit) break;
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      out.push(p);
    }

    // bookmark が無い/空なら終了
    bookmark = json?.bookmark || json?.next_bookmark || null;
    if (!bookmark) break;
  }

  return out.slice(0, safeLimit);
}

  
/* ============================================================
   /api/me/boards - ユーザーのボード一覧
============================================================ */
app.get('/api/me/boards', async (req, res) => {
  const accessToken =
    dynamicAccessToken || process.env.PINTEREST_ACCESS_TOKEN;

  if (!accessToken) {
    return res.status(500).json({
      ok: false,
      error: "Access Token がありません。/auth/login で認証してください。"
    });
  }

  const params = new URLSearchParams({
    page_size: '100'
  });

  try {
    const endpoint = `https://api.pinterest.com/v5/boards?${params.toString()}`;
    const pinterestRes = await fetchWithTimeout(endpoint, {
      timeoutMs: 10000,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`
      }
    });

    if (!pinterestRes.ok) {
      const text = await pinterestRes.text();
      console.error("Pinterest boards API error:", pinterestRes.status, text);
      return res.status(502).json({ ok: false, error: "Pinterest API error (boards)" });
    }

    const json = await pinterestRes.json();
    const items = Array.isArray(json?.items)
      ? json.items.map((b) => ({
          id: String(b.id),
          name: b.name || '',
          description: b.description || ''
        }))
      : [];

    return res.json({ ok: true, items });
  } catch (err) {
    console.error("Pinterest boards request failed:", err);
    return res.status(502).json({ ok: false, error: "Pinterest boards request failed" });
  }
});

/* ============================================================
   /api/me/pins - 自分の保存ピン一覧
============================================================ */
app.get('/api/me/pins', async (req, res) => {
  const accessToken =
    dynamicAccessToken || process.env.PINTEREST_ACCESS_TOKEN;

  if (!accessToken) {
    return res.status(500).json({
      ok: false,
      error: "Access Token がありません。/auth/login で認証してください。"
    });
  }

  try {
    // NOTE:
    // Pinterest v5 の /pins は「自分が作成したピン」系に寄りやすく、
    // 「保存したピン（各ボードに保存されているピン）」を一括で返さないことがある。
    // そのため「すべてのピン」は、ボード一覧→各ボードの pins を集約して返す。

    const rawLimit = Number(req.query.limit || 120);
    const limit = Math.min(Math.max(rawLimit, 1), 500);

    // 1) ボード一覧取得（最大100件+bookmark対応）
    /** @type {Array<{id:string,name:string}>} */
    const boards = [];
    let bookmark = null;
    let loops = 0;

    while (boards.length < 500 && loops < 20) {
      loops += 1;
      const params = new URLSearchParams({ page_size: '100' });
      if (bookmark) params.set('bookmark', String(bookmark));
      const endpoint = `https://api.pinterest.com/v5/boards?${params.toString()}`;
      const pinterestRes = await fetchWithTimeout(endpoint, {
        timeoutMs: 10000,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${accessToken}`
        }
      });
      if (!pinterestRes.ok) {
        const text = await pinterestRes.text().catch(() => '');
        console.error('Pinterest boards API error:', pinterestRes.status, text);
        return res.status(502).json({ ok: false, error: 'Pinterest API error (boards)' });
      }
      const json = await pinterestRes.json();
      const items = Array.isArray(json?.items) ? json.items : [];
      for (const b of items) {
        if (!b?.id) continue;
        boards.push({ id: String(b.id), name: b.name || '' });
      }
      bookmark = json?.bookmark || json?.next_bookmark || null;
      if (!bookmark) break;
    }

    if (!boards.length) {
      return res.json({ ok: true, items: [] });
    }

    // 2) 各ボードの pins を順に集約（上限 limit）
    /** @type {Array<{id:string,title:string,link:string|null,image:string}>} */
    const out = [];
    const seen = new Set();

    for (const b of boards) {
      if (out.length >= limit) break;
      try {
        const pins = await fetchPinsPaged({
          endpointBase: `https://api.pinterest.com/v5/boards/${encodeURIComponent(b.id)}/pins`,
          accessToken,
          limit: Math.min(200, limit - out.length),
          timeoutMs: 10000
        });
        for (const p of pins) {
          if (out.length >= limit) break;
          if (seen.has(p.id)) continue;
          seen.add(p.id);
          out.push(p);
        }
      } catch (e) {
        // 一部ボードが失敗しても全体は継続
        console.warn('Board pins fetch failed:', b.id, e?.message || e);
      }
    }

    return res.json({ ok: true, items: out.slice(0, limit) });
  } catch (err) {
    console.error("Pinterest my pins request failed:", err);
    return res.status(502).json({ ok: false, error: "Pinterest my pins request failed" });
  }
});

/* ============================================================
   /api/boards/:boardId/pins - 特定ボードの保存ピン
============================================================ */
app.get('/api/boards/:boardId/pins', async (req, res) => {
  const accessToken =
    dynamicAccessToken || process.env.PINTEREST_ACCESS_TOKEN;

  if (!accessToken) {
    return res.status(500).json({
      ok: false,
      error: "Access Token がありません。/auth/login で認証してください。"
    });
  }

  const rawLimit = Number(req.query.limit || 120);
  const limit = Math.min(Math.max(rawLimit, 1), 500);
  const boardId = req.params.boardId;

  try {
    const items = await fetchPinsPaged({
      endpointBase: `https://api.pinterest.com/v5/boards/${encodeURIComponent(boardId)}/pins`,
      accessToken,
      limit,
      timeoutMs: 10000
    });

    return res.json({ ok: true, items });
  } catch (err) {
    console.error("Pinterest board pins request failed:", err);
    return res.status(502).json({ ok: false, error: "Pinterest board pins request failed" });
  }
});



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
