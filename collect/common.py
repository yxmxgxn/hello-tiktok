"""サイトの管理用APIに送る(合言葉は環境変数 CRAWL_TOKEN。値はファイルに書かない)。"""
import json
import os
import sys
import urllib.error
import urllib.request


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
