# Apify で毎日の新着を取る

過去の分はブックマークレット(`collect/tiktok-collect.js`)で入れて、新着は Apify で取ります。仕組みと見守りは、インスタ版(`hello-insta`)と同じ形にします。

> 受け口の `/api/crawl/apify` は `src/worker.js` にあります。手順 4(Webhook)は、サイトをデプロイしたあとに行います。
>
> 自動で集めることは、TikTok の利用規約の禁止にあたります。

## 流れ

```
Apify のタスク(スケジュール) → Webhook → Worker /api/crawl/apify → D1
                                              └→ Discord(失敗・0件・止まっている)
```

## 1. 鍵を入れる

名前はインスタ版のコードに合わせます。**値はリポジトリにもチャットにも書きません。**

| 名前 | 入れる場所 | 中身 |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | GitHub の Secrets | デプロイ用 |
| `CLOUDFLARE_ACCOUNT_ID` | GitHub の Secrets | 同上 |
| `CRAWL_TOKEN` | GitHub の Secrets | 取り込み用の合言葉(長いランダム文字列)。デプロイで Worker にも入る |
| `SITE_PASS` | GitHub の Secrets | 公開前のサイトの合言葉。デプロイで Worker にも入る |
| `DISCORD_WEBHOOK` | Cloudflare の Worker の Secret | 通知先。表示名は「TikTok 検索」 |
| `APIFY_TOKEN` | Cloudflare の Worker の Secret | Worker がデータセットを読むのに使う |

`CRAWL_TOKEN` と `SITE_PASS` は、デプロイのたびに GitHub の値で Worker が上書きされます(Threads 版・インスタ版と同じ)。両方に入れるときは、同じ値にします。

`TAKEDOWN_SALT` は入れません。削除依頼の IP ハッシュには、`CRAWL_TOKEN` を混ぜる作りにします。

## 2. タスクを作る

Actor は [`clockworks/tiktok-profile-scraper`](https://apify.com/clockworks/tiktok-profile-scraper)。「タスク」として保存して、入力を JSON で入れます。

```json
{
    "profiles": ["juicejuice_uf", "ootanioo"],
    "resultsPerPage": 10,
    "profileSorting": "latest",
    "oldestPostDateUnified": "2",
    "excludePinnedPosts": false,
    "shouldDownloadAvatars": false,
    "shouldDownloadCovers": false,
    "shouldDownloadSlideshowImages": false,
    "shouldDownloadVideos": false,
    "commentsPerPost": 0,
    "topLevelCommentsPerPost": 0,
    "maxRepliesPerComment": 0,
    "maxFollowersPerProfile": 0,
    "maxFollowingPerProfile": 0
}
```

| 項目 | 意味 |
|---|---|
| `resultsPerPage` | 1人あたりの上限。**省くと 100 になるので、必ず入れる** |
| `oldestPostDateUnified` | `"2"` は昨日と今日の分([入力の説明](https://apify.com/clockworks/tiktok-profile-scraper/input-schema))。日の区切りのタイムゾーンは書かれていない |
| `excludePinnedPosts` | `false` のままにする。古いピン留めは日付で外れる(下の試し実行)。`true` にすると、新しい投稿がピン留めされたときに取りこぼす |

実行の設定の **Maximum cost per run** も入れます(試しは $0.5)。

### 最初の試し実行(2人)

上の入力のまま1回動かして、次を確かめます。`ootanioo` は2023年から投稿がないので、「新着なし」の人の見本です。

- [x] 新着のない人にも、結果の行ができて課金されるか → **される**(中身のない行にも、結果と日付の絞り込みの両方が付く)
- [x] ピン留めの古い投稿が、日付で絞っても返るか → **返らない**(2026-11-26、`karin_miyamoto`。2023年のピン留めがあるが、直近の2件だけが返った)
- [x] 実行履歴の使用料 → 2026-11-26 の実行は **$0.0215**(5行 × $0.0043。`juicejuice_uf` 4件と `ootanioo` の空の行1件)
- [x] 空の行の形 → `id` がなく、`authorMeta`・`input`・`note`(`No videos found to match the filter`)だけ。`errorCode` は付かない

## 3. スケジュールと費用

無料プランは、結果1件 $0.003 + 日付の絞り込み $0.0013 = **$0.0043**(2026-11-25 に確認)。月 $5 の無料枠は、**インスタ版などと同じ Apify アカウントなら共有**です。

下限の目安(新着のない人にも1件分かかる。全員が1回に1件だけの場合):

| 分け方 | 月の費用 |
|---|---|
| 48人を毎日 | 約 $6.2 |
| 10人を毎日 + 38人を週1回 | 約 $2.0 |

投稿の多いアカウントは、この上に件数分がかかります。1日4本のペースが続くアカウントを毎日・2日分で取ると、月約 $1 です。

よく投稿する人は「毎日」、あまりしない人は「週1回」(`oldestPostDateUnified` は `"8"`)の、2つのタスクに分けます。どちらに入れるかは、過去分がそろってから、投稿の頻度を数えて決めます。実行は朝 6:00(日本時間)ごろにします。

## 4. Webhook(サイトをデプロイしたあと)

タスクの Integrations → Webhooks で、**4つのイベント**に同じ送り先とヘッダーを付けます。

- `Run succeeded`
- `Run failed`
- `Run timed out`
- `Run aborted`

後ろの3つを足さないと、失敗の知らせは届きません。

| 設定 | 値 |
|---|---|
| URL | `https://tiktok.karin-archive.com/api/crawl/apify` |
| ヘッダー | `{"Authorization": "Bearer <CRAWL_TOKEN>"}`(URL には付けない) |
| ペイロード | 既定のまま |

## Worker 側の動き

### 見守り(インスタ版と同じ)

数えるのは時刻と件数だけで、本文は使いません。

| 場面 | 知らせ |
|---|---|
| 実行が失敗・時間切れ・中止 | すぐ Discord に「⚠ Apify の実行が終わりませんでした」+ タスク名 + 実行へのリンク |
| 成功したが投稿が0件 | 毎日の報告に控え(最大5行) |
| 1件以上入った | 印なし。最後の受け取りの時刻(`meta.apify_last`)を控える |
| 受け取った直後の毎日の報告 | 「Apify: 最後の受け取り 日時」 |
| 最後の受け取りが120時間より前 | 毎日の報告に「⚠ 止まっているかもしれません」 |
| 一度も受け取っていない | 毎日の報告に「⚠ まだ一度も受け取っていません」 |

最初のデプロイのあと、20:00 の報告の前にタスクを1回手で動かすと、「一度も受け取っていません」は出ません。

### 取り込みの対応

| D1 | Apify の項目 | 注意 |
|---|---|---|
| `id` | `id` | 文字列のまま扱う(19桁) |
| `permalink` | `webVideoUrl` | `https://www.tiktok.com/@user/video/<id>` |
| `account` | `authorMeta.name` | 小文字で比べ、表示は登録のとおり |
| `ts` | `createTimeISO` | UTC なので日本時間に直す |
| `caption` | `text` | ブックマークレットで入った本文と、改行・空白だけが違うときは上書きしない |
| 楽曲 | `musicMeta.musicId` `musicName` `musicAuthor` `musicOriginal` | 曲名はローマ字で来ることがある。日本語の名前が入っていれば上書きしない |

- `id` のない行は捨てて、件数だけ数えます。新着がない人の行は `note`、存在しないユーザー名の行は `errorCode` が付きます。
- データセットは、使う項目だけに絞って読みます(`flatten` と `fields`)。本物の Apify で絞れるかは、デプロイ後の最初の実行で確かめます。再生数・いいね数・動画の URL は保存しません。
