"""tiktok-collect.js から bookmarklet.html を作り直す。JS を直したら実行する。"""
import html
import urllib.parse
from pathlib import Path

HERE = Path(__file__).resolve().parent


def main():
    src = (HERE / "tiktok-collect.js").read_text(encoding="utf-8")
    url = "javascript:" + urllib.parse.quote(src, safe="") + "void 0"
    page = f'''<!doctype html>
<html lang="ja"><meta charset="utf-8"><title>TikTok 取得 ブックマークレット</title>
<body style="font:16px/1.8 sans-serif;max-width:640px;margin:40px auto;padding:0 16px">
<p>次のリンクを、ブックマークバーへドラッグします。</p>
<p><a href="{html.escape(url)}" style="font-size:20px">TikTok取得</a></p>
<ol><li>ログアウトした状態で、TikTok のプロフィール画面を直接開く</li><li>投稿が並んだら、ブックマークバーの「TikTok取得」を押して、画面を触らずに待つ</li><li>終わったら「保存」を押し、できた JSON を data フォルダに置く</li></ol>
</body></html>
'''
    (HERE / "bookmarklet.html").write_text(page, encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
