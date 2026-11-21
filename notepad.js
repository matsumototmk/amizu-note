'use strict';

/* =========================================================
   あみ図ノート  手書きメモ
   - 罫線のノートに、Apple Pencil（または指）で自由に書く
   - 作品（グループ）ごと、またはグループに入っていない編み図ごとに1冊
   - ページは下に足していける
   線の位置はページの幅を1とした割合で覚えるので、画面の大きさが変わってもずれない。
   ========================================================= */

const NotePad = (() => {
  const RATIO = 1.414;       // ページの縦横比（A4くらい）
  const LINES = 24;          // 1ページの罫線の数
  const COLORS = ['#222222', '#d62f2f', '#2b6cb0', '#2f855a', '#b5576b'];
  const WIDTHS = [['細', 0.0025], ['中', 0.004], ['太', 0.007]];
  const el = (id) => document.getElementById(id);

  let note = null;           // { id, title, pages: [ [stroke, ...], ... ], updated }
  let canvases = [];
  let tool = 'pen';
  let color = COLORS[0];
  let width = WIDTHS[1][1];
  let undoStack = [], redoStack = [];
  let stroke = null;         // 書いている途中の線 { page, s, id, pen, erase, changed }
  let penOnly = false;
  let saveTimer;
  let dpr = 1;

  /* ---------- 保存 ---------- */
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 600);
  }
  function saveNow() {
    clearTimeout(saveTimer);
    if (!note) return Promise.resolve();
    note.updated = Date.now();
    return putNote(note).catch((e) => console.error(e));
  }

  /* ---------- 元に戻す ---------- */
  const snap = () => JSON.stringify(note.pages);
  function pushUndo() {
    undoStack.push(snap());
    if (undoStack.length > 80) undoStack.shift();
    redoStack = [];
    updateButtons();
  }
  function updateButtons() {
    el('npUndo').disabled = !undoStack.length;
    el('npRedo').disabled = !redoStack.length;
  }
  function restore(json) {
    note.pages = JSON.parse(json);
    buildPages();
    updateButtons();
    scheduleSave();
  }

  /* ---------- 描く ---------- */
  function pageWidth() {
    return Math.min(el('npScroll').clientWidth - 24, 900);
  }

  function drawPage(i) {
    const c = canvases[i];
    if (!c) return;
    const W = c.width / dpr, H = c.height / dpr;
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#fffdf9';
    g.fillRect(0, 0, W, H);
    // 罫線
    g.strokeStyle = '#e6ddd5';
    g.lineWidth = 1;
    g.beginPath();
    const gap = H / (LINES + 1);
    for (let k = 1; k <= LINES; k++) { g.moveTo(W * 0.04, gap * k); g.lineTo(W * 0.96, gap * k); }
    g.stroke();
    for (const s of note.pages[i]) drawStroke(g, s, W);
  }

  function drawStroke(g, s, W) {
    const p = s.p, lw = s.w * W;
    g.strokeStyle = g.fillStyle = s.c;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    if (p.length <= 3) {
      g.beginPath(); g.arc(p[0] * W, p[1] * W, lw * 0.6, 0, Math.PI * 2); g.fill();
      return;
    }
    for (let i = 3; i < p.length; i += 3) drawSeg(g, p, i, lw, W);
  }
  function drawSeg(g, p, i, lw, W) {
    g.lineWidth = lw * (0.4 + (p[i - 1] + p[i + 2]) * 0.6);
    g.beginPath();
    g.moveTo(p[i - 3] * W, p[i - 2] * W);
    g.lineTo(p[i] * W, p[i + 1] * W);
    g.stroke();
  }

  function buildPages() {
    const box = el('npPages');
    box.innerHTML = '';
    canvases = [];
    dpr = window.devicePixelRatio || 1;
    const W = pageWidth(), H = Math.round(W * RATIO);
    note.pages.forEach((_, i) => {
      const wrap = document.createElement('div');
      wrap.className = 'np-page';
      const c = document.createElement('canvas');
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
      c.style.width = W + 'px';
      c.style.height = H + 'px';
      c.dataset.page = i;
      const num = document.createElement('span');
      num.className = 'np-num';
      num.textContent = `${i + 1} / ${note.pages.length}`;
      wrap.append(c, num);
      box.append(wrap);
      canvases.push(c);
      setupCanvas(c);
      drawPage(i);
    });
  }

  /* ---------- 指・ペンの操作 ---------- */
  function toPage(c, ev) {
    const r = c.getBoundingClientRect();
    const k = 1 / r.width;
    return { x: Math.round((ev.clientX - r.left) * k * 1e5) / 1e5, y: Math.round((ev.clientY - r.top) * k * 1e5) / 1e5 };
  }

  // 消しゴム：触れた線を1本まるごと消す
  function eraseAt(i, pt, c) {
    const r = 14 / c.getBoundingClientRect().width; // 画面で14ピクセルぶん
    const list = note.pages[i];
    const segDist = (ax, ay, bx, by) => {
      const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
      const t = L ? Math.min(1, Math.max(0, ((pt.x - ax) * dx + (pt.y - ay) * dy) / L)) : 0;
      return Math.hypot(pt.x - (ax + dx * t), pt.y - (ay + dy * t));
    };
    const keep = list.filter((s) => {
      const p = s.p, lim = r + s.w / 2;
      if (p.length <= 3) return Math.hypot(pt.x - p[0], pt.y - p[1]) >= lim;
      for (let j = 3; j < p.length; j += 3) if (segDist(p[j - 3], p[j - 2], p[j], p[j + 1]) < lim) return false;
      return true;
    });
    if (keep.length === list.length) return false;
    note.pages[i] = keep;
    return true;
  }

  function addPoint(c, ev) {
    const i = stroke.page;
    const pt = toPage(c, ev);
    if (stroke.erase) {
      const last = stroke.last || pt;
      const n = Math.max(1, Math.min(40, Math.ceil(Math.hypot(pt.x - last.x, pt.y - last.y) / 0.005)));
      let hit = false;
      for (let k = 1; k <= n; k++) {
        if (eraseAt(i, { x: last.x + ((pt.x - last.x) * k) / n, y: last.y + ((pt.y - last.y) * k) / n }, c)) hit = true;
      }
      stroke.last = pt;
      if (hit) { stroke.changed = true; drawPage(i); }
      return;
    }
    const p = stroke.s.p;
    if (Math.abs(pt.x - p[p.length - 3]) + Math.abs(pt.y - p[p.length - 2]) < 0.0012) return;
    const pr = ev.pointerType === 'pen' && ev.pressure ? ev.pressure : 0.5;
    p.push(pt.x, pt.y, Math.round(pr * 100) / 100);
    // 書いている間は、新しい部分だけ描き足す（速い）
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.strokeStyle = stroke.s.c;
    g.lineCap = 'round';
    const W = c.width / dpr;
    drawSeg(g, p, p.length - 3, stroke.s.w * W, W);
  }

  const touches = new Set();
  function setupCanvas(c) {
    c.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') {
        touches.add(e.pointerId);
        if (penOnly || tool === 'hand') return;          // 指はスクロール用
        if (touches.size >= 2) { cancelStroke(); return; } // 2本指ならスクロールに
        if (stroke && stroke.pen) return;                // ペンで書いている間の手のひら
      }
      if (e.pointerType === 'pen' && !penOnly) {
        setPenOnly(true);
        toast('Apple Pencil を見つけました。ペンで書き、指でスクロールします');
      }
      if (stroke || tool === 'hand') return;
      e.preventDefault();
      c.setPointerCapture(e.pointerId);
      const i = +c.dataset.page;
      pushUndo();
      stroke = { page: i, id: e.pointerId, pen: e.pointerType === 'pen' };
      if (tool === 'eraser') {
        stroke.erase = true;
        addPoint(c, e);
      } else {
        const pt = toPage(c, e);
        const pr = e.pointerType === 'pen' && e.pressure ? e.pressure : 0.5;
        stroke.s = { c: color, w: width, p: [pt.x, pt.y, Math.round(pr * 100) / 100] };
        note.pages[i].push(stroke.s);
        drawPage(i);
      }
    });
    c.addEventListener('pointermove', (e) => {
      if (!stroke || e.pointerId !== stroke.id) return;
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      (evs.length ? evs : [e]).forEach((ev) => addPoint(c, ev));
    });
    const up = (e) => {
      if (e.pointerType === 'touch') touches.delete(e.pointerId);
      if (!stroke || e.pointerId !== stroke.id) return;
      if (e.type === 'pointercancel') { cancelStroke(); return; }
      if (stroke.erase && !stroke.changed) { undoStack.pop(); updateButtons(); }
      stroke = null;
      scheduleSave();
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    // Apple Pencil でなぞったときに画面がスクロールしないように
    c.addEventListener('touchstart', (e) => {
      if (tool !== 'hand' && [...e.changedTouches].some((t) => t.touchType === 'stylus')) e.preventDefault();
    }, { passive: false });
    c.addEventListener('touchmove', (e) => { if (stroke && stroke.pen) e.preventDefault(); }, { passive: false });
  }

  function cancelStroke() {
    if (!stroke) return;
    const i = stroke.page;
    const u = undoStack.pop();
    if (u) note.pages = JSON.parse(u);
    stroke = null;
    updateButtons();
    drawPage(i);
  }

  /* ---------- 道具 ---------- */
  function setPenOnly(on) {
    penOnly = on;
    try { localStorage.setItem('penOnly', on ? '1' : '0'); } catch (e) { /* 何もしない */ }
    renderTools();
  }

  function renderTools() {
    el('notePad').classList.toggle('finger-draw', !penOnly && tool !== 'hand');
    document.querySelectorAll('[data-np-tool]').forEach((b) => b.classList.toggle('on', b.dataset.npTool === tool));
    el('npHand').hidden = penOnly; // ペンだけで書くときは、指でスクロールできるので「移動」はいらない
    el('npColors').innerHTML = COLORS.map((c) =>
      `<button class="swatch${c === color ? ' on' : ''}" data-np-color="${c}" style="background:${c}" aria-label="色"></button>`).join('');
    el('npWidths').innerHTML = WIDTHS.map(([n, w]) =>
      `<button class="chip-btn${w === width ? ' on' : ''}" data-np-width="${w}">${n}</button>`).join('');
    el('npPenChk').checked = penOnly;
  }

  /* ---------- 開く・閉じる ---------- */
  async function open(id, title) {
    note = (await getNote(id)) || { id, pages: [[]], created: Date.now() };
    note.title = title;
    if (!note.pages || !note.pages.length) note.pages = [[]];
    undoStack = []; redoStack = [];
    stroke = null;
    try { penOnly = localStorage.getItem('penOnly') === '1'; } catch (e) { /* 何もしない */ }
    if (penOnly && tool === 'hand') tool = 'pen';
    el('npTitle').textContent = title;
    el('notePad').hidden = false;
    renderTools();
    updateButtons();
    buildPages();
    el('npScroll').scrollTop = 0;
  }

  async function close() {
    await saveNow();
    note = null;
    el('npPages').innerHTML = '';
    canvases = [];
    el('notePad').hidden = true;
  }

  function init() {
    el('npBack').onclick = close;
    el('npUndo').onclick = () => { if (!undoStack.length) return; redoStack.push(snap()); restore(undoStack.pop()); };
    el('npRedo').onclick = () => { if (!redoStack.length) return; undoStack.push(snap()); restore(redoStack.pop()); };
    el('npAddPage').onclick = () => {
      pushUndo();
      note.pages.push([]);
      buildPages();
      scheduleSave();
      const s = el('npScroll');
      s.scrollTo({ top: s.scrollHeight, behavior: 'smooth' });
    };
    el('npClear').onclick = () => {
      if (!note.pages.some((p) => p.length)) return;
      if (!confirm('このメモに書いたものを全部消しますか？\n（すぐなら「↶」で戻せます）')) return;
      pushUndo();
      note.pages = note.pages.map(() => []);
      buildPages();
      scheduleSave();
    };
    el('npPenChk').addEventListener('change', (e) => { setPenOnly(e.target.checked); if (penOnly && tool === 'hand') { tool = 'pen'; renderTools(); } });
    el('npTools').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.npTool) tool = b.dataset.npTool;
      if (b.dataset.npColor) { color = b.dataset.npColor; if (tool !== 'pen') tool = 'pen'; }
      if (b.dataset.npWidth) { width = parseFloat(b.dataset.npWidth); if (tool !== 'pen') tool = 'pen'; }
      renderTools();
    });
    // 画面の向きが変わったら、ページの大きさを合わせ直す
    let lastW = 0;
    window.addEventListener('resize', () => {
      if (!note) return;
      const w = pageWidth();
      if (Math.abs(w - lastW) > 2) { lastW = w; buildPages(); }
    });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && note) saveNow(); });
  }

  return { init, open };
})();
