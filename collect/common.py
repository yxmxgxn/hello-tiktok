"""収集スクリプトの共通部分。管理用APIに送る合言葉は環境変数 CRAWL_TOKEN(値はファイルに書かない)。"""
import glob
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def collected():
    """data/tiktok_*.json を古い順に読み、1アカウントずつ { account, total, full, posts } で返す。

    ブックマークレットは1ファイル1アカウント、拡張は1ファイルに複数。full は全投稿を取り終えたもの。
    """
    for path in sorted(glob.glob(str(ROOT / "data" / "tiktok_*.json")), key=os.path.getmtime):
        with open(path, encoding="utf-8-sig") as f:
            d = json.load(f)
        if "accounts" in d:
            yield from d["accounts"]
        else:
            yield {**d, "full": d.get("missing") == 0}


def post_json(site, path, body):
    token = os.environ.get("CRAWL_TOKEN")
    if not token:
        sys.exit("環境変数 CRAWL_TOKEN がありません")
    if not (site.startswith("https://") or site.startswith("http://localhost")):
        sys.exit("--site は https:// か http://localhost で始めてください")
    req = urllib.request.Request(
        site.rstrip("/") + path, data=json.dumps(body).encode("utf-8"), method="POST",
        headers={"authorization": f"Bearer {token}", "content-type": "application/json", "user-agent": "hello-tiktok-collect"})
    try:
        with urllib.request.urlopen(req, timeout=120) as res:
            return json.load(res)
    except urllib.error.HTTPError as e:
        sys.exit(f"{path}: {e.code} {e.read().decode('utf-8', 'replace')[:300]}")
