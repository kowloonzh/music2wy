#!/usr/bin/env python3
"""export_cookie.py — 从网易云音乐 macOS 客户端本地存储解出登录 cookie。

客户端把 cookie 以 NSKeyedArchiver(plist) 形式存在 MMKV 里，这里做两件事：
  1) 解析 MMKV 二进制（varint 键值对），取出 cookie / userInfo 两个键；
  2) 反归档 plist，拼出 music.163.com 域的 cookie 串，写入 ~/.musicbridge/cookie.json（权限 600）。

只读客户端文件，不修改它。客户端重新登录后重跑一次即可。
"""
import json
import os
import plistlib
import re
import stat
import sys

MMKV = os.path.expanduser(
    "~/Library/Application Support/com.netease.163music/Documents/storage/mmkv.default"
)
OUT_DIR = os.environ.get("MUSICBRIDGE_HOME", os.path.expanduser("~/.musicbridge"))
OUT = os.path.join(OUT_DIR, "cookie.json")


def rd_varint(b, i):
    x = 0
    s = 0
    while True:
        c = b[i]
        i += 1
        x |= (c & 0x7F) << s
        if not c & 0x80:
            break
        s += 7
    return x, i


def parse_mmkv(path):
    data = open(path, "rb").read()
    i, out = 0, {}
    while i < len(data) - 2:
        try:
            klen, j = rd_varint(data, i)
            if klen == 0 or klen > 200 or j + klen > len(data):
                i += 1
                continue
            key = data[j:j + klen]
            if not re.fullmatch(rb"[A-Za-z0-9_\-\.]{1,80}", key):
                i += 1
                continue
            vlen, k = rd_varint(data, j + klen)
            if vlen > len(data) - k:
                i += 1
                continue
            out[key.decode()] = data[k:k + vlen]
            i = k + vlen
        except Exception:
            i += 1
    return out


def unarchive(blob):
    """把 NSKeyedArchiver blob 还原成 python 对象。"""
    idx = blob.find(b"bplist00")
    if idx < 0:
        return None
    pl = plistlib.loads(blob[idx:])
    objs = pl["$objects"]

    def dep(x, seen=None):
        seen = seen or set()
        if isinstance(x, plistlib.UID):
            n = x.data
            if n in seen:
                return None
            return dep(objs[n], seen | {n})
        if isinstance(x, dict):
            return {k: dep(v, seen) for k, v in x.items() if k != "$class"}
        if isinstance(x, list):
            return [dep(v, seen) for v in x]
        return x

    return dep(pl.get("$top"))


def cookies_from_blob(blob):
    root = unarchive(blob)["root"]
    res = {}
    for dom, entries in zip(root["NS.keys"], root["NS.objects"]):
        if dom not in ("music.163.com", ".music.163.com"):
            continue
        for e in entries.get("NS.objects", []):
            pr = e["properties"]
            kv = dict(zip(pr["NS.keys"], pr["NS.objects"]))
            v = kv.get("Value")
            if isinstance(v, str):
                res[kv["Name"]] = v
    return res


def main():
    if not os.path.exists(MMKV):
        print(f"❌ 找不到客户端存储: {MMKV}", file=sys.stderr)
        return 1
    kv = parse_mmkv(MMKV)
    if "cookie" not in kv:
        print("❌ mmkv 里没有 cookie 键（先打开并登录网易云客户端）", file=sys.stderr)
        return 2
    ck = cookies_from_blob(kv["cookie"])
    if not ck.get("MUSIC_U"):
        print("❌ cookie 里没有 MUSIC_U，登录态可能无效", file=sys.stderr)
        return 3
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(ck, f, ensure_ascii=False)
    os.chmod(OUT, stat.S_IRUSR | stat.S_IWUSR)
    print(f"✅ 已导出 {len(ck)} 个 cookie 到 {OUT}")
    if "userInfo" in kv:
        ui = unarchive(kv["userInfo"])
        try:
            kv2 = dict(zip(ui["root"]["NS.keys"], ui["root"]["NS.objects"]))
            print(f"   userId={kv2.get('userId')}")
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
