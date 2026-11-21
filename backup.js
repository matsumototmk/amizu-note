'use strict';

/* =========================================================
   あみ図ノート  バックアップ
   - 端末の中に保存しているもの（編み図の画像・段数・帯の位置・書き込み・
     描いた編み図・グループ・手書きメモ）を、1つのファイルにまとめる
   - そのファイルから元に戻す（この端末にだけあるものは消さない。
     同じものがあるときは、新しいほうを残す）
   ファイルの形：
     "AMIZU1\n"（7バイト）＋ 中身の説明の長さ（4バイト）＋ 中身の説明（JSON）
     ＋ 画像をそのまま並べたもの（説明の中に、どこから何バイトかを書いておく）
   画像を文字に変えずにそのまま入れるので、ファイルが大きくなりすぎない。
   ========================================================= */

const Backup = (() => {
  const MAGIC = 'AMIZU1\n';
  const el = (id) => document.getElementById(id);
  const all = (store) => dbRun(store, 'readonly', (t) => t.objectStore(store).getAll());
  const stamp = (x) => (x && (x.updated || x.created)) || 0;

  /* ---------- 作る ---------- */
  async function make() {
    const [meta, pages, charts, groups, notes] = await Promise.all(['meta', 'pages', 'charts', 'groups', 'notes'].map(all));
    const parts = [];
    let off = 0;
    const pageIndex = pages.map((p) => ({
      id: p.id,
      blobs: p.blobs.map((b) => {
        const item = { off, len: b.size, type: b.type || 'image/jpeg' };
        parts.push(b);
        off += b.size;
        return item;
      }),
    }));
    const header = new TextEncoder().encode(JSON.stringify({
      app: 'amizu-note', version: 1, created: Date.now(),
      meta, charts, groups, notes, pages: pageIndex,
    }));
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, header.length, true);
    return { blob: new Blob([MAGIC, len, header, ...parts], { type: 'application/octet-stream' }), count: meta.length + charts.length };
  }

  function fileName() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `amizu-backup-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.amizu`;
  }

  function markDone() {
    try { localStorage.setItem('lastBackup', String(Date.now())); } catch (e) { /* 何もしない */ }
    renderInfo();
  }

  async function save() {
    busy('バックアップを作っています…');
    let made;
    try {
      made = await make();
    } catch (err) {
      busy(null);
      console.error(err);
      alert('バックアップを作れませんでした。\n' + (err.message || err));
      return;
    }
    busy(null);
    if (!made.count) { toast('まだ保存するものがありません'); return; }
    const file = new File([made.blob], fileName(), { type: 'application/octet-stream' });
    const mb = (made.blob.size / 1024 / 1024).toFixed(1);

    // iPhone・iPad：共有メニューから「"ファイル"に保存」できるようにする
    const touch = navigator.maxTouchPoints > 0;
    if (touch && navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'あみ図ノートのバックアップ' });
        markDone();
        toast(`バックアップを保存しました（${mb}MB）`);
      } catch (err) {
        if (err.name !== 'AbortError') { console.error(err); download(file, mb); }
      }
      return;
    }
    download(file, mb);
  }

  // パソコンなど：ふつうのダウンロード
  function download(file, mb) {
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    markDone();
    toast(`バックアップを保存しました（${mb}MB）`);
  }

  /* ---------- 読む ---------- */
  async function readFile(file) {
    const buf = await file.arrayBuffer();
    const head = new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(MAGIC.length, buf.byteLength)));
    if (head !== MAGIC) throw new Error('あみ図ノートのバックアップファイルではないようです。');
    const len = new DataView(buf, MAGIC.length, 4).getUint32(0, true);
    const start = MAGIC.length + 4;
    const data = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, start, len)));
    if (data.app !== 'amizu-note') throw new Error('あみ図ノートのバックアップファイルではないようです。');
    const base = start + len;
    const blobsOf = (p) => p.blobs.map((b) => new Blob([buf.slice(base + b.off, base + b.off + b.len)], { type: b.type }));
    return { data, blobsOf };
  }

  async function restore(file) {
    busy('バックアップを読み込んでいます…');
    let read;
    try {
      read = await readFile(file);
    } catch (err) {
      busy(null);
      console.error(err);
      alert('読み込めませんでした。\n' + (err.message || err));
      return;
    }
    const { data, blobsOf } = read;
    const [meta, charts, groups, notes] = await Promise.all(['meta', 'charts', 'groups', 'notes'].map(all));
    busy(null);

    // 同じものがこの端末にもあるときは、新しいほうを残す
    const pick = (list, here) => {
      const map = new Map(here.map((x) => [x.id, x]));
      const add = [], upd = [];
      for (const x of list || []) {
        const h = map.get(x.id);
        if (!h) add.push(x);
        else if (stamp(x) > stamp(h)) upd.push(x);
      }
      return { add, upd, put: add.concat(upd) };
    };
    const m = pick(data.meta, meta), c = pick(data.charts, charts), g = pick(data.groups, groups), n = pick(data.notes, notes);
    const total = m.put.length + c.put.length + g.put.length + n.put.length;
    const when = new Date(data.created).toLocaleString('ja-JP', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    if (!total) {
      alert(`${when} のバックアップです。\nこの端末には、もう全部入っています（新しく入れるものはありません）。`);
      return;
    }
    const line = (name, r) => (r.put.length ? `・${name}：新しく ${r.add.length}件、更新 ${r.upd.length}件\n` : '');
    const ok = confirm(`${when} のバックアップを読み込みます。\n\n`
      + line('取り込んだ編み図', m) + line('描いた編み図', c) + line('グループ', g) + line('手書きメモ', n)
      + '\nこの端末にだけあるものは消えません。同じものがあるときは、新しいほうを残します。');
    if (!ok) return;

    busy('元に戻しています…');
    try {
      const pages = new Map((data.pages || []).map((p) => [p.id, p]));
      await dbRun(['meta', 'pages', 'charts', 'groups', 'notes'], 'readwrite', (t) => {
        for (const x of m.put) {
          t.objectStore('meta').put(x);
          const p = pages.get(x.id);
          if (p) t.objectStore('pages').put({ id: p.id, blobs: blobsOf(p) });
        }
        c.put.forEach((x) => t.objectStore('charts').put(x));
        g.put.forEach((x) => t.objectStore('groups').put(x));
        n.put.forEach((x) => t.objectStore('notes').put(x));
      });
      busy(null);
      await renderHome();
      toast('バックアップから戻しました');
    } catch (err) {
      busy(null);
      console.error(err);
      alert('元に戻せませんでした。\n' + (err.message || err));
    }
  }

  /* ---------- 表示 ---------- */
  function renderInfo() {
    let last = 0;
    try { last = parseInt(localStorage.getItem('lastBackup'), 10) || 0; } catch (e) { /* 何もしない */ }
    const info = el('backupInfo');
    if (!last) {
      info.textContent = 'まだバックアップしていません。';
      info.classList.add('warn');
      return;
    }
    const days = Math.floor((Date.now() - last) / 86400000);
    const d = new Date(last).toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' });
    info.textContent = `前回のバックアップ：${d}` + (days >= 30 ? `（${days}日前です。そろそろ保存しておきましょう）` : '');
    info.classList.toggle('warn', days >= 30);
  }

  function init() {
    el('backupSave').onclick = save;
    el('backupFile').addEventListener('change', (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (f) restore(f);
    });
    renderInfo();
  }

  return { init, make, readFile, restore };
})();
