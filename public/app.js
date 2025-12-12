import { bus } from './eventBus.js';

// DOM references
const dom = {
  board: document.getElementById('board'),
  order: document.getElementById('order'),
  interval: document.getElementById('interval'),
  counter: document.getElementById('counter'),
  btnSearch: document.getElementById('btn-search'),
  viewer: document.getElementById('viewer'),
  img: document.getElementById('viewer-img'),
  btnPlay: document.getElementById('btn-play'),
  btnStop: document.getElementById('btn-stop'),
  btnNext: document.getElementById('btn-next'),
  countdown: document.getElementById('countdown'),
  thumbs: document.getElementById('thumbs'),
  histCount: document.getElementById('history-count'),
};

const HISTORY_STORAGE_KEY = 'pinterval_history_v1';

// ---- localStorage (history) ----
function loadHistoryFromStorage() {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((x) => typeof x === 'string');
  } catch (e) {
    console.warn('Failed to load history from storage', e);
    return [];
  }
}

function saveHistoryToStorage(history) {
  try {
    const payload = Array.isArray(history) ? history.slice(-500) : [];
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(payload));
  } catch (e) {
    console.warn('Failed to save history to storage', e);
  }
}

// ---- state ----
const state = {
  mode: 'standby', // 'standby' | 'play'
  items: /** @type {Array<{id:string,title:string,link:string|null,image:string}>} */ ([]),
  idx: -1,
  shownCount: 0,
  history: /** @type {string[]} */ (loadHistoryFromStorage()),
  remainMs: 0,
  timerId: /** @type {number|null} */ (null),
};

function setLeftDisabled(disabled) {
  if (dom.board) dom.board.disabled = disabled;
  if (dom.order) dom.order.disabled = disabled;
  if (dom.interval) dom.interval.disabled = disabled;
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
  if (!dom.img) return;
  const item = state.items[state.idx];
  if (!item) {
    dom.img.removeAttribute('src');
    dom.img.alt = '';
    return;
  }
  dom.img.src = item.image;
  dom.img.alt = item.title || 'Pinterest image';
}

function renderHistory() {
  if (!dom.thumbs || !dom.histCount) return;
  dom.thumbs.innerHTML = '';
  const uniqueUrls = Array.from(new Set(state.history.slice().reverse()));
  for (const url of uniqueUrls.slice(0, 200)) {
    const img = document.createElement('img');
    img.src = url;
    img.className = 'thumb';
    img.title = '履歴';
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
function enterStandby() {
  state.mode = 'standby';
  if (state.timerId != null) {
    clearInterval(state.timerId);
    state.timerId = null;
  }
  setLeftDisabled(false);
}

function enterPlay() {
  if (!state.items.length) return;

  state.mode = 'play';
  setLeftDisabled(true);

  // ★ 最初の再生でも確実にセットする
  const totalMs = ms(dom.interval?.value || 30);
  state.remainMs = totalMs;
  if (dom.countdown)
    dom.countdown.textContent = formatMMSS(state.remainMs);

  // タイマー初期化
  if (state.timerId != null) {
    clearInterval(state.timerId);
  }

  state.timerId = window.setInterval(() => {
    state.remainMs -= 1000;

    if (state.remainMs <= 0) {
      showNext(true);
    } else if (dom.countdown) {
      dom.countdown.textContent = formatMMSS(state.remainMs);
    }
  }, 1000);
}


function pausePlay() {
  if (state.timerId != null) {
    clearInterval(state.timerId);
    state.timerId = null;
  }
  state.mode = 'standby';
  setLeftDisabled(false);
}

function stopPlay() {
  if (state.timerId != null) {
    clearInterval(state.timerId);
    state.timerId = null;
  }
  state.mode = 'standby';
  setLeftDisabled(false);
  state.remainMs = 0;
  if (dom.countdown) dom.countdown.textContent = '00:00';
}

function showNext(resetCountdown) {
  if (!state.items.length) return;
  state.idx = (state.idx + 1) % state.items.length;
  const item = state.items[state.idx];

  state.shownCount += 1;
  if (dom.counter) dom.counter.textContent = String(state.shownCount);

  renderViewer();

  if (item && item.image) {
    state.history.push(item.image);
    saveHistoryToStorage(state.history);
    renderHistory();
  }

  if (resetCountdown) {
    state.remainMs = ms(dom.interval ? dom.interval.value : 30);
    if (dom.countdown) dom.countdown.textContent = formatMMSS(state.remainMs);
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
    state.idx = 0;
    state.shownCount = 0;
    if (dom.counter) dom.counter.textContent = '0';
    renderViewer();
  } finally {
    setLeftDisabled(false);
    if (dom.btnSearch) {
      dom.btnSearch.disabled = false;
      dom.btnSearch.textContent = '検索して準備';
    }
  }
}

// ---- event wiring ----
if (dom.btnSearch) {
  dom.btnSearch.addEventListener('click', () => {
    prepareAndPreview();
  });
}

if (dom.btnPlay) {
  dom.btnPlay.addEventListener('click', async () => {
    if (state.mode === 'play') {
      pausePlay();
      return;
    }

    // 初回再生で items が無ければ自動準備
    if (!state.items.length) {
      await prepareAndPreview();
    }

    if (state.items.length) {
      enterPlay();  // ★ここで確実にカウントダウン開始
    }
  });

}

if (dom.btnStop) {
  dom.btnStop.addEventListener('click', () => {
    stopPlay();
  });
}

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
if (dom.interval) dom.interval.value = '30';
renderHistory();
loadBoards();

// Optional: expose for debugging
window.__PINTERVAL_STATE__ = state;

document.getElementById('loginBtn')?.addEventListener('click',()=>{window.location.href='https://pinterval.onrender.com/auth/login';});
