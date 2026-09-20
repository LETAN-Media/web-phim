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

FEED_SRC = "/var/www/phim/data/feed.json"
THUMB_DIR = "/var/www/phim/data/thumbs"
OUT_FEED = "/root/web-phim/public/data/feed.json"
OUT_THUMB_DIR = "/root/web-phim/public/thumbs"


def log(msg):
    print(f"[sync-feed] {msg}", flush=True)


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
