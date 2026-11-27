// TikTok 公式の埋め込み(Embed Player)を、押したときだけ、暗い背景のポップアップで開く(トップと /day で共通)。
// window.postActions(li, permalink, label) は、投稿の下の「▶ ここで見る」「TikTok で見る ↗」の行を作る。
// label(window.postLabel)は、ポップアップのカードの下の「2026/11/26 名前@ID」。
// ポップアップの中では、「‹」「›」・キーボードの ← → ・(パソコンは)暗い背景でのホイールで、一覧の前後の投稿に移れる。
// 閉じるのは「×」・背景・Esc。前後の投稿は、開いた投稿が表示し終わってから、裏で先に読み込んでおく
(function () {
  "use strict";

  // 公式の Embed Player(https://developers.tiktok.com/doc/embed-player)を iframe で置く。
  // 押さない人には TikTok の読み込みは何も起きない
  function playerUrl(url) {
    var id = (url.match(/\/(?:video|photo)\/(\d+)/) || [])[1];
    return id ? "https://www.tiktok.com/player/v1/" + id + "?description=1&music_info=1&rel=0&autoplay=0" : "";
  }

  // 見えていないカードの動画は止める
  function pause(el) {
    var f = el.querySelector("iframe");
    if (f && f.contentWindow) f.contentWindow.postMessage({ "x-tiktok-player": true, type: "pause" }, "https://www.tiktok.com");
  }

  // プレーヤーから「準備できた」の知らせが来たカードは、くるくるを消す
  window.addEventListener("message", function (e) {
    if (e.origin !== "https://www.tiktok.com" || !e.data || e.data.type !== "onPlayerReady") return;
    cards.forEach(function (c) {
      var f = c.el.querySelector("iframe");
      if (f && f.contentWindow === e.source) c.el.classList.add("ready");
    });
  });

  var modal = null;      // ポップアップ(開いている間だけ)
  var current = null;    // いま出している投稿の li
  var opener = null;     // 開いたボタン(閉じたらここに戻す)
  var cards = [];        // 読み込み済みのカード [{ li, el }]。いま出している投稿と、その前後だけ持つ
  var warmTimer = 0;

  function urlOf(li) { return li.getAttribute("data-url"); }

  // 一覧の中の、見られる投稿(前後に移る範囲)
  function items(li) {
    return Array.prototype.filter.call(li.parentNode.children, function (e) { return e.getAttribute && e.getAttribute("data-url"); });
  }

  // li の埋め込みのカードを作る(あれば、それを返す)。まだ出さない
  function ensure(li) {
    for (var i = 0; i < cards.length; i++) if (cards[i].li === li) return cards[i].el;
    var el = document.createElement("div");
    el.className = "emodal-card";
    var frame = document.createElement("iframe");
    frame.title = "TikTok の投稿";
    frame.allow = "fullscreen; encrypted-media; picture-in-picture";
    // 知らせが来ないときも、読み込みの5秒後には中身を見せる
    var loaded = false;
    frame.onload = function () { loaded = true; setTimeout(function () { el.classList.add("ready"); }, 5000); };
    frame.src = playerUrl(urlOf(li));
    el.appendChild(frame);
    modal.querySelector(".emodal-stage").appendChild(el);
    cards.push({ li: li, el: el });
    // パソコンで、両側にうすく見えている前後のカードは、押すとそこへ移る(中は TikTok の画面なので、上に重ねた幕が受ける)
    el.addEventListener("click", function () {
      if (el.classList.contains("side-prev")) step(-1);
      else if (el.classList.contains("side-next")) step(1);
    });
    // 15秒たっても読み込めなければ、右下の「TikTok で見る」を案内する
    setTimeout(function () { if (!loaded && !el.classList.contains("ready")) el.classList.add("fail"); }, 15000);
    return el;
  }

  // 前後の投稿を、裏で先に読み込む(動かすときに、待たずに出るように)。回線を節約したい設定のときはしない。
  // いま出している投稿が先に出るよう、少し待ってから。次を先に、そのあと前
  function warm(li) {
    clearTimeout(warmTimer);
    var save = navigator.connection && navigator.connection.saveData;
    warmTimer = setTimeout(function () {
      if (!modal || current !== li) return;
      var all = items(li), i = all.indexOf(li);
      var keep = [li];
      if (!save) {
        if (all[i + 1]) { keep.push(all[i + 1]); ensure(all[i + 1]); }
        if (all[i - 1]) { keep.push(all[i - 1]); ensure(all[i - 1]); }
      }
      // 離れた投稿のカードは捨てる(増やし続けない)
      cards = cards.filter(function (c) {
        if (keep.indexOf(c.li) >= 0) return true;
        c.el.remove();
        return false;
      });
      mark(li);
    }, 1500);
  }

  // いま出している投稿(on)と、一覧の前(side-prev)・後(side-next)のカードに印を付ける。
  // 前後は、広い画面(パソコン)だけ、カードの両側にうすく見せる(style.css)。出していないカードの動画は止める
  function mark(li) {
    var all = items(li), i = all.indexOf(li);
    cards.forEach(function (c) {
      var k = all.indexOf(c.li) - i;
      c.el.classList.toggle("on", k === 0);
      c.el.classList.toggle("side-prev", k === -1);
      c.el.classList.toggle("side-next", k === 1);
      if (k !== 0) pause(c.el);
    });
  }

  // 枠の高さは、投稿によらず同じ(縦長 9:16。画面に収まる高さまで)。大きさは style.css で決める
  function show(li) {
    current = li;
    ensure(li);
    mark(li);
    // 前後の投稿(なければ「‹」「›」は押せない)。後ろの投稿が無くても、「さらに古い投稿」があれば押して読み込む
    var all = items(li), i = all.indexOf(li);
    modal.querySelector(".emodal-prev").disabled = i <= 0;
    var more = document.getElementById("more");
    modal.querySelector(".emodal-next").disabled = i >= all.length - 1 && !(more && !more.hidden);
    modal.querySelector(".emodal-count").textContent = (i + 1) + " / " + all.length + (more && !more.hidden ? "+" : "");
    // 右下の「TikTok で見る ↗」も、この投稿に
    modal.querySelector(".emodal-link").href = urlOf(li);
    modal.querySelector(".emodal-who").textContent = li.getAttribute("data-who") || "";
    // 後ろの一覧も、いま出している投稿に合わせて動かす
    li.scrollIntoView({ block: "nearest" });
    warm(li);
  }

  function step(d) {
    if (!modal || !current) return;
    var all = items(current), i = all.indexOf(current) + d;
    if (i >= 0 && i < all.length) { show(all[i]); return; }
    // いちばん後ろで「›」: 「さらに古い投稿」を読み込んで、増えたら次へ
    var more = document.getElementById("more");
    if (d > 0 && more && !more.hidden) {
      var n = all.length, from = current;
      more.click();
      var t0 = Date.now();
      (function wait() {
        if (!modal || current !== from) return;
        var now = items(from);
        if (now.length > n) { show(now[n]); return; }
        if (Date.now() - t0 < 6000) setTimeout(wait, 150);
      })();
    }
  }

  function close() {
    if (!modal) return;
    document.removeEventListener("keydown", onKey, true);
    clearTimeout(warmTimer);
    modal.remove();
    modal = null;
    current = null;
    cards = [];
    document.documentElement.classList.remove("emodal-open");
    if (opener) { try { opener.focus({ preventScroll: true }); } catch (e) { /* 無くてもよい */ } }
    opener = null;
  }

  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); step(1); }
  }

  function btn(cls, label, text, onclick) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    b.setAttribute("aria-label", label);
    b.textContent = text;
    b.onclick = onclick;
    return b;
  }

  function open(li, from) {
    close();
    opener = from;
    modal = document.createElement("div");
    modal.className = "emodal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-label", "投稿");
    var bg = document.createElement("div");
    bg.className = "emodal-bg";
    bg.onclick = close;
    var stage = document.createElement("div");
    stage.className = "emodal-stage";
    var count = document.createElement("div");
    count.className = "emodal-count";
    count.setAttribute("aria-live", "polite");
    var link = document.createElement("a");
    link.className = "emodal-link";
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "TikTok で見る ↗";
    // カードの下の行: 左に「2026/11/26 宮本佳林@ID」、右に「TikTok で見る ↗」
    var who = document.createElement("span");
    who.className = "emodal-who";
    var foot = document.createElement("div");
    foot.className = "emodal-foot";
    foot.appendChild(who);
    foot.appendChild(link);
    modal.appendChild(bg);
    modal.appendChild(btn("emodal-x", "閉じる", "×", close));
    modal.appendChild(btn("emodal-prev", "前の投稿", "‹", function () { step(-1); }));
    modal.appendChild(stage);
    modal.appendChild(btn("emodal-next", "次の投稿", "›", function () { step(1); }));
    modal.appendChild(foot);
    modal.appendChild(count);
    // パソコン: 暗い背景(カードの外)でマウスのホイールを回すと、前後の投稿へ。下に回すと次。
    // 出している投稿の中は TikTok の画面なので、操作は TikTok が受ける(両側のうすいカードの上は、前後へ移る)
    var wheelAt = 0;
    modal.addEventListener("wheel", function (e) {
      if (e.target.closest && e.target.closest(".emodal-card.on")) return;
      e.preventDefault();
      var now = Date.now();
      if (now - wheelAt < 450 || Math.abs(e.deltaY) + Math.abs(e.deltaX) < 8) return;   // 勢いのある1回で1つだけ
      wheelAt = now;
      step((Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) > 0 ? 1 : -1);
    }, { passive: false });
    document.body.appendChild(modal);
    document.documentElement.classList.add("emodal-open");
    document.addEventListener("keydown", onKey, true);
    modal.querySelector(".emodal-x").focus({ preventScroll: true });
    show(li);
  }

  // 投稿の下の操作の行:「▶ ここで見る」(ポップアップで開く)と「TikTok で見る ↗」(元の投稿へ)
  // 「名前@ユーザー名」。1人で複数アカウントの人の名前に付く「（@…）」は、重なるので外す
  window.whoLabel = function (account, names) {
    return String(names[account] || account).replace(/（@[^）]*）$/, "") + "@" + account;
  };
  // 「2026/11/26 宮本佳林@ID」。ポップアップのカードの下に出す
  window.postLabel = function (ts, account, names) {
    return String(ts).slice(0, 10).replace(/-/g, "/") + " " + window.whoLabel(account, names);
  };

  function actions(li, permalink, label) {
    if (label) li.setAttribute("data-who", label);
    var url = permalink;
    li.setAttribute("data-url", url);
    var row = document.createElement("div");
    row.className = "acts";
    var see = document.createElement("button");
    see.type = "button";
    see.className = "see";
    see.textContent = "▶ ここで見る";
    see.onclick = function () { open(li, see); };
    var link = document.createElement("a");
    link.className = "open";
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "TikTok で見る ↗";
    row.appendChild(see);
    row.appendChild(link);
    return row;
  }

  window.postActions = actions;
})();
