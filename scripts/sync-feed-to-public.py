#!/usr/bin/env python3
"""Sync VPS feed + thumbnails into Worker static assets. No R2, no secrets.

Reads /var/www/phim/data/feed.json + thumbs dir.
Writes public/data/feed.json (player-ready, no expiring URLs) and
copies poster/thumb files to public/thumbs/<mid>.(jpg).
Rerun + redeploy whenever new videos arrive on Telegram/VPS.
"""
import json
import os
import shutil
import sys
import urllib.parse
import urllib.request

FEED_SRC = "/var/www/phim/data/feed.json"
THUMB_DIR = "/var/www/phim/data/thumbs"
OUT_FEED = "/root/web-phim/public/data/feed.json"
OUT_THUMB_DIR = "/root/web-phim/public/thumbs"
CONFIG_FILE = "/root/web-phim/tg-config.json"


def log(msg):
    print(f"[sync-feed] {msg}", flush=True)


def load_config():
    try:
        with open(CONFIG_FILE, encoding="utf-8") as f:
            d = json.load(f)
            return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def bot_api(method, params=None, timeout=30):
    cfg = load_config()
    tok = (cfg.get("bot_token") or "").strip()
    base = (cfg.get("api_base") or "https://api.telegram.org").rstrip("/")
    if not tok:
        raise RuntimeError("missing bot_token")
    url = f"{base}/bot{tok}/{method}"
    data = urllib.parse.urlencode(params or {}).encode() if params else None
    req = urllib.request.Request(url, data=data, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def ensure_thumb(mid, poster_id, thumb_id):
    """Copy poster/thumb tu o cung Bot API local ve THUMB_DIR neu chua co.
    Doc truc tiep tu disk (/root/tg-bot-api, mount cua container) thay vi
    tai HTTP /file/ (endpoint nay 404 trong setup hien tai).
    Khong bao gio in token. Loi -> bo qua (web dung anh fallback)."""
    for cand in (f"{mid}_poster", f"{mid}.jpg"):
        if os.path.isfile(os.path.join(THUMB_DIR, cand)):
            return True
    fid = poster_id or thumb_id
    if not fid:
        return False
    try:
        res = bot_api("getFile", {"file_id": fid}, timeout=60)
        if not res.get("ok"):
            return False
        fpath = res["result"].get("file_path", "")
        expected = res["result"].get("file_size", 0) or 0
        # Container path /var/lib/telegram-bot-api/... <-> host /root/tg-bot-api/...
        rel = fpath.lstrip("/")
        prefix = "var/lib/telegram-bot-api/"
        if rel.startswith(prefix):
            rel = rel[len(prefix):]
        else:
            return False
        # Chan path traversal: chi chap nhan photos|thumbnails|documents/<file>
        parts = rel.split("/")
        if len(parts) < 3 or parts[1] not in ("photos", "thumbnails", "documents"):
            return False
        src = os.path.join("/root/tg-bot-api", parts[0], parts[1], parts[-1])
        if not os.path.isfile(src):
            return False
        if expected > 0 and os.path.getsize(src) < expected:
            return False  # file chua tai xong, de lan sync sau
        dest_name = f"{mid}_poster" if poster_id else f"{mid}.jpg"
        dest = os.path.join(THUMB_DIR, dest_name)
        tmp = dest + ".dl"
        shutil.copyfile(src, tmp)
        os.replace(tmp, dest)
        log(f"copied thumb for mid={mid} ({os.path.getsize(dest)} bytes)")
        return True
    except Exception as e:
        log(f"thumb copy failed mid={mid}: {e}")
        return False


def main():
    if not os.path.isfile(FEED_SRC):
        print(f"feed not found: {FEED_SRC}", flush=True)
        sys.exit(1)
    with open(FEED_SRC, encoding="utf-8") as f:
        feed = json.load(f)
    if not isinstance(feed, list):
        print("feed is not a list", flush=True)
        sys.exit(1)

    os.makedirs(os.path.dirname(OUT_FEED), exist_ok=True)
    os.makedirs(OUT_THUMB_DIR, exist_ok=True)

    items = []
    for x in feed:
        try:
            mid = int(x.get("mid"))
        except (TypeError, ValueError):
            log(f"skip invalid mid: {x.get('mid')!r}")
            continue
        ensure_thumb(mid, x.get("poster_id"), x.get("thumb_id"))
        thumb_src = None
        for cand in (f"{mid}_poster", f"{mid}.jpg"):
            p = os.path.join(THUMB_DIR, cand)
            if os.path.isfile(p):
                thumb_src = p
                break
        thumb_url = ""
        if thumb_src:
            dest = os.path.join(OUT_THUMB_DIR, f"{mid}.jpg")
            shutil.copyfile(thumb_src, dest)
            thumb_url = f"/thumbs/{mid}.jpg"
        items.append({
            "mid": mid,
            "title": x.get("title", ""),
            "desc": x.get("desc", ""),
            "date": x.get("date", 0),
            "duration": x.get("duration", 0),
            "stream": f"/api/play?mid={mid}",
            "thumb": thumb_url,
            "has_poster": bool(x.get("poster_id")),
        })

    items.sort(key=lambda i: i.get("date", 0), reverse=True)
    payload = {"ok": True, "configured": True, "count": len(items), "items": items}
    tmp = OUT_FEED + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    os.replace(tmp, OUT_FEED)
    with_thumbs = sum(1 for i in items if i["thumb"])
    log(f"wrote {OUT_FEED}: {len(items)} items, {with_thumbs} with thumbs")


if __name__ == "__main__":
    main()
