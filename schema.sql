-- ハロプロ TikTok検索 D1 スキーマ(hello-tiktok)
-- デプロイのたびに流す(IF NOT EXISTS なので何度流しても同じ)。
--
-- 本文は画面に全部は出さない。一覧には先頭の抜粋だけを返し、検索は本文全体の bigram(post_fts)で行う。

CREATE TABLE IF NOT EXISTS post (
  id             TEXT PRIMARY KEY,  -- TikTok の動画ID(19桁。数値にせず文字列のまま)
  account        TEXT NOT NULL,     -- ユーザー名(account の登録のとおりの大文字小文字)
  ts             TEXT NOT NULL,     -- 投稿日時(JST, 'YYYY-MM-DD HH:MM')
  permalink      TEXT NOT NULL,     -- https://www.tiktok.com/@user/video/<id>
  excerpt        TEXT,              -- 本文の先頭(一覧表示用)
  added_at       TEXT,              -- このDBに初めて入った日時(JST)。毎日の報告の「新着」に使う
  cap_hash       TEXT,              -- 本文の指紋。本文が前と同じなら索引(post_fts)を書き直さないのに使う
  seen_at        TEXT,              -- 最後に取得結果に入っていた日時(JST)
  source         TEXT,              -- 最初にどの経路で入ったか: bookmarklet / apify
  caption        TEXT,              -- 本文(書かれたとおり)。画面には出さない。検索で当たった箇所の前後を切り出すのにだけ使う
  music_id       TEXT,              -- 楽曲(音源)のID。同じIDの投稿は、同じ音源を使っている
  music_title    TEXT,
  music_author   TEXT,
  music_original INTEGER            -- 1=オリジナル音源
);
CREATE INDEX IF NOT EXISTS post_ts ON post(ts);
CREATE INDEX IF NOT EXISTS post_account_ts ON post(account, ts);
CREATE INDEX IF NOT EXISTS post_music_ts ON post(music_id, ts);

CREATE VIRTUAL TABLE IF NOT EXISTS post_fts USING fts5(
  id UNINDEXED,
  bigram
);

-- 対象アカウント。collect/accounts.py が毎回まるごと送る。
-- 対象から外れた人も消さずに active=0 にする(貯めた投稿をその人で絞り込めるように)
CREATE TABLE IF NOT EXISTS account (
  username TEXT PRIMARY KEY,
  name     TEXT NOT NULL,       -- 表示名(インスタ版と同じにする)
  section  TEXT NOT NULL,       -- 選択肢の見出し(グループ名 / J.P ROOM など)
  sort     INTEGER NOT NULL,
  active   INTEGER NOT NULL DEFAULT 1,
  groups   TEXT                 -- 所属したことがある現役グループの名前(",モーニング娘。,Juice=Juice,")
);

-- 取り込み1回ごと・アカウントごとの記録
CREATE TABLE IF NOT EXISTS import_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL,       -- 登録した日時(JST)
  source  TEXT NOT NULL,       -- bookmarklet / apify
  account TEXT NOT NULL,
  added   INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0,
  same    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS import_log_at ON import_log(at);

-- 覚え書き(前回の毎日の報告の時刻と件数・Apify の最後の受け取り)
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT
);

-- 削除・公開停止の依頼(about のフォーム)。送られたら Discord にも知らせる
CREATE TABLE IF NOT EXISTS takedown (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  target     TEXT NOT NULL,              -- 投稿のURL か アカウント名
  contact    TEXT,                       -- 返事が欲しい人だけ(任意)
  message    TEXT,                       -- 任意
  user_agent TEXT,
  ip_hash    TEXT,                       -- 日付と秘密の値を混ぜたIPのハッシュ。IPそのものは残さない
  done       INTEGER NOT NULL DEFAULT 0, -- 対応済みなら1
  created_at TEXT NOT NULL
);
