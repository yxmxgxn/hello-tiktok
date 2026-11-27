"""data/ の収集結果を数えて、アカウントの一覧(data/checklist.html)を作る。

件数の目安は Apify の結果(dataset_*.json)、取れた分はブックマークレットの結果(tiktok_*.json)から数える。
本文は一覧に出さない。何度でも実行してよい。
"""
import glob
import html
import json
from pathlib import Path

from common import collected

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
HIDDEN_MAX = 3  # プロフィールの数と一覧に並ぶ数の差として、許す件数


def load(pattern):
    for path in sorted(glob.glob(str(DATA / pattern)), key=lambda p: Path(p).stat().st_mtime):
        with open(path, encoding="utf-8-sig") as f:
            yield json.load(f)


def main():
    accounts = json.loads((ROOT / "collect" / "count-input.json").read_text(encoding="utf-8"))["profiles"]

    total, nick = {}, {}
    for rows in load("dataset_*.json"):
        for r in rows:
            if "error" not in r:
                a = r["authorMeta"]
                total[a["name"].lower()] = a["video"]
                nick[a["name"].lower()] = a["nickName"]

    ids, clean = {}, {}
    for d in collected():
        key = d["account"].lower()
        ids.setdefault(key, set()).update(p["id"] for p in d["posts"])
        if d.get("total") is not None:
            total[key] = d["total"]
        # 一度でも取り逃しなく全部を読めていれば、そう数える
        clean[key] = clean.get(key) or d.get("full")

    rows = []
    for user in accounts:
        key = user.lower()
        want, got = total.get(key), len(ids.get(key, ()))
        if got and want is not None and (got >= want or (clean.get(key) and got >= want - HIDDEN_MAX)):
            state = "済"
        elif got:
            state = "一部"
        else:
            state = "未"
        rows.append((state, want, got, user, nick.get(key, "")))

    # まだのものを上に、件数の少ない順
    rows.sort(key=lambda r: (r[0] == "済", r[1] if r[1] is not None else 10**9))
    done = [r for r in rows if r[0] == "済"]
    left = sum(max((r[1] or 0) - r[2], 0) for r in rows if r[0] != "済")
    head = f"済 {len(done)} / {len(rows)} アカウント。残り {len(rows) - len(done)} アカウント・約 {left:,} 件"

    body = "".join(
        f'<tr class="{"done" if state == "済" else ""}"><td>{state}</td>'
        f'<td class="n">{"?" if want is None else f"{want:,}"}</td><td class="n">{got:,}</td>'
        f'<td><a href="https://www.tiktok.com/@{html.escape(user)}" target="_blank" rel="noreferrer">@{html.escape(user)}</a></td>'
        f"<td>{html.escape(name)}</td></tr>\n"
        for state, want, got, user, name in rows
    )
    page = f"""<!doctype html>
<html lang="ja"><meta charset="utf-8"><title>TikTok 収集の一覧</title>
<style>body{{font:15px/1.6 sans-serif;max-width:760px;margin:32px auto;padding:0 16px}}table{{border-collapse:collapse;width:100%}}
th,td{{border-bottom:1px solid #ddd;padding:6px 8px;text-align:left}}.n{{text-align:right}}.done{{color:#999}}</style>
<p>{head}</p>
<table><tr><th>状態</th><th class="n">総数</th><th class="n">取得</th><th>アカウント</th><th>名前</th></tr>
{body}</table></html>
"""
    (DATA / "checklist.html").write_text(page, encoding="utf-8", newline="\n")
    print(head)
    for r in rows:
        if r[0] != "未":
            print(f"{r[0]}  {r[2]}/{r[1]}  @{r[3]}")


if __name__ == "__main__":
    main()
