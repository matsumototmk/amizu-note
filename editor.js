'use strict';

/* =========================================================
   あみ図ノート  ステップ3：編み図を描く
   - 方眼（棒針・かぎ針）と、円・自由配置（かぎ針）
   - ペン（筆圧対応）、記号スタンプ、色塗り、消しゴム、動かす
   - Apple Pencil を使うと「ペンで描く・指で移動」になる
   - 「編む」で画像にして、編む画面へ送る
   ========================================================= */

const Editor = (() => {
  const C = 32;            // 1マスの大きさ（編み図の中の座標）
  const FREE_CELLS = 25;   // 円・自由配置のキャンバスの大きさ（マス数）
  const PEN_COLORS = ['#222222', '#b5576b', '#2b6cb0', '#2f855a', '#d69e2e'];
  const PEN_WIDTHS = [['細', 1.2], ['中', 2.5], ['太', 5]];
  const FILL_COLORS = ['#e57373', '#f6ad55', '#f6e05e', '#68d391', '#63b3ed', '#9f7aea', '#f6e3e7', '#a0aec0', '#4a4a4a', '#ffffff'];
  const el = (id) => document.getElementById(id);

  let doc = null;
  let canvas, ctx, dpr = 1;
  let view = { s: 1, ox: 0, oy: 0 };
  let tool = 'pen';
  let undoStack = [], redoStack = [];
  let selected = -1;           // 「動かす」で選んだ記号
  let ghost = null;            // 置く前の記号の影
  let saveTimer;
  const opt = {
    penColor: PEN_COLORS[0], penWidth: 2.5,
    symSet: 'knit', sym: 'k',
    fillColor: FILL_COLORS[0],
    eraser: 14,
    rotDeg: 0, autoCenter: true,
  };
  let penOnly = false;
  try { penOnly = localStorage.getItem('penOnly') === '1'; } catch (e) { /* 何もしない */ }

  /* ---------- 保存 ---------- */
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 700);
  }
  function saveNow() {
    clearTimeout(saveTimer);
    if (!doc) return Promise.resolve();
    doc.updated = Date.now();
    return putChart(doc).catch((e) => console.error(e));
  }

  /* ---------- 元に戻す / やり直す ---------- */
  const snapshot = () => JSON.stringify({ cols: doc.cols, rows: doc.rows, cells: doc.cells, strokes: doc.strokes, stamps: doc.stamps });
  function restore(json) {
    Object.assign(doc, JSON.parse(json));
    selected = -1;
    requestRender();
    scheduleSave();
    updateUndoButtons();
  }
  function pushUndo() {
    undoStack.push(snapshot());
    if (undoStack.length > 60) undoStack.shift();
    redoStack = [];
    updateUndoButtons();
  }
  function updateUndoButtons() {
    el('edUndo').disabled = undoStack.length === 0;
    el('edRedo').disabled = redoStack.length === 0;
  }

  /* ---------- 形と大きさ ---------- */
  function bounds(d) {
    if (d.mode === 'grid') return { x: -C * 0.6, y: -C * 0.6, w: d.cols * C + C * 2.0, h: d.rows * C + C * 1.8 };
    const S = FREE_CELLS * C;
    return { x: 0, y: 0, w: S, h: S };
  }

  /* ---------- 描画 ---------- */
  function drawStroke(g, s) {
    const p = s.p;
    g.strokeStyle = s.c;
    g.fillStyle = s.c;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    if (p.length <= 3) {
      g.beginPath(); g.arc(p[0], p[1], s.w * 0.6, 0, Math.PI * 2); g.fill();
      return;
    }
    for (let i = 3; i < p.length; i += 3) {
      g.lineWidth = s.w * (0.35 + (p[i - 1] + p[i + 2]) * 0.65);
      g.beginPath();
      g.moveTo(p[i - 3], p[i - 2]);
      g.lineTo(p[i], p[i + 1]);
      g.stroke();
    }
  }

  function cellOwner(d, r, c) {
    for (let k = 0; k < 4; k++) {
      const key = r + ',' + (c - k);
      const cell = d.cells[key];
      if (cell && cell.s) {
        const span = (SYMBOLS[cell.s] && SYMBOLS[cell.s].span) || 1;
        if (span > k) return key;
        if (k === 0) return null;
      }
    }
    return null;
  }

  function drawDoc(g, d, forExport) {
    const b = bounds(d);
    g.fillStyle = '#fff';
    g.fillRect(b.x, b.y, b.w, b.h);

    if (d.mode === 'grid') {
      for (const key in d.cells) {
        const cell = d.cells[key];
        if (!cell.col) continue;
        const [r, c] = key.split(',').map(Number);
        g.fillStyle = cell.col;
        g.fillRect(c * C, r * C, C, C);
      }
      // 細い線
      g.lineWidth = 1;
      g.strokeStyle = '#bdb4ae';
      g.beginPath();
      for (let r = 0; r <= d.rows; r++) { g.moveTo(0, r * C); g.lineTo(d.cols * C, r * C); }
      for (let c = 0; c <= d.cols; c++) { g.moveTo(c * C, 0); g.lineTo(c * C, d.rows * C); }
      g.stroke();
      // 10段・10目ごとの太い線（右下から数える）
      g.lineWidth = 2;
      g.strokeStyle = '#7d726c';
      g.beginPath();
      for (let r = 0; r <= d.rows; r++) if ((d.rows - r) % 10 === 0 || r === 0) { g.moveTo(0, r * C); g.lineTo(d.cols * C, r * C); }
      for (let c = 0; c <= d.cols; c++) if ((d.cols - c) % 10 === 0 || c === 0) { g.moveTo(c * C, 0); g.lineTo(c * C, d.rows * C); }
      g.stroke();
      // 記号
      for (const key in d.cells) {
        const cell = d.cells[key];
        if (!cell.s || !SYMBOLS[cell.s]) continue;
        const [r, c] = key.split(',').map(Number);
        const span = SYMBOLS[cell.s].span || 1;
        drawSymbol(g, cell.s, (c + span / 2) * C, (r + 0.5) * C, C, 0, cell.col || '#fff');
      }
      // 段数（右）と目数（下）
      g.fillStyle = '#6b5f5a';
      g.font = `${Math.round(C * 0.4)}px sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      for (let r = 0; r < d.rows; r++) g.fillText(String(d.rows - r), d.cols * C + C * 0.62, (r + 0.5) * C);
      for (let c = 0; c < d.cols; c++) g.fillText(String(d.cols - c), (c + 0.5) * C, d.rows * C + C * 0.55);
    } else {
      const S = FREE_CELLS * C, mid = S / 2;
      if (d.guides !== false) {
        g.strokeStyle = forExport ? '#efe9e5' : '#e3dad4';
        g.lineWidth = 1;
        for (let r = C; r < mid; r += C) { g.beginPath(); g.arc(mid, mid, r, 0, Math.PI * 2); g.stroke(); }
        g.beginPath();
        for (let a = 0; a < 12; a++) {
          const t = (a * Math.PI) / 6;
          g.moveTo(mid + Math.cos(t) * C, mid + Math.sin(t) * C);
          g.lineTo(mid + Math.cos(t) * (mid - C * 0.5), mid + Math.sin(t) * (mid - C * 0.5));
        }
        g.stroke();
      }
      d.stamps.forEach((st, i) => {
        drawSymbol(g, st.s, st.x, st.y, C, st.r || 0);
        if (!forExport && i === selected) {
          g.save();
          g.strokeStyle = '#2b6cb0'; g.lineWidth = 2; g.setLineDash([4, 3]);
          g.beginPath(); g.arc(st.x, st.y, C * 0.62, 0, Math.PI * 2); g.stroke();
          g.restore();
        }
      });
    }

    for (const s of d.strokes) drawStroke(g, s);

    if (!forExport && ghost) {
      g.globalAlpha = 0.45;
      drawSymbol(g, ghost.s, ghost.x, ghost.y, C, ghost.r);
      g.globalAlpha = 1;
    }
  }

  let renderQueued = false;
  function requestRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
  }
  function render() {
    if (!doc || !ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#e9e4e0';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr * view.s, 0, 0, dpr * view.s, dpr * view.ox, dpr * view.oy);
    const b = bounds(doc);
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.18)';
    ctx.shadowBlur = 12 / view.s;
    ctx.fillStyle = '#fff';
    ctx.fillRect(b.x, b.y, b.w, b.h);
    ctx.restore();
    drawDoc(ctx, doc, false);
  }

  function resizeCanvas() {
    if (!canvas) return;
    dpr = window.devicePixelRatio || 1;
    const w = el('edWrap').clientWidth, h = el('edWrap').clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    render();
  }

  function fitView() {
    const b = bounds(doc);
    const W = el('edWrap').clientWidth, H = el('edWrap').clientHeight;
    view.s = Math.min(W / b.w, H / b.h) * 0.94;
    view.ox = (W - b.w * view.s) / 2 - b.x * view.s;
    view.oy = (H - b.h * view.s) / 2 - b.y * view.s;
  }

  const toWorld = (sx, sy) => ({ x: (sx - view.ox) / view.s, y: (sy - view.oy) / view.s });
  function localXY(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /* ---------- 方眼のマスの操作 ---------- */
  function cellAt(w) {
    const c = Math.floor(w.x / C), r = Math.floor(w.y / C);
    if (r < 0 || c < 0 || r >= doc.rows || c >= doc.cols) return null;
    return { r, c };
  }
  function clearSym(key) {
    const cell = doc.cells[key];
    if (!cell) return;
    delete cell.s;
    if (!cell.col) delete doc.cells[key];
  }
  function setSym(r, c, id) {
    const span = SYMBOLS[id].span || 1;
    if (c + span > doc.cols) c = doc.cols - span;
    if (c < 0) return;
    for (let k = 0; k < span; k++) {
      const ow = cellOwner(doc, r, c + k);
      if (ow) clearSym(ow);
    }
    // 右側のマスから始まる記号が重なる場合も消す
    for (let k = 1; k < span; k++) {
      const key = r + ',' + (c + k);
      if (doc.cells[key] && doc.cells[key].s) clearSym(key);
    }
    const key = r + ',' + c;
    doc.cells[key] = Object.assign({}, doc.cells[key], { s: id });
  }
  function setColor(r, c, col) {
    const key = r + ',' + c;
    const cell = doc.cells[key] || {};
    if (col && col !== '#ffffff') cell.col = col; else delete cell.col;
    if (cell.s || cell.col) doc.cells[key] = cell; else delete doc.cells[key];
  }

  /* ---------- 消しゴム ---------- */
  function eraseAt(w) {
    const r = opt.eraser / view.s;
    let changed = false;
    const before = doc.strokes.length;
    doc.strokes = doc.strokes.filter((s) => {
      for (let i = 0; i < s.p.length; i += 3) {
        if (Math.hypot(s.p[i] - w.x, s.p[i + 1] - w.y) < r + s.w / 2) return false;
      }
      return true;
    });
    if (doc.strokes.length !== before) changed = true;
    if (doc.mode === 'grid') {
      const c0 = Math.floor((w.x - r) / C), c1 = Math.floor((w.x + r) / C);
      const r0 = Math.floor((w.y - r) / C), r1 = Math.floor((w.y + r) / C);
      for (let rr = Math.max(0, r0); rr <= Math.min(doc.rows - 1, r1); rr++) {
        for (let cc = Math.max(0, c0); cc <= Math.min(doc.cols - 1, c1); cc++) {
          const ow = cellOwner(doc, rr, cc);
          if (ow) { clearSym(ow); changed = true; }
          const key = rr + ',' + cc;
          if (doc.cells[key] && doc.cells[key].col) { setColor(rr, cc, null); changed = true; }
        }
      }
    } else {
      const n = doc.stamps.length;
      doc.stamps = doc.stamps.filter((st) => Math.hypot(st.x - w.x, st.y - w.y) > r + C * 0.35);
      if (doc.stamps.length !== n) { changed = true; selected = -1; }
    }
    return changed;
  }

  function stampRotation(w) {
    if (opt.autoCenter) {
      const mid = (FREE_CELLS * C) / 2;
      const dx = w.x - mid, dy = w.y - mid;
      if (Math.hypot(dx, dy) > C * 0.4) return Math.atan2(dy, dx) + Math.PI / 2;
    }
    return (opt.rotDeg * Math.PI) / 180;
  }

  /* ---------- 指・ペンの操作 ---------- */
  const pointers = new Map();
  let action = null;   // 今している操作
  let gesture = null;  // 2本指の移動・拡大

  function startGesture() {
    const pts = [...pointers.values()].filter((p) => p.type === 'touch');
    if (pts.length < 2) return;
    const [a, b] = pts;
    gesture = {
      d0: Math.hypot(a.x - b.x, a.y - b.y),
      m0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      s0: view.s, ox0: view.ox, oy0: view.oy,
    };
  }
  function updateGesture() {
    const pts = [...pointers.values()].filter((p) => p.type === 'touch');
    if (pts.length < 2) return;
    const [a, b] = pts;
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const s = Math.min(12, Math.max(0.1, gesture.s0 * d / gesture.d0));
    // 指の真ん中の点が、同じ場所を指したまま動くように
    const wx = (gesture.m0.x - gesture.ox0) / gesture.s0;
    const wy = (gesture.m0.y - gesture.oy0) / gesture.s0;
    view.s = s;
    view.ox = m.x - wx * s;
    view.oy = m.y - wy * s;
    requestRender();
  }

  function cancelAction() {
    if (!action) return;
    if (action.undo) restore(action.undo);
    undoStack.pop();
    updateUndoButtons();
    action = null;
    ghost = null;
    requestRender();
  }

  function beginAction(e, p) {
    const w = toWorld(p.x, p.y);
    const isFinger = e.pointerType === 'touch';
    let t = tool;
    if (isFinger && penOnly && t !== 'hand') t = 'hand';

    if (t === 'hand') {
      action = { t, last: p };
      return;
    }
    const undo = snapshot();
    pushUndo();
    action = { t, undo, id: e.pointerId, lastW: { x: w.x, y: w.y } };

    if (t === 'pen') {
      const pr = e.pointerType === 'touch' || !e.pressure ? 0.5 : e.pressure;
      action.stroke = { c: opt.penColor, w: opt.penWidth, p: [round1(w.x), round1(w.y), round2(pr)] };
      doc.strokes.push(action.stroke);
    } else if (t === 'eraser') {
      action.changed = eraseAt(w);
    } else if (t === 'stamp') {
      if (doc.mode === 'grid') {
        const cell = cellAt(w);
        if (cell) {
          const ow = cellOwner(doc, cell.r, cell.c);
          action.mode = ow && doc.cells[ow].s === opt.sym ? 'clear' : 'set';
          applyStampCell(cell);
        }
      } else {
        ghost = { s: opt.sym, x: w.x, y: w.y, r: stampRotation(w) };
      }
    } else if (t === 'fill') {
      const cell = cellAt(w);
      if (cell) {
        const cur = doc.cells[cell.r + ',' + cell.c];
        action.mode = cur && cur.col === opt.fillColor ? 'clear' : 'set';
        applyFillCell(cell);
      }
    } else if (t === 'move') {
      let best = -1, bd = C * 0.7;
      doc.stamps.forEach((st, i) => { const d = Math.hypot(st.x - w.x, st.y - w.y); if (d < bd) { bd = d; best = i; } });
      selected = best;
      buildOptions();
      if (best >= 0) action.grab = { dx: doc.stamps[best].x - w.x, dy: doc.stamps[best].y - w.y };
    }
    requestRender();
  }

  function applyStampCell(cell) {
    const key = cell.r + ',' + cell.c;
    if (action.lastKey === key) return;
    action.lastKey = key;
    if (action.mode === 'clear') {
      const ow = cellOwner(doc, cell.r, cell.c);
      if (ow) clearSym(ow);
    } else {
      setSym(cell.r, cell.c, opt.sym);
    }
  }
  function applyFillCell(cell) {
    const key = cell.r + ',' + cell.c;
    if (action.lastKey === key) return;
    action.lastKey = key;
    setColor(cell.r, cell.c, action.mode === 'clear' ? null : opt.fillColor);
  }

  function continueAction(e, p) {
    if (action.t === 'hand') {
      view.ox += p.x - action.last.x;
      view.oy += p.y - action.last.y;
      action.last = p;
      requestRender();
      return;
    }
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    const r = canvas.getBoundingClientRect();
    const points = [];
    for (const ev of (events.length ? events : [e])) {
      const w = toWorld(ev.clientX - r.left, ev.clientY - r.top);
      w.ev = ev;
      // 速くなぞったときに間のマスが抜けないよう、前の点との間を細かく補う
      if (action.t !== 'pen' && action.lastW) {
        const dx = w.x - action.lastW.x, dy = w.y - action.lastW.y;
        const n = Math.floor(Math.hypot(dx, dy) / (C / 3));
        for (let i = 1; i <= n; i++) points.push({ x: action.lastW.x + (dx * i) / (n + 1), y: action.lastW.y + (dy * i) / (n + 1), ev });
      }
      points.push(w);
      action.lastW = { x: w.x, y: w.y };
    }
    for (const w of points) {
      const ev = w.ev;
      if (action.t === 'pen') {
        const pts = action.stroke.p;
        const lx = pts[pts.length - 3], ly = pts[pts.length - 2];
        if (Math.hypot(w.x - lx, w.y - ly) < 0.6 / view.s) continue;
        const pr = ev.pointerType === 'touch' || !ev.pressure ? 0.5 : ev.pressure;
        pts.push(round1(w.x), round1(w.y), round2(pr));
      } else if (action.t === 'eraser') {
        if (eraseAt(w)) action.changed = true;
      } else if (action.t === 'stamp') {
        if (doc.mode === 'grid') {
          const span = SYMBOLS[opt.sym].span || 1;
          const cell = cellAt(w);
          if (cell && span === 1) applyStampCell(cell);
        } else if (ghost) {
          ghost.x = w.x; ghost.y = w.y; ghost.r = stampRotation(w);
        }
      } else if (action.t === 'fill') {
        const cell = cellAt(w);
        if (cell) applyFillCell(cell);
      } else if (action.t === 'move' && selected >= 0 && action.grab) {
        const st = doc.stamps[selected];
        st.x = w.x + action.grab.dx;
        st.y = w.y + action.grab.dy;
        if (opt.autoCenter) st.r = stampRotation(st);
        action.moved = true;
      }
    }
    requestRender();
  }

  function finishAction() {
    const a = action;
    action = null;
    if (!a || a.t === 'hand') return;
    if (a.t === 'stamp' && doc.mode !== 'grid' && ghost) {
      doc.stamps.push({ s: ghost.s, x: round1(ghost.x), y: round1(ghost.y), r: ghost.r });
      ghost = null;
    }
    const unchanged =
      (a.t === 'eraser' && !a.changed) ||
      (a.t === 'move' && !a.moved) ||
      ((a.t === 'stamp' || a.t === 'fill') && doc.mode === 'grid' && !a.lastKey);
    if (unchanged) { undoStack.pop(); updateUndoButtons(); }
    else scheduleSave();
    requestRender();
  }

  const round1 = (v) => Math.round(v * 10) / 10;
  const round2 = (v) => Math.round(v * 100) / 100;

  function setupPointer() {
    canvas.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const p = localXY(e);
      // ペンで描いている最中の手のひらは無視する
      if (e.pointerType === 'touch' && action && action.id !== undefined && pointers.get(action.id) && pointers.get(action.id).type === 'pen') return;
      canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: p.x, y: p.y, type: e.pointerType });

      if (e.pointerType === 'pen' && !penOnly) {
        penOnly = true;
        try { localStorage.setItem('penOnly', '1'); } catch (er) { /* 何もしない */ }
        toast('Apple Pencil を見つけました。ペンで描き、指で移動・拡大します');
      }

      const touches = [...pointers.values()].filter((q) => q.type === 'touch').length;
      if (e.pointerType === 'touch' && touches >= 2) {
        // 2本目の指：描きかけを取り消して、移動・拡大に切りかえる
        if (action && action.t !== 'hand') cancelAction();
        action = null;
        startGesture();
        return;
      }
      if (e.pointerType === 'pen' && action && action.t === 'hand') action = null; // 指で動かしている途中にペン
      if (gesture) return;
      if (!action) beginAction(e, p);
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      const p = localXY(e);
      pointers.set(e.pointerId, { x: p.x, y: p.y, type: e.pointerType });
      if (gesture) { updateGesture(); return; }
      if (action && (action.id === undefined || action.id === e.pointerId || action.t === 'hand')) continueAction(e, p);
    });

    const up = (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.delete(e.pointerId);
      if (gesture) {
        if ([...pointers.values()].filter((q) => q.type === 'touch').length < 2) gesture = null;
        return;
      }
      if (action && (action.id === undefined || action.id === e.pointerId)) {
        if (e.type === 'pointercancel' && action.t !== 'hand') cancelAction();
        else finishAction();
      }
    };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);

    // パソコン：ホイールで移動、Ctrl + ホイールで拡大
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = localXY(e);
      if (e.ctrlKey) {
        const s = Math.min(12, Math.max(0.1, view.s * Math.exp(-e.deltaY * 0.003)));
        const w = toWorld(p.x, p.y);
        view.s = s;
        view.ox = p.x - w.x * s;
        view.oy = p.y - w.y * s;
      } else {
        view.ox -= e.deltaX;
        view.oy -= e.deltaY;
      }
      requestRender();
    }, { passive: false });
  }

  /* ---------- 道具ごとの設定欄 ---------- */
  function buildOptions() {
    const box = el('edOptions');
    let html = '';
    if (tool === 'pen') {
      html = `<div class="opt-row">${PEN_COLORS.map((c) => `<button class="swatch${c === opt.penColor ? ' on' : ''}" data-pen-color="${c}" style="background:${c}" aria-label="色"></button>`).join('')}
        <span class="opt-gap"></span>
        ${PEN_WIDTHS.map(([n, w]) => `<button class="chip-btn${w === opt.penWidth ? ' on' : ''}" data-pen-width="${w}">${n}</button>`).join('')}</div>`;
    } else if (tool === 'stamp') {
      const ids = Object.keys(SYMBOLS).filter((id) => SYMBOLS[id].set === opt.symSet && !(doc.mode !== 'grid' && SYMBOLS[id].span > 1));
      html = `<div class="opt-row">
          <div class="seg small-seg">
            <button data-sym-set="knit" class="${opt.symSet === 'knit' ? 'on' : ''}">棒針</button>
            <button data-sym-set="crochet" class="${opt.symSet === 'crochet' ? 'on' : ''}">かぎ針</button>
          </div>
          <span class="opt-note">${doc.mode === 'grid' ? '同じ記号をもう一度タップすると消えます' : 'タップした場所に置きます'}</span>
        </div>
        <div class="sym-list">${ids.map((id) => `<button class="sym-btn${id === opt.sym ? ' on' : ''}" data-sym="${id}"><img src="${symbolIcon(id)}" alt=""><span>${SYMBOLS[id].name}</span></button>`).join('')}</div>`;
      if (doc.mode !== 'grid') {
        html += `<div class="opt-row">
          <label class="check"><input type="checkbox" id="optAuto" ${opt.autoCenter ? 'checked' : ''}> 中心に向ける</label>
          <span class="opt-gap"></span>
          <button class="chip-btn" data-rot="-15">↺</button><span class="opt-note">${opt.rotDeg}°</span><button class="chip-btn" data-rot="15">↻</button>
        </div>`;
      }
    } else if (tool === 'fill') {
      html = `<div class="opt-row">${FILL_COLORS.map((c) => `<button class="swatch${c === opt.fillColor ? ' on' : ''}" data-fill="${c}" style="background:${c}" aria-label="色"></button>`).join('')}</div>
        <div class="opt-note">マスをなぞると塗れます。同じ色のマスをタップすると消えます</div>`;
    } else if (tool === 'eraser') {
      html = `<div class="opt-row"><span class="opt-note">大きさ</span>
        <button class="chip-btn${opt.eraser === 8 ? ' on' : ''}" data-eraser="8">小</button>
        <button class="chip-btn${opt.eraser === 14 ? ' on' : ''}" data-eraser="14">中</button>
        <button class="chip-btn${opt.eraser === 30 ? ' on' : ''}" data-eraser="30">大</button>
        <span class="opt-note">線は1本まるごと消えます</span></div>`;
    } else if (tool === 'move') {
      html = selected >= 0
        ? `<div class="opt-row"><span class="opt-note">選んだ記号：</span>
            <button class="chip-btn" data-sel-rot="-15">↺ 15°</button>
            <button class="chip-btn" data-sel-rot="15">↻ 15°</button>
            <button class="chip-btn danger" data-sel-del="1">削除</button></div>`
        : '<div class="opt-note">記号をドラッグすると動かせます。タップで選ぶと回転・削除できます</div>';
    } else {
      html = '<div class="opt-note">1本指でドラッグして移動、2本指で拡大・縮小します</div>';
    }
    box.innerHTML = html;
  }

  function setupOptions() {
    el('edOptions').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const d = b.dataset;
      if (d.penColor) opt.penColor = d.penColor;
      if (d.penWidth) opt.penWidth = parseFloat(d.penWidth);
      if (d.symSet) {
        opt.symSet = d.symSet;
        const first = Object.keys(SYMBOLS).find((id) => SYMBOLS[id].set === opt.symSet);
        if (SYMBOLS[opt.sym].set !== opt.symSet) opt.sym = first;
      }
      if (d.sym) opt.sym = d.sym;
      if (d.rot) { opt.rotDeg = (opt.rotDeg + parseInt(d.rot, 10) + 360) % 360; opt.autoCenter = false; }
      if (d.fill) opt.fillColor = d.fill;
      if (d.eraser) opt.eraser = parseInt(d.eraser, 10);
      if (d.selRot && selected >= 0) {
        pushUndo();
        const st = doc.stamps[selected];
        st.r = (st.r || 0) + (parseInt(d.selRot, 10) * Math.PI) / 180;
        scheduleSave(); requestRender();
      }
      if (d.selDel && selected >= 0) {
        pushUndo();
        doc.stamps.splice(selected, 1);
        selected = -1;
        scheduleSave(); requestRender();
      }
      const keepScroll = el('edOptions').querySelector('.sym-list');
      const sl = keepScroll ? keepScroll.scrollLeft : 0;
      buildOptions();
      const nl = el('edOptions').querySelector('.sym-list');
      if (nl) nl.scrollLeft = sl;
    });
    el('edOptions').addEventListener('change', (e) => {
      if (e.target.id === 'optAuto') { opt.autoCenter = e.target.checked; }
    });
  }

  function setTool(t) {
    tool = t;
    if (t !== 'move') selected = -1;
    document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
    buildOptions();
    requestRender();
  }

  /* ---------- 画像にする ---------- */
  function exportCanvas(maxSide) {
    const b = bounds(doc);
    const k = Math.min(3, maxSide / Math.max(b.w, b.h));
    const c = document.createElement('canvas');
    c.width = Math.round(b.w * k);
    c.height = Math.round(b.h * k);
    const g = c.getContext('2d');
    g.setTransform(k, 0, 0, k, -b.x * k, -b.y * k);
    const sel = selected; selected = -1;
    drawDoc(g, doc, true);
    selected = sel;
    return { canvas: c, k, b };
  }
  function makeThumb() {
    const { canvas: c } = exportCanvas(240);
    try { return c.toDataURL('image/jpeg', 0.8); } catch (e) { return null; }
  }

  // 編む画面へ送る
  async function knit() {
    busy('編む画面を準備中…');
    try {
      doc.thumb = makeThumb();
      const { canvas: c, k, b } = exportCanvas(2400);
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      let meta = null;
      if (doc.patternId) meta = (await getAllMeta()).find((m) => m.id === doc.patternId) || null;
      if (!meta) {
        meta = {
          id: newId(), created: Date.now(), chartId: doc.id,
          state: { page: 0, row: 1, y: 0.85, h: 0.04, dir: 'up', zoom: 1, dim: true, snap: false, rot: 0, quarter: 0 },
        };
        doc.patternId = meta.id;
      }
      meta.name = doc.name;
      meta.pageCount = 1;
      meta.chartId = doc.id;
      const s = meta.state;
      s.page = 0; s.rot = 0; s.quarter = 0;
      if (doc.mode === 'grid') {
        // 今の段の位置に帯をぴったり置く（1段目 = いちばん下）
        const row = Math.min(Math.max(1, s.row), doc.rows);
        s.h = (C * k) / c.height;
        s.y = (((doc.rows - row) * C - b.y) * k) / c.height;
        s.dir = 'up';
        s.snap = false;
      }
      await addPattern(meta, [blob]);
      await saveNow();
      busy(null);
      close(false);
      openViewer(meta.id);
    } catch (err) {
      busy(null);
      console.error(err);
      alert('準備に失敗しました。\n' + (err.message || err));
    }
  }

  /* ---------- ダイアログ ---------- */
  function showModal(html, onReady) {
    el('modalBox').innerHTML = html;
    el('modal').hidden = false;
    if (onReady) onReady(el('modalBox'));
  }
  function hideModal() { el('modal').hidden = true; el('modalBox').innerHTML = ''; }

  function newChartDialog() {
    showModal(`
      <h2>新しい編み図</h2>
      <label class="field"><span>名前</span><input id="ncName" value="新しい編み図"></label>
      <div class="field"><span>種類</span>
        <div class="type-list">
          <label><input type="radio" name="ncType" value="knit" checked> 棒針（方眼）</label>
          <label><input type="radio" name="ncType" value="crochet-grid"> かぎ針（方眼）</label>
          <label><input type="radio" name="ncType" value="crochet-free"> かぎ針（円・自由）</label>
        </div>
      </div>
      <div id="ncSize" class="size-row">
        <label class="field"><span>目数（横）</span><input id="ncCols" type="number" min="1" max="200" value="20" inputmode="numeric"></label>
        <label class="field"><span>段数（たて）</span><input id="ncRows" type="number" min="1" max="300" value="30" inputmode="numeric"></label>
      </div>
      <div class="modal-actions"><button id="ncCancel" class="sub">やめる</button><button id="ncOk" class="primary">作る</button></div>
    `, (box) => {
      box.querySelectorAll('input[name=ncType]').forEach((r) => {
        r.onchange = () => { el('ncSize').hidden = r.value === 'crochet-free' && r.checked; };
      });
      el('ncCancel').onclick = hideModal;
      el('ncOk').onclick = async () => {
        const type = box.querySelector('input[name=ncType]:checked').value;
        const cols = Math.min(200, Math.max(1, parseInt(el('ncCols').value, 10) || 20));
        const rows = Math.min(300, Math.max(1, parseInt(el('ncRows').value, 10) || 30));
        const d = {
          id: newId(),
          name: el('ncName').value.trim() || '新しい編み図',
          created: Date.now(),
          kind: type,
          mode: type === 'crochet-free' ? 'free' : 'grid',
          cols, rows, cells: {}, strokes: [], stamps: [], guides: true,
        };
        await putChart(d);
        hideModal();
        open(d.id);
      };
    });
  }

  function menuDialog() {
    const grid = doc.mode === 'grid';
    showModal(`
      <h2>設定</h2>
      ${grid ? `<div class="size-row">
        <label class="field"><span>目数（横）</span><input id="mdCols" type="number" min="1" max="200" value="${doc.cols}" inputmode="numeric"></label>
        <label class="field"><span>段数（たて）</span><input id="mdRows" type="number" min="1" max="300" value="${doc.rows}" inputmode="numeric"></label>
      </div>
      <p class="opt-note">段を増やすと上に、目を増やすと左に追加されます。</p>` : `
      <label class="check"><input id="mdGuides" type="checkbox" ${doc.guides !== false ? 'checked' : ''}> 円のガイド線を表示</label>`}
      <label class="check"><input id="mdPen" type="checkbox" ${penOnly ? 'checked' : ''}> ペンだけで描く（指では移動・拡大）</label>
      <div class="modal-actions">
        <button id="mdDelete" class="sub danger">この編み図を削除</button>
        <button id="mdOk" class="primary">OK</button>
      </div>
    `, () => {
      el('mdOk').onclick = () => {
        penOnly = el('mdPen').checked;
        try { localStorage.setItem('penOnly', penOnly ? '1' : '0'); } catch (e) { /* 何もしない */ }
        if (grid) {
          const cols = Math.min(200, Math.max(1, parseInt(el('mdCols').value, 10) || doc.cols));
          const rows = Math.min(300, Math.max(1, parseInt(el('mdRows').value, 10) || doc.rows));
          if (cols !== doc.cols || rows !== doc.rows) resizeGrid(cols, rows);
        } else {
          doc.guides = el('mdGuides').checked;
        }
        scheduleSave();
        hideModal();
        buildOptions();
        requestRender();
      };
      el('mdDelete').onclick = async () => {
        if (!confirm(`「${doc.name}」を削除しますか？`)) return;
        const id = doc.id;
        hideModal();
        doc = null;
        await deleteChart(id);
        close(true);
      };
    });
  }

  // 右下を基準にして大きさを変える（段は上、目は左に増減）
  function resizeGrid(cols, rows) {
    pushUndo();
    const dr = rows - doc.rows, dc = cols - doc.cols;
    const cells = {};
    for (const key in doc.cells) {
      const [r, c] = key.split(',').map(Number);
      const nr = r + dr, nc = c + dc;
      if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) cells[nr + ',' + nc] = doc.cells[key];
    }
    doc.cells = cells;
    doc.strokes.forEach((s) => { for (let i = 0; i < s.p.length; i += 3) { s.p[i] += dc * C; s.p[i + 1] += dr * C; } });
    doc.cols = cols;
    doc.rows = rows;
    fitView();
  }

  /* ---------- 開く・閉じる ---------- */
  async function open(id) {
    const d = await getChart(id);
    if (!d) { toast('編み図が見つかりません'); return; }
    doc = d;
    doc.strokes = doc.strokes || [];
    doc.stamps = doc.stamps || [];
    doc.cells = doc.cells || {};
    undoStack = []; redoStack = [];
    updateUndoButtons();
    selected = -1;
    ghost = null;
    opt.symSet = doc.kind === 'knit' ? 'knit' : 'crochet';
    opt.sym = opt.symSet === 'knit' ? 'k' : 'sc';
    document.querySelector('[data-tool=fill]').hidden = doc.mode !== 'grid';
    document.querySelector('[data-tool=move]').hidden = doc.mode === 'grid';

    el('home').hidden = true;
    el('viewer').hidden = true;
    el('editor').hidden = false;
    el('edTitle').textContent = doc.name;
    setTool('stamp');   // 先に道具の欄を作ってから、残りの大きさに合わせる
    resizeCanvas();
    fitView();
    render();
  }

  async function close(skipSave) {
    if (doc && !skipSave) {
      doc.thumb = makeThumb();
      await saveNow();
    }
    doc = null;
    el('editor').hidden = true;
    el('home').hidden = false;
    renderHome();
  }

  function init() {
    canvas = el('edCanvas');
    ctx = canvas.getContext('2d');
    setupPointer();
    setupOptions();
    document.querySelectorAll('[data-tool]').forEach((b) => { b.onclick = () => setTool(b.dataset.tool); });
    el('edBack').onclick = () => close(false);
    el('edKnit').onclick = knit;
    el('edMenu').onclick = menuDialog;
    el('edUndo').onclick = () => { if (!undoStack.length) return; redoStack.push(snapshot()); restore(undoStack.pop()); };
    el('edRedo').onclick = () => { if (!redoStack.length) return; undoStack.push(snapshot()); restore(redoStack.pop()); };
    el('edTitle').onclick = () => {
      const name = prompt('名前を変更', doc.name);
      if (name && name.trim()) { doc.name = name.trim(); el('edTitle').textContent = doc.name; scheduleSave(); }
    };
    el('modal').addEventListener('click', (e) => { if (e.target.id === 'modal') hideModal(); });
    // 画面の向きを変えたときや、道具の欄の高さが変わったときに描く場所を合わせ直す
    if (window.ResizeObserver) new ResizeObserver(() => { if (doc) resizeCanvas(); }).observe(el('edWrap'));
    else window.addEventListener('resize', () => { if (doc) resizeCanvas(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && doc) saveNow(); });
    document.addEventListener('keydown', (e) => {
      if (!doc || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); (e.shiftKey ? el('edRedo') : el('edUndo')).click(); }
    });
  }

  return { init, open, newChartDialog, get isOpen() { return !!doc; } };
})();
