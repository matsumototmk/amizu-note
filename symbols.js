'use strict';

/* =========================================================
   編み目記号の形
   それぞれの記号は、幅1・高さ1のマス（中心が 0,0、下向きが +y）に描く。
   span が 2 以上の記号（交差編み）は、横に span マス分の幅を使う。
   ========================================================= */

const SYMBOLS = (() => {
  const line = (g, x1, y1, x2, y2) => { g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); };
  const circle = (g, x, y, r, fill) => { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); fill ? g.fill() : g.stroke(); };
  const ellipse = (g, x, y, rx, ry, fill) => { g.beginPath(); g.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); fill ? g.fill() : g.stroke(); };
  const cross = (g, x, y, r) => { line(g, x - r, y - r, x + r, y + r); line(g, x + r, y - r, x - r, y + r); };

  // かぎ針の「柱」を、根元(bx,by)から頭(tx,ty)へ向けて描く
  // kind: 'sc' 細編み / 'hdc' 中長編み / 'dc' 長編み / 'tr' 長々編み
  function stem(g, kind, bx, by, tx, ty) {
    const dx = tx - bx, dy = ty - by, L = Math.hypot(dx, dy);
    const ux = dx / L, uy = dy / L;      // 柱の向き
    const px = -uy, py = ux;             // 柱に直角な向き
    if (kind === 'sc') {
      line(g, bx, by, tx, ty);
      const mx = bx + dx * 0.55, my = by + dy * 0.55;
      cross(g, mx, my, 0.09);
      return;
    }
    line(g, bx, by, tx, ty);
    line(g, tx - px * 0.17, ty - py * 0.17, tx + px * 0.17, ty + py * 0.17); // 頭の横棒
    const slashes = kind === 'dc' ? [0.5] : kind === 'tr' ? [0.4, 0.62] : [];
    for (const t of slashes) {
      const mx = bx + dx * t, my = by + dy * t;
      line(g, mx + px * 0.12 - ux * 0.06, my + py * 0.12 - uy * 0.06,
              mx - px * 0.12 + ux * 0.06, my - py * 0.12 + uy * 0.06);
    }
  }

  // 交差編み（over: 上になる側）
  function cable(g, span, over, bg) {
    const n = span / 2, half = span / 2;
    const right = [], left = [];
    for (let i = 0; i < n; i++) {
      right.push([i + n - half + 0.5, 0.42, i - half + 0.5, -0.42]); // 右の目 → 左へ
      left.push([i - half + 0.5, 0.42, i + n - half + 0.5, -0.42]);  // 左の目 → 右へ
    }
    const under = over === 'right' ? left : right;
    const top = over === 'right' ? right : left;
    under.forEach((l) => line(g, ...l));
    const lw = g.lineWidth;
    g.strokeStyle = bg; g.lineWidth = lw * 3.2;
    top.forEach((l) => line(g, ...l));
    g.strokeStyle = '#222'; g.lineWidth = lw;
    top.forEach((l) => line(g, ...l));
  }

  return {
    /* ---------- 棒針 ---------- */
    k:     { set: 'knit', name: '表目', draw: (g) => line(g, 0, -0.36, 0, 0.36) },
    p:     { set: 'knit', name: '裏目', draw: (g) => line(g, -0.34, 0, 0.34, 0) },
    yo:    { set: 'knit', name: 'かけ目', draw: (g) => circle(g, 0, 0, 0.26) },
    k2tog: { set: 'knit', name: '左上2目一度', draw: (g) => {
      line(g, -0.32, 0.36, 0.0, -0.3); line(g, 0.32, 0.36, 0.0, -0.3);
      line(g, 0.0, -0.3, 0.16, -0.38); // 左の目が上
    } },
    ssk:   { set: 'knit', name: '右上2目一度', draw: (g) => {
      line(g, -0.32, 0.36, 0.0, -0.3); line(g, 0.32, 0.36, 0.0, -0.3);
      line(g, 0.0, -0.3, -0.16, -0.38); // 右の目が上
    } },
    s2kp:  { set: 'knit', name: '中上3目一度', draw: (g) => {
      line(g, -0.32, 0.36, 0, -0.34); line(g, 0.32, 0.36, 0, -0.34); line(g, 0, 0.36, 0, -0.34);
    } },
    ktbl:  { set: 'knit', name: 'ねじり目', draw: (g) => {
      g.beginPath();
      g.moveTo(-0.14, 0.38);
      g.bezierCurveTo(0.3, -0.05, 0.25, -0.38, 0, -0.38);
      g.bezierCurveTo(-0.25, -0.38, -0.3, -0.05, 0.14, 0.38);
      g.stroke();
    } },
    sl:    { set: 'knit', name: 'すべり目', draw: (g) => { line(g, -0.28, -0.34, 0, 0.34); line(g, 0.28, -0.34, 0, 0.34); } },
    bo:    { set: 'knit', name: '伏せ目', draw: (g) => circle(g, 0, 0, 0.17, true) },
    none:  { set: 'knit', name: '目なし', draw: (g) => { g.fillStyle = '#b9b2ad'; g.fillRect(-0.5, -0.5, 1, 1); } },
    c1r:   { set: 'knit', name: '右上1目交差', span: 2, draw: (g, s, bg) => cable(g, s, 'right', bg) },
    c1l:   { set: 'knit', name: '左上1目交差', span: 2, draw: (g, s, bg) => cable(g, s, 'left', bg) },
    c2r:   { set: 'knit', name: '右上2目交差', span: 4, draw: (g, s, bg) => cable(g, s, 'right', bg) },
    c2l:   { set: 'knit', name: '左上2目交差', span: 4, draw: (g, s, bg) => cable(g, s, 'left', bg) },

    /* ---------- かぎ針 ---------- */
    ch:     { set: 'crochet', name: 'くさり編み', draw: (g) => ellipse(g, 0, 0, 0.3, 0.15) },
    slst:   { set: 'crochet', name: '引き抜き編み', draw: (g) => ellipse(g, 0, 0, 0.2, 0.12, true) },
    sc:     { set: 'crochet', name: '細編み', draw: (g) => cross(g, 0, 0, 0.24) },
    hdc:    { set: 'crochet', name: '中長編み', draw: (g) => stem(g, 'hdc', 0, 0.4, 0, -0.36) },
    dc:     { set: 'crochet', name: '長編み', draw: (g) => stem(g, 'dc', 0, 0.4, 0, -0.36) },
    tr:     { set: 'crochet', name: '長々編み', draw: (g) => stem(g, 'tr', 0, 0.4, 0, -0.36) },
    sc2inc: { set: 'crochet', name: '細編み2目編み入れ', draw: (g) => { stem(g, 'sc', 0, 0.4, -0.27, -0.36); stem(g, 'sc', 0, 0.4, 0.27, -0.36); } },
    sc2tog: { set: 'crochet', name: '細編み2目一度', draw: (g) => { stem(g, 'sc', -0.27, 0.4, 0, -0.36); stem(g, 'sc', 0.27, 0.4, 0, -0.36); } },
    dc2inc: { set: 'crochet', name: '長編み2目編み入れ', draw: (g) => { stem(g, 'dc', 0, 0.4, -0.27, -0.36); stem(g, 'dc', 0, 0.4, 0.27, -0.36); } },
    dc2tog: { set: 'crochet', name: '長編み2目一度', draw: (g) => { stem(g, 'dc', -0.27, 0.4, 0, -0.36); stem(g, 'dc', 0.27, 0.4, 0, -0.36); } },
    dc3cl:  { set: 'crochet', name: '長編み3目の玉編み', draw: (g) => {
      line(g, -0.27, 0.4, 0, -0.32); line(g, 0, 0.4, 0, -0.32); line(g, 0.27, 0.4, 0, -0.32);
      line(g, -0.16, -0.36, 0.16, -0.36);
      ellipse(g, 0, 0.06, 0.22, 0.2);
    } },
  };
})();

// 記号を描く。x, y は記号の中心、size は1マスの大きさ、rot は回転（ラジアン）
function drawSymbol(g, id, x, y, size, rot, bg) {
  const sym = SYMBOLS[id];
  if (!sym) return;
  g.save();
  g.translate(x, y);
  if (rot) g.rotate(rot);
  g.scale(size, size);
  g.lineWidth = 0.07;
  g.strokeStyle = '#222';
  g.fillStyle = '#222';
  g.lineCap = 'round';
  g.lineJoin = 'round';
  sym.draw(g, sym.span || 1, bg || '#fff');
  g.restore();
}

// ボタン用の小さな絵（データURL）
const symbolIconCache = {};
function symbolIcon(id) {
  if (symbolIconCache[id]) return symbolIconCache[id];
  const sym = SYMBOLS[id];
  const span = sym.span || 1;
  const W = 88, H = 64;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const size = Math.min(H * 0.9, (W * 0.9) / span);
  drawSymbol(g, id, W / 2, H / 2, size, 0, '#fff');
  return (symbolIconCache[id] = c.toDataURL());
}
