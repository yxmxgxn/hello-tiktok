# ハロプロ TikTok検索

https://tiktok.karin-archive.com/

ハロー！プロジェクトのメンバーとOGのTikTokの投稿を、日付・メンバー・本文・楽曲で探せる個人の非公式サイト。

## 構成

| 場所 | 中身 |
|---|---|
| `src/worker.js` | 公開API と管理用API。正規化と bigram 化はここだけ |
| `public/` | 画面(静的ファイル) |
| `schema.sql` | D1 `hello-tiktok` のテーブル。デプロイのたびに流す |
| `collect/` | 過去分の収集(ブックマークレット)と、サイトへ入れるスクリプト |
| `docs/apify.md` | 毎日の新着(Apify)の設定 |
| `dev/server.mjs` | 手元で確かめるサーバー |

## 手元で動かす

    node dev/server.mjs

別の端末で(合言葉は手元だけの `dev-token`):

    $env:CRAWL_TOKEN = "dev-token"
    python collect/accounts.py --site http://localhost:8787
    python collect/upload.py --site http://localhost:8787

## 本番に入れる

対象アカウントを送ってから、投稿を入れる(`CRAWL_TOKEN` は本番の値を環境変数に)。

    python collect/accounts.py --site https://tiktok.karin-archive.com
    python collect/upload.py --site https://tiktok.karin-archive.com
