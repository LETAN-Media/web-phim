#!/usr/bin/env python3
"""Migrate videos + posters from VPS Telegram cache to Cloudflare R2.

Idempotent: checks R2 head first, SKIP if object exists with matching size.
Resume-safe: rerunnable, no duplicates, never deletes Telegram/VPS data.
Streaming upload: boto3 multipart, no full file in RAM.
Deterministic keys:
  videos/<mid>/video.mp4
  posters/<mid>/poster.jpg
  thumbs/<mid>/thumb.jpg
  meta/feed.json  (generated, keeps telegram_message_id)

Creds from ENV only (.env supported). Never prints secrets.
"""
import json
import os
import sys
import time
import hashlib
import urllib.request
import urllib.parse

try:
    import boto3
    from botocore.exceptions import ClientError
except ImportError:
    print("missing boto3. run: pip install boto3", flush=True)
    sys.exit(2)

FEED_SRC = "/var/www/phim/data/feed.json"
THUMB_DIR = "/var/www/phim/data/thumbs"
CONFIG_FILE = "/root/web-phim/tg-config.json"
ENV_FILE = "/root/web-phim/.env"

VIDEO_KEY_TMPL = "videos/{mid}/video.mp4"
POSTER_KEY_TMPL = "posters/{mid}/poster.jpg"
THUMB_KEY_TMPL = "thumbs/{mid}/thumb.jpg"
FEED_R2_KEY = "meta/feed.json"

MAX_RETRIES = 5


def log(msg):
    print(f"[migrate] {msg}", flush=True)


def fail(msg, code=1):
    log(f"FATAL: {msg}")
    sys.exit(code)


def load_dotenv(path):
    if not os.path.isfile(path):
        return
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k = k.strip()
                v = v.strip().strip("'").strip('"')
                if k and k not in os.environ:
                    os.environ[k] = v
    except OSError as e:
        fail(f"cannot read env file: {e}")


def env_or_fail(name):
    v = (os.environ.get(name) or "").strip()
    if not v:
        fail(f"missing ENV {name}")
    return v


def load_tg_config():
    try:
        with open(CONFIG_FILE, encoding="utf-8") as f:
            d = json.load(f)
            return d if isinstance(d, dict) else {}
    except OSError as e:
        fail(f"cannot read tg config: {e}")
    return {}


def tg_api(method, params, base, token, timeout=60):
    if not token:
        fail("telegram token not configured")
    url = f"{base}/bot{token}/{method}"
    data = urllib.parse.urlencode(params or {}).encode() if params else None
    req = urllib.request.Request(url, data=data, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


BOT_CONTAINER_DIR = "/var/lib/telegram-bot-api"
BOT_HOST_DIR = "/root/tg-bot-api"


def host_path_for(container_path):
    rp = os.path.normpath(container_path or "")
    if not rp.startswith(BOT_CONTAINER_DIR + os.sep):
        raise RuntimeError("invalid file path")
    rel = os.path.relpath(rp, BOT_CONTAINER_DIR)
    if rel.startswith(".."):
        raise RuntimeError("invalid file path")
    return os.path.join(os.path.realpath(BOT_HOST_DIR), rel)


def resolve_local_file(file_id, cfg, token, timeout_wait=300):
    """Resolve Telegram file_id to local disk path via local Bot API. No secret logging."""
    if not file_id:
        return None
    base = (cfg.get("api_base") or "https://api.telegram.org").rstrip("/")
    res = tg_api("getFile", {"file_id": file_id}, base, token)
    if not res.get("ok"):
        raise RuntimeError("getFile failed")
    info = res["result"]
    size = info.get("file_size", 0)
    path = host_path_for(info.get("file_path", ""))
    deadline = time.time() + timeout_wait
    while time.time() < deadline:
        try:
            if size > 0 and os.path.isfile(path) and os.path.getsize(path) >= size:
                return path, size
        except OSError:
            pass
        time.sleep(3)
        try:
            tg_api("getFile", {"file_id": file_id}, base, token)
        except Exception:
            pass
    if os.path.isfile(path):
        return path, os.path.getsize(path)
    raise RuntimeError("timeout waiting for Telegram file")


def r2_client():
    endpoint = env_or_fail("R2_ENDPOINT")
    access = env_or_fail("R2_ACCESS_KEY_ID")
    secret = env_or_fail("R2_SECRET_ACCESS_KEY")
    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access,
        aws_secret_access_key=secret,
        region_name="auto",
    )


def r2_head(s3, bucket, key):
    try:
        r = s3.head_object(Bucket=bucket, Key=key)
        return r
    except ClientError as e:
        code = str(e.response.get("ResponseMetadata", {}).get("HTTPStatusCode", ""))
        err = str(e.response.get("Error", {}).get("Code", ""))
        if code == "404" or err in ("404", "NoSuchKey", "NotFound"):
            return None
        raise


def upload_with_retry(s3, bucket, key, local_path, content_type):
    size = os.path.getsize(local_path)
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            s3.upload_file(
                local_path,
                bucket,
                key,
                ExtraArgs={"ContentType": content_type},
            )
            head = r2_head(s3, bucket, key)
            if head is None:
                raise RuntimeError("verify failed: object missing after upload")
            remote_size = head.get("ContentLength", -1)
            if remote_size != size:
                raise RuntimeError(f"size mismatch local={size} remote={remote_size}")
            return size
        except Exception as e:
            log(f"upload {key} attempt {attempt}/{MAX_RETRIES} failed: {type(e).__name__}")
            if attempt >= MAX_RETRIES:
                raise
            time.sleep(min(2 ** attempt, 30))
    raise RuntimeError("unreachable")


def slug_mid(mid):
    try:
        return str(int(mid))
    except (TypeError, ValueError):
        fail(f"invalid mid: {mid!r}")


def main():
    load_dotenv(ENV_FILE)
    bucket = env_or_fail("R2_BUCKET")
    # Validate other creds exist without printing values.
    env_or_fail("R2_ENDPOINT")
    env_or_fail("R2_ACCESS_KEY_ID")
    env_or_fail("R2_SECRET_ACCESS_KEY")

    if not os.path.isfile(FEED_SRC):
        fail(f"feed not found: {FEED_SRC}")
    try:
        with open(FEED_SRC, encoding="utf-8") as f:
            feed = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        fail(f"cannot parse feed: {type(e).__name__}")
    if not isinstance(feed, list):
        fail("feed is not a list")

    try:
        with open(CONFIG_FILE, encoding="utf-8") as f:
            cfg = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        fail(f"cannot read tg config: {type(e).__name__}")
    token = (os.environ.get("BOT_TOKEN") or cfg.get("bot_token") or "").strip()
    if not token:
        fail("BOT_TOKEN missing (env or tg-config)")

    s3 = r2_client()
    try:
        s3.head_bucket(Bucket=bucket)
    except Exception as e:
        fail(f"cannot access bucket: {type(e).__name__}")

    total = len(feed)
    log(f"feed items: {total}, bucket check OK")
    migrated = 0
    skipped = 0
    out_items = []

    for item in feed:
        mid = slug_mid(item.get("mid"))
        title = str(item.get("title") or f"mid-{mid}")[:80]
        video_key = VIDEO_KEY_TMPL.format(mid=mid)

        head = r2_head(s3, bucket, video_key)
        if head is not None:
            log(f"SKIP mid={mid} title={title!r} (exists, size={head.get('ContentLength')})")
            skipped += 1
            local_size = head.get("ContentLength", 0)
        else:
            file_id = item.get("file_id")
            if not file_id:
                log(f"SKIP mid={mid}: no file_id")
                skipped += 1
                local_size = 0
            else:
                log(f"fetch mid={mid} title={title!r} from Telegram cache...")
                try:
                    local_path, _ = resolve_local_file(file_id, cfg, token)
                except Exception as e:
                    log(f"ERROR mid={mid}: resolve failed: {type(e).__name__}")
                    continue
                try:
                    local_size = upload_with_retry(s3, bucket, video_key, local_path, "video/mp4")
                except Exception as e:
                    log(f"ERROR mid={mid}: upload failed: {type(e).__name__}")
                    continue
                log(f"OK video mid={mid} size={local_size}")
                migrated += 1

        # Poster / thumb: best-effort, never fails migration.
        for kind, tmpl, fid_key in (
            ("poster", POSTER_KEY_TMPL, "poster_id"),
            ("thumb", THUMB_KEY_TMPL, "thumb_id"),
        ):
            key = tmpl.format(mid=mid)
            try:
                if r2_head(s3, bucket, key) is not None:
                    continue
                fid = item.get(fid_key)
                if not fid:
                    # Fallback: cached file on VPS disk.
                    suffix = "poster" if kind == "poster" else "jpg"
                    cached = os.path.join(THUMB_DIR, f"{mid}_{suffix}" if kind == "poster" else f"{mid}.{suffix}")
                    if not os.path.isfile(cached):
                        continue
                    s3.upload_file(cached, bucket, key, ExtraArgs={"ContentType": "image/jpeg"})
                    continue
                local_path, _ = resolve_local_file(fid, cfg, token, timeout_wait=120)
                s3.upload_file(local_path, bucket, key, ExtraArgs={"ContentType": "image/jpeg"})
            except Exception as e:
                log(f"warn {kind} mid={mid}: {type(e).__name__}")

        # Build Worker-compatible feed entry. Keeps telegram metadata for restore.
        try:
            date = item.get("date", 0)
            duration = item.get("duration", 0)
            desc = item.get("desc", "")
            has_poster = bool(item.get("poster_id"))
            thumb_key = POSTER_KEY_TMPL.format(mid=mid) if has_poster else THUMB_KEY_TMPL.format(mid=mid)
            out_items.append({
                "mid": int(mid),
                "title": item.get("title", ""),
                "desc": desc,
                "date": date,
                "duration": duration,
                "stream": f"/media/{video_key}",
                "thumb": f"/media/{thumb_key}",
                "has_poster": has_poster,
                "r2_key": video_key,
                "thumb_key": thumb_key,
                "poster_key": POSTER_KEY_TMPL.format(mid=mid) if has_poster else None,
                "storage": "r2",
                "telegram_message_id": int(mid),
            })
        except (TypeError, ValueError):
            log(f"warn: skip feed entry mid={mid}")
            continue

    # Sort newest first, write meta/feed.json to R2 (overwrite is safe: deterministic).
    out_items.sort(key=lambda x: x.get("date", 0), reverse=True)
    payload = {"ok": True, "configured": True, "count": len(out_items), "items": out_items}
    tmp = "/tmp/feed-r2.json"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    s3.upload_file(tmp, bucket, FEED_R2_KEY, ExtraArgs={"ContentType": "application/json; charset=utf-8"})
    log(f"feed written: {FEED_R2_KEY} count={len(out_items)}")
    try:
        os.remove(tmp)
    except OSError:
        pass
    log(f"done: migrated={migrated} skipped={skipped} total={total}")


if __name__ == "__main__":
    main()
