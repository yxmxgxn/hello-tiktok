// TikTok のプロフィール画面で動かすブックマークレットの本体(ログアウトした状態で使う)。
// 画面がすでに読み込んだ投稿データを拾うだけで、TikTok への問い合わせは自分では作らない。
// 下へ少しずつスクロールして、出てきた分を足していく。「保存」でアカウントごとの JSON を保存する。
// 画面が中身(本文など)を持っているのは直近に読み込んだ1回分だけ。先に読み込まれた分があるときや、
// 足りないときは、並び順(古い順・最新・人気)を切り替えて一覧を読み直し、取れた分を合わせる。
// 確認画面(パズルなど)が出たら手で対応する。進まなくなったら止まる(回避はしない)。
(() => {
  const m = location.pathname.match(/^\/@([^/]+)\/?$/);
  if (!location.hostname.endsWith("tiktok.com") || !m) {
    alert("TikTok のプロフィール画面(tiktok.com/@ユーザー名)で押してください");
    return;
  }
  if (window.__ttCollect) window.__ttCollect.close();

  const account = decodeURIComponent(m[1]);
  const posts = new Map();
  let running = true;

  // プロフィールに出ている投稿数。ページを直接開いたときだけ分かる(分からなければ null)
  const total = (() => {
    try {
      const data = JSON.parse(document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__").textContent);
      const info = data.__DEFAULT_SCOPE__["webapp.user-detail"].userInfo;
      return info.user.uniqueId.toLowerCase() === account.toLowerCase() ? Number(info.stats.videoCount) : null;
    } catch (e) {
      return null;
    }
  })();

  const jst = (sec) => new Date((sec + 9 * 3600) * 1000).toISOString().slice(0, 16).replace("T", " ");

  function add(item) {
    // おすすめや再投稿など、この人以外の投稿は入れない
    if (String(item.author.uniqueId).toLowerCase() !== account.toLowerCase()) return;
    const sec = Number(item.createTime);
    const music = item.music || {};
    posts.set(String(item.id), {
      id: String(item.id),
      account,
      createTime: sec,
      ts: jst(sec),
      permalink: `https://www.tiktok.com/@${account}/video/${item.id}`,
      // desc は改行がなくなっているので、行ごとに分かれた contents があれば改行でつなぐ
      caption: item.contents && item.contents.length ? item.contents.map((c) => c.desc || "").join("\n") : item.desc,
      music: music.id
        ? { id: String(music.id), title: music.title || "", author: music.authorName || "", original: !!music.original }
        : null,
    });
  }

  // 画面(React)が持っているデータの中から、投稿の形をしたものを探す
  function scan() {
    const el = [...document.querySelectorAll('[data-e2e="user-post-item"], [data-e2e="user-post-item-list"], #app, body > div')]
      .find((e) => Object.keys(e).some((k) => k.startsWith("__reactFiber") || k.startsWith("__reactContainer")));
    if (!el) return;
    let root = el[Object.keys(el).find((k) => k.startsWith("__reactFiber") || k.startsWith("__reactContainer"))];
    while (root.return) root = root.return;
    if (root.stateNode && root.stateNode.current) root = root.stateNode.current;

    const seen = new WeakSet();
    const look = (v, depth) => {
      if (!v || typeof v !== "object" || depth > 5 || seen.has(v)) return;
      seen.add(v);
      if (v instanceof Node || v === window || v.$$typeof) return;
      if (v.id && v.createTime && typeof v.desc === "string" && v.author && v.author.uniqueId) return add(v);
      if (v instanceof Map) return v.forEach((x) => look(x, depth + 1));
      for (const k of Object.keys(v)) {
        if (k.startsWith("__react") || k === "_owner") continue;
        let x;
        try { x = v[k]; } catch (e) { continue; }
        look(x, depth + 1);
      }
    };

    const stack = [root];
    while (stack.length) {
      const f = stack.pop();
      look(f.memoizedProps, 0);
      let st = f.memoizedState;
      for (let n = 0; st && typeof st === "object" && n < 60; n++) {
        if (!("next" in st)) { look(st, 0); break; }
        look(st.memoizedState, 0);
        st = st.next;
      }
      if (f.sibling) stack.push(f.sibling);
      if (f.child) stack.push(f.child);
    }
  }

  const panel = document.createElement("div");
  panel.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#fff;color:#000;border:2px solid #000;padding:12px;font:14px/1.6 sans-serif;width:260px";
  const status = document.createElement("div");
  const button = (label, onclick) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText = "margin:8px 8px 0 0;padding:4px 12px;border:1px solid #000;background:#fff;color:#000;cursor:pointer";
    b.onclick = onclick;
    return b;
  };
  const show = (note) => {
    status.textContent = `@${account}: ${posts.size} / ${total === null ? "?" : total} 件。${note}`;
  };

  // 画面に並んでいるのに、中身を取れていない投稿
  const missing = () => [...document.querySelectorAll('[data-e2e="user-post-item"] a[href]')]
    .map((a) => (a.href.match(/\/(?:video|photo)\/(\d+)/) || [])[1])
    .filter((id) => id && !posts.has(id)).length;

  function save() {
    const list = [...posts.values()].sort((a, b) => b.createTime - a.createTime);
    const now = jst(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ source: "bookmarklet", account, total, missing: missing(), collectedAt: now, posts: list }, null, 1);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([body], { type: "application/json" }));
    a.download = `tiktok_${account}_${now.replace(/\D/g, "")}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  function close() {
    running = false;
    panel.remove();
  }

  panel.append(status, button("停止", () => { running = false; }), button("保存", save), button("閉じる", close));
  document.body.append(panel);
  window.__ttCollect = { posts, close };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const IDLE_MAX = 8; // 一覧が増えないまま、この回数スクロールしたら次へ(約16秒)
  const grid = () => document.querySelectorAll('[data-e2e="user-post-item"]');
  const alive = () => running && panel.isConnected;
  const captcha = () => !!document.querySelector('#captcha-verify-container-main-page, .captcha-verify-container, #captcha_container');
  const complete = () => total !== null && posts.size >= total;

  // 確認画面が出ている間は何もせず、手で解くのを待つ
  async function waitHuman() {
    while (alive() && captcha()) {
      show("確認画面を手で解いてください");
      await sleep(500);
    }
  }

  // 次の読み込みで中身が入れ替わる前に拾えるよう、こまめに見る
  async function watch(ms) {
    for (let t = 0; t < ms && alive(); t += 150) {
      await sleep(150);
      scan();
    }
  }

  // 並び順を切り替えて、一覧を最初から読み直させる。取り逃しなしで並べば true
  async function reorder(label) {
    const b = [...document.querySelectorAll("button")].find((e) => e.innerText.trim() === label);
    if (!b) return false;
    window.scrollTo(0, 0);
    b.click();
    show(`「${label}」で読み直しています…`);
    await watch(1500);
    for (let i = 0; i < 20 && alive(); i++) {
      await waitHuman();
      if (grid().length && !missing()) return true;
      await watch(500);
    }
    return false;
  }

  // 下まで読み足しながら拾う
  async function sweep() {
    let idle = 0;
    while (alive() && !complete() && idle < IDLE_MAX) {
      await waitHuman();
      show("収集中…(画面は触らないでください)");
      const before = posts.size + grid().length;
      const items = grid();
      if (items.length) items[items.length - 1].scrollIntoView({ block: "center" });
      window.scrollBy(0, 600);
      await watch(1500 + Math.random() * 1000);
      idle = posts.size + grid().length > before ? 0 : idle + 1;
    }
  }

  // 一覧のほぼ全部(プロフィールの数との差は3件まで)を、取り逃しなく見終えた
  const covered = () => total !== null && grid().length >= total - 3 && !missing();

  (async () => {
    // 投稿が並ぶまで待つ(確認画面が出ていれば、その間に手で解く)
    while (alive() && !grid().length) {
      show("投稿が並ぶのを待っています…");
      await sleep(500);
    }
    await watch(1000);
    let done = false;
    if (alive() && !missing()) {
      await sweep();
      done = complete() || covered();
    }
    for (const label of ["古い順", "最新", "人気"]) {
      if (done || !alive()) break;
      if (!(await reorder(label))) continue;
      await sweep();
      done = complete() || covered();
    }
    running = false;
    if (!panel.isConnected) return;
    // プロフィールの数と、画面に並ぶ数が少し違うことがある(103件の表示で、並ぶのは102件など)
    if (complete()) show("全部そろいました");
    else if (done) show("終わりました。一覧に並んだ分は全部取れました");
    else show("止まりました。足りないかもしれません。「保存」してから、時間をおいて押し直してください");
  })();
})();
