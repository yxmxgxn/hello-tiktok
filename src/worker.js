/**
 * ハロプロ TikTok検索 Worker (Static Assets 併用)
 *
 * 公開API
 *   GET /api/posts?a=&act=&m=&order=&from=&to=&q=&before=
 *       投稿を新しい順に100件ずつ。a はユーザー名のカンマ区切り。act=1 は(a が無いとき)現役グループの人だけ。m は楽曲ID
 *   GET /api/calendar?ym=YYYY-MM&a=&q=    その月の日ごとの投稿数(a / q の条件込み)。ym なしなら月ごとの投稿数
 *   GET /api/accounts                     絞り込み用のアカウント一覧
 *   GET /api/day?d=YYYY-MM-DD             その日の投稿を時刻の順に(/day のページ用)
 *   POST /api/takedown                    削除・公開停止の依頼(about のフォーム)。Discord にも知らせる
 *
 * 管理用API (Authorization: Bearer <CRAWL_TOKEN>。未設定なら存在しないことにする)
 *   POST /api/crawl/accounts   対象アカウントを丸ごと差し替え(外れた人は active=0)。remove の人は投稿ごと消す
 *   POST /api/crawl/posts      { account, posts } ブックマークレットで集めた投稿を書く(1回100件まで)
 *   POST /api/crawl/apify      Apify の Webhook から。データセットを読んで書く。失敗の知らせは Discord へ
 *   GET  /api/crawl/takedown   削除依頼の一覧
 *   POST /api/crawl/takedown   { id, action: "done" | "undo" | "delete" }
 *   POST /api/crawl/remove     { id } 投稿を1件消す
 *
 * 定期実行: 毎日 JST 20:00 に、収録件数・新着・取り込みの異常を Discord へ送る(DISCORD_WEBHOOK)
 *
 * それ以外は静的アセット(public/)へ。考え方はインスタ版(hello-insta)と同じ。
 */

const MAX_Q = 100;         // 検索語の長さの上限
const PAGE = 100;          // 1回に返す投稿数
const WRITE_MAX = 100;     // 1回に書く投稿数
const EXCERPT_LEN = 80;    // 一覧に出す本文の先頭の文字数
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^\d{15,25}$/;

/* ============================ 正規化・bigram ============================ */

// 索引と検索で完全に同じものを使う: NFKC→小文字→日本語と英数字以外を除去(# も消えるので「ハロプロ」で #ハロプロ に当たる)
const DROP = /[^0-9a-z々぀-ヿ㐀-䶿一-鿿]/gu;

function normalize(s) {
  return (s || "").normalize("NFKC").toLowerCase().replace(DROP, "");
}

function bigrams(s) {
  const out = [];
  for (let i = 0; i + 1 < s.length; i++) out.push(s.slice(i, i + 2));
  return out;
}

// 検索語 → FTS5 のクエリ。語ごとに bigram のフレーズ(連続一致≒部分一致)にして AND で繋ぐ。
// 「-」で始まる語は、含まない語(NOT)。含まない語だけのときは { onlyNot: true }(探せない)
function buildMatch(q) {
  const terms = [], nots = [];
  for (const raw of q.slice(0, MAX_Q).split(/[\s　]+/)) {
    const neg = /^[-－‐−]/.test(raw);
    const toks = bigrams(normalize(neg ? raw.slice(1) : raw));
    if (toks.length) (neg ? nots : terms).push('"' + toks.join(" ") + '"');
  }
  if (!terms.length) return nots.length ? { onlyNot: true } : null;
  let match = terms.join(" AND ");
  if (nots.length) match = `(${match})` + nots.map((p) => ` NOT (${p})`).join("");
  return { match };
}

/* ============================ 共通 ============================ */

function json(obj, status = 200, cache = "no-store") {
  return new Response(JSON.stringify(obj), {
    status,
    // API の中身は検索エンジンに載せない
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": cache, "x-robots-tag": "noindex" },
  });
}

async function cached(request, ctx, build) {
  const cache = caches.default;
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await build();
  if (res.status === 200) ctx.waitUntil(cache.put(request, res.clone()));
  return res;
}

// UNIX秒 → JST の '2026-10-13 19:00'
function jstOf(sec) {
  return new Date((sec + 9 * 3600) * 1000).toISOString().slice(0, 16).replace("T", " ");
}

const nowJst = () => jstOf(Math.floor(Date.now() / 1000));
const agoJst = (hours) => jstOf(Math.floor(Date.now() / 1000 - hours * 3600));

// 合言葉を聞く画面(Basic 認証)
function locked() {
  return new Response("この画面は非公開です。\n", {
    status: 401,
    headers: {
      "www-authenticate": 'Basic realm="hello-tiktok", charset="UTF-8"',
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

// 長さの違いで中身が漏れないよう、最後まで見てから比べる
function same(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// 合言葉が合っているか(Basic認証の形。利用者名は何でもよく、合言葉だけを見る)
function unlocked(request, pass) {
  const got = request.headers.get("authorization") || "";
  if (!got.startsWith("Basic ")) return false;
  let decoded = "";
  try {
    decoded = new TextDecoder().decode(Uint8Array.from(atob(got.slice(6)), (c) => c.charCodeAt(0)));
  } catch {
    return false;
  }
  return same(decoded.slice(decoded.indexOf(":") + 1), pass);
}

function authorized(request, env) {
  return !!env.CRAWL_TOKEN && same(request.headers.get("authorization") || "", `Bearer ${env.CRAWL_TOKEN}`);
}

// 片割れになったサロゲート(切り方で絵文字が割れたもの)を取り除く
function dropBroken(s) {
  return String(s || "").replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

async function discord(env, payload) {
  if (!env.DISCORD_WEBHOOK) return false;
  const r = await fetch(env.DISCORD_WEBHOOK, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // ウェブフックはほかのサイトと共用でもよい。送り主の表示だけ変える
    body: JSON.stringify({ username: "TikTok 検索", allowed_mentions: { parse: [] }, ...payload }),
  }).catch(() => null);
  return !!(r && r.ok);
}

/* ============================ 公開API ============================ */

// 「ハロプロ現役のみ」の対象の見出し(account.section の頭)。collect/accounts.py の GROUPS と同じものを保つ
const ACTIVE_SECTIONS = ["モーニング娘。", "アンジュルム", "Juice=Juice", "つばきファクトリー", "BEYOOOOONDS", "OCHA NORMA", "ロージークロニクル"];

// 検索語のうち、色を付ける・抜粋を合わせる語(「-」の語は除く)。正規化したもの
function searchTerms(q) {
  return q.slice(0, MAX_Q).split(/[\s　]+/)
    .filter((w) => w && !/^[-－‐−]/.test(w))
    .map(normalize).filter((w) => w.length >= 2);
}

// 本文から、検索語が最初に当たった箇所の前後を、excerpt と同じ長さ(EXCERPT_LEN 文字)で切り出す。
// 当たった箇所が先頭の近くなら null(いつもの先頭の抜粋のまま)
const SNIP_BEFORE = 20;   // 当たった語の前に残す文字数
function snippet(caption, terms) {
  if (!caption) return null;
  const chars = Array.from(String(caption).split(/\s+/).filter(Boolean).join(" "));
  // 1文字ずつ正規化して、正規化後の位置 → 元の文字の位置の対応を作る(索引と同じ正規化)
  let flat = "";
  const map = [];
  chars.forEach((c, i) => {
    const n = normalize(c);
    for (let k = 0; k < n.length; k++) map.push(i);
    flat += n;
  });
  let at = -1;
  for (const t of terms) {
    const i = flat.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return null;
  const hit = map[at];
  if (hit + 10 <= EXCERPT_LEN) return null;   // 先頭の抜粋の中に見えている
  const start = Math.max(0, hit - SNIP_BEFORE);
  const end = Math.min(chars.length, start + EXCERPT_LEN);
  return (start > 0 ? "…" : "") + chars.slice(start, end).join("").trim() + (end < chars.length ? "…" : "");
}

// 一覧とカレンダーは同じ条件を使う(件数が必ず一致するように)
function filters(p) {
  const where = [];
  const args = [];
  const accounts = (p.get("a") || "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 90);
  if (accounts.length) {
    where.push(`account IN (${accounts.map(() => "?").join(",")})`);
    args.push(...accounts);
  } else if (p.get("act") === "1") {
    // アカウントを選んでいないときだけ、現役グループの人に絞る(選んでいれば、その人たちを出す)
    where.push(`account IN (SELECT username FROM account WHERE active = 1 AND (${ACTIVE_SECTIONS.map(() => "section LIKE ?").join(" OR ")}))`);
    args.push(...ACTIVE_SECTIONS.map((s) => s + "%"));
  }
  const music = p.get("m") || "";
  if (ID_RE.test(music)) { where.push("music_id = ?"); args.push(music); }
  const from = p.get("from") || "";
  const to = p.get("to") || "";
  if (DATE_RE.test(from)) { where.push("ts >= ?"); args.push(from); }
  if (DATE_RE.test(to)) { where.push("ts < ?"); args.push(to + " 99"); } // その日の終わりまで
  const built = buildMatch(p.get("q") || "");
  if (built && built.match) {
    where.push("id IN (SELECT id FROM post_fts WHERE post_fts MATCH ?)");
    args.push(built.match);
  }
  return { where, args, notonly: !!(built && built.onlyNot) };
}

// 新しい順(order=old なら古い順)
async function handlePosts(url, env) {
  const p = url.searchParams;
  const { where, args, notonly } = filters(p);
  if (notonly) return json({ error: "notonly", posts: [], more: false });   // 含まない語(-)だけでは探せない
  const before = p.get("before") || "";
  // order=old は古い順(続きの before は「これより新しいもの」になる)
  const old = p.get("order") === "old";
  if (before) { where.push(old ? "ts > ?" : "ts < ?"); args.push(before.slice(0, 16)); }
  // 検索語があるときは本文も読み、抜粋を「当たった箇所の前後」にする(本文そのものは返さない)
  const terms = searchTerms(p.get("q") || "");
  const sql =
    "SELECT id, account, ts, permalink, excerpt, music_id, music_title, music_author, music_original" +
    (terms.length ? ", caption" : "") + " FROM post" +
    (where.length ? " WHERE " + where.join(" AND ") : "") + (old ? " ORDER BY ts ASC LIMIT ?" : " ORDER BY ts DESC LIMIT ?");
  const { results } = await env.DB.prepare(sql).bind(...args, PAGE).all();
  for (const r of results) {
    if (terms.length) {
      const s = snippet(r.caption, terms);
      if (s) r.excerpt = s;
      delete r.caption;
    }
  }
  return json({ posts: results, more: results.length === PAGE }, 200, "public, max-age=300");
}

async function handleCalendar(url, env) {
  const p = new URLSearchParams(url.searchParams);
  const ym = p.get("ym") || "";
  p.delete("from");
  p.delete("to");
  const { where, args } = filters(p);
  // ym なし: 月ごとの件数(年×月の表と、いつから・いつまでの選択肢に使う)
  if (!ym) {
    const { results } = await env.DB
      .prepare("SELECT substr(ts, 1, 7) AS ym, COUNT(*) AS n FROM post" +
        (where.length ? " WHERE " + where.join(" AND ") : "") + " GROUP BY ym ORDER BY ym")
      .bind(...args)
      .all();
    return json({ months: results.map((r) => [r.ym, r.n]) }, 200, "public, max-age=300");
  }
  if (!/^\d{4}-\d{2}$/.test(ym)) return json({ error: "ym" }, 400);
  const [y, m] = ym.split("-").map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  where.push("ts >= ?", "ts < ?");
  args.push(ym, next);
  const { results } = await env.DB
    .prepare(`SELECT substr(ts, 1, 10) AS d, COUNT(*) AS n FROM post WHERE ${where.join(" AND ")} GROUP BY d`)
    .bind(...args)
    .all();
  const days = {};
  for (const r of results) days[r.d] = r.n;
  return json({ days }, 200, "public, max-age=300");
}

// その日(日本時間)の投稿を、時刻の早い順に全部。多すぎるときは DAY_MAX 件で切って truncated を付ける。
// 形は全サイトで同じにする(あとでポータルが同じ部品を並べるため)
const DAY_MAX = 1000;

async function handleDay(url, env) {
  const d = url.searchParams.get("d") || "";
  if (!DATE_RE.test(d)) return json({ error: "d" }, 400);
  const { results } = await env.DB
    .prepare("SELECT account, ts, permalink, excerpt FROM post WHERE ts >= ? AND ts < ? ORDER BY ts, id LIMIT ?")
    .bind(d, d + " 99", DAY_MAX + 1)
    .all();
  const truncated = results.length > DAY_MAX;
  return json({ posts: results.slice(0, DAY_MAX), truncated }, 200, "public, max-age=300");
}

async function handleAccounts(env) {
  const [accounts, latest] = await env.DB.batch([
    env.DB.prepare(
      "SELECT a.username, a.name, a.section, a.active, a.groups, " +
      "(SELECT COUNT(*) FROM post WHERE account = a.username) AS posts, " +
      "(SELECT MIN(ts) FROM post WHERE account = a.username) AS first, " +
      "(SELECT MAX(ts) FROM post WHERE account = a.username) AS last " +
      "FROM account a ORDER BY a.active DESC, a.sort"),
    env.DB.prepare("SELECT MAX(ts) AS ts FROM post"),
  ]);
  return json({
    accounts: accounts.results,
    latest: latest.results[0] ? latest.results[0].ts : null,
  }, 200, "public, max-age=300");
}

/* ============================ 削除・公開停止の依頼 ============================ */

// IP は日付と秘密の値を混ぜたハッシュだけ残し、同じ人の連投を数える
const TD_RATE_MIN = 10;     // レート制限の窓(分)
const TD_RATE_MAX = 5;      // 窓あたりの上限件数

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function handleTakedown(request, env, ctx) {
  let b;
  try { b = await request.json(); } catch { return json({ error: "bad" }, 400); }
  if (b.website) return json({ ok: true });   // 人には見えない欄。埋まっていたら機械の送信なので黙って捨てる
  const cut = (s, n) => String(s || "").trim().slice(0, n);
  const target = cut(b.target, 300), contact = cut(b.contact, 200), message = cut(b.message, 2000);
  if (!target) return json({ error: "target" }, 400);

  const ip = request.headers.get("cf-connecting-ip") || "";
  const today = new Date().toISOString().slice(0, 10);
  const ipHash = await sha256Hex(`${env.TAKEDOWN_SALT || env.CRAWL_TOKEN || "hello-tiktok"}:${today}:${ip}`);
  const cnt = await env.DB.prepare("SELECT count(*) AS n FROM takedown WHERE ip_hash = ? AND created_at > ?")
    .bind(ipHash, agoJst(TD_RATE_MIN / 60)).first();
  if ((cnt?.n || 0) >= TD_RATE_MAX) return json({ error: "rate" }, 429);

  const ua = (request.headers.get("user-agent") || "").slice(0, 300);
  const res = await env.DB.prepare(
    "INSERT INTO takedown (target, contact, message, user_agent, ip_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(target, contact || null, message || null, ua, ipHash, nowJst()).run();
  const id = res.meta.last_row_id;
  ctx.waitUntil(discord(env, {
    content: (`**削除・公開停止の依頼 #${id}**\n対象: ${target}\n連絡先: ${contact || "(なし)"}` +
      (message ? `\n${message}` : "")).slice(0, 1900),
  }));
  return json({ ok: true, id });
}

async function crawlTakedownList(env) {
  const { results } = await env.DB
    .prepare("SELECT id, target, contact, message, done, created_at FROM takedown ORDER BY done ASC, id DESC LIMIT 200").all();
  return json({ takedown: results });
}

async function crawlTakedownDecide(request, env) {
  const { id, action } = await request.json();
  if (!Number.isInteger(id) || id <= 0) return json({ error: "bad_request" }, 400);
  if (action === "delete") await env.DB.prepare("DELETE FROM takedown WHERE id = ?").bind(id).run();
  else if (action === "done" || action === "undo") {
    await env.DB.prepare("UPDATE takedown SET done = ? WHERE id = ?").bind(action === "done" ? 1 : 0, id).run();
  } else return json({ error: "bad_request" }, 400);
  return json({ ok: true });
}

/* ============================ 取り込み ============================ */

// { accounts: [{ username, name, section, sort, groups }], remove: [username] }
async function crawlAccounts(request, env) {
  const { accounts, remove } = await request.json();
  if (!Array.isArray(accounts) || !accounts.length) return json({ error: "empty" }, 400);
  const stmts = [env.DB.prepare("UPDATE account SET active = 0")];
  // 載せないと決めた人は、対象から外すだけでなく、投稿ごと消す。対象に入っている人は消さない(書き間違いの備え)
  const keep = new Set(accounts.map((a) => String(a.username)));
  for (const u of (Array.isArray(remove) ? remove : []).map(String).filter((u) => u && !keep.has(u))) {
    stmts.push(env.DB.prepare("DELETE FROM post_fts WHERE id IN (SELECT id FROM post WHERE account = ?)").bind(u));
    stmts.push(env.DB.prepare("DELETE FROM post WHERE account = ?").bind(u));
    stmts.push(env.DB.prepare("DELETE FROM account WHERE username = ?").bind(u));
  }
  for (const a of accounts) {
    stmts.push(env.DB
      .prepare(
        "INSERT INTO account(username, name, section, sort, active, groups) VALUES(?, ?, ?, ?, 1, ?) " +
        "ON CONFLICT(username) DO UPDATE SET name = excluded.name, section = excluded.section, " +
        "sort = excluded.sort, active = 1, groups = excluded.groups")
      .bind(String(a.username), String(a.name), String(a.section), Number(a.sort) || 0, String(a.groups || "")));
  }
  await env.DB.batch(stmts);
  return json({ ok: true, count: accounts.length });
}

// 一覧に出す本文の先頭。絵文字を途中で割らないよう、文字単位(Array.from)で切る
function makeExcerpt(caption) {
  return Array.from(String(caption || "").split(/\s+/).filter(Boolean).join(" ")).slice(0, EXCERPT_LEN).join("");
}

// 本文の指紋(FNV-1a 32bit)。本文が前と同じ投稿は、重い索引(post_fts)を書き直さないのに使う
function capHash(caption) {
  let h = 0x811c9dc5;
  for (const c of String(caption || "")) {
    h ^= c.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

const squash = (s) => String(s || "").replace(/\s+/g, "");

// 取り込みの形をそろえる。使えないものは null
function cleanPost(p) {
  const id = String(p.id || "");
  const sec = Number(p.createTime);
  if (!ID_RE.test(id) || !Number.isFinite(sec) || sec <= 0) return null;
  const m = p.music && ID_RE.test(String(p.music.id || "")) ? p.music : null;
  return {
    id, sec,
    caption: String(p.caption || ""),
    music: m ? { id: String(m.id), title: String(m.title || ""), author: String(m.author || ""), original: m.original ? 1 : 0 } : null,
  };
}

// 1アカウント分の投稿を書く(cleanPost 済みのもの、WRITE_MAX 件まで)。
// Apify は、本文の改行・空白と曲名の表記がブックマークレット(画面の表示)と違うことがあるので、
// 先に入っている値があれば、本文は「改行・空白だけの違い」なら変えず、曲名は同じ楽曲なら変えない
async function writePosts(env, username, posts, source) {
  const known = new Map();
  for (let i = 0; i < posts.length; i += 90) {
    const part = posts.slice(i, i + 90).map((p) => p.id);
    const { results } = await env.DB
      .prepare(`SELECT id, caption, cap_hash, music_id, music_title, music_author, music_original FROM post WHERE id IN (${part.map(() => "?").join(",")})`)
      .bind(...part).all();
    for (const r of results) known.set(r.id, r);
  }
  const now = nowJst();
  const stmts = [];
  const count = { added: 0, updated: 0, same: 0 };
  for (const p of posts) {
    const prev = known.get(p.id);
    const caption = prev && source === "apify" && squash(prev.caption) === squash(p.caption) ? String(prev.caption || "") : p.caption;
    let music = p.music;
    if (prev && prev.music_id && (!music || (source === "apify" && music.id === prev.music_id))) {
      music = { id: prev.music_id, title: prev.music_title, author: prev.music_author, original: prev.music_original };
    }
    const hash = capHash(caption);
    const m = music || { id: null, title: null, author: null, original: null };
    if (prev && prev.cap_hash === hash && prev.music_id === m.id && prev.music_title === m.title && prev.music_author === m.author) {
      count.same++;
      stmts.push(env.DB.prepare("UPDATE post SET seen_at = ? WHERE id = ?").bind(now, p.id));
      continue;
    }
    count[prev ? "updated" : "added"]++;
    // 取り直しでは added_at と source を変えない(初めて入ったときのものを残す)
    stmts.push(env.DB
      .prepare(
        "INSERT INTO post(id, account, ts, permalink, excerpt, added_at, cap_hash, seen_at, source, caption, music_id, music_title, music_author, music_original) " +
        "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET account = excluded.account, ts = excluded.ts, permalink = excluded.permalink, " +
        "excerpt = excluded.excerpt, cap_hash = excluded.cap_hash, seen_at = excluded.seen_at, caption = excluded.caption, " +
        "music_id = excluded.music_id, music_title = excluded.music_title, music_author = excluded.music_author, music_original = excluded.music_original")
      .bind(p.id, username, jstOf(p.sec), `https://www.tiktok.com/@${username}/video/${p.id}`, makeExcerpt(caption),
        now, hash, now, source, caption, m.id, m.title, m.author, m.original));
    if (!prev || prev.cap_hash !== hash) {
      if (prev) stmts.push(env.DB.prepare("DELETE FROM post_fts WHERE id = ?").bind(p.id));
      const grams = bigrams(normalize(caption)).join(" ");
      if (grams) stmts.push(env.DB.prepare("INSERT INTO post_fts(id, bigram) VALUES(?, ?)").bind(p.id, grams));
    }
  }
  stmts.push(env.DB
    .prepare("INSERT INTO import_log(at, source, account, added, updated, same) VALUES(?, ?, ?, ?, ?, ?)")
    .bind(now, source, username, count.added, count.updated, count.same));
  await env.DB.batch(stmts);
  return { account: username, ...count };
}

// 対象アカウント: 小文字のユーザー名 → 登録のとおりのユーザー名
async function targets(env) {
  const { results } = await env.DB.prepare("SELECT username FROM account").all();
  return new Map(results.map((a) => [a.username.toLowerCase(), a.username]));
}

// { account, posts: [{ id, createTime, caption, music: { id, title, author, original } }] }
async function crawlPosts(request, env) {
  const { account, posts } = await request.json();
  if (!Array.isArray(posts) || posts.length > WRITE_MAX) return json({ error: "bad_request", message: `posts は ${WRITE_MAX} 件まで` }, 400);
  const username = (await targets(env)).get(String(account || "").toLowerCase());
  if (!username) return json({ error: "unknown_account", message: `対象にないアカウントです: ${account}` }, 400);
  const ok = posts.map(cleanPost).filter(Boolean);
  const result = ok.length ? await writePosts(env, username, ok, "bookmarklet") : { account: username, added: 0, updated: 0, same: 0 };
  return json({ ok: true, skipped: posts.length - ok.length, ...result });
}

async function crawlRemove(request, env) {
  const { id } = await request.json();
  if (!ID_RE.test(String(id || ""))) return json({ error: "bad_request" }, 400);
  const [, res] = await env.DB.batch([
    env.DB.prepare("DELETE FROM post_fts WHERE id = ?").bind(String(id)),
    env.DB.prepare("DELETE FROM post WHERE id = ?").bind(String(id)),
  ]);
  return json({ ok: true, removed: res.meta.changes });
}

/* ============================ Apify ============================ */

// 使う項目だけを受け取る(再生数・いいね数などは聞かない)。note は新着がない人の行、errorCode は取れなかった行
const APIFY_FIELDS = "id,text,createTime,authorMeta.name,musicMeta.musicId,musicMeta.musicName,musicMeta.musicAuthor,musicMeta.musicOriginal,note,errorCode,input";
const APIFY_FLATTEN = "authorMeta,musicMeta";
const APIFY_STALE_HOURS = 120;  // 最後の受け取りがこれより古ければ、止まっているかもと知らせる(5日)
const APIFY_BAD = { FAILED: "失敗しました", "TIMED-OUT": "時間切れです", ABORTED: "中止されました" };

// Webhook の知らせが、失敗・時間切れ・中止のものなら、その種類を返す(成功ならnull)
function apifyBad(body) {
  const norm = (v) => String(v || "").toUpperCase().replace(/^ACTOR\.RUN\./, "").replace(/_/g, "-");
  const ev = norm(body.eventType), st = norm(body.resource && body.resource.status);
  return Object.keys(APIFY_BAD).find((k) => k === ev || k === st) || null;
}

// タスクの名前(Apify の画面と同じもの)。取れなければ空
async function apifyTaskName(env, body) {
  const id = String((body.resource && body.resource.actorTaskId) || body.actorTaskId || "");
  if (!env.APIFY_TOKEN || !/^[A-Za-z0-9]+$/.test(id)) return "";
  try {
    const r = await fetch(`https://api.apify.com/v2/actor-tasks/${id}`, { headers: { authorization: `Bearer ${env.APIFY_TOKEN}` } });
    if (!r.ok) return "";
    const d = (await r.json()).data || {};
    return String(d.title || d.name || "").replace(/[\[\]*_`~|>]/g, "").slice(0, 60);
  } catch { return ""; }
}

// 毎日の知らせに載せる控え(最大5行。報告のあとで消す)
async function apifyNote(env, line) {
  const cur = await env.DB.prepare("SELECT v FROM meta WHERE k = 'apify_notes'").first("v");
  const lines = (cur ? cur.split("\n") : []).concat(line).slice(-5);
  await env.DB.prepare("INSERT OR REPLACE INTO meta(k, v) VALUES('apify_notes', ?)").bind(lines.join("\n")).run();
}

async function crawlApify(request, env) {
  const body = await request.json().catch(() => ({}));

  // 実行が終わらなかった知らせ(失敗・時間切れ・中止)は、すぐ Discord に知らせる
  const bad = apifyBad(body);
  if (bad) {
    const name = await apifyTaskName(env, body);
    const runId = String((body.resource && body.resource.id) || (body.eventData && body.eventData.actorRunId) || "");
    const link = /^[A-Za-z0-9]+$/.test(runId) ? `\n[実行を見る](https://console.apify.com/actors/runs/${runId})` : "";
    const sent = await discord(env, {
      embeds: [{ title: "Apify", description: `⚠ Apify の実行が終わりませんでした: ${APIFY_BAD[bad]}${name ? `\nタスク: ${name}` : ""}${link}`, color: 0xd9534f }],
    });
    return json({ ok: true, event: bad, notified: sent });
  }

  if (!env.APIFY_TOKEN) return json({ error: "no_token", message: "APIFY_TOKEN が Worker に入っていません" }, 500);
  const datasetId = body.datasetId || (body.resource && body.resource.defaultDatasetId);
  if (!/^[A-Za-z0-9]+$/.test(String(datasetId || ""))) return json({ error: "bad_request", message: "datasetId がありません" }, 400);
  const res = await fetch(
    `https://api.apify.com/v2/datasets/${datasetId}/items?clean=1&format=json&flatten=${APIFY_FLATTEN}&fields=${APIFY_FIELDS}`,
    { headers: { authorization: `Bearer ${env.APIFY_TOKEN}` } });
  if (!res.ok) return json({ error: "apify", message: `Apify が ${res.status} を返しました` }, 502);
  const items = await res.json();

  const target = await targets(env);
  const groups = new Map();
  let outside = 0, empty = 0;
  const rows = Array.isArray(items) ? items : [];
  for (const it of rows) {
    // 入れ子の項目は、flatten で "authorMeta.name" の形になる。そのままの形でも読めるようにする
    const get = (a, b) => it[`${a}.${b}`] ?? (it[a] && it[a][b]);
    if (!it.id) { empty++; continue; }
    const user = target.get(String(get("authorMeta", "name") || "").toLowerCase());
    const post = cleanPost({
      id: it.id, createTime: it.createTime, caption: it.text,
      music: { id: get("musicMeta", "musicId"), title: get("musicMeta", "musicName"), author: get("musicMeta", "musicAuthor"), original: get("musicMeta", "musicOriginal") },
    });
    if (!user || !post) { outside++; continue; }
    if (!groups.has(user)) groups.set(user, []);
    groups.get(user).push(post);
  }
  const results = [];
  for (const [user, posts] of groups) {
    for (let i = 0; i < posts.length; i += WRITE_MAX) results.push(await writePosts(env, user, posts.slice(i, i + WRITE_MAX), "apify"));
  }
  // 投稿が1件でも来たら「最後の受け取り」を控える。0件なら、毎日の知らせで気づけるよう控えておく
  const count = [...groups.values()].reduce((n, g) => n + g.length, 0);
  if (count > 0) {
    await env.DB.prepare("INSERT OR REPLACE INTO meta(k, v) VALUES('apify_last', ?)").bind(nowJst()).run();
  } else {
    const name = await apifyTaskName(env, body);
    await apifyNote(env, `${nowJst().slice(5).replace("-", "/")} ${name ? name + " " : ""}${rows.length} 行・投稿 0 件（空 ${empty}・対象外 ${outside}）。新着がなかっただけかもしれません`);
  }
  return json({ ok: true, items: rows.length, empty, outside, results });
}

/* ============================ 毎日の報告 ============================ */

const SITE = "https://tiktok.karin-archive.com";
const REPORT_LIST_MAX = 30;   // 新着として一覧に載せる最大件数(Discord の文字数上限に収める)
const FRESH_DAYS = 3;         // 新着とみなす投稿日時の古さの上限

// 収録件数と前回からの増加数、新着の一覧を送る。
// 新着は「前回の報告以降にDBへ入った」かつ「投稿が直近 FRESH_DAYS 日以内」のもの
async function dailyReport(env) {
  if (!env.DISCORD_WEBHOOK) return;
  const [{ results: tot }, { results: prev }] = await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) AS n FROM post"),
    env.DB.prepare("SELECT k, v FROM meta WHERE k IN ('report_at', 'report_total', 'apify_last', 'apify_notes')"),
  ]);
  const total = tot[0].n;
  const m = Object.fromEntries(prev.map((r) => [r.k, r.v]));
  const now = nowJst();
  const since = m.report_at || agoJst(24);   // 初回は24時間前から
  const diff = m.report_total == null ? null : total - Number(m.report_total);

  const { results: fresh } = await env.DB
    .prepare(
      "SELECT p.ts, p.permalink, p.excerpt, ifnull(a.name, p.account) AS name FROM post p " +
      "LEFT JOIN account a ON a.username = p.account WHERE p.added_at > ? AND p.ts >= ? ORDER BY p.ts")
    .bind(since, agoJst(24 * FRESH_DAYS))
    .all();
  const lines = fresh.slice(0, REPORT_LIST_MAX).map((r) => {
    const text = Array.from(dropBroken(r.excerpt) || "（本文なし）").slice(0, 40).join("").replace(/[\[\]]/g, "");
    return `${r.ts.slice(5).replace("-", "/")} **${r.name}** [${text}](${r.permalink})`;
  });
  if (fresh.length > REPORT_LIST_MAX) lines.push(`ほか ${fresh.length - REPORT_LIST_MAX} 件は[サイト](${SITE}/)で`);

  let warn = "";
  if (env.APIFY_TOKEN) {
    const last = m.apify_last;
    if (!last) {
      warn += "\n⚠ Apify: まだ一度も受け取っていません";
    } else {
      const jstMs = (s) => Date.parse(s.replace(" ", "T") + ":00+09:00");
      const hours = (jstMs(now) - jstMs(last)) / 3600e3;
      warn += hours > APIFY_STALE_HOURS
        ? `\n⚠ Apify: 最後の受け取りが ${Math.floor(hours)} 時間前です（${last}）。止まっているかもしれません`
        : `\nApify: 最後の受け取り ${last}`;
    }
    if (m.apify_notes) warn += m.apify_notes.split("\n").map((l) => `\n⚠ Apify の取り込み: ${l}`).join("");
  }
  const open = (await env.DB.prepare("SELECT COUNT(*) AS n FROM takedown WHERE done = 0").first()).n;
  if (open) warn += `\n⚠ 削除・公開停止の依頼が **${open}** 件、未対応です`;

  const head =
    `収録 **${total.toLocaleString()}** 件` +
    (diff == null ? "" : `（前回から ${diff >= 0 ? "+" : ""}${diff.toLocaleString()}）`) +
    `\n新着 **${fresh.length}** 件（${since.slice(5).replace("-", "/")} 〜 ${now.slice(5).replace("-", "/")}）` + warn;

  const sent = await discord(env, {
    embeds: [{
      title: "今日の TikTok",
      url: SITE + "/",
      description: (head + (lines.length ? "\n\n" + lines.join("\n") : "")).slice(0, 4000),
      color: 0x161616,
    }],
  });
  if (!sent) throw new Error("Discord に送れませんでした");

  await env.DB.batch([
    env.DB.prepare("INSERT OR REPLACE INTO meta(k, v) VALUES('report_at', ?)").bind(now),
    env.DB.prepare("INSERT OR REPLACE INTO meta(k, v) VALUES('report_total', ?)").bind(String(total)),
    env.DB.prepare("DELETE FROM meta WHERE k = 'apify_notes'"),
  ]);
}

/* ============================ ルーティング ============================ */

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dailyReport(env).catch((e) => console.log("毎日の報告に失敗", String(e))));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;

    // 鍵: SITE_PASS があるあいだは、合言葉を知っている人だけ通す(利用者名は何でもよい)。CRAWL_TOKEN でも通す。
    // 管理用APIは Bearer トークンで守っているので対象外。SITE_PASS を消せば公開になる
    if (env.SITE_PASS) {
      if (p === "/robots.txt") {
        return new Response("User-agent: *\nDisallow: /\n", {
          headers: { "content-type": "text/plain; charset=utf-8", "x-robots-tag": "noindex, nofollow" },
        });
      }
      if (!p.startsWith("/api/crawl/") && !unlocked(request, env.SITE_PASS) &&
          !(env.CRAWL_TOKEN && unlocked(request, env.CRAWL_TOKEN))) {
        return locked();
      }
    }

    // 公開API: 同一IPからの叩きすぎを止める
    if (p.startsWith("/api/") && !p.startsWith("/api/crawl/") && env.RL) {
      const ip = request.headers.get("cf-connecting-ip") || "unknown";
      const { success } = await env.RL.limit({ key: ip });
      if (!success) return json({ error: "rate_limited" }, 429);
    }

    try {
      if (p === "/api/posts" && request.method === "GET") return await cached(request, ctx, () => handlePosts(url, env));
      if (p === "/api/calendar" && request.method === "GET") return await cached(request, ctx, () => handleCalendar(url, env));
      if (p === "/api/accounts" && request.method === "GET") return await cached(request, ctx, () => handleAccounts(env));
      if (p === "/api/day" && request.method === "GET") return await cached(request, ctx, () => handleDay(url, env));
      if (p === "/api/takedown" && request.method === "POST") return await handleTakedown(request, env, ctx);
    } catch (e) {
      console.log("api", p, String(e));
      return json({ error: "failed" }, 500);
    }

    if (p.startsWith("/api/crawl/")) {
      if (!authorized(request, env)) return new Response("Not found", { status: 404 });
      try {
        const route = `${request.method} ${p.slice("/api/crawl/".length)}`;
        if (route === "POST accounts") return await crawlAccounts(request, env);
        if (route === "POST posts") return await crawlPosts(request, env);
        if (route === "POST apify") return await crawlApify(request, env);
        if (route === "GET takedown") return await crawlTakedownList(env);
        if (route === "POST takedown") return await crawlTakedownDecide(request, env);
        if (route === "POST remove") return await crawlRemove(request, env);
        return new Response("Not found", { status: 404 });
      } catch (e) {
        // 例外のままだと Cloudflare の汎用エラー(1101)になって原因が分からないので中身を返す
        return json({ error: "crawl", message: String((e && e.message) || e) }, 500);
      }
    }

    if (p.startsWith("/api/")) return new Response("Not found", { status: 404 });
    return env.ASSETS.fetch(request);
  },
};
