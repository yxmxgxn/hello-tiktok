"""最後の投稿と頻度で、Apify のタスクを「毎日・週1回・月1回」に分けて、入力の JSON を作る。

現役グループの公式は投稿が多いので Apify では取らず、拡張(collect/extension)で手で回る。

    python collect/groups.py          # data/ の結果から分けて、data/apify-<組>.json に書く

毎日は、ほぼ毎日投稿している人だけ(直近30日のうち15日以上に投稿)。数えられるのは全投稿がある人で、
まだの人は週1回か月1回にする。data/ の結果が新しくなったら、もう一度実行する。
本文は読まない。
"""
import datetime as dt
import glob
import json
import sys
from pathlib import Path

from common import collected

ROOT = Path(__file__).resolve().parent.parent
JST = dt.timezone(dt.timedelta(hours=9))

DAILY_DAYS = 15     # 毎日: 直近30日のうち、投稿した日がこの日数以上(2日に1日以上)
STOP_DAYS = 90      # 月1回: 最後の投稿がこの日数より前
# 現役グループの公式。拡張で取る(collect/extension/content.js の ACCOUNTS と同じものを保つ)
OFFICIAL = {"morningmusume_uf", "angerme_uf", "juicejuice_uf", "tsubakifactory_uf", "beyooooonds_", "ocha_norma", "rosy_chronicle"}

# いつも新着を最新にしておく人(インスタ版と同じ)
PRIORITY = {"karin_miyamoto"}

TASKS = {  # 組: (さかのぼる日数, 1人あたりの上限, 月の実行回数)
    "daily": ("2 days", 10, 30),
    "weekly": ("15 days", 40, 30 / 7),  # 1回失敗しても、次の回で拾える範囲
    "monthly": ("32 days", 100, 1),
}
PRICE = 0.0043  # 無料プランの1件(結果 + 日付の絞り込み)


def day(sec):
    return dt.datetime.fromtimestamp(sec, JST).date()


def load():
    info = {}  # 小文字のユーザー名 → { last, full, recent90, avg }
    today = dt.datetime.now(JST).date()
    at = lambda u: info.setdefault(u.lower(), {"last": None, "atleast": None, "days30": None})
    for f in glob.glob(str(ROOT / "data" / "dataset_*.json")):
        for r in json.loads(Path(f).read_text(encoding="utf-8-sig")):
            if not r.get("id"):
                continue
            a, d = r["authorMeta"], day(r["createTime"])
            x = at(a["name"])
            # ピン留めの投稿は「少なくともこの日には投稿していた」だけが分かる
            key = "atleast" if r.get("isPinned") else "last"
            x[key] = max(x[key] or d, d)
    for d in collected():
        if not d["posts"]:
            continue
        x = at(d["account"])
        days = [day(p["createTime"]) for p in d["posts"]]
        x["last"] = max(max(days), x["last"] or max(days))
        if d.get("full"):
            x["days30"] = len({v for v in days if (today - v).days <= 30})
    return info, today


def classify(user, x, today):
    low = user.lower()
    if low in PRIORITY:
        return "daily", "最優先"
    if not x.get("last"):
        return "weekly", f"不明: ピン留め以外の日付がない({x.get('atleast') or '情報なし'})"
    if (today - x["last"]).days > STOP_DAYS:
        return "monthly", f"最後 {x['last']}"
    days = x.get("days30")
    if days is None:
        return "weekly", f"暫定: 最後 {x['last']}"
    return ("daily" if days >= DAILY_DAYS else "weekly"), f"最後 {x['last']}・直近30日のうち {days}日"


def main():
    users = json.loads((ROOT / "collect" / "count-input.json").read_text(encoding="utf-8"))["profiles"]
    info, today = load()
    groups = {k: [] for k in TASKS}
    for u in users:
        if u.lower() in OFFICIAL:
            print(f"拡張	{u}")
            continue
        group, why = classify(u, info.get(u.lower(), {}), today)
        groups[group].append(u)
        print(f"{group}\t{u}\t{why}")
    for name, (window, limit, runs) in TASKS.items():
        task = {
            "commentsPerPost": 0, "excludePinnedPosts": False, "maxFollowersPerProfile": 0, "maxFollowingPerProfile": 0,
            "maxRepliesPerComment": 0, "oldestPostDateUnified": window, "profileSorting": "latest", "profiles": groups[name],
            "resultsPerPage": limit, "shouldDownloadAvatars": False, "shouldDownloadCovers": False,
            "shouldDownloadSlideshowImages": False, "shouldDownloadVideos": False, "topLevelCommentsPerPost": 0,
        }
        (ROOT / "data" / f"apify-{name}.json").write_text(json.dumps(task, ensure_ascii=False, indent=4) + "\n", encoding="utf-8")
        print(f"{name}: {len(groups[name])}人、下限 月 ${len(groups[name]) * runs * PRICE:.2f}")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
