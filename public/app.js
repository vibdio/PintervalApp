import { bus } from './eventBus.js';

const dom = {
  theme: document.getElementById('theme'),
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
  leftCol: document.getElementById('left-col')
};

const state = {
  mode: 'standby', // 'standby' | 'play'
  items: /** @type {Array<{id:string,title:string,link:string|null,image:string}>} */ ([]),
  idx: -1,
  shownCount: 0,
  history: /** @type {string[]} */ ([]),
  remainMs: 0,
  timerId: /** @type {number|null} */ (null)
};

const INTERVAL_OPTIONS = [10,15,20,30,40,50,60,90,120,180];

function setLeftDisabled(disabled) {
  dom.theme.disabled = disabled;
  dom.interval.disabled = disabled;
  dom.btnSearch.disabled = disabled;
}

function ms(val) { return Math.max(0, Number(val) || 0) * 1000; }

function formatMMSS(ms) {
  const total = Math.ceil(ms/1000);
  const m = Math.floor(total/60);
  const s = total%60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
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
  state.shownCount += 1;
  dom.counter.textContent = String(state.shownCount);
  renderHistory();
  if (resetCountdown) {
    state.remainMs = ms(dom.interval.value);
  }
}

async function runSearch() {
  const q = dom.theme.value.trim();
  if (!q) {
    alert('テーマを入力してください。');
    return;
  }
  // Use eventBus emitSwitch with lockKey 'search'
  await bus.emitSwitch('search:run', { query: q }, { lockKey: 'search' });
}

// Register event handlers per 開発方針
bus.on('search:run', async (payload, ctx) => {
  // pre: validate
}, { phase: 'pre', priority: 10 });

bus.on('search:run', async (payload, ctx) => {
  // main: fetch
  const q = payload.query;
  const controller = new AbortController();
  ctx.signal.addEventListener('abort', () => controller.abort(), { once: true });

  const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&limit=120`, { signal: controller.signal });
  if (!res.ok) throw new Error('検索に失敗しました。');
  const data = await res.json();
  const items = Array.isArray(data.items) ? data.items : [];
  state.items = items;
  state.idx = -1;
  state.history = [];
  state.shownCount = 0;
}, { phase: 'main', priority: 0 });

bus.on('search:run', async (payload, ctx) => {
  // post: UI update
  dom.counter.textContent = '0';
  renderHistory();
  if (state.items.length) {
    showNext(false);
  } else {
    alert('画像が見つかりませんでした。');
  }
}, { phase: 'post', priority: 0 });

// Play controls
dom.btnSearch.addEventListener('click', runSearch);
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
