import { bus } from './eventBus.js';

const dom = {
  // theme: document.getElementById('theme'),
  board: document.getElementById('board'),
  order: document.getElementById('order'),
  interval: document.getElementById('interval'),
  counter: document.getElementById('counter'),
  // btnSearch: document.getElementById('btn-search'),
  viewer: document.getElementById('viewer'),
  img: document.getElementById('viewer-img'),
  btnPlay: document.getElementById('btn-play'),
  btnStop: document.getElementById('btn-stop'),
  btnNext: document.getElementById('btn-next'),
  countdown: document.getElementById('countdown'),
  thumbs: document.getElementById('thumbs'),
  histCount: document.getElementById('history-count'),
  leftCol: document.getElementById('left-col')
};



const HISTORY_STORAGE_KEY = 'pinterval:history';

function loadHistoryFromStorage() {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((u) => typeof u === 'string');
  } catch (e) {
    console.warn('Failed to load history from storage', e);
    return [];
  }
}
// 不要な閉じ括弧を削除
function saveHistoryToStorage(history) {
  try {
    const payload = Array.isArray(history) ? history.slice(-500) : [];
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(payload));
  } catch (e) {
    console.warn('Failed to save history to storage', e);
  }
}

const state = {
  mode: 'standby', // 'standby' | 'play'
  items: /** @type {Array<{id:string,title:string,link:string|null,image:string}>} */ ([]),
  idx: -1,
  shownCount: 0,
  history: /** @type {string[]} */ (loadHistoryFromStorage()),
  remainMs: 0,
  timerId: /** @type {number|null} */ (null)
};

const INTERVAL_OPTIONS = [10,15,20,30,40,50,60,90,120,180];

function setLeftDisabled(disabled) {
  if (dom.board) dom.board.disabled = disabled;
  if (dom.order) dom.order.disabled = disabled;
  if (dom.interval) dom.interval.disabled = disabled;
}

function ms(val) { return Math.max(0, Number(val) || 0) * 1000; }

function formatMMSS(ms) {
  const total = Math.ceil(ms/1000);
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function shuffleArray(arr) {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

async function loadBoards() {
  if (!dom.board) return;
  try {
    const res = await fetch('/api/me/boards');
    if (!res.ok) return;
    const data = await res.json();
    const items = Array.isArray(data.items) ? data.items : [];

    dom.board.innerHTML = '';
    dom.board.insertAdjacentHTML('beforeend', '<option value="all">すべてのピン</option>');

    if (!items.length) {
      dom.board.insertAdjacentHTML('beforeend', '<option value="" disabled>ボードが見つかりません</option>');
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

function renderViewer() {
  const item = state.items[state.idx];
  if (!item) return;
  dom.img.src = item.image;
  dom.img.alt = item.title || 'Pinterest image';
}

function renderHistory() {
  dom.thumbs.innerHTML = '';
  for (const url of state.history.slice(-90).reverse()) {
    const img = document.createElement('img');
    img.src = url;
    img.title = '履歴';
    img.addEventListener('click', () => {
      // jump to this image if exists in current items
      const i = state.items.findIndex(it => it.image === url);
      if (i >= 0) {
        state.idx = i;
        renderViewer();
      }
    });
    dom.thumbs.appendChild(img);
  }
  dom.histCount.textContent = String(state.history.length);
}

function enterStandby() {
  state.mode = 'standby';
  if (state.timerId) {
    clearInterval(state.timerId);
    state.timerId = null;
  }
  setLeftDisabled(false);
}

function enterPlay() {
  if (!state.items.length) return; // nothing to play
  state.mode = 'play';
  setLeftDisabled(true);
  const totalMs = ms(dom.interval.value);
  state.remainMs = totalMs;
  dom.countdown.textContent = formatMMSS(state.remainMs);

  if (state.timerId) clearInterval(state.timerId);
  state.timerId = setInterval(() => {
    if (state.mode !== 'play') return;
    state.remainMs -= 250;
    if (state.remainMs <= 0) {
      showNext(true);
    }
    dom.countdown.textContent = formatMMSS(state.remainMs);
    bus.emit('countdown:tick', { remainMs: state.remainMs }).catch(()=>{});
  }, 250);
}

function pausePlay() {
  if (state.mode !== 'play') return;
  state.mode = 'standby';
  if (state.timerId) {
    clearInterval(state.timerId);
    state.timerId = null;
  }
  // 左カラムは操作不可のままに見えるため、明確に有効化する
  setLeftDisabled(false);
}

function stopPlay() {
  if (state.timerId) {
    clearInterval(state.timerId);
    state.timerId = null;
  }
  state.mode = 'standby';
  setLeftDisabled(false);
  state.remainMs = 0;
  dom.countdown.textContent = '00:00';
}

function showNext(resetCountdown) {
  if (!state.items.length) return;
  state.idx = (state.idx + 1) % state.items.length;
  const item = state.items[state.idx];
  renderViewer();
  state.history.push(item.image);
  saveHistoryToStorage(state.history);
  state.shownCount += 1;
  dom.counter.textContent = String(state.shownCount);
  renderHistory();
  if (resetCountdown) {
    state.remainMs = ms(dom.interval.value);
  }
}

// テーマ検索機能は廃止

// テーマ検索関連イベントは廃止

// Play controls
dom.btnPlay.addEventListener('click', () => {
  if (state.mode === 'play') {
    pausePlay(); // 一時停止
  } else {
    enterPlay(); // 再生
  }
});
dom.btnStop.addEventListener('click', () => {
  stopPlay();
});
dom.btnNext.addEventListener('click', () => {
  showNext(true);
});

// Keyboard shortcuts (optional)
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    e.preventDefault();
    dom.btnPlay.click();
  } else if (e.code === 'ArrowRight') {
    dom.btnNext.click();
  } else if (e.code === 'Escape') {
    dom.btnStop.click();
  }
});

// Defaults
dom.interval.value = '30';
renderHistory();
loadBoards();
