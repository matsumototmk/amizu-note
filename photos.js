'use strict';

/* =========================================================
   あみ図ノート  プロジェクトの写真
   - 写真を画面いっぱいに大きく見る（左右の ‹ › で前後の写真へ）
   - 「✎ 書く」で、写真にペンで書き込む（Apple Pencil の筆圧も）
   - 「⋯」から表紙にする・削除
   書き込みは写真の大きさに対する割合（0〜1）で、プロジェクトの photos[i].ink に入れる。
   ========================================================= */

const PhotoView = (() => {
  const COLORS = ['#ffffff', '#222222', '#d62f2f', '#2b6cb0', '#f6c90e'];
  const WIDTH = 0.006; // ペンの太さ（写真の幅に対する割合）
  const el = (id) => document.getElementById(id);

  let proj = null;      // 見ているプロジェクト
  let index = 0;        // 何枚目の写真か
  let url = null;
  let writing = false;
  let tool = 'pen';
  let color = COLORS[2];
  let undo = [];
  let stroke = null;
  let box = { w: 1, h: 1 }; // 画面に出している写真の大きさ（ピクセル）
  let dirty = false;
  const dpr = () => window.devicePixelRatio || 1;
  const photo = () => proj.photos[index];

  /* ---------- 表示 ---------- */
  async function show() {
    const ph = photo();
    if (!ph) return close();
    const blob = await getPhotoBlob(ph.id, false);
    if (url) URL.revokeObjectURL(url);
    url = blob ? URL.createObjectURL(blob) : '';
    const img = el('pvImg');
    img.onload = layout;
    img.src = url;
    el('pvTitle').textContent = `${proj.name}（${index + 1} / ${proj.photos.length}）` + (proj.cover === ph.id ? ' 表紙' : '');
    el('pvPrev').hidden = index === 0 || writing;
    el('pvNext').hidden = index >= proj.photos.length - 1 || writing;
  }

  // 写真を画面に収まる大きさにして、書き込み用のキャンバスをぴったり重ねる
  function layout() {
    const img = el('pvImg');
    const wrap = el('pvWrap');
    const W = wrap.clientWidth, H = wrap.clientHeight;
    const iw = img.naturalWidth || 1, ih = img.naturalHeight || 1;
    const k = Math.min(W / iw, H / ih);
    box = { w: Math.round(iw * k), h: Math.round(ih * k) };
    for (const e of [img, el('pvInk')]) {
      e.style.width = box.w + 'px';
      e.style.height = box.h + 'px';
      e.style.left = Math.round((W - box.w) / 2) + 'px';
      e.style.top = Math.round((H - box.h) / 2) + 'px';
    }
    const c = el('pvInk');
    c.width = Math.round(box.w * dpr());
    c.height = Math.round(box.h * dpr());
    draw();
  }

  function draw() {
    const c = el('pvInk');
    const g = c.getContext('2d');
    g.setTransform(dpr(), 0, 0, dpr(), 0, 0);
    g.clearRect(0, 0, box.w, box.h);
    for (const s of (photo() && photo().ink) || []) drawStroke(g, s);
  }

  function drawStroke(g, s) {
    const p = s.p, W = box.w, H = box.h, lw = s.w * W;
    g.strokeStyle = g.fillStyle = s.c;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    // 白い線は写真の上で見えるよう、うすい影をつける
    g.shadowColor = s.c === '#ffffff' ? 'rgba(0,0,0,.45)' : 'transparent';
    g.shadowBlur = s.c === '#ffffff' ? lw * 0.8 : 0;
    if (p.length <= 3) { g.beginPath(); g.arc(p[0] * W, p[1] * H, lw * 0.6, 0, Math.PI * 2); g.fill(); return; }
    for (let i = 3; i < p.length; i += 3) seg(g, p, i, lw, W, H);
    g.shadowBlur = 0;
  }
  function seg(g, p, i, lw, W, H) {
    g.lineWidth = lw * (0.4 + (p[i - 1] + p[i + 2]) * 0.6);
    g.beginPath();
    g.moveTo(p[i - 3] * W, p[i - 2] * H);
    g.lineTo(p[i] * W, p[i + 1] * H);
    g.stroke();
  }

  /* ---------- 書き込み ---------- */
  function penOnly() {
    try { return localStorage.getItem('penOnly') === '1'; } catch (e) { return false; }
  }
  function toPt(ev) {
    const r = el('pvInk').getBoundingClientRect();
    return { x: Math.round(((ev.clientX - r.left) / r.width) * 1e5) / 1e5, y: Math.round(((ev.clientY - r.top) / r.height) * 1e5) / 1e5 };
  }

  function eraseAt(pt) {
    const ph = photo();
    const r = 16 / box.w;
    const before = ph.ink.length;
    const segDist = (ax, ay, bx, by) => {
      // 写真の縦横の比をそろえて距離を測る
      const a = box.h / box.w;
      const dx = bx - ax, dy = (by - ay) * a, L = dx * dx + dy * dy;
      const px = pt.x - ax, py = (pt.y - ay) * a;
      const t = L ? Math.min(1, Math.max(0, (px * dx + py * dy) / L)) : 0;
      return Math.hypot(px - dx * t, py - dy * t);
    };
    ph.ink = ph.ink.filter((s) => {
      const p = s.p, lim = r + s.w / 2;
      if (p.length <= 3) return segDist(p[0], p[1], p[0], p[1]) >= lim;
      for (let i = 3; i < p.length; i += 3) if (segDist(p[i - 3], p[i - 2], p[i], p[i + 1]) < lim) return false;
      return true;
    });
    return ph.ink.length !== before;
  }

  function setupInk() {
    const c = el('pvInk');
    const touches = new Set();
    c.addEventListener('pointerdown', (e) => {
      if (!writing) return;
      if (e.pointerType === 'touch') {
        touches.add(e.pointerId);
        if (penOnly() || touches.size > 1 || (stroke && stroke.pen)) return;
      }
      if (stroke) return;
      e.preventDefault();
      c.setPointerCapture(e.pointerId);
      const ph = photo();
      if (!ph.ink) ph.ink = [];
      undo.push(JSON.stringify(ph.ink));
      const pt = toPt(e);
      stroke = { id: e.pointerId, pen: e.pointerType === 'pen' };
      if (tool === 'eraser') {
        stroke.erase = true;
        if (eraseAt(pt)) { dirty = true; draw(); }
      } else {
        const pr = e.pointerType === 'pen' && e.pressure ? e.pressure : 0.5;
        stroke.s = { c: color, w: WIDTH, p: [pt.x, pt.y, Math.round(pr * 100) / 100] };
        ph.ink.push(stroke.s);
        dirty = true;
        draw();
      }
    });
    c.addEventListener('pointermove', (e) => {
      if (!stroke || e.pointerId !== stroke.id) return;
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      for (const ev of (evs.length ? evs : [e])) {
        const pt = toPt(ev);
        if (stroke.erase) { if (eraseAt(pt)) { dirty = true; draw(); } continue; }
        const p = stroke.s.p;
        if (Math.abs(pt.x - p[p.length - 3]) + Math.abs(pt.y - p[p.length - 2]) < 0.001) continue;
        const pr = ev.pointerType === 'pen' && ev.pressure ? ev.pressure : 0.5;
        p.push(pt.x, pt.y, Math.round(pr * 100) / 100);
        const g = c.getContext('2d');
        g.setTransform(dpr(), 0, 0, dpr(), 0, 0);
        g.strokeStyle = stroke.s.c;
        g.lineCap = 'round';
        g.shadowColor = stroke.s.c === '#ffffff' ? 'rgba(0,0,0,.45)' : 'transparent';
        g.shadowBlur = stroke.s.c === '#ffffff' ? WIDTH * box.w * 0.8 : 0;
        seg(g, p, p.length - 3, stroke.s.w * box.w, box.w, box.h);
      }
    });
    const up = (e) => {
      if (e.pointerType === 'touch') touches.delete(e.pointerId);
      if (!stroke || e.pointerId !== stroke.id) return;
      stroke = null;
      draw();
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('touchstart', (e) => {
      if (writing && [...e.changedTouches].some((t) => t.touchType === 'stylus')) e.preventDefault();
    }, { passive: false });
  }

  function setWriting(on) {
    writing = on;
    el('photoView').classList.toggle('pv-writing', on);
    el('pvTools').hidden = !on;
    el('pvWrite').textContent = on ? '' : '✎ 書く';
    el('pvWrite').hidden = on;
    if (on) undo = [];
    renderTools();
    show();
    if (!on) save();
  }

  function renderTools() {
    document.querySelectorAll('[data-pv-tool]').forEach((b) => b.classList.toggle('on', b.dataset.pvTool === tool));
    el('pvColors').innerHTML = COLORS.map((c) =>
      `<button class="swatch${c === color ? ' on' : ''}" data-pv-color="${c}" style="background:${c}" aria-label="色"></button>`).join('');
  }

  async function save() {
    if (!dirty || !proj) return;
    dirty = false;
    proj.updated = Date.now();
    await putGroup(proj);
  }

  /* ---------- メニュー ---------- */
  function menu() {
    const ph = photo();
    sheet(`
      <h2>この写真</h2>
      <div class="menu-list">
        <button data-act="cover">${proj.cover === ph.id ? '✓ 表紙になっています' : '表紙にする'}</button>
        ${(ph.ink || []).length ? '<button data-act="clear">書き込みを全部消す</button>' : ''}
        <button data-act="del" class="danger">この写真を削除</button>
      </div>
      <div class="modal-actions"><button class="sub" data-act="close">閉じる</button></div>
    `, (b) => {
      b.onclick = async (e) => {
        const t = e.target.closest('[data-act]');
        if (!t) return;
        const act = t.dataset.act;
        if (act === 'close') closeSheet();
        if (act === 'cover') { proj.cover = ph.id; dirty = true; await save(); closeSheet(); show(); toast('表紙にしました'); }
        if (act === 'clear') {
          if (!confirm('この写真の書き込みを全部消しますか？')) return;
          ph.ink = []; dirty = true; await save(); closeSheet(); draw();
        }
        if (act === 'del') {
          if (!confirm('この写真を削除しますか？\n（元に戻せません）')) return;
          await deletePhotoBlob(ph.id);
          proj.photos.splice(index, 1);
          if (proj.cover === ph.id) delete proj.cover;
          dirty = true;
          await save();
          closeSheet();
          if (!proj.photos.length) { close(); return; }
          index = Math.min(index, proj.photos.length - 1);
          show();
        }
      };
    });
  }

  /* ---------- 開く・閉じる ---------- */
  function open(g, i) {
    proj = g;
    index = i;
    dirty = false;
    el('photoView').hidden = false;
    setWriting(false);
  }

  async function close() {
    if (writing) { writing = false; el('pvTools').hidden = true; el('photoView').classList.remove('pv-writing'); el('pvWrite').hidden = false; }
    await save();
    el('photoView').hidden = true;
    el('pvImg').removeAttribute('src');
    if (url) { URL.revokeObjectURL(url); url = null; }
    proj = null;
    renderHome();
  }

  function init() {
    setupInk();
    el('pvBack').onclick = close;
    el('pvWrite').onclick = () => setWriting(true);
    el('pvDone').onclick = () => setWriting(false);
    el('pvMenu').onclick = menu;
    el('pvPrev').onclick = () => { if (index > 0) { index--; show(); } };
    el('pvNext').onclick = () => { if (index < proj.photos.length - 1) { index++; show(); } };
    el('pvUndo').onclick = () => {
      const u = undo.pop();
      if (u === undefined) { toast('戻せる書き込みはありません'); return; }
      photo().ink = JSON.parse(u);
      dirty = true;
      draw();
    };
    document.querySelectorAll('[data-pv-tool]').forEach((b) => { b.onclick = () => { tool = b.dataset.pvTool; renderTools(); }; });
    el('pvColors').addEventListener('click', (e) => {
      const b = e.target.closest('[data-pv-color]');
      if (!b) return;
      color = b.dataset.pvColor;
      tool = 'pen';
      renderTools();
    });
    window.addEventListener('resize', () => { if (proj) layout(); });
    // 左右にさっとなでると、前後の写真へ（書いていないとき）
    let sw = null;
    el('pvWrap').addEventListener('pointerdown', (e) => { if (!writing) sw = { x: e.clientX, y: e.clientY }; });
    el('pvWrap').addEventListener('pointerup', (e) => {
      if (!sw || writing) return;
      const dx = e.clientX - sw.x, dy = e.clientY - sw.y;
      sw = null;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) (dx < 0 ? el('pvNext') : el('pvPrev')).click();
    });
  }

  return { init, open };
})();
