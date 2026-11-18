'use strict';

/* =========================================================
   あみ図ノート  ステップ1
   - 写真 / PDF の編み図を取り込む
   - 帯（ハイライト）を1段ずつ動かす
   - 段数と帯の位置を作品ごとに覚えておく
   ========================================================= */

const PDFJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
const PDFJS_WORKER_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
const MIN_BAND = 0.005; // 帯の最小の太さ（ページ高さに対する割合）
const MAX_SIDE = 3000;  // 画像の長辺の上限（iPhone のメモリ制限対策）
const MAX_ZOOM = 6;

const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* ---------- 保存（端末の中の IndexedDB） ----------
   meta  : 名前・段数・帯の位置など（よく書き換える）
   pages : 編み図の画像（大きいので別に保存） */
let dbPromise;
function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('amizu-note', 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('pages')) db.createObjectStore('pages', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('charts')) db.createObjectStore('charts', { keyPath: 'id' }); // 描いた編み図
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}
async function dbRun(storeNames, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeNames, mode);
    const req = fn(t);
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
const getAllMeta = () => dbRun('meta', 'readonly', (t) => t.objectStore('meta').getAll());
const getPages = (id) => dbRun('pages', 'readonly', (t) => t.objectStore('pages').get(id));
const putMeta = (m) => dbRun('meta', 'readwrite', (t) => { t.objectStore('meta').put(m); });
const addPattern = (m, blobs) => dbRun(['meta', 'pages'], 'readwrite', (t) => {
  t.objectStore('meta').put(m);
  t.objectStore('pages').put({ id: m.id, blobs });
});
const deletePattern = (id) => dbRun(['meta', 'pages'], 'readwrite', (t) => {
  t.objectStore('meta').delete(id);
  t.objectStore('pages').delete(id);
});
const getAllCharts = () => dbRun('charts', 'readonly', (t) => t.objectStore('charts').getAll());
const getChart = (id) => dbRun('charts', 'readonly', (t) => t.objectStore('charts').get(id));
const putChart = (d) => dbRun('charts', 'readwrite', (t) => { t.objectStore('charts').put(d); });
const deleteChart = (id) => dbRun('charts', 'readwrite', (t) => { t.objectStore('charts').delete(id); });

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/* ---------- ちょっとした表示 ---------- */
let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
}
function busy(msg) {
  $('busy').hidden = !msg;
  if (msg) $('busyText').textContent = msg;
}

/* ---------- 取り込み ---------- */
function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = PDFJS_URL;
    s.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
      resolve(window.pdfjsLib);
    };
    s.onerror = () => reject(new Error('PDFを開く部品を読み込めませんでした。インターネット接続を確認してください。'));
    document.head.appendChild(s);
  });
}

// PDF の各ページを画像（JPEG）に変換する
async function pdfToImages(file) {
  const lib = await loadPdfJs();
  const pdf = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
  const blobs = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    busy(`PDFを変換中… ${i} / ${pdf.numPages} ページ`);
    const page = await pdf.getPage(i);
    const base = page.getViewport({ scale: 1 });
    // 拡大しても読める解像度。iPhone の画像サイズ上限に収まるよう長辺 2400px 程度に
    const scale = Math.min(4, 2400 / Math.max(base.width, base.height));
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    blobs.push(await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9)));
    canvas.width = canvas.height = 0; // メモリ解放
  }
  return blobs;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('画像を読み込めませんでした。'));
    img.src = src;
  });
}

// スマホの写真はとても大きいので、扱いやすい大きさ（長辺 MAX_SIDE）に縮める
async function shrinkPhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const w = img.naturalWidth, h = img.naturalHeight;
    const k = MAX_SIDE / Math.max(w, h);
    if (k >= 1) return file;
    const c = document.createElement('canvas');
    c.width = Math.round(w * k);
    c.height = Math.round(h * k);
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
    c.width = c.height = 0;
    return blob || file;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function importFile(file) {
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  busy('読み込み中…');
  try {
    const blobs = isPdf ? await pdfToImages(file) : [await shrinkPhoto(file)];
    if (!blobs.length) throw new Error('ページが見つかりませんでした。');
    const meta = {
      id: newId(),
      name: file.name.replace(/\.[^.]+$/, '') || '編み図',
      created: Date.now(),
      pageCount: blobs.length,
      state: { page: 0, row: 1, y: 0.85, h: 0.04, dir: 'up', zoom: 1, dim: true },
    };
    await addPattern(meta, blobs);
    busy(null);
    await openViewer(meta.id, true);
  } catch (err) {
    busy(null);
    console.error(err);
    alert('取り込みに失敗しました。\n' + (err.message || err));
  }
}

/* ---------- 一覧画面 ---------- */
let listUrls = [];
async function renderHome() {
  listUrls.forEach(URL.revokeObjectURL);
  listUrls = [];
  const list = $('patternList');
  list.innerHTML = '';
  const metas = (await getAllMeta()).sort((a, b) => (b.updated || b.created) - (a.updated || a.created));
  $('emptyMsg').hidden = metas.length > 0;

  for (const m of metas) {
    const li = document.createElement('li');
    li.className = 'card';

    const open = document.createElement('button');
    open.className = 'card-open';
    const img = document.createElement('img');
    img.alt = '';
    const info = document.createElement('div');
    info.className = 'card-info';
    const name = document.createElement('div');
    name.className = 'card-name';
    name.textContent = m.name;
    const metaLine = document.createElement('div');
    metaLine.className = 'card-meta';
    metaLine.textContent = `${m.state.row} 段目` + (m.pageCount > 1 ? ` ・ ${m.pageCount} ページ` : '');
    info.append(name, metaLine);
    open.append(img, info);
    open.onclick = () => openViewer(m.id);

    const del = document.createElement('button');
    del.className = 'card-del';
    del.textContent = '削除';
    del.onclick = async () => {
      if (!confirm(`「${m.name}」を削除しますか？`)) return;
      await deletePattern(m.id);
      renderHome();
    };

    li.append(open, del);
    list.append(li);

    getPages(m.id).then((p) => {
      if (p && p.blobs[0]) {
        const url = URL.createObjectURL(p.blobs[0]);
        listUrls.push(url);
        img.src = url;
      }
    });
  }

  // 描いた編み図
  const charts = (await getAllCharts()).sort((a, b) => (b.updated || b.created) - (a.updated || a.created));
  const clist = $('chartList');
  clist.innerHTML = '';
  $('chartSection').hidden = charts.length === 0;
  const kindName = { knit: '棒針', 'crochet-grid': 'かぎ針・方眼', 'crochet-free': 'かぎ針・円' };
  for (const d of charts) {
    const li = document.createElement('li');
    li.className = 'card';
    const open = document.createElement('button');
    open.className = 'card-open';
    const img = document.createElement('img');
    img.alt = '';
    if (d.thumb) img.src = d.thumb;
    const info = document.createElement('div');
    info.className = 'card-info';
    const name = document.createElement('div');
    name.className = 'card-name';
    name.textContent = d.name;
    const metaLine = document.createElement('div');
    metaLine.className = 'card-meta';
    metaLine.textContent = (kindName[d.kind] || '') + (d.mode === 'grid' ? ` ・ ${d.cols}目×${d.rows}段` : '');
    info.append(name, metaLine);
    open.append(img, info);
    open.onclick = () => Editor.open(d.id);
    li.append(open);
    clist.append(li);
  }
}

/* ---------- 見る画面 ---------- */
let cur = null;        // 開いている作品の meta
let curBlobs = [];
let pageUrl = null;
let adjusting = false;
let saveTimer;
let wakeLock = null;

const st = () => cur.state;

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 400);
}
function saveNow() {
  clearTimeout(saveTimer);
  if (!cur) return Promise.resolve();
  cur.updated = Date.now();
  return putMeta(cur).catch((e) => console.error(e));
}

async function openViewer(id, isNew = false) {
  const metas = await getAllMeta();
  cur = metas.find((m) => m.id === id);
  const p = await getPages(id);
  if (!cur || !p) { toast('編み図が見つかりません'); return; }
  curBlobs = p.blobs;
  if (!cur.counters) cur.counters = [{ name: '目数', n: 0, reset: true }];
  if (!cur.notes) cur.notes = {};
  $('editChartBtn').hidden = !cur.chartId;
  $('notesSheet').hidden = true;
  renderCounters();

  $('home').hidden = true;
  $('viewer').hidden = false;
  $('titleBtn').textContent = cur.name;
  setAdjusting(isNew);
  await showPage(st().page);
  requestWakeLock();
  if (isNew) toast('帯を今の段に合わせて「完了」を押してください');
}

async function closeViewer() {
  setAdjusting(false);
  await saveNow();
  releaseWakeLock();
  cur = null;
  if (pageUrl) URL.revokeObjectURL(pageUrl);
  pageUrl = null;
  srcImg = null;
  $('pageCanvas').width = $('pageCanvas').height = 0;
  $('viewer').hidden = true;
  $('home').hidden = false;
  renderHome();
}

let srcImg = null; // 今のページの元画像

async function showPage(index) {
  st().page = clamp(index, 0, curBlobs.length - 1);
  if (pageUrl) URL.revokeObjectURL(pageUrl);
  pageUrl = URL.createObjectURL(curBlobs[st().page]);
  try {
    srcImg = await loadImage(pageUrl);
  } catch (e) {
    toast('画像を表示できませんでした');
    return;
  }
  drawPage();
  applyZoom();
  render();
  scrollToBand(false);
}

// 元画像を、傾き（回転）をつけてキャンバスに描く
function drawPage() {
  if (!srcImg) return;
  const s = st();
  const rad = (((s.quarter || 0) * 90) + (s.rot || 0)) * Math.PI / 180;
  const w = srcImg.naturalWidth, h = srcImg.naturalHeight;
  const cos = Math.abs(Math.cos(rad)), sin = Math.abs(Math.sin(rad));
  const bw = w * cos + h * sin;   // 回したあとに収まる大きさ
  const bh = w * sin + h * cos;
  const k = Math.min(1, MAX_SIDE / Math.max(bw, bh));
  const c = $('pageCanvas');
  c.width = Math.round(bw * k);
  c.height = Math.round(bh * k);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  g.imageSmoothingQuality = 'high';
  g.translate(c.width / 2, c.height / 2);
  g.rotate(rad);
  g.scale(k, k);
  g.drawImage(srcImg, -w / 2, -h / 2);
}

/* --- 罫線を探して帯をぴったり合わせる ---
   帯の上端・下端の近くで「横方向に長く続く、まわりより暗い線」を探す。
   紙の影などで全体が暗くても見つけられるよう、上下の明るさと比べて判断する。 */
function lineScores(y0, y1) {
  const c = $('pageCanvas');
  const g = c.getContext('2d', { willReadFrequently: true });
  const D = 5; // 上下何ピクセル離れた所と比べるか
  const top = Math.max(0, y0 - D), bottom = Math.min(c.height, y1 + D);
  const h = bottom - top;
  if (h <= 2 * D) return null;
  const data = g.getImageData(0, top, c.width, h).data;
  const W = c.width, stepX = 2, cols = Math.ceil(W / stepX);
  const lum = (row, x) => { const i = (row * W + x) * 4; return data[i] * 0.3 + data[i + 1] * 0.59 + data[i + 2] * 0.11; };
  const scores = [];
  for (let y = Math.max(y0, top + D); y < Math.min(y1, bottom - D); y++) {
    const r = y - top;
    let hits = 0;
    for (let x = 0; x < W; x += stepX) {
      const v = lum(r, x), a = lum(r - D, x), b = lum(r + D, x);
      if (v < (a + b) / 2 - 18 && v < Math.min(a, b) - 6) hits++;
    }
    scores.push({ y, s: hits / cols });
  }
  return scores;
}

function findLine(centerPx, radiusPx) {
  const sc = lineScores(Math.round(centerPx - radiusPx), Math.round(centerPx + radiusPx) + 1);
  if (!sc || !sc.length) return null;
  let best = 0;
  sc.forEach((p, i) => { if (p.s > sc[best].s) best = i; });
  const max = sc[best].s;
  const sorted = sc.map((p) => p.s).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (max < 0.2 || max < median * 2.5 + 0.05) return null; // はっきりした線がない
  // 太い線なら真ん中をとる
  let a = best, b = best;
  while (a > 0 && sc[a - 1].s >= max * 0.7) a--;
  while (b < sc.length - 1 && sc[b + 1].s >= max * 0.7) b++;
  return (sc[a].y + sc[b].y) / 2 + 0.5;
}

function snapBand(radiusFrac, quiet) {
  const H = $('pageCanvas').height;
  if (!H) return false;
  const s = st();
  const hp = s.h * H;
  const r = Math.max(4, hp * radiusFrac);
  const t = findLine(s.y * H, r);
  const b = findLine((s.y + s.h) * H, r);
  if (t === null && b === null) {
    if (!quiet) toast('罫線が見つかりませんでした。ボタンで調整してください');
    return false;
  }
  let nt, nb;
  if (t !== null && b !== null && b - t > hp * 0.6 && b - t < hp * 1.4) {
    nt = t; nb = b;               // 上下とも見つかった
  } else if (t !== null) {
    nt = t; nb = t + hp;          // 上だけ（太さはそのまま）
  } else {
    nb = b; nt = b - hp;          // 下だけ
  }
  s.y = clamp(nt / H, 0, 1);
  s.h = clamp((nb - nt) / H, MIN_BAND, 1 - s.y);
  render();
  scheduleSave();
  if (!quiet) toast('罫線に合わせました');
  return true;
}

function holdRepeat(btn, fn) {
  let t1, t2;
  const stop = () => {
    if (!t1 && !t2) return;
    clearTimeout(t1); clearInterval(t2); t1 = t2 = null;
    scheduleSave();
  };
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    fn();
    t1 = setTimeout(() => { t2 = setInterval(fn, 50); }, 400);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => btn.addEventListener(ev, stop));
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
}

// 傾きスライダーを動かしている間、描き直しを画面の更新に合わせて間引く
let drawQueued = false;
function queueDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; drawPage(); render(); });
}

let guideTimer;
function flashGuides() {
  $('viewer').classList.add('show-guides');
  clearTimeout(guideTimer);
  guideTimer = setTimeout(() => $('viewer').classList.remove('show-guides'), 1500);
}

function setRotation(deg) {
  st().rot = Math.round(clamp(deg, -20, 20) * 10) / 10;
  flashGuides();
  queueDraw();
  scheduleSave();
}

function applyZoom() {
  const w = $('scroller').clientWidth;
  $('stage').style.width = Math.round(w * st().zoom) + 'px';
}

// 指定した点（画面上の位置）を中心に拡大・縮小する
function zoomAt(newZoom, clientX, clientY) {
  const sc = $('scroller'), stage = $('stage');
  const r = sc.getBoundingClientRect();
  const cx = clientX - r.left, cy = clientY - r.top;
  const fx = (sc.scrollLeft + cx - stage.offsetLeft) / stage.offsetWidth;
  const fy = (sc.scrollTop + cy - stage.offsetTop) / stage.offsetHeight;
  st().zoom = clamp(newZoom, 1, MAX_ZOOM);
  applyZoom();
  sc.scrollLeft = fx * stage.offsetWidth + stage.offsetLeft - cx;
  sc.scrollTop = fy * stage.offsetHeight + stage.offsetTop - cy;
}

/* --- 2本指でつまんで拡大（スマホ・iPad） --- */
let pinchEndedAt = 0;
function setupPinch() {
  const sc = $('scroller');
  let pinch = null;
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const mid = (t) => [(t[0].clientX + t[1].clientX) / 2, (t[0].clientY + t[1].clientY) / 2];

  sc.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2 && cur) {
      e.preventDefault();
      pinch = { d0: dist(e.touches), z0: st().zoom };
    }
  }, { passive: false });
  sc.addEventListener('touchmove', (e) => {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    const [x, y] = mid(e.touches);
    zoomAt(pinch.z0 * dist(e.touches) / pinch.d0, x, y);
  }, { passive: false });
  const end = (e) => {
    if (pinch && e.touches.length < 2) {
      pinch = null;
      pinchEndedAt = Date.now();
      scheduleSave();
    }
  };
  sc.addEventListener('touchend', end);
  sc.addEventListener('touchcancel', end);
  // iPhone の Safari で画面全体が拡大されるのを防ぐ
  document.addEventListener('gesturestart', (e) => e.preventDefault());

  // パソコン: Ctrl + ホイール（トラックパッドのピンチも）で拡大
  sc.addEventListener('wheel', (e) => {
    if (!e.ctrlKey || !cur) return;
    e.preventDefault();
    zoomAt(st().zoom * Math.exp(-e.deltaY * 0.003), e.clientX, e.clientY);
    scheduleSave();
  }, { passive: false });
}

function render() {
  const s = st();
  const band = $('band');
  band.style.top = (s.y * 100) + '%';
  band.style.height = (s.h * 100) + '%';

  const showShade = s.dim && !adjusting;
  $('shadeTop').hidden = !showShade;
  $('shadeBottom').hidden = !showShade;
  $('shadeTop').style.height = (s.y * 100) + '%';
  $('shadeBottom').style.top = ((s.y + s.h) * 100) + '%';

  $('rowNum').textContent = s.row;
  $('rowInput').value = s.row;
  $('dimChk').checked = !!s.dim;
  $('rotSlider').value = s.rot || 0;
  $('rotLabel').textContent = (s.rot || 0).toFixed(1) + '°';
  $('snapChk').checked = s.snap !== false;
  document.querySelectorAll('[data-dir]').forEach((b) => b.classList.toggle('on', b.dataset.dir === s.dir));

  const n = curBlobs.length;
  $('pageNav').hidden = n <= 1;
  $('pageLabel').textContent = `${s.page + 1} / ${n}`;
}

// 帯が画面の真ん中あたりに来るようにスクロール
function scrollToBand(smooth = true) {
  const scroller = $('scroller');
  const stageH = $('stage').offsetHeight;
  const bandCenter = (st().y + st().h / 2) * stageH;
  const top = bandCenter - scroller.clientHeight / 2;
  scroller.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' });
}

function stepRow(n) {
  const s = st();
  if (s.row + n < 1) return;
  const dy = (s.dir === 'up' ? -s.h : s.h) * n;
  const ny = s.y + dy;
  if (ny < -0.0001 || ny + s.h > 1.0001) {
    toast('ページの端です。「調整」で帯の位置を合わせてください');
  }
  s.y = clamp(ny, 0, 1 - s.h);
  s.row += n;
  if (n > 0) {
    cur.counters.forEach((c) => { if (c.reset) c.n = 0; });
    renderCounters();
  }
  if (s.snap !== false) snapBand(0.25, true);
  render();
  scrollToBand();
  scheduleSave();
  if (navigator.vibrate) navigator.vibrate(15);
}

function setAdjusting(on) {
  adjusting = on;
  $('viewer').classList.toggle('adjusting', on);
  $('adjustPanel').hidden = !on;
  $('adjustBtn').textContent = on ? '完了' : '調整';
  if (cur) { render(); applyZoom(); }
  if (!on) scheduleSave();
}

/* --- 帯のドラッグ（調整モードのとき） --- */
function setupBandDrag() {
  const band = $('band');
  band.addEventListener('pointerdown', (e) => {
    if (!adjusting) return;
    e.preventDefault();
    e.stopPropagation();
    const mode = e.target.classList.contains('top') ? 'top'
      : e.target.classList.contains('bottom') ? 'bottom' : 'move';
    const H = $('stage').getBoundingClientRect().height;
    const startY = e.clientY;
    const s = st();
    const y0 = s.y, h0 = s.h;
    band.setPointerCapture(e.pointerId);

    const onMove = (ev) => {
      const d = (ev.clientY - startY) / H;
      if (mode === 'move') {
        s.y = clamp(y0 + d, 0, 1 - h0);
      } else if (mode === 'top') {
        const ny = clamp(y0 + d, 0, y0 + h0 - MIN_BAND);
        s.h = h0 + (y0 - ny);
        s.y = ny;
      } else {
        s.h = clamp(h0 + d, MIN_BAND, 1 - y0);
      }
      render();
    };
    const onUp = () => {
      band.removeEventListener('pointermove', onMove);
      band.removeEventListener('pointerup', onUp);
      band.removeEventListener('pointercancel', onUp);
      scheduleSave();
    };
    band.addEventListener('pointermove', onMove);
    band.addEventListener('pointerup', onUp);
    band.addEventListener('pointercancel', onUp);
  });

  // 調整モード中に編み図をタップ → そこへ帯を移動
  let downAt = null;
  $('stage').addEventListener('pointerdown', (e) => {
    downAt = e.isPrimary ? { x: e.clientX, y: e.clientY } : null; // 2本目の指ならタップ扱いしない
  });
  $('stage').addEventListener('pointerup', (e) => {
    if (!adjusting || !downAt) return;
    if (Date.now() - pinchEndedAt < 400) { downAt = null; return; } // ピンチ直後は無視
    const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
    downAt = null;
    if (moved > 8) return; // スクロールしただけ
    const rect = $('stage').getBoundingClientRect();
    const s = st();
    const fy = (e.clientY - rect.top) / rect.height;
    s.y = clamp(fy - s.h / 2, 0, 1 - s.h);
    render();
    scheduleSave();
  });
}

/* --- 画面を消さない（編んでいる間にスリープしないように） --- */
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch (e) { /* 対応していない端末では何もしない */ }
}
function releaseWakeLock() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && cur) requestWakeLock();
  if (document.visibilityState === 'hidden') saveNow();
});

/* ---------- ステップ2：カウンターとメモ ---------- */
function renderCounters() {
  if (!cur) return;
  const cs = cur.counters;
  // 下の操作エリアの小さなカウンター（1つ目）
  $('counterChip').hidden = cs.length === 0;
  if (cs.length) {
    $('chipName').textContent = cs[0].name;
    $('chipNum').textContent = cs[0].n;
  }
  // メモ画面のカウンター一覧
  const list = $('counterList');
  list.innerHTML = '';
  cs.forEach((c, i) => {
    const row = document.createElement('div');
    row.className = 'counter';
    row.innerHTML = `
      <div class="counter-top">
        <input class="c-name" aria-label="カウンターの名前">
        <button class="c-del text-btn" aria-label="このカウンターを削除">削除</button>
      </div>
      <div class="counter-main">
        <button class="c-minus" aria-label="1減らす">－</button>
        <span class="c-num"></span>
        <button class="c-plus" aria-label="1増やす">＋</button>
        <button class="c-zero sub">0に戻す</button>
      </div>
      <label class="check small"><input type="checkbox" class="c-reset"> 段を進めたら0に戻す</label>`;
    row.querySelector('.c-name').value = c.name;
    row.querySelector('.c-num').textContent = c.n;
    row.querySelector('.c-reset').checked = !!c.reset;
    row.querySelector('.c-name').onchange = (e) => { c.name = e.target.value.trim() || 'カウンター'; renderCounters(); scheduleSave(); };
    row.querySelector('.c-minus').onclick = () => { if (c.n > 0) c.n--; renderCounters(); scheduleSave(); };
    row.querySelector('.c-plus').onclick = () => { c.n++; renderCounters(); scheduleSave(); if (navigator.vibrate) navigator.vibrate(10); };
    row.querySelector('.c-zero').onclick = () => { c.n = 0; renderCounters(); scheduleSave(); };
    row.querySelector('.c-reset').onchange = (e) => { c.reset = e.target.checked; scheduleSave(); };
    row.querySelector('.c-del').onclick = () => {
      if (!confirm(`カウンター「${c.name}」を削除しますか？`)) return;
      cs.splice(i, 1); renderCounters(); scheduleSave();
    };
    list.append(row);
  });
}

function openNotes() {
  const n = cur.notes;
  $('noteNeedle').value = n.needle || '';
  $('noteYarn').value = n.yarn || '';
  $('noteGauge').value = n.gauge || '';
  $('noteText').value = n.text || '';
  renderCounters();
  $('notesSheet').hidden = false;
}

function setupNotes() {
  $('notesBtn').onclick = openNotes;
  $('notesClose').onclick = () => { $('notesSheet').hidden = true; saveNow(); };
  $('counterChip').onclick = () => {
    const c = cur.counters[0];
    if (!c) return;
    c.n++;
    renderCounters();
    scheduleSave();
    if (navigator.vibrate) navigator.vibrate(10);
  };
  $('addCounter').onclick = () => {
    cur.counters.push({ name: cur.counters.length ? '模様の回数' : '目数', n: 0, reset: false });
    renderCounters();
    scheduleSave();
  };
  const bind = (id, key) => $(id).addEventListener('input', (e) => { cur.notes[key] = e.target.value; scheduleSave(); });
  bind('noteNeedle', 'needle');
  bind('noteYarn', 'yarn');
  bind('noteGauge', 'gauge');
  bind('noteText', 'text');

  $('editChartBtn').onclick = async () => {
    const chartId = cur.chartId;
    await closeViewer();
    Editor.open(chartId);
  };
}

/* ---------- ボタンなどのつなぎこみ ---------- */
function setup() {
  Editor.init();
  setupNotes();
  $('newChartBtn').onclick = () => Editor.newChartDialog();

  $('fileInput').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) importFile(f);
  });

  $('backBtn').onclick = closeViewer;
  $('adjustBtn').onclick = () => setAdjusting(!adjusting);
  $('doneBtn').onclick = () => setAdjusting(false);
  $('nextRow').onclick = () => stepRow(1);
  $('prevRow').onclick = () => stepRow(-1);

  $('titleBtn').onclick = () => {
    const name = prompt('名前を変更', cur.name);
    if (name && name.trim()) {
      cur.name = name.trim();
      $('titleBtn').textContent = cur.name;
      scheduleSave();
    }
  };

  document.querySelectorAll('[data-dir]').forEach((b) => {
    b.onclick = () => { st().dir = b.dataset.dir; render(); scheduleSave(); };
  });
  $('snapChk').addEventListener('change', (e) => { st().snap = e.target.checked; scheduleSave(); });

  // 調整パネルのタブ
  document.querySelectorAll('[data-tab]').forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('on', x === b));
      document.querySelectorAll('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== b.dataset.tab; });
      if (b.dataset.tab === 'rot') flashGuides();
    };
  });

  // 帯の微調整ボタン（押し続けると連続で動く）
  const nudges = {
    up:    (s, px) => { s.y = clamp(s.y - px, 0, 1 - s.h); },
    down:  (s, px) => { s.y = clamp(s.y + px, 0, 1 - s.h); },
    thin:  (s, px) => { if (s.h - px >= MIN_BAND) { s.h -= px; s.y += px / 2; } },
    thick: (s, px) => { s.h = Math.min(1, s.h + px); s.y = clamp(s.y - px / 2, 0, 1 - s.h); },
  };
  document.querySelectorAll('[data-nudge]').forEach((btn) => {
    const fn = nudges[btn.dataset.nudge];
    const once = () => {
      const px = 1 / $('stage').offsetHeight; // 画面上の 1 ピクセルぶん
      fn(st(), px);
      render();
    };
    holdRepeat(btn, once);
  });

  $('snapBtn').onclick = () => snapBand(0.35, false);

  $('multiBtn').onclick = () => {
    const v = prompt('いま帯で囲んでいる範囲は何段分ですか？\n\n例：10段分を帯で囲んでから「10」と入力すると、1段の高さを正確に計算します。', '10');
    const n = parseInt(v, 10);
    if (!(n >= 2)) return;
    const s = st();
    const nh = s.h / n;
    // 囲んだ範囲のうち、これから編む最初の段に帯を置く
    if (s.dir === 'up') s.y = s.y + s.h - nh;
    s.h = nh;
    render();
    scheduleSave();
    toast(`${n}段分から1段の高さを決めました`);
  };
  $('rowInput').addEventListener('change', (e) => {
    const v = parseInt(e.target.value, 10);
    if (v >= 1) { st().row = v; render(); scheduleSave(); }
  });
  $('dimChk').addEventListener('change', (e) => { st().dim = e.target.checked; render(); scheduleSave(); });

  // 傾き
  $('rotSlider').addEventListener('input', (e) => setRotation(parseFloat(e.target.value)));
  $('rotMinus').onclick = () => setRotation((st().rot || 0) - 0.2);
  $('rotPlus').onclick = () => setRotation((st().rot || 0) + 0.2);
  $('rotReset').onclick = () => setRotation(0);
  $('rot90').onclick = () => {
    st().quarter = ((st().quarter || 0) + 1) % 4;
    drawPage();
    render();
    scrollToBand(false);
    scheduleSave();
  };

  const zoomBy = (f) => {
    const s = st();
    s.zoom = clamp(f === 0 ? 1 : s.zoom * f, 1, MAX_ZOOM);
    applyZoom();
    scrollToBand(false);
    scheduleSave();
  };
  $('zoomIn').onclick = () => zoomBy(1.25);
  $('zoomOut').onclick = () => zoomBy(0.8);
  $('zoomFit').onclick = () => zoomBy(0);

  $('prevPage').onclick = () => { showPage(st().page - 1); scheduleSave(); };
  $('nextPage').onclick = () => { showPage(st().page + 1); scheduleSave(); };

  window.addEventListener('resize', () => { if (cur) applyZoom(); });

  // パソコンで試すとき用のキー操作
  document.addEventListener('keydown', (e) => {
    if (!cur || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || !$('notesSheet').hidden) return;
    if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); stepRow(1); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); stepRow(-1); }
  });

  setupBandDrag();
  setupPinch();
  renderHome();

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // 保存した編み図をブラウザが勝手に消さないようにお願いする
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  // iPhone / iPad の Safari で開いているときは「ホーム画面に追加」を案内
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  let tipClosed = false;
  try { tipClosed = localStorage.getItem('installTipClosed') === '1'; } catch (e) { /* 何もしない */ }
  if (isIOS && !standalone && !tipClosed) $('installTip').hidden = false;
  $('installTipClose').onclick = () => {
    $('installTip').hidden = true;
    try { localStorage.setItem('installTipClosed', '1'); } catch (e) { /* 何もしない */ }
  };
}

setup();
