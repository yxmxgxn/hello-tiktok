"""対象アカウントの表示名と見出しを SNS一覧(公開CSV)から作って、サイトに送る。

対象のユーザー名は collect/count-input.json の profiles。表示名・見出し・並びはインスタ版(crawler/fetch.py)と同じにする。

    python collect/accounts.py                      # 中身を表示するだけ
    python collect/accounts.py --site <サイトのURL>   # 送る(環境変数 CRAWL_TOKEN が要る)
"""
import argparse
import csv
import io
import json
import re
import sys
import unicodedata
import urllib.request
from pathlib import Path

from common import post_json

ROOT = Path(__file__).resolve().parent.parent

# karin-archive の SNS一覧スプシ(accounts シート)。列: 0=member番号 1=名前 2=platform 3=ID(位置で読む)
ACCOUNTS_CSV = (
    "https://docs.google.com/spreadsheets/d/e/"
    "2PACX-1vSLHCVWWxyVI5GS9SSohSNYL4U-uY4jekuMXbaKYXYjWrSZlgSxGV0BFvnCWRrd-A4Z5sqkoRwRyDqD/pub"
    "?gid=1522035537&single=true&output=csv"
)

# 現役グループ(affiliation → 見出し。この順が並び順)。インスタ版と同じものを保つ
GROUPS = {
    "morningmusume": "モーニング娘。'26",
    "angerme": "アンジュルム",
    "juicejuice": "Juice=Juice",
    "tsubakifactory": "つばきファクトリー",
    "beyooooonds": "BEYOOOOONDS",
    "ochanorma": "OCHA NORMA",
    "rosychronicle": "ロージークロニクル",
}
OG_SECTIONS = ["J.P ROOM", "UP-FRONT CREATE", "UP-FRONT PROMOTION", "その他のOG"]
OG_ORDER = {
    "J.P ROOM": [
        "譜久村聖", "竹内朱莉", "石田亜佑美", "佐藤優樹", "宮崎由加", "宮本佳林",
        "植村あかり", "佐々木莉佳子", "稲場愛香", "森戸知沙希", "小関舞", "浅倉樹々",
    ],
    "UP-FRONT CREATE": [
        "安倍なつみ", "飯田圭織", "石川梨華", "勝田里奈", "熊井友理奈", "里田まい", "鈴木愛理",
        "須藤茉麻", "高橋愛", "田中れいな", "中澤裕子", "中島早貴", "牧野真莉愛", "真野恵里菜",
        "矢口真里", "矢島舞美", "保田圭", "山岸理子", "飯窪春菜", "辻希美", "藤本美貴",
    ],
}
GROUP_NAMES = {
    2: "モーニング娘。", 11: "アンジュルム", 12: "Juice=Juice", 15: "つばきファクトリー",
    16: "BEYOOOOONDS", 17: "OCHA NORMA", 18: "ロージークロニクル",
}
# グループの公式アカウント(SNS一覧にはない)。各グループの見出しの一番上に、グループの名前で並べる
GROUP_OFFICIAL = {
    "morningmusume": "morningmusume_uf",
    "angerme": "angerme_uf",
    "juicejuice": "juicejuice_uf",
    "tsubakifactory": "tsubakifactory_uf",
    "beyooooonds": "beyooooonds_",
    "ochanorma": "ocha_norma",
    "rosychronicle": "rosy_chronicle",
}
# SNS一覧にない、そのほかのアカウント: ユーザー名 → (表示名, 見出し)
EXTRA_ACCOUNTS = {"decarbo46": ("DECA!BEATS", "その他")}


def gojuon(kana):
    hira = "".join(chr(ord(c) - 0x60) if "ァ" <= c <= "ヶ" else c for c in kana)
    plain = "".join(c for c in unicodedata.normalize("NFD", hira) if c not in "゙゚")
    return (plain, hira)


def load_targets(usernames):
    """[{username, name, section, sort, groups}]。現役(グループ順→加入順)のあとに OG(見出しごと→加入順)。"""
    wanted = {u.lower(): u for u in usernames}
    with urllib.request.urlopen(ACCOUNTS_CSV, timeout=60) as res:
        rows = list(csv.reader(io.StringIO(res.read().decode("utf-8"))))[1:]

    members = {}
    for row in rows:
        row = [c.strip() for c in row] + [""] * 5
        num_s, name, platform, id_ = row[:4]
        if not num_s.isdigit() or not platform:
            continue
        m = members.setdefault(int(num_s), {"num": int(num_s), "name": name, "aff": "", "tt": [], "kana": "", "groups": []})
        if not m["name"] and name:
            m["name"] = name
        if not id_ and re.fullmatch(r"[ぁ-ゖァ-ヺー・]+", platform):
            m["kana"] = platform
        elif platform == "affiliation":
            m["aff"] = id_
        elif platform in ("GroupNo", "SubGroup") and id_.isdigit() and int(id_) in GROUP_NAMES:
            if GROUP_NAMES[int(id_)] not in m["groups"]:
                m["groups"].append(GROUP_NAMES[int(id_)])
        elif platform == "tiktok" and id_:
            m["tt"].append(id_.strip("/").lstrip("@").lower())

    group_order = list(GROUPS)
    picked = []
    for m in members.values():
        m["tt"] = [u for u in m["tt"] if u in wanted]
        if not m["tt"]:
            continue
        if m["aff"] in GROUPS:
            picked.append(((0, group_order.index(m["aff"]), m["num"]), m, GROUPS[m["aff"]]))
            continue
        name = m["name"].replace(" ", "").replace("　", "")
        listed = [(sec, names.index(name)) for sec, names in OG_ORDER.items() if name in names]
        if listed:
            sec, pos = listed[0]
        elif m["aff"] == "upfrontpromotion":
            sec, pos = "UP-FRONT PROMOTION", m["num"]
        else:
            sec, pos = "その他のOG", gojuon(m["kana"] or m["name"])
        picked.append(((1, OG_SECTIONS.index(sec), pos), m, sec))
    for slug, user in GROUP_OFFICIAL.items():
        if user.lower() in wanted:
            label = re.sub(r"'\d+$", "", GROUPS[slug])
            picked.append(((0, group_order.index(slug), -1), {"name": label, "tt": [user.lower()]}, GROUPS[slug]))

    out = {}
    for _, m, sec in sorted(picked, key=lambda t: t[0]):
        for low in m["tt"]:
            user = wanted[low]
            name = m["name"] if len(m["tt"]) <= 1 else f"{m['name']}（@{user}）"
            out.setdefault(low, {"username": user, "name": name, "section": sec,
                                 "groups": ("," + ",".join(m["groups"]) + ",") if m.get("groups") else ""})
    for user, (name, sec) in EXTRA_ACCOUNTS.items():
        if user.lower() in wanted:
            out.setdefault(user.lower(), {"username": wanted[user.lower()], "name": name, "section": sec, "groups": ""})

    lost = [u for low, u in wanted.items() if low not in out]
    if lost:
        sys.exit(f"名前が分からないアカウントがあります(SNS一覧か EXTRA_ACCOUNTS を確かめる): {', '.join(lost)}")
    targets = list(out.values())
    for i, t in enumerate(targets):
        t["sort"] = i
    return targets


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--site")
    args = ap.parse_args()
    usernames = json.loads((ROOT / "collect" / "count-input.json").read_text(encoding="utf-8"))["profiles"]
    targets = load_targets(usernames)
    if not args.site:
        for t in targets:
            print(f"{t['section']}\t{t['name']}\t@{t['username']}")
        print(len(targets), "アカウント(--site を付けると送ります)")
        return
    print(post_json(args.site, "/api/crawl/accounts", {"accounts": targets}))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
