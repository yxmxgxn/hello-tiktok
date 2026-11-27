"""ブックマークレットや拡張で保存した JSON(data/tiktok_*.json)を、サイトに入れる。

    python collect/upload.py --site <サイトのURL>                  # 全部
    python collect/upload.py --site <サイトのURL> --account <名前>  # 1人だけ

同じ投稿は何度送っても1件のまま(変わっていなければ書き直さない)。先に accounts.py で対象を送っておく。
"""
import argparse
import json
import sys

from common import ROOT, collected, post_json

BATCH = 100


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", required=True)
    ap.add_argument("--account")
    args = ap.parse_args()

    # 対象(count-input.json)から外した人のファイルは、残っていても送らない
    listed = json.loads((ROOT / "collect" / "count-input.json").read_text(encoding="utf-8"))["profiles"]
    targets = {u.lower() for u in listed}
    # 同じアカウントのファイルが複数あれば合わせる(新しいファイルの値を使う)
    accounts = {}
    for d in collected():
        if d["account"].lower() not in targets:
            continue
        accounts.setdefault(d["account"], {}).update({p["id"]: p for p in d["posts"]})
    if args.account:
        accounts = {a: v for a, v in accounts.items() if a.lower() == args.account.lower()}
    if not accounts:
        sys.exit("送るファイルがありません")

    for account, posts in accounts.items():
        items = list(posts.values())
        total = {"added": 0, "updated": 0, "same": 0, "skipped": 0}
        for i in range(0, len(items), BATCH):
            part = [{k: p.get(k) for k in ("id", "createTime", "caption", "music")} for p in items[i:i + BATCH]]
            res = post_json(args.site, "/api/crawl/posts", {"account": account, "posts": part})
            for k in total:
                total[k] += res.get(k, 0)
        print(f"@{account}: {len(items)} 件 → 新規 {total['added']}・更新 {total['updated']}・同じ {total['same']}・使えない {total['skipped']}")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
