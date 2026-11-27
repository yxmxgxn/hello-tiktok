// TikTok の公式アカウントのプロフィールを順に開いて、画面が読み込んだ投稿を拾う(ログアウトした状態で使う)。
// TikTok への問い合わせは自分では作らない。確認画面(パズル)は手で解く。その間は待つだけで、回避はしない。
// 進み具合は localStorage、拾った投稿は IndexedDB(どちらも tiktok.com の中)に置き、最後に JSON を1つ保存する。
// 合言葉は扱わない(本番に入れるのは、手元の collect/upload.py)。
(() => {
  // 順に回るアカウント(足すときはここに書く)
  const ACCOUNTS = [
    "morningmusume_uf", "angerme_uf", "juicejuice_uf", "tsubakifactory_uf",
    "beyooooonds_", "ocha_norma", "rosy_chronicle",
  ];
  const NEW_DAYS = 14;   // 「新着だけ」で、前の記録がないときにさかのぼる日数
  const PINNED_MAX = 3;  // ピン留めは3件まで。これより多く古い投稿が見えたら、新着は読み終えた
  const IDLE_MAX = 8;    // 一覧が増えないまま、この回数スクロールしたら終わりとみなす
  const KEY = "hpCollect", LAST = "hpCollectLast";

  if (window.top !== window || window.__hpCollect) return;
  window.__hpCollect = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const load = (k) => { try { return JSON.parse(localStorage.getItem(k)) || null; } catch (e) { return null; } };
  const store = (k, v) => localStorage.setItem(k, JSON.stringify(v));
  const jst = (sec) => new Date((sec + 9 * 3600) * 1000).toISOString().slice(0, 16).replace("T", " ");
  const now = () => Math.floor(Date.now() / 1000);
  const account = (location.pathname.match(/^\/@([^/]+)\/?$/) || [])[1] || "";

  /* ---------- 保存先(IndexedDB) ---------- */
  function db(mode, fn) {
    return new Promise((ok, ng) => {
      const open = indexedDB.open(KEY, 1);
      open.onupgradeneeded = () => open.result.createObjectStore("accounts", { keyPath: "account" });
      open.onerror = () => ng(open.error);
      open.onsuccess = () => {
        const tx = open.result.transaction("accounts", mode);
        const req = fn(tx.objectStore("accounts"));
        tx.oncomplete = () => { open.result.close(); ok(req.result); };
        tx.onerror = () => { open.result.close(); ng(tx.error); };
      };
    });
  }

  /* ---------- 画面 ---------- */
  const panel = document.createElement("div");
  panel.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#fff;color:#000;border:2px solid #000;padding:12px;font:14px/1.6 sans-serif;width:280px";
  const status = document.createElement("div");
  const buttons = document.createElement("div");
  panel.append(status, buttons);
  const say = (text) => { status.textContent = text; };
  function setButtons(list) {
    buttons.textContent = "";
    for (const [label, onclick] of list) {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.cssText = "margin:8px 8px 0 0;padding:4px 12px;border:1px solid #000;background:#fff;color:#000;cursor:pointer";
      b.onclick = onclick;
      buttons.append(b);
    }
  }

  /* ---------- 画面のデータを読む ---------- */
  const posts = new Map();
  const total = (() => {
    try {
      const data = JSON.parse(document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__").textContent);
      const info = data.__DEFAULT_SCOPE__["webapp.user-detail"].userInfo;
      return info.user.uniqueId.toLowerCase() === account.toLowerCase() ? Number(info.stats.videoCount) : null;
    } catch (e) {
      return null;
    }
  })();

  function add(item) {
    if (String(item.author.uniqueId).toLowerCase() !== account.toLowerCase()) return;
    const sec = Number(item.createTime);
    const music = item.music || {};
    posts.set(String(item.id), {
      id: String(item.id), account, createTime: sec, ts: jst(sec),
      permalink: `https://www.tiktok.com/@${account}/video/${item.id}`,
      // desc は改行がなくなっているので、行ごとに分かれた contents があれば改行でつなぐ
      caption: item.contents && item.contents.length ? item.contents.map((c) => c.desc || "").join("\n") : item.desc,
      music: music.id ? { id: String(music.id), title: music.title || "", author: music.authorName || "", original: !!music.original } : null,
    });
  }

  // 画面(React)が持っているデータの中から、投稿の形をしたものを探す(持っているのは直近に読み込んだ分だけ)
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

  const grid = () => document.querySelectorAll('[data-e2e="user-post-item"]');
  // 画面に並んでいるのに、中身を取れていない投稿
  const missing = () => [...document.querySelectorAll('[data-e2e="user-post-item"] a[href]')]
    .map((a) => (a.href.match(/\/(?:video|photo)\/(\d+)/) || [])[1])
    .filter((id) => id && !posts.has(id)).length;
  const captcha = () => !!document.querySelector('#captcha-verify-container-main-page, .captcha-verify-container, #captcha_container');

  let stopped = false;
  async function watch(ms) {
    for (let t = 0; t < ms && !stopped; t += 150) {
      await sleep(150);
      scan();
    }
  }
  async function waitHuman() {
    while (!stopped && captcha()) {
      say(`@${account}: パズルを解いてください`);
      await sleep(500);
    }
  }

  // 下まで読み足しながら拾う。enough() が true になったら、そこで終わる
  async function sweep(enough, note) {
    let idle = 0;
    while (!stopped && !enough() && idle < IDLE_MAX) {
      await waitHuman();
      say(`@${account}: ${posts.size} / ${total ?? "?"} 件。${note}`);
      // 下に着いたまま次が読み込まれないときは、少し上に戻ってから、もう一度下りる
      if (idle >= 3) { window.scrollBy(0, -1500); await watch(600); }
      const before = posts.size + grid().length;
      const items = grid();
      if (items.length) items[items.length - 1].scrollIntoView({ block: "center" });
      window.scrollBy(0, 600);
      await watch(1500 + Math.random() * 1000);
      idle = posts.size + grid().length > before ? 0 : idle + 1;
    }
  }

  // 並び順を切り替えて、一覧を最初から読み直させる。取り逃しなしで並べば true
  async function reorder(label) {
    const b = [...document.querySelectorAll("button")].find((e) => e.innerText.trim() === label);
    if (!b) return false;
    window.scrollTo(0, 0);
    b.click();
    say(`@${account}: 「${label}」で読み直しています…`);
    await watch(1500);
    for (let i = 0; i < 20 && !stopped; i++) {
      await waitHuman();
      if (grid().length && !missing()) return true;
      await watch(500);
    }
    return false;
  }

  /* ---------- 1アカウント分 ---------- */
  async function collect(mode) {
    // 投稿が並ぶまで待つ(パズルが出ていれば、その間に手で解く)
    while (!stopped && !grid().length) {
      say(`@${account}: 投稿が並ぶのを待っています(パズルが出ていたら解いてください)`);
      await watch(500);
    }
    await watch(1000);
    if (stopped) return null;

    if (mode === "new") {
      const last = (load(LAST) || {})[account];
      const cutoff = last ? last - 86400 : now() - NEW_DAYS * 86400;
      const reached = () => [...posts.values()].filter((p) => p.createTime < cutoff).length > PINNED_MAX ||
        (total !== null && posts.size >= total);
      const clean = !missing();
      if (clean) await sweep(reached, "新着を読んでいます");
      return { full: false, ok: clean && !missing() && reached() };
    }

    const complete = () => total !== null && posts.size >= total;
    // 一覧のほぼ全部(プロフィールの数との差は3件まで)を、取り逃しなく見終えた
    const covered = () => total !== null && grid().length >= total - 3 && !missing();
    let done = false;
    if (!missing()) {
      await sweep(complete, "収集中…(画面は触らないでください)");
      done = complete() || covered();
    }
    for (const label of ["古い順", "最新", "人気"]) {
      if (done || stopped) break;
      if (!(await reorder(label))) continue;
      await sweep(complete, "収集中…(画面は触らないでください)");
      done = complete() || covered();
    }
    return { full: done, ok: done };
  }

  /* ---------- 順に回る ---------- */
  const open = (user) => { location.href = `https://www.tiktok.com/@${user}`; };

  async function keep(result) {
    const prev = await db("readonly", (s) => s.get(account));
    const merged = new Map((prev ? prev.posts : []).map((p) => [p.id, p]));
    for (const [id, p] of posts) merged.set(id, p);
    const list = [...merged.values()].sort((a, b) => b.createTime - a.createTime);
    await db("readwrite", (s) => s.put({ account, total, full: result.full || !!(prev && prev.full), ok: result.ok, posts: list }));
    // 次の「新着だけ」は、今回の最後の投稿から先を読む(取り切れたときだけ進める)
    if (result.ok && list.length) store(LAST, { ...(load(LAST) || {}), [account]: list[0].createTime });
  }

  async function save() {
    const rows = await db("readonly", (s) => s.getAll());
    if (!rows.length) return say("保存するものがありません");
    const stamp = jst(now());
    const body = JSON.stringify({ source: "extension", collectedAt: stamp, accounts: rows }, null, 1);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([body], { type: "application/json" }));
    a.download = `tiktok_official_${stamp.replace(/\D/g, "")}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  function finish(state) {
    store(KEY, { ...state, running: false });
    const bad = state.failed.length ? ` 足りないかもしれない: ${state.failed.map((u) => "@" + u).join(" ")}` : "";
    say(`終わりました。JSON を保存しました。${bad}`);
    save();
    setButtons([["もう一度保存", save], ["閉じる", () => panel.remove()]]);
  }

  async function next(state, failed) {
    if (failed) state.failed.push(state.queue[state.index]);
    state.index++;
    state.tries = 0;
    store(KEY, state);
    if (state.index >= state.queue.length) return finish(state);
    say("次のアカウントに移ります…");
    await sleep(3000);
    if ((load(KEY) || {}).running) open(state.queue[state.index]);
  }

  async function start(mode) {
    await db("readwrite", (s) => s.clear());
    store(KEY, { running: true, mode, queue: ACCOUNTS, index: 0, tries: 0, failed: [] });
    open(ACCOUNTS[0]);
  }

  function idle() {
    stopped = true;
    const state = load(KEY);
    say(`公式 ${ACCOUNTS.length} アカウントを順に取ります`);
    const list = [["新着だけ", () => start("new")], ["全部", () => start("all")]];
    if (state && state.index < state.queue.length) {
      list.push(["続きから", () => { store(KEY, { ...state, running: true, tries: 0 }); open(state.queue[state.index]); }]);
    }
    list.push(["保存", save]);
    setButtons(list);
  }

  async function run() {
    const state = load(KEY);
    if (!state || !state.running) return idle();
    const user = state.queue[state.index];
    const quit = () => { stopped = true; store(KEY, { ...load(KEY), running: false }); idle(); };
    const skip = () => { stopped = true; next(state, true); };
    setButtons([["停止", quit], ["この人を飛ばす", skip]]);
    if (account.toLowerCase() !== user.toLowerCase()) {
      // 開き直しても別の画面になるときは、止まって人に任せる
      if (state.tries >= 2) return say(`@${user} の画面を開けません。「この人を飛ばす」か「停止」を押してください`);
      store(KEY, { ...state, tries: state.tries + 1 });
      say(`@${user} を開きます…`);
      await sleep(2000);
      if ((load(KEY) || {}).running) open(user);
      return;
    }
    say(`(${state.index + 1} / ${state.queue.length}) @${account}`);
    const result = await collect(state.mode);
    if (!result || stopped) return;
    await keep(result);
    if (result.ok) return next(state, false);
    say(`@${account}: ${posts.size} / ${total ?? "?"} 件。足りないかもしれません`);
    setButtons([["もう一度", () => location.reload()], ["次へ", () => next(state, true)], ["停止", quit]]);
  }

  // 一覧のページ(プロフィール)か、回っている途中だけ、右下に出す
  if (account || (load(KEY) || {}).running) {
    document.body.append(panel);
    run().catch((e) => say("エラー: " + e.message));
  }
})();
