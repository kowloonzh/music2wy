#!/usr/bin/env python3
"""browser_session.py — Playwright 兜底：用真浏览器打开站点、把 WAF 挑战过掉，输出 cookie。

由 `lib/browser.mjs` 调用，一般不需要手动跑。手动调试：

    python3 browser_session.py --url https://flac.music.hi.cn/ --headed
    python3 browser_session.py --url https://flac.music.hi.cn/ --channel chrome

要点：WAF 下发的 cookie 是 **HttpOnly**，页面的 `document.cookie` 读不到，
必须走 Playwright 的 `context.cookies()`。

输出：stdout 最后一行是一个 JSON 对象
    {"ok": true, "cookies": {...}, "title": "...", "ua": "...", "elapsed": 1.23}
"""
import argparse
import json
import sys
import time
from urllib.parse import urlparse


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--timeout", type=int, default=60000, help="毫秒")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--headed", dest="headed", action="store_true", default=False)
    g.add_argument("--headless", dest="headed", action="store_false")
    ap.add_argument("--channel", default=None,
                    help="用已安装的浏览器，例如 chrome / msedge；不填则用 Playwright 自带的 Chromium")
    ap.add_argument("--keep-open", type=float, default=0.0,
                    help="过挑战后再停留多少秒（调试用，方便肉眼看页面）")
    args = ap.parse_args()

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print(json.dumps({"ok": False, "error": "未安装 playwright：pip install playwright && playwright install chromium"},
                         ensure_ascii=False))
        return 1

    hostname = urlparse(args.url).hostname
    deadline = time.time() + args.timeout / 1000.0
    t0 = time.time()

    with sync_playwright() as p:
        launch_kw = {"headless": not args.headed}
        if args.channel:
            launch_kw["channel"] = args.channel
        try:
            browser = p.chromium.launch(**launch_kw)
        except Exception as e:
            print(json.dumps({"ok": False, "error": f"启动浏览器失败: {e}"}, ensure_ascii=False))
            return 1
        try:
            ctx = browser.new_context(locale="zh-CN", timezone_id="Asia/Shanghai")
            page = ctx.new_page()
            try:
                page.goto(args.url, wait_until="domcontentloaded", timeout=args.timeout)
            except Exception as e:
                # 挑战过程中页面会自己 reload，goto 偶尔会报错；只要 cookie 拿到了就算成功
                first_err = str(e).splitlines()[0]
            else:
                first_err = None

            cookies = {}
            title = None
            while time.time() < deadline:
                cookies = {c["name"]: c["value"] for c in ctx.cookies()}
                if "sl-session" in cookies and ("sl_jwt_session" in cookies or "sl-challenge-jwt" in cookies):
                    try:
                        title = page.title()
                    except Exception:
                        title = None
                    if not title or not any(k in title for k in ("SafeLine", "验证", "challenge")):
                        break
                page.wait_for_timeout(400)

            if args.keep_open:
                page.wait_for_timeout(int(args.keep_open * 1000))

            ua = None
            try:
                ua = page.evaluate("navigator.userAgent")
            except Exception:
                pass

            ok = "sl-session" in cookies and ("sl_jwt_session" in cookies or "sl-challenge-jwt" in cookies)
            out = {
                "ok": ok,
                "cookies": cookies,
                "title": title,
                "ua": ua,
                "elapsed": round(time.time() - t0, 2),
            }
            if not ok:
                out["error"] = f"没拿到 WAF cookie（现有: {','.join(cookies) or '无'}）；goto 错误: {first_err}"
            print(json.dumps(out, ensure_ascii=False))
            return 0 if ok else 1
        finally:
            browser.close()


if __name__ == "__main__":
    sys.exit(main())
