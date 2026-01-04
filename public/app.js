// --- 未ログイン時は自動でログインページへ遷移 ---
async function redirectIfNotLoggedIn() {
  try {
    const res = await fetch('/api/me/boards');
    if (res.status === 401 || res.status === 403) {
      window.location.href = 'https://pinterval.onrender.com/auth/login';
      return;
    }
    // API仕様上、認証エラー時はエラーjson返却も考慮
    if (!res.ok) {
      const data = await res.json().catch(()=>null);
      if (data && data.error && String(data.error).includes('認証')) {
        window.location.href = 'https://pinterval.onrender.com/auth/login';
        return;
      }
    }
  } catch (e) {
    // 通信エラー時も念のため遷移
    window.location.href = 'https://pinterval.onrender.com/auth/login';
  }
}

// ページロード時に即チェック
redirectIfNotLoggedIn();
import { bus } from './eventBus.js';

// DOM references
const dom = {
  board: document.getElementById('board'),
  order: document.getElementById('order'),
  interval: document.getElementById('interval'),
  gridCount: document.getElementById('grid-count'),
  toggleGrayscale: document.getElementById('toggle-grayscale'),
  counter: document.getElementById('counter'),
  btnSearch: document.getElementById('btn-search'),
  viewer: document.getElementById('viewer'),
  viewerGrid: document.getElementById('viewer-grid'),
  btnPrev: document.getElementById('btn-prev'),
  btnPlay: document.getElementById('btn-play'),
  btnStop: document.getElementById('btn-stop'),
  btnNext: document.getElementById('btn-next'),
  countdown: document.getElementById('countdown'),
  thumbs: document.getElementById('thumbs'),
  gapCountdown: document.getElementById('gap-countdown'),
  histCount: document.getElementById('history-count'),
  countdownBar: document.getElementById('countdown-bar'),
  countdownBarContainer: document.querySelector('.countdown-bar-container'),
};

/** @type {HTMLImageElement[]} */
let viewerImgs = [];

function initViewerImageVisibility(img) {
  if (!img) return;
  // Standby: never show broken icon / alt text before we actually have an image
  img.hidden = true;
  img.alt = '';
  img.removeAttribute('src');

  img.addEventListener('load', () => {
    // グレースケール変換のために一度プロキシ画像を読み込む場合は、
    // ここでは表示せず、変換後の画像が読み込めたタイミングで表示する。
    if (img.dataset?.grayPending === '1') return;
    img.hidden = false;
  });

  img.addEventListener('error', () => {
    // broken icon を出さない
    img.hidden = true;
  });
}

function getGridCount() {
  const v = Number(dom.gridCount ? dom.gridCount.value : 1);
  return [1, 4, 9, 16].includes(v) ? v : 1;
}

function applyGridLayout() {
  if (!dom.viewerGrid) return;
  const count = getGridCount();
  const n = Math.max(1, Math.round(Math.sqrt(count))); // 1/2/3/4
  dom.viewerGrid.style.setProperty('--grid-n', String(n));

  // 画像要素を必要数に揃える
  if (viewerImgs.length === count) return;

  dom.viewerGrid.innerHTML = '';
  viewerImgs = [];
  for (let i = 0; i < count; i++) {
    const img = document.createElement('img');
    img.className = 'viewer-img';
    img.decoding = 'async';
    img.loading = 'eager';
    initViewerImageVisibility(img);
    dom.viewerGrid.appendChild(img);
    viewerImgs.push(img);
  }
}


// ---- state ----
const state = {
  phase: 'gap', // 'gap' | 'show'
  mode: 'standby', // 'standby' | 'play' | 'paused'
  grayscale: false,
  items: /** @type {Array<{id:string,title:string,link:string|null,image:string}>} */ ([]),
  idx: -1,
  shownCount: 0,
  history: /** @type {string[]} */ ([]),
  remainMs: 0,
  timerId: /** @type {number|null} */ (null),
};

function setLeftDisabled(disabled) {
  if (dom.board) dom.board.disabled = disabled;
  if (dom.order) dom.order.disabled = disabled;
  if (dom.interval) dom.interval.disabled = disabled;
  if (dom.gridCount) dom.gridCount.disabled = disabled;
  if (dom.btnSearch) dom.btnSearch.disabled = disabled;
}

function ms(val) {
  return Math.max(0, Number(val) || 0) * 1000;
}

function formatMMSS(msVal) {
  const total = Math.max(0, Math.ceil(msVal / 1000));
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

// ---- grayscale mode (カラー / グレースケール) ----
const GRAYSCALE_KEY = 'pinterval_grayscale_enabled';
const GRAY_CACHE_LIMIT = 120;
/** @type {Map<string, string>} key -> objectURL */
const grayCache = new Map();

function cacheGet(key) {
  const v = grayCache.get(key);
  if (!v) return null;
  // LRU: touch
  grayCache.delete(key);
  grayCache.set(key, v);
  return v;
}

function cacheSet(key, objectUrl) {
  if (!objectUrl) return;
  if (grayCache.has(key)) {
    const prev = grayCache.get(key);
    if (prev && prev !== objectUrl) {
      try { URL.revokeObjectURL(prev); } catch {}
    }
    grayCache.delete(key);
  }
  grayCache.set(key, objectUrl);

  // simple LRU eviction
  while (grayCache.size > GRAY_CACHE_LIMIT) {
    const firstKey = grayCache.keys().next().value;
    const firstVal = grayCache.get(firstKey);
    grayCache.delete(firstKey);
    if (firstVal) {
      try { URL.revokeObjectURL(firstVal); } catch {}
    }
  }
}

function buildProxyImageUrl(originalUrl) {
  return `/api/image-proxy?url=${encodeURIComponent(String(originalUrl || ''))}`;
}

/**
 * 画像要素（同一オリジンで読み込み済み）を、指定の輝度計算でグレースケール化して objectURL を返す。
 * 輝度 = 0.299 * R + 0.587 * G + 0.114 * B
 *
 * @param {HTMLImageElement} imgEl
 * @param {{ maxDim?: number }} [opt]
 * @returns {Promise<string>}
 */
async function convertImgElToGrayscaleObjectUrl(imgEl, opt = {}) {
  const sw = imgEl.naturalWidth || imgEl.width;
  const sh = imgEl.naturalHeight || imgEl.height;
  if (!sw || !sh) throw new Error('画像サイズが取得できません');

  const maxDim = Math.max(0, Number(opt.maxDim) || 0);
  // 安全弁: 極端に巨大な画像でメモリが吹き飛ぶのを防ぐ
  const safetyCap = 4096;
  const limit = maxDim > 0 ? Math.min(maxDim, safetyCap) : safetyCap;

  let tw = sw;
  let th = sh;
  const m = Math.max(sw, sh);
  if (m > limit) {
    const s = limit / m;
    tw = Math.max(1, Math.round(sw * s));
    th = Math.max(1, Math.round(sh * s));
  }

  const canvas = document.createElement('canvas');
  canvas.width = tw;
  canvas.height = th;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas が利用できません');

  ctx.drawImage(imgEl, 0, 0, tw, th);
  const imageData = ctx.getImageData(0, 0, tw, th);
  const d = imageData.data;

  // 指定の係数で輝度を算出して RGB を同値にする
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    d[i] = y;
    d[i + 1] = y;
    d[i + 2] = y;
    // alpha (d[i+3]) は保持
  }

  ctx.putImageData(imageData, 0, 0);

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('toBlob に失敗しました');
  return URL.createObjectURL(blob);
}

let viewerRenderSeq = 0;

// ---- gap (interval) countdown UI ----
function showGapCountdown() {
  const el = dom.gapCountdown;
  if (!el) return;
  const n = Math.max(1, Math.ceil(state.remainMs / 1000));
  el.textContent = String(n);
  el.hidden = false;
  // インターバル中は画像を一切表示しない
  for (const img of viewerImgs) img.hidden = true;
}


function hideGapCountdown() {
  const el = dom.gapCountdown;
  if (el) el.hidden = true
}

function shuffle(array) {
  const copy = array.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// ---- Pinterest API helpers ----
async function loadBoards() {
  if (!dom.board) return;
  try {
    const res = await fetch('/api/me/boards');
    if (!res.ok) {
      console.error('Failed to load boards', res.status);
      return;
    }
    const data = await res.json();
    const items = Array.isArray(data.items) ? data.items : [];

    dom.board.innerHTML = '';
    dom.board.insertAdjacentHTML('beforeend', '<option value="all">すべてのピン</option>');

    if (!items.length) {
      dom.board.insertAdjacentHTML(
        'beforeend',
        '<option value="" disabled>ボードが見つかりません</option>'
      );
      return;
    }

    for (const b of items) {
      const option = document.createElement('option');
      option.value = b.id;
      option.textContent = b.name || b.id;
      dom.board.appendChild(option);
    }
  } catch (e) {
    console.warn('Failed to load boards', e);
  }
}

/**
 * 現在のボードと表示モードに応じてピン一覧を取得
 * @returns {Promise<Array<{id:string,title:string,link:string|null,image:string}>>}
 */
async function fetchPinsForCurrentSelection() {
  const limit = 500;
  const boardId = dom.board ? dom.board.value : 'all';
  let url;
  if (!boardId || boardId === 'all') {
    url = `/api/me/pins?limit=${limit}`;
  } else {
    url = `/api/boards/${encodeURIComponent(boardId)}/pins?limit=${limit}`;
  }

  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error('Failed to load pins', res.status, text);
    alert('画像の取得に失敗しました。Pinterestへのログインや権限を確認してください。');
    return [];
  }

  /** @type {{ ok?: boolean, items?: any[] }} */
  const data = await res.json();
  const items = Array.isArray(data.items) ? data.items : [];

  // 並び替え
  const order = dom.order ? dom.order.value : 'newest';
  let sorted = items.slice();
  if (order === 'random') {
    sorted = shuffle(sorted);
  } else if (order === 'oldest') {
    // API は通常 新しい順 なので 反転
    sorted = sorted.slice().reverse();
  } // newest: そのまま

  return sorted;
}

// ---- rendering ----
function renderViewer() {
  applyGridLayout();
  if (!dom.viewerGrid) return;

  const seq = ++viewerRenderSeq;
  const count = getGridCount();

  // standby / 未選択時は全て非表示にして broken icon を出さない
  if (!state.items.length || state.idx < 0) {
    for (const img of viewerImgs) {
      img.removeAttribute('src');
      img.alt = '';
      img.hidden = true;
      img.dataset.grayPending = '0';
      img.dataset.renderSeq = String(seq);
    }
    return;
  }

  // idx から count 枚を並べて表示
  for (let i = 0; i < viewerImgs.length; i++) {
    const imgEl = viewerImgs[i];
    const item = state.items[(state.idx + i) % state.items.length];
    if (!item || !item.image) {
      imgEl.removeAttribute('src');
      imgEl.alt = '';
      imgEl.hidden = true;
      imgEl.dataset.grayPending = '0';
      imgEl.dataset.renderSeq = String(seq);
      continue;
    }

    const originalUrl = item.image;
    imgEl.alt = item.title || 'Pinterest image';
    imgEl.dataset.renderSeq = String(seq);

    // カラー表示
    if (!state.grayscale) {
      imgEl.dataset.grayPending = '0';
      imgEl.src = originalUrl;
      imgEl.hidden = false;
      continue;
    }

    // グレースケール表示（キャッシュがあれば即表示）
    const cacheKey = `viewer:${originalUrl}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
      imgEl.dataset.grayPending = '0';
      imgEl.src = cached;
      imgEl.hidden = false;
      continue;
    }

    // まずは同一オリジンのプロキシ画像を読み込み、その後 canvas で変換する
    imgEl.dataset.grayPending = '1';
    imgEl.hidden = true;

    const onLoad = async () => {
      if (imgEl.dataset.renderSeq !== String(seq)) return;
      try {
        const grayObjUrl = await convertImgElToGrayscaleObjectUrl(imgEl, { maxDim: 0 });
        if (imgEl.dataset.renderSeq !== String(seq)) {
          try { URL.revokeObjectURL(grayObjUrl); } catch {}
          return;
        }
        cacheSet(cacheKey, grayObjUrl);
        imgEl.dataset.grayPending = '0';
        imgEl.src = grayObjUrl;
      } catch (e) {
        console.warn('Grayscale conversion failed (viewer):', e);
        imgEl.dataset.grayPending = '0';
        imgEl.src = originalUrl;
        imgEl.hidden = false;
      }
    };

    const onError = () => {
      if (imgEl.dataset.renderSeq !== String(seq)) return;
      imgEl.dataset.grayPending = '0';
      imgEl.src = originalUrl;
      imgEl.hidden = false;
    };

    imgEl.addEventListener('load', onLoad, { once: true });
    imgEl.addEventListener('error', onError, { once: true });
    imgEl.src = buildProxyImageUrl(originalUrl);
  }
}

function renderHistory() {
  if (!dom.thumbs || !dom.histCount) return;
  dom.thumbs.innerHTML = '';
  const uniqueUrls = Array.from(new Set(state.history.slice().reverse()));
  for (const url of uniqueUrls.slice(0, 200)) {
    const img = document.createElement('img');
    // クリック判定は「元URL」を使う
    img.className = 'thumb';
    img.title = '履歴';

    if (!state.grayscale) {
      img.src = url;
    } else {
      const cacheKey = `thumb:${url}`;
      const cached = cacheGet(cacheKey);
      if (cached) {
        img.src = cached;
      } else {
        // 同一オリジンのプロキシから読み込み → 小さめに変換してサムネ用キャッシュに保持
        img.dataset.grayPending = '1';
        img.style.opacity = '0.65';
        img.addEventListener('load', async () => {
          try {
            // 変換中にトグルがOFFになった場合は中止
            if (!state.grayscale || !img.isConnected) return;
            const grayObjUrl = await convertImgElToGrayscaleObjectUrl(img, { maxDim: 240 });
            if (!state.grayscale || !img.isConnected) {
              try { URL.revokeObjectURL(grayObjUrl); } catch {}
              return;
            }
            cacheSet(cacheKey, grayObjUrl);
            img.dataset.grayPending = '0';
            img.style.opacity = '';
            img.src = grayObjUrl;
          } catch (e) {
            console.warn('Grayscale conversion failed (thumb):', e);
            img.dataset.grayPending = '0';
            img.style.opacity = '';
            img.src = url;
          }
        }, { once: true });
        img.addEventListener('error', () => {
          img.dataset.grayPending = '0';
          img.style.opacity = '';
          img.src = url;
        }, { once: true });
        img.src = buildProxyImageUrl(url);
      }
    }

    img.addEventListener('click', () => {
      const i = state.items.findIndex((it) => it.image === url);
      if (i >= 0) {
        state.idx = i;
        renderViewer();
      }
    });
    dom.thumbs.appendChild(img);
  }
  dom.histCount.textContent = String(state.history.length);
}



// ---- play control ----
function stopTimer() {
  if (state.timerId != null) {
    clearInterval(state.timerId);
    state.timerId = null;
  }
}

function tickCountdown() {
  const step = 50; // ms
  state.remainMs -= step;

  // バーの進捗を更新（無段階）
  updateCountdownBar();

  // gap中のみ1秒単位で数字表示
  if (state.phase === 'gap') {
    showGapCountdown();
  } else {
    hideGapCountdown();
  }

  if (state.remainMs <= 0) {
    if (state.phase === 'gap') {
      // gap -> show
      hideGapCountdown();
      showNext(true); // 次の画像を表示し、表示用カウントダウンを開始
      state.phase = 'show';
    } else {
      // show -> gap
      state.phase = 'gap';
      state.remainMs = 3000;
      showGapCountdown();
    }
  }

  // 表示は1秒単位で更新
  if (dom.countdown) dom.countdown.textContent = formatMMSS(state.remainMs);
}

// カウントダウンバーの進捗を更新
function updateCountdownBar() {
  if (!dom.countdownBar || !dom.countdownBarContainer) return;
  // インターバル（gap）時はバー自体を非表示
  if (state.phase === 'gap') {
    dom.countdownBarContainer.style.display = 'none';
    return;
  }
  // プレイ・ポーズ時のみ表示、スタンバイ時は非表示
  if (state.mode === 'play' || state.mode === 'paused') {
    dom.countdownBarContainer.style.display = '';
  } else {
    dom.countdownBarContainer.style.display = 'none';
    return;
  }
  // 表示間隔（秒）
  let totalMs = 0;
  if (state.phase === 'show') {
    totalMs = ms(dom.interval ? dom.interval.value : 30);
  }
  // 0除算防止
  if (totalMs <= 0) {
    dom.countdownBar.style.height = '0%';
    dom.countdownBar.style.background = '#fff';
    return;
  }
  // 残り割合
  const percent = Math.max(0, Math.min(1, state.remainMs / totalMs));
  dom.countdownBar.style.height = (percent * 100) + '%';
  // 色変更: 通常=白, 半分以下=黄, 10%以下=赤
  if (percent <= 0.1) {
    dom.countdownBar.style.background = '#ff3b30'; // 赤
  } else if (percent <= 0.5) {
    dom.countdownBar.style.background = '#ffd600'; // 黄
  } else {
    dom.countdownBar.style.background = '#fff'; // 白
  }
}

function startTimer() {
  stopTimer();
  state.timerId = setInterval(tickCountdown, 50); // 50msごとにtick
}

function enterPlay() {
  if (!state.items.length) return;

  state.mode = 'play';
  updatePlayIcon();
  setLeftDisabled(true);

  // start with 3s gap countdown
  state.phase = 'gap';
  state.remainMs = 3000;
  if (dom.countdown) dom.countdown.textContent = formatMMSS(state.remainMs);
  showGapCountdown();
  updateCountdownBar();
  startTimer();
}

function pausePlay() {
  // 残り時間を保持したまま停止（再開で続きから）
  stopTimer();
  state.mode = 'paused';
  updatePlayIcon();
  setLeftDisabled(true); // 一時停止中も左カラム無効化
}

function resumePlay() {
  if (!state.items.length) return;

  state.mode = 'play';
  updatePlayIcon();
  setLeftDisabled(true); // 再生中も左カラム無効化

  // 現在のフェーズに合わせてUIを整える（残り時間は保持）
  if (state.phase === 'gap') {
    showGapCountdown();
  } else {
    hideGapCountdown();
  }
  if (dom.countdown) dom.countdown.textContent = formatMMSS(state.remainMs);
  updateCountdownBar();
  startTimer();
}

function stopPlay() {
  stopTimer();
  state.mode = 'standby';
  updatePlayIcon();
  setLeftDisabled(false); // 停止時のみ有効化

  state.phase = 'gap';
  state.remainMs = 0;
  hideGapCountdown();
  if (dom.countdown) dom.countdown.textContent = '00:00';
  if (dom.countdownBar) dom.countdownBar.style.height = '0%';
  if (dom.countdownBarContainer) dom.countdownBarContainer.style.display = 'none';
}

function showNext(resetCountdown) {
  if (!state.items.length) return;
  const step = getGridCount();
  // idx は「現在表示している先頭」を指す。次へは step 分進める。
  state.idx = (state.idx + step) % state.items.length;

  state.shownCount += step;
  if (dom.counter) dom.counter.textContent = String(state.shownCount);

  renderViewer();

  // 表示した分を履歴へ
  for (let i = 0; i < Math.min(step, state.items.length); i++) {
    const it = state.items[(state.idx + i) % state.items.length];
    if (it && it.image) state.history.push(it.image);
  }
  renderHistory();

  if (resetCountdown) {
    state.remainMs = ms(dom.interval ? dom.interval.value : 30);
    if (dom.countdown) dom.countdown.textContent = formatMMSS(state.remainMs);
    // 表示中はギャップ用カウントダウンは常に非表示
    hideGapCountdown();
    // グレースケール変換中（grayPending=1）の場合は、変換完了まで表示しない
    for (const img of viewerImgs) {
      if (img.dataset?.grayPending !== '1') img.hidden = false;
    }
    updateCountdownBar();
  }
}

// ---- prepare (search) ----
async function prepareAndPreview() {
  if (state.mode === 'play') return; // 再生中は無視

  setLeftDisabled(true);
  if (dom.btnSearch) {
    dom.btnSearch.disabled = true;
    dom.btnSearch.textContent = '読み込み中...';
  }

  try {
    const items = await fetchPinsForCurrentSelection();
    if (!items.length) {
      state.items = [];
      state.idx = -1;
      renderViewer();
      alert('画像が見つかりませんでした。ボードやピンが存在するか確認してください。');
      return;
    }

    state.items = items;
    // 次回 showNext() で先頭が 0 になるよう、表示数分だけ戻しておく
    state.idx = -getGridCount();
    state.shownCount = 0;
    if (dom.counter) dom.counter.textContent = '0';
    renderViewer();
  
    // 自動再生: まず3秒インターバル→画像表示へ
    enterPlay();
} finally {
    setLeftDisabled(false);
    if (dom.btnSearch) {
      dom.btnSearch.disabled = false;
      dom.btnSearch.textContent = 'スタート';
    }
  }
}

// ---- event wiring ----
if (dom.btnSearch) {
  dom.btnSearch.addEventListener('click', () => {
    // 左カラムを隠す（drawer-open-leftクラスを除去、オーバーレイ非表示）
    document.body.classList.remove('drawer-open-left');
    const overlay = document.getElementById('drawer-overlay');
    if (overlay) overlay.hidden = true;
    prepareAndPreview();
  });
}

if (dom.btnPlay) {
  dom.btnPlay.addEventListener('click', async () => {
    if (state.mode === 'play') {
      pausePlay();
      return;
    }
    if (state.mode === 'paused') {
      resumePlay();
      return;
    }

    // standby: 初回再生で items が無ければ自動準備
    if (!state.items.length) {
      await prepareAndPreview();
    }

    if (state.items.length) {
      enterPlay(); // ★ここで確実にカウントダウン開始
    }
  });
}

if (dom.btnStop) {
  dom.btnStop.addEventListener('click', () => {
    stopPlay();
  });
}

if (dom.btnPrev) { dom.btnPrev.addEventListener('click',()=>showPrev()); }

if (dom.btnNext) {
  dom.btnNext.addEventListener('click', () => {
    showNext(true);
  });
}

// Keyboard shortcuts
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    e.preventDefault();
    if (dom.btnPlay) dom.btnPlay.click();
  } else if (e.code === 'ArrowRight') {
    if (dom.btnNext) dom.btnNext.click();
  } else if (e.code === 'Escape') {
    if (dom.btnStop) dom.btnStop.click();
  }
});

// defaults / init

// --- 表示間隔（秒）をlocalStorageで保存・復元 ---
const INTERVAL_KEY = 'pinterval_interval_sec';
if (dom.interval) {
  // 保存値があれば復元、なければデフォルト60
  const saved = localStorage.getItem(INTERVAL_KEY);
  if (saved && Array.from(dom.interval.options).some(opt => opt.value === saved)) {
    dom.interval.value = saved;
  } else {
    dom.interval.value = '300';
  }
  // 変更時に保存
  dom.interval.addEventListener('change', () => {
    localStorage.setItem(INTERVAL_KEY, dom.interval.value);
  });
}

// --- 同時表示数（1/4/9/16）を localStorage で保存・復元 ---
const GRIDCOUNT_KEY = 'pinterval_grid_count';
if (dom.gridCount) {
  const saved = localStorage.getItem(GRIDCOUNT_KEY);
  if (saved && ['1','4','9','16'].includes(saved)) {
    dom.gridCount.value = saved;
  } else {
    dom.gridCount.value = '1';
  }
  dom.gridCount.addEventListener('change', () => {
    localStorage.setItem(GRIDCOUNT_KEY, dom.gridCount.value);

    // 再生中はUIが無効化される想定だが、念のためガード
    if (state.mode === 'play') return;

    // 表示中なら「先頭 idx」を合わせる（次の showNext で飛ばないよう補正）
    if (state.items.length && state.idx >= 0) {
      // idx は常にグループ先頭に合わせる
      const step = getGridCount();
      state.idx = Math.floor(state.idx / step) * step;
    } else if (state.items.length && state.idx < 0) {
      state.idx = -getGridCount();
    }
    renderViewer();
  });
}

// --- グレースケール設定を localStorage で保存・復元 ---
{
  const saved = localStorage.getItem(GRAYSCALE_KEY);
  if (saved === '1' || saved === '0') {
    state.grayscale = saved === '1';
  }
  if (dom.toggleGrayscale) {
    dom.toggleGrayscale.checked = !!state.grayscale;
    dom.toggleGrayscale.addEventListener('change', () => {
      state.grayscale = !!dom.toggleGrayscale.checked;
      localStorage.setItem(GRAYSCALE_KEY, state.grayscale ? '1' : '0');
      // 表示中の画像と履歴を即時に切替
      renderViewer();
      renderHistory();
    });
  }
}

renderHistory();
renderViewer();
loadBoards();
// 初期状態でバー非表示
if (dom.countdownBarContainer) dom.countdownBarContainer.style.display = 'none';

// Optional: expose for debugging
window.__PINTERVAL_STATE__ = state;

document.getElementById('loginBtn')?.addEventListener('click',()=>{window.location.href='https://pinterval.onrender.com/auth/login';});

function updatePlayIcon(){
  if(!dom.btnPlay) return;
  // 再生中は一時停止（⏸）、一時停止中は再生（▶）
  dom.btnPlay.textContent = (state.mode==='play') ? '⏸' : '▶';
}

function showPrev(){
  if(!state.items.length) return;
  const step = getGridCount();
  state.idx=(state.idx-step+state.items.length*1000)%state.items.length;
  renderViewer();
}

// ---- mobile / portrait drawer UI ----
(function initDrawerUI(){
  const left = document.getElementById('left-col');
  const right = document.getElementById('right-col');
  const overlay = document.getElementById('drawer-overlay');
  const btnOpenLeft = document.getElementById('btn-open-left');
  const btnOpenRight = document.getElementById('btn-open-right');
  const btnCloseLeft = document.getElementById('btn-close-left');
  const btnCloseRight = document.getElementById('btn-close-right');

  if (!left || !right || !overlay || !btnOpenLeft || !btnOpenRight) return;

  const mq = window.matchMedia('(max-width: 900px), (max-aspect-ratio: 1/1)');

  function closeAll() {
    document.body.classList.remove('drawer-open-left', 'drawer-open-right');
    overlay.hidden = true;
  }

  function openLeft() {
    document.body.classList.add('drawer-open-left');
    document.body.classList.remove('drawer-open-right');
    overlay.hidden = false;
  }

  function openRight() {
    document.body.classList.add('drawer-open-right');
    document.body.classList.remove('drawer-open-left');
    overlay.hidden = false;
  }

  // open
  btnOpenLeft.addEventListener('click', () => {
    if (!mq.matches) return;
    openLeft();
  });
  btnOpenRight.addEventListener('click', () => {
    if (!mq.matches) return;
    openRight();
  });

  // close
  overlay.addEventListener('click', closeAll);
  btnCloseLeft?.addEventListener('click', closeAll);
  btnCloseRight?.addEventListener('click', closeAll);

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAll();
  });

  // 画面サイズが戻ったら強制的に閉じる（PC レイアウトへ復帰）
  function syncForViewport() {
    if (!mq.matches) closeAll();
  }
  try {
    mq.addEventListener('change', syncForViewport);
  } catch {
    // Safari old
    mq.addListener(syncForViewport);
  }
  syncForViewport();
})();
