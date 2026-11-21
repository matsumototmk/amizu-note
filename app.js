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
      const req = indexedDB.open('amizu-note', 3);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('pages')) db.createObjectStore('pages', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('charts')) db.createObjectStore('charts', { keyPath: 'id' }); // 描いた編み図
        if (!db.objectStoreNames.contains('groups')) db.createObjectStore('groups', { keyPath: 'id' }); // 作品ごとのグループ
        if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes', { keyPath: 'id' });   // 手書きメモ
      };
      req.onsuccess = () => {
        const db = req.result;
        // 新しい版のアプリが開かれたら、古い画面は接続を閉じて道をあける
        db.onversionchange = () => { db.close(); dbPromise = null; toast('アプリが新しくなりました。画面を読み込み直してください'); };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => toast('ほかのタブや画面で「あみ図ノート」が開いています。閉じてから読み込み直してください');
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
const deletePattern = (id) => dbRun(['meta', 'pages', 'notes'], 'readwrite', (t) => {
  t.objectStore('meta').delete(id);
  t.objectStore('pages').delete(id);
  t.objectStore('notes').delete('p:' + id);
});
// 手書きメモ（id は 'g:グループid' か 'p:編み図id'）
const getNote = (id) => dbRun('notes', 'readonly', (t) => t.objectStore('notes').get(id));
const putNote = (n) => dbRun('notes', 'readwrite', (t) => { t.objectStore('notes').put(n); });
const getAllCharts = () => dbRun('charts', 'readonly', (t) => t.objectStore('charts').getAll());
const getChart = (id) => dbRun('charts', 'readonly', (t) => t.objectStore('charts').get(id));
const putChart = (d) => dbRun('charts', 'readwrite', (t) => { t.objectStore('charts').put(d); });
const deleteChart = (id) => dbRun('charts', 'readwrite', (t) => { t.objectStore('charts').delete(id); });

const getAllGroups = () => dbRun('groups', 'readonly', (t) => t.objectStore('groups').getAll());
const putGroup = (g) => dbRun('groups', 'readwrite', (t) => { t.objectStore('groups').put(g); });
// グループを消す。中の編み図は消さずに、グループの外へ出す
const deleteGroup = (id, metas) => dbRun(['groups', 'meta', 'notes'], 'readwrite', (t) => {
  t.objectStore('groups').delete(id);
  t.objectStore('notes').delete('g:' + id);
  metas.filter((m) => m.group === id).forEach((m) => { delete m.group; t.objectStore('meta').put(m); });
});

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

// 1つのファイルを取り込む（created をずらして渡すと、選んだ順に並ぶ）
async function importOne(file, group, created) {
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  const blobs = isPdf ? await pdfToImages(file) : [await shrinkPhoto(file)];
  if (!blobs.length) throw new Error('ページが見つかりませんでした。');
  const meta = {
    id: newId(),
    name: file.name.replace(/\.[^.]+$/, '') || '編み図',
    created: created || Date.now(),
    pageCount: blobs.length,
    state: { page: 0, row: 1, y: 0.85, h: 0.04, dir: 'up', zoom: 1, dim: true },
  };
  if (group) meta.group = group;
  await addPattern(meta, blobs);
  return meta;
}

async function importFiles(files) {
  if (!files.length) return;
  let group = curGroup;
  try {
    // 何枚かまとめて選んだときは、新しいプロジェクトにまとめる
    if (files.length > 1 && !group) {
      const name = prompt(`${files.length}枚の編み図を1つのプロジェクトにまとめます。\nプロジェクトの名前（作品名）を入れてください。`, '新しいプロジェクト');
      if (name === null) return;
      const g = newProject(name);
      await putGroup(g);
      group = g.id;
    }
    const t0 = Date.now();
    let last = null;
    for (let i = 0; i < files.length; i++) {
      busy(files.length > 1 ? `読み込み中… ${i + 1} / ${files.length}` : '読み込み中…');
      last = await importOne(files[i], group, t0 + i);
    }
    busy(null);
    if (files.length === 1) {
      await openViewer(last.id, true);
    } else {
      curGroup = group;
      await renderHome();
      toast(`${files.length}枚を取り込みました。1枚ずつ開いて帯を合わせてください`);
    }
  } catch (err) {
    busy(null);
    console.error(err);
    alert('取り込みに失敗しました。\n' + (err.message || err));
    renderHome();
  }
}

/* ---------- 小さな画面（メニューなど） ---------- */
function sheet(html, ready) {
  $('modalBox').innerHTML = html;
  $('modal').hidden = false;
  if (ready) ready($('modalBox'));
}
function closeSheet() { $('modal').hidden = true; $('modalBox').innerHTML = ''; }
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- プロジェクト ----------
   作品ごとの入れ物。保存場所は前の版の「グループ」と同じ（groups）。
   { id, name, created, updated, status: 'todo'着手前 | 'doing'制作中 | 'done'完成,
     start: 編み始めた日 'yyyy-mm-dd', done: 完成した日, cover: 表紙の写真id,
     photos: [ { id, created, ink: [書き込み] } ],
     memo: { yarn 糸, amount 使った糸の量, needle 針, gauge ゲージ, text メモ } }
   写真の画像は pages に 'ph:写真id' で入れる（[大きい画像, 小さな絵]）。 */
const STATUS = { todo: '着手前', doing: '制作中', done: '完成' };
const statusOf = (g) => g.status || 'doing'; // 前の版で作ったグループは「制作中」として扱う
const p2 = (n) => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };
const fmtDate = (s) => (s ? s.replace(/^(\d+)-0?(\d+)-0?(\d+)$/, '$1/$2/$3') : '');

function newProject(name) {
  return { id: newId(), name: (name || '').trim() || '新しいプロジェクト', created: Date.now(), status: 'todo', photos: [] };
}

// かかった日数（編み始めた日から、完成した日 or 今日まで。両方の日を数える）
function projDays(g) {
  if (!g.start) return null;
  const end = statusOf(g) === 'done' && g.done ? g.done : today();
  const n = Math.round((Date.parse(end) - Date.parse(g.start)) / 86400000) + 1;
  return n > 0 ? n : null;
}

// 写真
const photoKey = (id) => 'ph:' + id;
const putPhotoBlobs = (id, blobs) => dbRun('pages', 'readwrite', (t) => { t.objectStore('pages').put({ id: photoKey(id), blobs }); });
async function getPhotoBlob(id, small) {
  const p = await getPages(photoKey(id));
  if (!p) return null;
  return small ? p.blobs[1] || p.blobs[0] : p.blobs[0];
}
const deletePhotoBlob = (id) => dbRun('pages', 'readwrite', (t) => { t.objectStore('pages').delete(photoKey(id)); });

// 一覧用の小さな絵（長い辺 480px）
async function makeSmall(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const k = Math.min(1, 480 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k);
    c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const b = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
    c.width = c.height = 0;
    return b || blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// プロジェクトを消す。編み図は消さずに外へ出す。写真と手書きメモは消える
async function deleteProject(g) {
  const [metas, charts] = await Promise.all([getAllMeta(), getAllCharts()]);
  await dbRun(['groups', 'meta', 'charts', 'notes', 'pages'], 'readwrite', (t) => {
    t.objectStore('groups').delete(g.id);
    t.objectStore('notes').delete('g:' + g.id);
    (g.photos || []).forEach((ph) => t.objectStore('pages').delete(photoKey(ph.id)));
    metas.filter((m) => m.group === g.id).forEach((m) => { delete m.group; t.objectStore('meta').put(m); });
    charts.filter((d) => d.group === g.id).forEach((d) => { delete d.group; t.objectStore('charts').put(d); });
  });
}

// 着手前のプロジェクトで編み始めたら、自動で「制作中」に
async function autoStart(gid) {
  const g = (await getAllGroups()).find((x) => x.id === gid);
  if (!g || g.status !== 'todo') return;
  g.status = 'doing';
  if (!g.start) g.start = today();
  g.updated = Date.now();
  await putGroup(g);
  toast(`「${g.name}」を制作中にしました`);
}

/* ---------- 一覧画面 ---------- */
let listUrls = [];
let curGroup = null;   // 開いているプロジェクト（null = すべて）
let curProj = null;    // 開いているプロジェクトのデータ
let projFilter = 'all';
try { projFilter = localStorage.getItem('projFilter') || 'all'; } catch (e) { /* 何もしない */ }

function showBlob(blobPromise, img) {
  Promise.resolve(blobPromise).then((b) => {
    if (!b) return;
    const url = URL.createObjectURL(b);
    listUrls.push(url);
    img.src = url;
  });
}
function thumbOf(id, img) {
  showBlob(getPages(id).then((p) => p && p.blobs[0]), img);
}

// 表紙：選んだ写真 → 最初の写真 → 最初の編み図 → 描いた編み図
function setCover(g, items, charts, img, holder) {
  const photos = g.photos || [];
  const ph = photos.find((p) => p.id === g.cover) || photos[0];
  if (ph) { showBlob(getPhotoBlob(ph.id, true), img); return; }
  if (items[0]) { thumbOf(items[0].id, img); return; }
  const c = charts.find((d) => d.thumb);
  if (c) { img.src = c.thumb; return; }
  holder.classList.add('no-cover');
}

function cardBase(name, sub, onOpen, onMore) {
  const li = document.createElement('li');
  li.className = 'card';
  const open = document.createElement('button');
  open.className = 'card-open';
  const img = document.createElement('img');
  img.alt = '';
  const info = document.createElement('div');
  info.className = 'card-info';
  const nm = document.createElement('div');
  nm.className = 'card-name';
  nm.textContent = name;
  const metaLine = document.createElement('div');
  metaLine.className = 'card-meta';
  metaLine.textContent = sub;
  info.append(nm, metaLine);
  open.append(img, info);
  open.onclick = onOpen;
  const more = document.createElement('button');
  more.className = 'card-more';
  more.textContent = '⋯';
  more.setAttribute('aria-label', 'メニュー');
  more.onclick = onMore;
  li.append(open, more);
  return { li, img };
}

function patternCard(m) {
  const { li, img } = cardBase(m.name, `${m.state.row} 段目` + (m.pageCount > 1 ? ` ・ ${m.pageCount} ページ` : ''),
    () => openViewer(m.id), () => itemMenu('pattern', m));
  thumbOf(m.id, img);
  return li;
}

const KIND_NAME = { knit: '棒針', 'crochet-grid': 'かぎ針・方眼', 'crochet-free': 'かぎ針・円' };
function chartCard(d) {
  const { li, img } = cardBase(d.name, '✎ 描いた編み図 ・ ' + (KIND_NAME[d.kind] || '') + (d.mode === 'grid' ? ` ・ ${d.cols}目×${d.rows}段` : ''),
    () => Editor.open(d.id), () => itemMenu('chart', d));
  if (d.thumb) img.src = d.thumb;
  return li;
}

function projectCard(g, items, charts) {
  const st = statusOf(g);
  const li = document.createElement('li');
  li.className = 'proj-card st-' + st;
  const btn = document.createElement('button');
  btn.className = 'proj-open';
  btn.innerHTML = `<div class="proj-thumb"><img alt=""><span class="proj-badge">${STATUS[st]}</span></div>
    <div class="proj-body"><div class="proj-name"></div><div class="proj-sub"></div></div>`;
  btn.querySelector('.proj-name').textContent = g.name;
  const parts = [];
  const n = projDays(g);
  if (n && st === 'done') parts.push(`${n}日で完成`);
  else if (n && st === 'doing') parts.push(`${n}日目`);
  parts.push(`編み図 ${items.length + charts.length}`);
  if ((g.photos || []).length) parts.push(`写真 ${g.photos.length}`);
  btn.querySelector('.proj-sub').textContent = parts.join(' ・ ');
  setCover(g, items, charts, btn.querySelector('img'), btn.querySelector('.proj-thumb'));
  btn.onclick = () => { curGroup = g.id; renderHome(); window.scrollTo(0, 0); };
  li.append(btn);
  return li;
}

// 編み図をプロジェクトに入れる・出す（描いた編み図と、そこから作った「編む」用の編み図は一緒に動かす）
async function setProject(kind, item, gid) {
  const apply = (x) => { if (gid) x.group = gid; else delete x.group; };
  apply(item);
  if (kind === 'pattern') {
    await putMeta(item);
    if (item.chartId) { const d = await getChart(item.chartId); if (d) { apply(d); await putChart(d); } }
  } else {
    await putChart(item);
    if (item.patternId) { const m = (await getAllMeta()).find((x) => x.id === item.patternId); if (m) { apply(m); await putMeta(m); } }
  }
}

// 編み図の「⋯」メニュー
async function itemMenu(kind, item) {
  const groups = await getAllGroups();
  const g = groups.find((x) => x.id === item.group);
  sheet(`
    <h2>${esc(item.name)}</h2>
    <div class="menu-list">
      ${kind === 'pattern' ? '<button data-act="rename">名前を変える</button>' : '<button data-act="open">開いて描き直す</button>'}
      <button data-act="move">${g ? 'ほかのプロジェクトへ移す' : 'プロジェクトに入れる'}</button>
      ${g ? '<button data-act="out">プロジェクトから出す</button>' : ''}
      ${kind === 'pattern' ? '<button data-act="del" class="danger">削除</button>' : ''}
    </div>
    <div class="modal-actions"><button class="sub" data-act="close">閉じる</button></div>
  `, (box) => {
    box.onclick = async (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      if (act === 'close') closeSheet();
      if (act === 'open') { closeSheet(); Editor.open(item.id); }
      if (act === 'rename') {
        const name = prompt('名前を変更', item.name);
        if (name && name.trim()) { item.name = name.trim(); await putMeta(item); }
        closeSheet(); renderHome();
      }
      if (act === 'move') chooseProject(kind, item, groups);
      if (act === 'out') { await setProject(kind, item, null); closeSheet(); renderHome(); toast('プロジェクトから出しました'); }
      if (act === 'del') {
        if (!confirm(`「${item.name}」を削除しますか？\n（帯の位置や書き込みも消えます）`)) return;
        await deletePattern(item.id);
        closeSheet(); renderHome();
      }
    };
  });
}

// どのプロジェクトに入れるか選ぶ
function chooseProject(kind, item, groups) {
  const order = { doing: 0, todo: 1, done: 2 };
  groups.sort((a, b) => (order[statusOf(a)] - order[statusOf(b)]) || b.created - a.created);
  sheet(`
    <h2>どのプロジェクトに入れますか？</h2>
    <div class="menu-list">
      ${groups.map((g) => `<button data-gid="${g.id}" class="${g.id === item.group ? 'on' : ''}">${esc(g.name)}　<small>${STATUS[statusOf(g)]}</small></button>`).join('')}
      <button data-gid="new">＋ 新しいプロジェクトを作って入れる</button>
    </div>
    <div class="modal-actions"><button class="sub" data-gid="cancel">やめる</button></div>
  `, (box) => {
    box.onclick = async (e) => {
      const b = e.target.closest('[data-gid]');
      if (!b) return;
      let gid = b.dataset.gid;
      if (gid === 'cancel') { closeSheet(); return; }
      if (gid === 'new') {
        const name = prompt('プロジェクトの名前（作品名）', '新しいプロジェクト');
        if (!name || !name.trim()) return;
        const g = newProject(name);
        await putGroup(g);
        gid = g.id;
      }
      await setProject(kind, item, gid);
      closeSheet();
      renderHome();
      const g = (await getAllGroups()).find((x) => x.id === gid);
      toast(`「${g ? g.name : ''}」に入れました`);
    };
  });
}

async function newGroup() {
  const name = prompt('プロジェクトの名前（作品名）\n例：アランのセーター', '新しいプロジェクト');
  if (!name || !name.trim()) return;
  const g = newProject(name);
  await putGroup(g);
  curGroup = g.id;
  await renderHome();
  window.scrollTo(0, 0);
  toast('プロジェクトを作りました。写真や編み図を入れましょう');
}

async function groupMenu() {
  const g = curProj;
  if (!g) return;
  sheet(`
    <h2>${esc(g.name)}</h2>
    <div class="menu-list">
      <button data-act="rename">名前を変える</button>
      <button data-act="del" class="danger">プロジェクトを削除</button>
    </div>
    <div class="modal-actions"><button class="sub" data-act="close">閉じる</button></div>
  `, (box) => {
    box.onclick = async (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      if (act === 'close') closeSheet();
      if (act === 'rename') {
        const name = prompt('プロジェクトの名前', g.name);
        if (name && name.trim()) { g.name = name.trim(); g.updated = Date.now(); await putGroup(g); }
        closeSheet(); renderHome();
      }
      if (act === 'del') {
        if (!confirm(`プロジェクト「${g.name}」を削除しますか？\n\n・写真と手書きメモは消えます（元に戻せません）\n・編み図は消えずに、プロジェクトの外に出ます`)) return;
        await deleteProject(g);
        curGroup = null;
        closeSheet(); renderHome();
      }
    };
  });
}

/* ---------- プロジェクトのページ ---------- */
let projSaveTimer;
function saveProj() {
  if (!curProj) return;
  curProj.updated = Date.now();
  const g = curProj;
  clearTimeout(projSaveTimer);
  projSaveTimer = setTimeout(() => putGroup(g).catch((e) => console.error(e)), 400);
}

function renderProjStatus() {
  const g = curProj;
  const st = statusOf(g);
  document.querySelectorAll('[data-status]').forEach((b) => b.classList.toggle('on', b.dataset.status === st));
  $('projView').className = 'st-' + st;
  $('projStart').value = g.start || '';
  $('projDone').value = g.done || '';
  $('projDoneRow').hidden = st !== 'done';
  const n = projDays(g);
  $('projDays').textContent = !n ? (st === 'todo' ? 'まだ編み始めていません' : '')
    : st === 'done' ? `かかった日数：${n}日（${fmtDate(g.start)}〜${fmtDate(g.done)}）`
      : st === 'doing' ? `編み始めて ${n}日目` : '';
}

function renderPhotos() {
  const g = curProj;
  const grid = $('photoGrid');
  grid.innerHTML = '';
  (g.photos || []).forEach((ph, i) => {
    const b = document.createElement('button');
    b.className = 'photo-thumb' + (g.cover === ph.id ? ' cover' : '');
    const img = document.createElement('img');
    img.alt = '';
    b.append(img);
    if (ph.ink && ph.ink.length) { const s = document.createElement('span'); s.className = 'ph-ink'; s.textContent = '✎'; b.append(s); }
    if (g.cover === ph.id) { const s = document.createElement('span'); s.className = 'ph-cover'; s.textContent = '表紙'; b.append(s); }
    showBlob(getPhotoBlob(ph.id, true), img);
    b.onclick = () => PhotoView.open(g, i);
    grid.append(b);
  });
  $('photoEmpty').hidden = (g.photos || []).length > 0;
}

function renderProject(g, allMetas, charts) {
  curProj = g;
  if (!g.photos) g.photos = [];
  if (!g.memo) g.memo = {};
  $('groupName').textContent = g.name;
  const items = allMetas.filter((m) => m.group === g.id).sort((a, b) => a.created - b.created);
  const metaIds = new Set(allMetas.map((m) => m.id));
  const pch = charts.filter((d) => d.group === g.id && !(d.patternId && metaIds.has(d.patternId)))
    .sort((a, b) => a.created - b.created);

  const cov = $('projCover');
  cov.innerHTML = '<img alt="">';
  cov.classList.remove('no-cover');
  setCover(g, items, pch, cov.querySelector('img'), cov);
  renderProjStatus();
  renderPhotos();

  const list = $('projCharts');
  list.innerHTML = '';
  items.forEach((m) => list.append(patternCard(m)));
  pch.forEach((d) => list.append(chartCard(d)));
  $('projChartsEmpty').hidden = items.length + pch.length > 0;

  const memo = g.memo;
  $('pjYarn').value = memo.yarn || '';
  $('pjAmount').value = memo.amount || '';
  $('pjNeedle').value = memo.needle || '';
  $('pjGauge').value = memo.gauge || '';
  $('pjText').value = memo.text || '';
}

async function addPhotos(files) {
  const g = curProj;
  if (!g || !files.length) return;
  try {
    for (let i = 0; i < files.length; i++) {
      busy(files.length > 1 ? `写真を入れています… ${i + 1} / ${files.length}` : '写真を入れています…');
      const big = await shrinkPhoto(files[i]);
      const small = await makeSmall(big);
      const id = newId();
      await putPhotoBlobs(id, [big, small]);
      g.photos.push({ id, created: Date.now() + i });
    }
    g.updated = Date.now();
    await putGroup(g);
    busy(null);
    renderHome();
  } catch (err) {
    busy(null);
    console.error(err);
    alert('写真を入れられませんでした。\n' + (err.message || err));
  }
}

function setupProjects() {
  $('newGroupBtn').onclick = newGroup;
  $('groupBack').onclick = () => { curGroup = null; renderHome(); };
  $('groupMenu').onclick = groupMenu;
  document.querySelectorAll('[data-filter]').forEach((b) => {
    b.onclick = () => {
      projFilter = b.dataset.filter;
      try { localStorage.setItem('projFilter', projFilter); } catch (e) { /* 何もしない */ }
      renderHome();
    };
  });
  document.querySelectorAll('[data-status]').forEach((b) => {
    b.onclick = () => {
      const g = curProj;
      const st = b.dataset.status;
      g.status = st;
      if (st !== 'todo' && !g.start) g.start = today();
      if (st === 'done' && !g.done) g.done = today();
      saveProj();
      renderProjStatus();
      if (st === 'done') toast('完成おめでとうございます！ 完成写真を入れておきましょう');
    };
  });
  $('projStart').addEventListener('change', (e) => { curProj.start = e.target.value || undefined; saveProj(); renderProjStatus(); });
  $('projDone').addEventListener('change', (e) => { curProj.done = e.target.value || undefined; saveProj(); renderProjStatus(); });
  const bindMemo = (id, key) => $(id).addEventListener('input', (e) => { curProj.memo[key] = e.target.value; saveProj(); });
  bindMemo('pjYarn', 'yarn');
  bindMemo('pjAmount', 'amount');
  bindMemo('pjNeedle', 'needle');
  bindMemo('pjGauge', 'gauge');
  bindMemo('pjText', 'text');
  $('photoInput').addEventListener('change', (e) => { const fs = [...e.target.files]; e.target.value = ''; addPhotos(fs); });
  $('projFile').addEventListener('change', (e) => { const fs = [...e.target.files]; e.target.value = ''; importFiles(fs); });
  $('projDraw').onclick = () => Editor.newChartDialog(curGroup);
}

async function renderHome() {
  listUrls.forEach(URL.revokeObjectURL);
  listUrls = [];
  const [allMetas, groups, charts] = await Promise.all([getAllMeta(), getAllGroups(), getAllCharts()]);
  const group = groups.find((g) => g.id === curGroup);
  if (!group) { curGroup = null; curProj = null; }
  $('rootView').hidden = !!group;
  $('projView').hidden = !group;
  if (group) { renderProject(group, allMetas, charts); return; }

  // プロジェクトのカード（制作中 → 着手前 → 完成、その中は最近さわった順）
  const time = (x) => x.updated || x.created;
  const metaIds = new Set(allMetas.map((m) => m.id));
  const itemsOf = (g) => allMetas.filter((m) => m.group === g.id);
  const chartsOf = (g) => charts.filter((d) => d.group === g.id && !(d.patternId && metaIds.has(d.patternId)));
  const lastUsed = (g) => Math.max(time(g), ...itemsOf(g).map(time));
  const order = { doing: 0, todo: 1, done: 2 };
  const shown = groups.filter((g) => projFilter === 'all' || statusOf(g) === projFilter)
    .sort((a, b) => (order[statusOf(a)] - order[statusOf(b)]) || (lastUsed(b) - lastUsed(a)));
  const grid = $('projGrid');
  grid.innerHTML = '';
  shown.forEach((g) => grid.append(projectCard(g, itemsOf(g), chartsOf(g))));
  const label = { all: 'すべて', todo: '着手前', doing: '制作中', done: '完成' };
  document.querySelectorAll('[data-filter]').forEach((b) => {
    const f = b.dataset.filter;
    const n = f === 'all' ? groups.length : groups.filter((g) => statusOf(g) === f).length;
    b.textContent = `${label[f]} ${n}`;
    b.classList.toggle('on', f === projFilter);
  });
  $('projEmpty').hidden = shown.length > 0;
  $('projEmpty').innerHTML = groups.length
    ? `「${label[projFilter]}」のプロジェクトはありません。`
    : 'まだプロジェクトがありません。<br>「＋ 新しいプロジェクト」から作りましょう。';

  // プロジェクトに入っていない編み図
  const known = new Set(groups.map((g) => g.id));
  const loose = allMetas.filter((m) => !m.group || !known.has(m.group)).sort((a, b) => time(b) - time(a));
  const list = $('patternList');
  list.innerHTML = '';
  loose.forEach((m) => list.append(patternCard(m)));
  $('looseSection').hidden = loose.length === 0;

  // 描いた編み図（プロジェクトに入っていないもの）
  const looseCharts = charts.filter((d) => !d.group || !known.has(d.group)).sort((a, b) => time(b) - time(a));
  const clist = $('chartList');
  clist.innerHTML = '';
  looseCharts.forEach((d) => clist.append(chartCard(d)));
  $('chartSection').hidden = looseCharts.length === 0;
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
  inkUndo = [];
  setInking(false);
  cropping = false;
  $('viewer').classList.remove('cropping');
  $('cropPanel').hidden = true;
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
  setInking(false);
  if (cropping) { cropping = false; $('viewer').classList.remove('cropping'); $('cropPanel').hidden = true; }
  await saveNow();
  releaseWakeLock();
  cur = null;
  if (pageUrl) URL.revokeObjectURL(pageUrl);
  pageUrl = null;
  srcImg = null;
  pageXf = null;
  $('pageCanvas').width = $('pageCanvas').height = 0;
  $('inkCanvas').width = $('inkCanvas').height = 0;
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
  // トリミング（切り取り）：回したあとのページの中で、見せる範囲（0〜1の割合）
  const crop = cropping ? FULL : pageCrop(s);
  const k = Math.min(1, MAX_SIDE / Math.max(bw * crop.w, bh * crop.h)); // 切り取ったぶん、細かく描ける
  const fw = bw * k, fh = bh * k;           // ページ全体の大きさ（キャンバスの単位）
  const ox = crop.x * fw, oy = crop.y * fh; // 見せる範囲の左上
  const c = $('pageCanvas');
  c.width = Math.max(1, Math.round(fw * crop.w));
  c.height = Math.max(1, Math.round(fh * crop.h));
  pageXf = { rad, k, w, h, cw: c.width, ch: c.height, fw, fh, ox, oy };
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  g.imageSmoothingQuality = 'high';
  g.translate(fw / 2 - ox, fh / 2 - oy);
  g.rotate(rad);
  g.scale(k, k);
  g.drawImage(srcImg, -w / 2, -h / 2);
  drawInk();
}

/* ---------- トリミング（切り取り） ----------
   元の画像はそのまま残し、「見せる範囲」だけを覚える（あとで全体に戻せる）。
   s.crops = { ページ番号: { x, y, w, h } }  … 傾きを直したあとのページ全体に対する割合 */
const FULL = { x: 0, y: 0, w: 1, h: 1 };
let cropping = false;
let cropBox = null;     // トリミング中の囲み（ページ全体に対する割合）
const pageCrop = (s) => (s.crops && s.crops[s.page]) || FULL;

// 見せる範囲が変わったので、帯の位置などを「同じ編み図の場所」を指すように付けかえる
function remapBand(o, n) {
  const mx = (x) => (o.x + x * o.w - n.x) / n.w;   // 古い見え方の横位置 → 新しい見え方
  const my = (y) => (o.y + y * o.h - n.y) / n.h;
  const sw = o.w / n.w, sh = o.h / n.h;
  const fix = (p) => {
    if (p.y !== undefined) p.y = my(p.y);
    if (p.h !== undefined) p.h *= sh;
    const ax = p.a !== undefined ? 'a' : 'ax';
    if (p[ax] !== undefined) p[ax] = mx(p[ax]);
    const bd = p.b !== undefined ? 'b' : 'bend';
    if (p[bd]) p[bd] *= (o.h * n.w) / (o.w * n.h); // 腕の傾き（画面上の角度）を変えない
    if (p.cx !== undefined) { p.cx = mx(p.cx); p.cy = my(p.cy); p.rr *= sw; p.rt *= sw; }
  };
  const s = st();
  if (s.ax === undefined) s.ax = 0.5;
  fix(s);
  Object.values(s.rowPos || {}).forEach((p) => { if (p.p === s.page) fix(p); });
}

function setCropping(on) {
  const s = st();
  if (on) {
    if (adjusting) setAdjusting(false);
    if (inking) setInking(false);
    cropBox = Object.assign({}, pageCrop(s));
    if (cropBox.w === 1 && cropBox.h === 1) cropBox = { x: 0.05, y: 0.05, w: 0.9, h: 0.9 };
  }
  cropping = on;
  $('viewer').classList.toggle('cropping', on);
  $('cropPanel').hidden = !on;
  drawPage();
  applyZoom();
  render();
  renderCrop();
  if (!on) scrollToBand(false);
}

function renderCrop() {
  const b = $('cropBox');
  if (!cropping || !cropBox) return;
  b.style.left = (cropBox.x * 100) + '%';
  b.style.top = (cropBox.y * 100) + '%';
  b.style.width = (cropBox.w * 100) + '%';
  b.style.height = (cropBox.h * 100) + '%';
}

async function applyCrop(next) {
  const s = st();
  const old = pageCrop(s);
  remapBand(old, next);
  if (!s.crops) s.crops = {};
  if (next === FULL) delete s.crops[s.page]; else s.crops[s.page] = next;
  // 一覧の小さな絵は1ページ目の画像のまま（元の画像は消さない）
  await setCropping(false);
  scheduleSave();
}

function setupCrop() {
  $('cropBtn').onclick = () => setCropping(true);
  $('cropCancel').onclick = () => setCropping(false);
  $('cropReset').onclick = () => applyCrop(FULL);
  $('cropOk').onclick = () => {
    const c = cropBox;
    const r5c = (v) => Math.round(v * 1e5) / 1e5;
    applyCrop({ x: r5c(c.x), y: r5c(c.y), w: r5c(c.w), h: r5c(c.h) });
    toast('切り取りました。「全体に戻す」でいつでも元に戻せます');
  };
  // 囲みを動かす（中をドラッグ）・大きさを変える（四すみの丸をドラッグ）
  const MIN = 0.05;
  $('cropBox').addEventListener('pointerdown', (e) => {
    if (!cropping) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.target.closest('[data-corner]');
    const corner = el ? el.dataset.corner : 'move';
    const rect = $('stage').getBoundingClientRect();
    const sx = e.clientX, sy = e.clientY;
    const b0 = Object.assign({}, cropBox);
    const box = $('cropBox');
    box.setPointerCapture(e.pointerId);
    const onMove = (ev) => {
      const dx = (ev.clientX - sx) / rect.width, dy = (ev.clientY - sy) / rect.height;
      const b = Object.assign({}, b0);
      if (corner === 'move') {
        b.x = clamp(b0.x + dx, 0, 1 - b0.w);
        b.y = clamp(b0.y + dy, 0, 1 - b0.h);
      } else {
        let x1 = b0.x, y1 = b0.y, x2 = b0.x + b0.w, y2 = b0.y + b0.h;
        if (corner.includes('l')) x1 = clamp(x1 + dx, 0, x2 - MIN);
        if (corner.includes('r')) x2 = clamp(x2 + dx, x1 + MIN, 1);
        if (corner.includes('t')) y1 = clamp(y1 + dy, 0, y2 - MIN);
        if (corner.includes('b')) y2 = clamp(y2 + dy, y1 + MIN, 1);
        Object.assign(b, { x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
      }
      cropBox = b;
      renderCrop();
    };
    const onUp = () => {
      box.removeEventListener('pointermove', onMove);
      box.removeEventListener('pointerup', onUp);
      box.removeEventListener('pointercancel', onUp);
    };
    box.addEventListener('pointermove', onMove);
    box.addEventListener('pointerup', onUp);
    box.addEventListener('pointercancel', onUp);
  });
}

/* ---------- 編み図への書き込み ----------
   書いた線は「元の画像の中の位置（0〜1）」で覚えておくので、
   傾きを直したり拡大したりしても、線は編み図と一緒に動く。
   cur.ink = { ページ番号: [ { t:'pen'|'marker', c:色, w:太さ, p:[x,y,筆圧, ...] } ] } */
const INK_COLORS = {
  pen: ['#d62f2f', '#2b6cb0', '#222222', '#2f855a'],
  marker: ['#ffe600', '#ff8fb1', '#7cc8ff', '#8be38b'],
};
const INK_WIDTH = { pen: 0.0028, marker: 0.014 }; // 画像の幅に対する割合
let pageXf = null;     // 元画像 → キャンバスへの変換
let inking = false;
let inkTool = 'pen';
const inkColor = { pen: INK_COLORS.pen[0], marker: INK_COLORS.marker[0] };
let inkUndo = [];
let inkStroke = null;  // 書いている途中の線
let inkPenOnly = false;
const inkTouches = new Set();

const pageInk = () => {
  if (!cur.ink) cur.ink = {};
  if (!cur.ink[st().page]) cur.ink[st().page] = [];
  return cur.ink[st().page];
};

// 画面の位置 → 元画像の中の位置（0〜1）
function toSource(clientX, clientY) {
  const r = $('stage').getBoundingClientRect();
  const { rad, k, w, h, cw, ch, fw, fh, ox, oy } = pageXf;
  const dx = ((clientX - r.left) / r.width) * cw + ox - fw / 2;
  const dy = ((clientY - r.top) / r.height) * ch + oy - fh / 2;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const x = (dx * cos + dy * sin) / k + w / 2;
  const y = (-dx * sin + dy * cos) / k + h / 2;
  return { x: Math.round((x / w) * 1e5) / 1e5, y: Math.round((y / h) * 1e5) / 1e5 };
}

function drawInk() {
  const ic = $('inkCanvas');
  if (!pageXf || !cur) { ic.width = ic.height = 0; return; }
  const { rad, k, w, h, cw, ch, fw, fh, ox, oy } = pageXf;
  if (ic.width !== cw || ic.height !== ch) { ic.width = cw; ic.height = ch; }
  const g = ic.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, cw, ch);
  const strokes = (cur.ink && cur.ink[st().page]) || [];
  if (!strokes.length) return;
  g.translate(fw / 2 - ox, fh / 2 - oy);
  g.rotate(rad);
  g.scale(k, k);
  g.translate(-w / 2, -h / 2);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (const s of strokes) {
    const p = s.p, lw = s.w * w;
    g.strokeStyle = g.fillStyle = s.c;
    if (s.t === 'marker') {
      // マーカーは半透明で、下の記号が透けて見えるように
      g.globalAlpha = 0.45;
      g.globalCompositeOperation = 'multiply';
      g.lineWidth = lw;
      g.beginPath();
      g.moveTo(p[0] * w, p[1] * h);
      for (let i = 3; i < p.length; i += 3) g.lineTo(p[i] * w, p[i + 1] * h);
      if (p.length <= 3) g.lineTo(p[0] * w + 0.1, p[1] * h);
      g.stroke();
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over';
    } else if (p.length <= 3) {
      g.beginPath(); g.arc(p[0] * w, p[1] * h, lw * 0.6, 0, Math.PI * 2); g.fill();
    } else {
      for (let i = 3; i < p.length; i += 3) {
        g.lineWidth = lw * (0.4 + (p[i - 1] + p[i + 2]) * 0.6);
        g.beginPath();
        g.moveTo(p[i - 3] * w, p[i - 2] * h);
        g.lineTo(p[i] * w, p[i + 1] * h);
        g.stroke();
      }
    }
  }
}

let inkQueued = false;
function queueInk() {
  if (inkQueued) return;
  inkQueued = true;
  requestAnimationFrame(() => { inkQueued = false; drawInk(); });
}

function pushInkUndo() {
  inkUndo.push({ page: st().page, json: JSON.stringify(pageInk()) });
  if (inkUndo.length > 60) inkUndo.shift();
}

// 消しゴム：触れた線を1本まるごと消す
function eraseInk(pt) {
  const { k, w, h, cw } = pageXf;
  const rw = $('stage').getBoundingClientRect().width;
  const r = (16 * cw) / rw / k; // 画面で16ピクセルぶん（元画像の大きさで）
  const list = pageInk();
  const px = pt.x * w, py = pt.y * h;
  // 点から線分までの距離
  const segDist = (ax, ay, bx, by) => {
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    const t = L ? clamp(((px - ax) * dx + (py - ay) * dy) / L, 0, 1) : 0;
    return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
  };
  const keep = list.filter((s) => {
    const p = s.p, lim = r + (s.w * w) / 2;
    if (p.length <= 3) return Math.hypot(px - p[0] * w, py - p[1] * h) >= lim;
    for (let i = 3; i < p.length; i += 3) {
      if (segDist(p[i - 3] * w, p[i - 2] * h, p[i] * w, p[i + 1] * h) < lim) return false;
    }
    return true;
  });
  if (keep.length === list.length) return false;
  cur.ink[st().page] = keep;
  return true;
}

function setInkPenOnly(on) {
  inkPenOnly = on;
  try { localStorage.setItem('penOnly', on ? '1' : '0'); } catch (e) { /* 何もしない */ }
  $('viewer').classList.toggle('pen-only', on);
  $('inkPenChk').checked = on;
  renderInkPanel();
}

function renderInkPanel() {
  document.querySelectorAll('[data-ink-tool]').forEach((b) => b.classList.toggle('on', b.dataset.inkTool === inkTool));
  const colors = INK_COLORS[inkTool] || [];
  $('inkColors').innerHTML = colors.map((c) =>
    `<button class="swatch${c === inkColor[inkTool] ? ' on' : ''}" data-ink-color="${c}" style="background:${c}" aria-label="色"></button>`).join('');
  $('inkHelp').textContent = inkPenOnly
    ? 'Apple Pencil で書きます。指ではスクロール・拡大ができます。'
    : '指でなぞって書きます。2本指で拡大できます。書いたものは自動で保存されます。';
}

function setInking(on) {
  if (on && adjusting) setAdjusting(false);
  if (on && cropping) setCropping(false);
  inking = on;
  inkStroke = null;
  $('viewer').classList.toggle('inking', on);
  $('inkPanel').hidden = !on;
  $('inkBtn').classList.toggle('on', on);
  if (on) {
    try { inkPenOnly = localStorage.getItem('penOnly') === '1'; } catch (e) { /* 何もしない */ }
    $('viewer').classList.toggle('pen-only', inkPenOnly);
    $('inkPenChk').checked = inkPenOnly;
    renderInkPanel();
  } else {
    scheduleSave();
  }
  if (cur) applyZoom();
}

function setupInk() {
  const ic = $('inkCanvas');
  $('inkBtn').onclick = () => setInking(!inking);
  $('inkDone').onclick = () => setInking(false);
  $('inkPenChk').addEventListener('change', (e) => setInkPenOnly(e.target.checked));
  document.querySelectorAll('[data-ink-tool]').forEach((b) => {
    b.onclick = () => { inkTool = b.dataset.inkTool; renderInkPanel(); };
  });
  $('inkColors').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ink-color]');
    if (!b) return;
    inkColor[inkTool] = b.dataset.inkColor;
    renderInkPanel();
  });
  $('inkUndo').onclick = () => {
    const u = inkUndo.pop();
    if (!u) { toast('戻せる書き込みはありません'); return; }
    if (u.page !== st().page) showPage(u.page);
    if (!cur.ink) cur.ink = {};
    cur.ink[u.page] = JSON.parse(u.json);
    drawInk();
    scheduleSave();
  };
  $('inkClear').onclick = () => {
    if (!pageInk().length) return;
    if (!confirm('このページの書き込みを全部消しますか？')) return;
    pushInkUndo();
    cur.ink[st().page] = [];
    drawInk();
    scheduleSave();
  };

  const addPoint = (ev) => {
    const pt = toSource(ev.clientX, ev.clientY);
    if (inkStroke.erase) {
      // 速く動かしたときに間が抜けないよう、前の位置との間も細かく調べる
      const last = inkStroke.last || pt;
      const n = Math.min(60, Math.ceil(Math.hypot(pt.x - last.x, pt.y - last.y) / 0.004));
      for (let i = 1; i <= Math.max(1, n); i++) {
        const q = { x: last.x + ((pt.x - last.x) * i) / Math.max(1, n), y: last.y + ((pt.y - last.y) * i) / Math.max(1, n) };
        if (eraseInk(q)) { inkStroke.changed = true; queueInk(); }
      }
      inkStroke.last = pt;
      return;
    }
    const p = inkStroke.s.p;
    const lx = p[p.length - 3], ly = p[p.length - 2];
    if (Math.abs(pt.x - lx) + Math.abs(pt.y - ly) < 0.0006) return;
    const pr = ev.pointerType === 'pen' && ev.pressure ? ev.pressure : 0.5;
    p.push(pt.x, pt.y, Math.round(pr * 100) / 100);
    queueInk();
  };

  const cancelStroke = () => {
    if (!inkStroke) return;
    const u = inkUndo.pop();
    if (u) { cur.ink[u.page] = JSON.parse(u.json); }
    inkStroke = null;
    drawInk();
  };

  ic.addEventListener('pointerdown', (e) => {
    if (!inking || !pageXf) return;
    if (e.pointerType === 'touch') {
      inkTouches.add(e.pointerId);
      if (inkPenOnly) return;                 // 指はスクロール用
      if (inkTouches.size >= 2) { cancelStroke(); return; } // 2本指 → 拡大に切りかえ
      if (inkStroke && inkStroke.pen) return; // ペンで書いている最中の手のひら
    }
    if (e.pointerType === 'pen' && !inkPenOnly) {
      setInkPenOnly(true);
      toast('Apple Pencil を見つけました。ペンで書き、指でスクロールします');
    }
    if (inkStroke) return;
    e.preventDefault();
    ic.setPointerCapture(e.pointerId);
    pushInkUndo();
    inkStroke = { id: e.pointerId, pen: e.pointerType === 'pen' };
    if (inkTool === 'eraser') {
      inkStroke.erase = true;
      addPoint(e);
    } else {
      const pt = toSource(e.clientX, e.clientY);
      const pr = e.pointerType === 'pen' && e.pressure ? e.pressure : 0.5;
      inkStroke.s = { t: inkTool, c: inkColor[inkTool], w: INK_WIDTH[inkTool], p: [pt.x, pt.y, Math.round(pr * 100) / 100] };
      pageInk().push(inkStroke.s);
      queueInk();
    }
  });
  ic.addEventListener('pointermove', (e) => {
    if (!inkStroke || e.pointerId !== inkStroke.id) return;
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    (evs.length ? evs : [e]).forEach(addPoint);
  });
  const up = (e) => {
    if (e.pointerType === 'touch') inkTouches.delete(e.pointerId);
    if (!inkStroke || e.pointerId !== inkStroke.id) return;
    if (inkStroke.erase && !inkStroke.changed) inkUndo.pop(); // 何も消えなかった
    inkStroke = null;
    scheduleSave();
  };
  ic.addEventListener('pointerup', up);
  ic.addEventListener('pointercancel', (e) => {
    if (e.pointerType === 'touch') inkTouches.delete(e.pointerId);
    if (inkStroke && e.pointerId === inkStroke.id) cancelStroke();
  });
  // Apple Pencil でなぞったときに画面がスクロールしないように
  ic.addEventListener('touchstart', (e) => {
    if (!inking) return;
    if ([...e.changedTouches].some((t) => t.touchType === 'stylus')) e.preventDefault();
  }, { passive: false });
  ic.addEventListener('touchmove', (e) => {
    if (inking && inkStroke && inkStroke.pen) e.preventDefault();
  }, { passive: false });
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
  const sc = $('scroller');
  const w = sc.clientWidth;
  if (cropping) {
    // トリミング中は、四すみに届くよう、ページ全体を画面に収める
    const c = $('pageCanvas');
    const fit = Math.min(w, (sc.clientHeight - 24) * (c.width / Math.max(1, c.height)));
    $('stage').style.width = Math.round(fit) + 'px';
    sc.scrollTo(0, 0);
    return;
  }
  $('stage').style.width = Math.round(w * st().zoom) + 'px';
  renderBand(); // 大きさが変わったので、帯を描き直す
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

/* --- 帯の形 ---
   s.y  : 頂点（折れ目）での帯の上のふち   s.h : 帯の太さ（たての長さ）
   s.ax : 頂点の横の位置（0〜1、ふつうは真ん中 0.5）
   s.bend : 腕の傾き。折れ目から横に「ページ幅の半分」進んだとき、どれだけ下がるか
            （マイナスなら上がる）。0 ならまっすぐ。左右の腕はいつも同じ傾き。
   くの字（Vの字）の段の編み図にも、帯を折り曲げて合わせられる。 */
const apexX = (s) => (s.ax === undefined ? 0.5 : s.ax);
// 横の位置 x での、帯の上のふちの高さ
function bandTopAt(s, x) {
  const b = s.bend || 0;
  if (!b) return s.y;
  return s.y + b * Math.abs(x - apexX(s)) * 2;
}
const isBent = (s) => Math.abs(s.bend || 0) > 0.0005;

// 今の段の編む向き（true = ←、false = →、null = 矢印なし）
function rowLeft(s) {
  const way = s.way || 'none';
  if (way === 'none') return null;
  let left = !s.wayFlip;                               // 1段目は右から左（←）がふつう
  if (way === 'flat' && s.row % 2 === 0) left = !left; // 往復編みは段ごとに反対向き
  return left;
}

function renderBand() {
  const s = st();
  const stage = $('stage');
  const W = stage.offsetWidth, H = stage.offsetHeight;
  if (!W || !H) return;
  const svg = $('bandSvg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const isRing = s.shape === 'ring';
  $('adjustPanel').classList.toggle('ring-mode', isRing);
  $('viewer').classList.toggle('ring-mode-stage', isRing);
  $('hBend').hidden = isRing;
  $('posLabel').textContent = isRing ? '中心' : '位置';
  document.querySelectorAll('[data-shape]').forEach((b) => b.classList.toggle('on', b.dataset.shape === (isRing ? 'ring' : 'line')));
  if (isRing) { renderRing(s, W, H); return; }
  const ax = apexX(s) * W, h = s.h * H;
  const tL = bandTopAt(s, 0) * H, tA = s.y * H, tR = bandTopAt(s, 1) * H;
  const f = fx1;
  $('bandP').setAttribute('d', `M0 ${f(tL)} L${f(ax)} ${f(tA)} L${W} ${f(tR)} L${W} ${f(tR + h)} L${f(ax)} ${f(tA + h)} L0 ${f(tL + h)} Z`);

  const showShade = s.dim && !adjusting;
  $('shadeTopP').setAttribute('d', showShade ? `M0 0 L${W} 0 L${W} ${f(tR)} L${f(ax)} ${f(tA)} L0 ${f(tL)} Z` : '');
  $('shadeBotP').setAttribute('d', showShade ? `M0 ${f(tL + h)} L${f(ax)} ${f(tA + h)} L${W} ${f(tR + h)} L${W} ${H} L0 ${H} Z` : '');

  // 編む向きの矢印を、帯の真ん中の線にそって並べる
  const g = $('bandArrows');
  g.innerHTML = '';
  const left = rowLeft(s);
  if (left !== null) {
    const size = clamp(h * 0.5, 6, 36);
    const gap = size * 2.6;
    const pts = [[0, tL + h / 2], [ax, tA + h / 2], [W, tR + h / 2]];
    let html = '';
    let carry = gap / 2;
    for (let i = 0; i < 2; i++) {
      const [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
      const len = Math.hypot(x2 - x1, y2 - y1);
      if (len < 1) continue;
      let ang = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
      if (left) ang += 180;
      for (let d = carry; d < len; d += gap) {
        html += chevron(x1 + ((x2 - x1) * d) / len, y1 + ((y2 - y1) * d) / len, ang, size);
        carry = d + gap - len;
      }
    }
    g.innerHTML = html;
  }

  // 調整用の持ち手：上下のふちは頂点に、「曲げ」は折れ目のすぐ右に置く
  const place = (id, xFrac, yFrac) => { $(id).style.left = (xFrac * 100) + '%'; $(id).style.top = (yFrac * 100) + '%'; };
  place('hTop', apexX(s), s.y);
  place('hBot', apexX(s), s.y + s.h);
  const bx = bendHandleX(s, W);
  place('hBend', bx, bandTopAt(s, bx) + s.h / 2);
}

const fx1 = (v) => v.toFixed(1);
// 向きの矢印1つ（くの字の「>」を、ang 度の向きに）
function chevron(x, y, ang, size) {
  const f = fx1;
  return `<path transform="translate(${f(x)} ${f(y)}) rotate(${ang.toFixed(1)})" stroke-width="${Math.max(1.5, size * 0.14).toFixed(1)}" d="M${f(-size * 0.25)} ${f(-size / 2)} L${f(size * 0.25)} 0 L${f(-size * 0.25)} ${f(size / 2)}"/>`;
}

/* --- 円の帯（ドーナツ形） ---
   s.cx, s.cy : 円の中心（ページの幅・高さに対する割合）
   s.rr : 内側の円の半径、 s.rt : 1段の太さ（どちらもページの幅に対する割合）
   1段目は rr = 0 で、中心の丸い部分になる。次の段へ進むと rr が rt ずつ大きくなる。 */
function renderRing(s, W, H) {
  const f = fx1;
  const cx = s.cx * W, cy = s.cy * H, r = s.rr * W, R = (s.rr + s.rt) * W;
  const circ = (rad) => (rad <= 0.5 ? '' : `M${f(cx - rad)} ${f(cy)} a${f(rad)} ${f(rad)} 0 1 0 ${f(2 * rad)} 0 a${f(rad)} ${f(rad)} 0 1 0 ${f(-2 * rad)} 0 Z`);
  $('bandP').setAttribute('d', circ(R) + circ(r));
  const showShade = s.dim && !adjusting;
  // 外側（大きな四角から外の円をくりぬく）＋ 内側の円の中を暗くする
  $('shadeTopP').setAttribute('d', showShade ? `M0 0 H${W} V${H} H0 Z` + circ(R) + circ(r) : '');
  $('shadeBotP').setAttribute('d', '');

  // 向きの矢印を円にそって並べる（← は反時計まわり、→ は時計まわり）
  const g = $('bandArrows');
  g.innerHTML = '';
  const left = rowLeft(s);
  const m = (r + R) / 2, size = clamp((R - r) * 0.5, 6, 36);
  if (left !== null && m > size) {
    const n = Math.max(3, Math.floor((2 * Math.PI * m) / (size * 2.6)));
    let html = '';
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2;
      // 画面は下向きが +y なので、角度が増える向きが時計まわり
      let ang = (Math.atan2(Math.cos(t), -Math.sin(t)) * 180) / Math.PI; // 時計まわりの向き
      if (left) ang += 180;
      html += chevron(cx + m * Math.cos(t), cy + m * Math.sin(t), ang, size);
    }
    g.innerHTML = html;
  }

  // 持ち手：中心から右に、内側の円のふち（左の丸）と外側のふち（右の丸）
  const place = (id, x, y) => { $(id).style.left = ((x / W) * 100) + '%'; $(id).style.top = ((y / H) * 100) + '%'; };
  place('hTop', cx + r, cy);
  place('hBot', cx + R, cy);
}

// 円の帯にするとき、まだ中心が決まっていなければ、いま見えている所の真ん中に置く
function initRing(s) {
  if (s.cx !== undefined) return;
  const sc = $('scroller'), stg = $('stage');
  s.cx = clamp((sc.scrollLeft + sc.clientWidth / 2 - stg.offsetLeft) / stg.offsetWidth, 0, 1);
  s.cy = clamp((sc.scrollTop + sc.clientHeight / 2 - stg.offsetTop) / stg.offsetHeight, 0, 1);
  s.rr = 0;
  s.rt = clamp((s.h * stg.offsetHeight) / stg.offsetWidth, 0.01, 0.3);
}

// 「曲げ」の持ち手の横の位置：折れ目から画面で80ピクセルほど右（拡大していても近くに出る）
function bendHandleX(s, W) {
  return Math.min(apexX(s) + 80 / W, 0.98);
}

function render() {
  const s = st();
  renderBand();
  const left = rowLeft(s);
  const way = s.way || 'none';
  $('rowWay').hidden = left === null;
  $('rowWay').textContent = s.shape === 'ring' ? (left ? '↺' : '↻') : (left ? '←' : '→');
  document.querySelectorAll('[data-way]').forEach((b) => b.classList.toggle('on', b.dataset.way === way));
  $('wayFlipRow').hidden = way === 'none';
  $('wayFlipChk').checked = !!s.wayFlip;

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
  const s = st();
  const stageH = $('stage').offsetHeight;
  if (s.shape === 'ring') {
    // 円の帯：円の中心が画面の真ん中に来るように（大きな円なら、上のふちが見えるように）
    const W = $('stage').offsetWidth;
    const R = (s.rr + s.rt) * W;
    const cyPx = s.cy * stageH;
    const top = R * 2 < scroller.clientHeight ? cyPx - scroller.clientHeight / 2 : cyPx - (s.rr + s.rt / 2) * W - scroller.clientHeight / 3;
    scroller.scrollTo({ top: Math.max(0, top), left: Math.max(0, s.cx * W - scroller.clientWidth / 2), behavior: smooth ? 'smooth' : 'auto' });
    return;
  }
  const bandCenter = (s.y + s.h / 2) * stageH;
  const top = bandCenter - scroller.clientHeight / 2;
  scroller.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' });
}

/* --- 段ごとに帯の位置を覚える ---
   かぎ針は段によって高さがちがうので、合わせた帯の位置を段ごとに記録しておき、
   2回目からはその位置へ動かす。 */
const r5 = (v) => Math.round(v * 1e5) / 1e5;
function rememberRow() {
  const s = st();
  if (!s.rowPos) s.rowPos = {};
  const pos = { p: s.page, y: r5(s.y), h: r5(s.h), b: r5(s.bend || 0), a: r5(apexX(s)) };
  if (s.shape === 'ring') Object.assign(pos, { sh: 'ring', cx: r5(s.cx), cy: r5(s.cy), rr: r5(s.rr), rt: r5(s.rt) });
  s.rowPos[s.row] = pos;
}

function stepRow(n) {
  const s = st();
  if (s.row + n < 1) return;
  rememberRow();
  const saved = s.rowPos[s.row + n];
  if (saved) {
    s.row += n;
    s.y = saved.y;
    s.h = saved.h;
    if (saved.b !== undefined) { s.bend = saved.b; s.ax = saved.a; }
    if (saved.sh === 'ring') Object.assign(s, { shape: 'ring', cx: saved.cx, cy: saved.cy, rr: saved.rr, rt: saved.rt });
    else delete s.shape;
    afterStep(n);
    if (saved.p !== s.page) showPage(saved.p);
    return;
  }
  if (s.shape === 'ring') {
    // 円の帯：1段分、外（戻るときは内）へ広げる
    s.rr = Math.max(0, s.rr + s.rt * n);
    s.row += n;
    afterStep(n);
    return;
  }
  const dy = (s.dir === 'up' ? -s.h : s.h) * n;
  const ny = s.y + dy;
  if (ny < -0.0001 || ny + s.h > 1.0001) {
    toast('ページの端です。「調整」で帯の位置を合わせてください');
  }
  s.y = clamp(ny, 0, 1 - s.h);
  s.row += n;
  if (s.snap !== false && !isBent(s)) snapBand(0.25, true); // 罫線合わせは、まっすぐな帯のときだけ
  afterStep(n);
}

function afterStep(n) {
  if (n > 0) {
    cur.counters.forEach((c) => { if (c.reset) c.n = 0; });
    renderCounters();
    if (cur.group) autoStart(cur.group); // 着手前のプロジェクトなら「制作中」に
  }
  render();
  scrollToBand();
  scheduleSave();
  if (navigator.vibrate) navigator.vibrate(15);
}

function setAdjusting(on) {
  if (on && inking) setInking(false);
  if (on && cropping) setCropping(false);
  adjusting = on;
  $('viewer').classList.toggle('adjusting', on);
  $('adjustPanel').hidden = !on;
  $('adjustBtn').textContent = on ? '完了' : '調整';
  if (cur) { render(); applyZoom(); }
  if (!on && cur) { rememberRow(); scheduleSave(); }
}

/* --- 帯のドラッグ（調整モードのとき） --- */
function setupBandDrag() {
  // 帯そのもの（動かす）と、3つの持ち手（上のふち・下のふち・曲げ）
  const startDrag = (e, el, mode) => {
    if (!adjusting) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = $('stage').getBoundingClientRect();
    const W = rect.width, H = rect.height;
    const sx = e.clientX, sy = e.clientY;
    const s = st();
    const y0 = s.y, h0 = s.h, a0 = apexX(s);
    const ring = s.shape === 'ring';
    const c0 = { x: s.cx, y: s.cy, rr: s.rr, rt: s.rt };
    el.setPointerCapture(e.pointerId);

    const onMove = (ev) => {
      const d = (ev.clientY - sy) / H;
      if (ring) {
        // 円の帯：帯を動かすと中心が動く。左の丸＝内側の円、右の丸＝1段の太さ（左右に動かす）
        const dx = (ev.clientX - sx) / W;
        if (mode === 'move') { s.cx = clamp(c0.x + dx, 0, 1); s.cy = clamp(c0.y + d, 0, 1); }
        else if (mode === 'top') s.rr = clamp(c0.rr + dx, 0, 2);
        else if (mode === 'bottom') s.rt = clamp(c0.rt + dx, 0.003, 2);
        renderBand();
        return;
      }
      if (mode === 'move') {
        s.y = clamp(y0 + d, 0, 1 - h0);
        // 曲げているときは、横にずらすと折れ目の位置も動く
        if (isBent(s)) s.ax = clamp(a0 + (ev.clientX - sx) / W, 0.05, 0.85);
      } else if (mode === 'top') {
        const ny = clamp(y0 + d, 0, y0 + h0 - MIN_BAND);
        s.h = h0 + (y0 - ny);
        s.y = ny;
      } else if (mode === 'bottom') {
        s.h = clamp(h0 + d, MIN_BAND, 1 - y0);
      } else if (mode === 'bend') {
        // 指のある所を、帯（の真ん中）が通るように曲げる
        const fx = (ev.clientX - rect.left) / W, fy = (ev.clientY - rect.top) / H;
        const dx = Math.max(Math.abs(fx - a0), 20 / W);
        s.bend = clamp((fy - h0 / 2 - y0) / (dx * 2), -3, 3);
      }
      renderBand();
    };
    const onUp = () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      scheduleSave();
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  };
  $('bandP').addEventListener('pointerdown', (e) => startDrag(e, $('bandP'), 'move'));
  ['hTop', 'hBot', 'hBend'].forEach((id) => {
    const el = $(id);
    el.addEventListener('pointerdown', (e) => startDrag(e, el, el.dataset.drag));
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
    const fx = (e.clientX - rect.left) / rect.width;
    const fy = (e.clientY - rect.top) / rect.height;
    if (s.shape === 'ring') {
      // 円の帯：タップした所を円の中心にする
      s.cx = clamp(fx, 0, 1);
      s.cy = clamp(fy, 0, 1);
      render();
      scheduleSave();
      return;
    }
    // タップした場所が帯の真ん中に来るように（曲げているときは、その横の位置で合わせる）
    s.y = clamp(fy - s.h / 2 - (bandTopAt(s, fx) - s.y), 0, 1 - s.h);
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
  $('handNoteLabel').textContent = cur.group ? 'プロジェクトの手書きメモを開く' : '手書きメモを開く';
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
  setupInk();
  setupCrop();
  Backup.init();
  $('newChartBtn').onclick = () => Editor.newChartDialog();

  $('fileInput').addEventListener('change', (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    importFiles(files);
  });
  setupProjects();
  PhotoView.init();
  NotePad.init();
  $('groupNote').onclick = () => { if (curProj) NotePad.open('g:' + curProj.id, '📝 ' + curProj.name); };
  // 編む画面のメモから：プロジェクトに入っていればプロジェクトのメモ、なければこの編み図のメモ
  $('handNoteBtn').onclick = async () => {
    await saveNow();
    const g = cur.group && (await getAllGroups()).find((x) => x.id === cur.group);
    if (g) NotePad.open('g:' + g.id, '📝 ' + g.name);
    else NotePad.open('p:' + cur.id, '📝 ' + cur.name);
  };

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
  document.querySelectorAll('[data-way]').forEach((b) => {
    b.onclick = () => { st().way = b.dataset.way; render(); scheduleSave(); };
  });
  $('wayFlipChk').addEventListener('change', (e) => { st().wayFlip = e.target.checked; render(); scheduleSave(); });
  $('resetRowsBtn').onclick = () => {
    if (!confirm('段ごとに覚えた帯の位置を全部忘れますか？\n（今の段の帯はそのまま残ります）')) return;
    st().rowPos = {};
    scheduleSave();
    toast('覚えた位置を消しました');
  };

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
    // くの字：両はしを上げ下げ（2ピクセルずつ）、折れ目を左右へ
    bendUp:   (s, px) => { s.bend = clamp((s.bend || 0) - px * 2, -3, 3); },
    bendDown: (s, px) => { s.bend = clamp((s.bend || 0) + px * 2, -3, 3); },
    apexL:    (s) => { s.ax = clamp(apexX(s) - 1 / $('stage').offsetWidth, 0.05, 0.85); },
    apexR:    (s) => { s.ax = clamp(apexX(s) + 1 / $('stage').offsetWidth, 0.05, 0.85); },
    // 円の帯：中心を左右へ、内側の円を小さく・大きく
    ringL:    (s) => { s.cx = clamp(s.cx - 1 / $('stage').offsetWidth, 0, 1); },
    ringR:    (s) => { s.cx = clamp(s.cx + 1 / $('stage').offsetWidth, 0, 1); },
    ringIn:   (s) => { s.rr = Math.max(0, s.rr - 1 / $('stage').offsetWidth); },
    ringOut:  (s) => { s.rr += 1 / $('stage').offsetWidth; },
  };
  // 円の帯のときは、「位置」は中心の上下、「太さ」は1段の太さを変える
  const ringNudges = {
    up:    (s, px) => { s.cy = clamp(s.cy - px, 0, 1); },
    down:  (s, px) => { s.cy = clamp(s.cy + px, 0, 1); },
    thin:  (s) => { s.rt = Math.max(0.003, s.rt - 1 / $('stage').offsetWidth); },
    thick: (s) => { s.rt += 1 / $('stage').offsetWidth; },
  };
  document.querySelectorAll('[data-shape]').forEach((b) => {
    b.onclick = () => {
      const s = st();
      if (b.dataset.shape === 'ring') { initRing(s); s.shape = 'ring'; } else delete s.shape;
      render();
      scrollToBand(false);
      scheduleSave();
    };
  });
  $('straightBtn').onclick = () => { const s = st(); s.bend = 0; s.ax = 0.5; render(); scheduleSave(); };
  // 腕を45°に：両はしが上がる「Vの字」（もう一度押すと下がる「Λの字」）
  $('bend45Btn').onclick = () => {
    const s = st();
    const stage = $('stage');
    // 45°：横に進んだのと同じだけ上がる（ページ幅の半分進むと、その長さだけ上がる）
    const up = -(stage.offsetWidth / stage.offsetHeight) / 2;
    s.bend = Math.abs((s.bend || 0) - up) < 0.001 ? -up : up; // もう一度押すと逆向き（Λの字）
    render();
    scheduleSave();
  };
  document.querySelectorAll('[data-nudge]').forEach((btn) => {
    const once = () => {
      const s = st();
      const fn = (s.shape === 'ring' && ringNudges[btn.dataset.nudge]) || nudges[btn.dataset.nudge];
      const px = 1 / $('stage').offsetHeight; // 画面上の 1 ピクセルぶん
      fn(s, px);
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
    if (s.shape === 'ring') {
      // 円の帯：ドーナツの太さが n 段分 → 1段の太さにする（内側の円はそのまま）
      s.rt /= n;
      render();
      scheduleSave();
      toast(`${n}段分から1段の太さを決めました`);
      return;
    }
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
