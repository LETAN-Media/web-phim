#!/usr/bin/env python3
"""Tự động đồng bộ video từ kênh Telegram PRIVATE lên web phim.

Cách hoạt động:
- Bạn tạo bot qua @BotFather, thêm bot làm ADMIN vào kênh private.
- Up video lên kênh (caption dòng đầu = tên phim) -> server tự bắt qua
  Bot API getUpdates (channel_post) -> web hiện phim mới, không cần làm gì thêm.
- Video phát qua /api/tg-stream (proxy, giấu token, hỗ trợ tua/seek).
- Poster mặc định lấy từ thumbnail của video, cache local.
- Poster tùy chọn: gởi ảnh cùng album với video, hoặc gởi 1 ảnh riêng trong vòng
  POSTER_WINDOW giây sau video -> ảnh đó thành poster (nên dùng tỉ lệ dọc 2:3).

Cấu hình: file /root/web-phim/tg-config.json  {"bot_token": "123:ABC..."}
  (KHÔNG copy file này lên /var/www/phim)
Chạy: pm2 start /root/web-phim/telegram-sync.py --name telegram-sync --interpreter python3
"""
import json
import os
import re
import shutil
import time
import threading
import urllib.request
import urllib.parse
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 8202
DATA_DIR = "/var/www/phim/data"
FEED_FILE = os.path.join(DATA_DIR, "feed.json")
OFFSET_FILE = os.path.join(DATA_DIR, "tg-offset.txt")
THUMB_DIR = os.path.join(DATA_DIR, "thumbs")
CONFIG_FILE = "/root/web-phim/tg-config.json"
POLL_INTERVAL = 10
POSTER_WINDOW = 15 * 60  # ảnh riêng trong 15 phút sau video -> được phép THAY poster đã có của video đó

os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(THUMB_DIR, exist_ok=True)


def load_config():
    try:
        with open(CONFIG_FILE, encoding="utf-8") as f:
            d = json.load(f)
            return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def bot_token():
    tok = os.environ.get("BOT_TOKEN", "").strip()
    if tok:
        return tok
    return (load_config().get("bot_token") or "").strip()


def api_base():
    return (load_config().get("api_base") or "https://api.telegram.org").rstrip("/")


def file_base():
    return (load_config().get("file_base") or api_base()).rstrip("/")


def file_url(path):
    return "%s/file/bot%s/%s" % (file_base(), bot_token(), path)


# Container docker map /root/tg-bot-api (máy thật) <-> /var/lib/telegram-bot-api (trong container).
# getFile trả về đường dẫn TRONG container -> phải dịch sang đường dẫn máy thật mới đọc được.
BOT_CONTAINER_DIR = "/var/lib/telegram-bot-api"
BOT_HOST_DIR = "/root/tg-bot-api"


def host_path_for(container_path):
    rp = os.path.normpath(container_path or "")
    if not rp.startswith(BOT_CONTAINER_DIR + os.sep):
        raise RuntimeError("duong dan file khong hop le")
    rel = os.path.relpath(rp, BOT_CONTAINER_DIR)
    if rel.startswith("..") or os.sep + ".." + os.sep in os.sep + rel + os.sep:
        raise RuntimeError("duong dan file khong hop le")
    return os.path.join(os.path.realpath(BOT_HOST_DIR), rel)


def sniff_video_ctype(path):
    try:
        with open(path, "rb") as f:
            h = f.read(12)
    except OSError:
        return "video/mp4"
    if len(h) >= 8 and h[4:8] == b"ftyp":
        return "video/mp4"
    if h.startswith(b"\x1a\x45\xdf\xa3"):
        return "video/webm"
    return "video/mp4"


def local_path_for(file_id, timeout_wait=180):
    """getFile qua server local -> đợi Telegram tải xong -> trả (disk_path, size)."""
    res = api("getFile", {"file_id": file_id}, timeout=60)
    if not res.get("ok"):
        raise RuntimeError("getFile that bai")
    info = res["result"]
    size = info.get("file_size", 0)
    p = host_path_for(info.get("file_path", ""))
    deadline = time.time() + timeout_wait
    while time.time() < deadline:
        try:
            if size > 0 and os.path.isfile(p) and os.path.getsize(p) >= size:
                return p, size
        except OSError:
            pass
        time.sleep(3)
        try:
            api("getFile", {"file_id": file_id}, timeout=60)  # kich lai download
        except Exception:
            pass
    if os.path.isfile(p):
        return p, os.path.getsize(p)
    raise RuntimeError("timeout doi file tu Telegram")


def sniff_image_ctype(path):
    try:
        with open(path, "rb") as f:
            h = f.read(12)
    except OSError:
        return "image/jpeg"
    if h.startswith(b"\x89PNG"):
        return "image/png"
    if h[:4] == b"RIFF" and h[8:12] == b"WEBP":
        return "image/webp"
    return "image/jpeg"


def _warm_file(key, fid, timeout_wait, attempts=3):
    """Warm 1 file với retry/backoff. Không raise ngoài hàm (chỉ log)."""
    if not fid:
        return
    last_err = None
    for attempt in range(1, attempts + 1):
        try:
            local_path_for(fid, timeout_wait=timeout_wait)
            return
        except Exception as e:
            last_err = e
            print("warm %s lan %d/%d loi: %s" % (key, attempt, attempts, e), flush=True)
            if attempt < attempts:
                time.sleep(15)
    print("warm %s FAIL sau %d lan: %s" % (key, attempts, last_err), flush=True)


def warm_item(item):
    """Tải trước poster/thumb (nhỏ, ưu tiên trước) rồi video về ổ cứng.
    Poster đi trước để không bị starve khi video lớn đang tải."""
    _warm_file("poster", item.get("poster_id"), timeout_wait=300, attempts=3)
    _warm_file("thumb", item.get("thumb_id"), timeout_wait=300, attempts=3)
    try:
        if item.get("file_id"):
            local_path_for(item["file_id"], timeout_wait=900)
    except Exception as e:
        print("warm video loi:", e, flush=True)


def api(method, params=None, timeout=30):
    tok = bot_token()
    if not tok:
        raise RuntimeError("chua cau hinh bot_token")
    url = "%s/bot%s/%s" % (api_base(), tok, method)
    data = urllib.parse.urlencode(params or {}).encode() if params else None
    req = urllib.request.Request(url, data=data, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def load_feed():
    try:
        with open(FEED_FILE, encoding="utf-8") as f:
            d = json.load(f)
            return d if isinstance(d, list) else []
    except Exception:
        return []


def save_feed(items):
    tmp = FEED_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False)
    os.replace(tmp, FEED_FILE)


def parse_caption(cap):
    cap = (cap or "").strip()
    if not cap:
        return "", ""
    lines = cap.split("\n")
    return lines[0].strip()[:150], "\n".join(lines[1:]).strip()[:2000]


def handle_channel_post(post):
    video = post.get("video") or {}
    doc = post.get("document") or {}
    file_id, thumb, duration = None, None, 0
    if video.get("file_id"):
        file_id = video["file_id"]
        thumb = video.get("thumb") or video.get("thumbnail")
        duration = video.get("duration", 0)
    elif (doc.get("mime_type") or "").startswith("video") and doc.get("file_id"):
        file_id = doc["file_id"]
        thumb = doc.get("thumb") or doc.get("thumbnail")
        duration = 0
    else:
        return None  # không phải video -> bỏ qua
    mid = post.get("message_id")
    chat = post.get("chat", {}) or {}
    title, desc = parse_caption(post.get("caption") or "")
    if not title:
        title = time.strftime("Video %d/%m/%Y", time.localtime(post.get("date", time.time())))
    thumb_id = thumb.get("file_id") if isinstance(thumb, dict) else None
    return {
        "mid": mid,
        "channel": chat.get("title", ""),
        "title": title,
        "desc": desc,
        "file_id": file_id,
        "thumb_id": thumb_id,
        "poster_id": None,
        "media_group_id": post.get("media_group_id"),
        "duration": duration,
        "date": post.get("date", 0),
    }


def photo_file_id(post):
    """Lấy file_id ảnh trong bài đăng (Photo lấy size lớn nhất, hoặc File ảnh). Không có -> None."""
    photos = post.get("photo") or []
    if photos:
        best = max(photos, key=lambda p: (p.get("width", 0) * p.get("height", 0), p.get("file_size", 0)))
        return best.get("file_id")
    doc = post.get("document") or {}
    if (doc.get("mime_type") or "").startswith("image/") and doc.get("file_id"):
        return doc["file_id"]
    return None


def set_poster(feed, item, poster_id):
    item["poster_id"] = poster_id
    save_feed(feed)
    cached = os.path.join(THUMB_DIR, "%s_poster" % item["mid"])
    try:
        os.remove(cached)
    except OSError:
        pass
    print("poster moi cho mid=%s: %s" % (item.get("mid"), item.get("title")), flush=True)
    threading.Thread(target=warm_item, args=({"poster_id": poster_id},), daemon=True).start()


def attach_poster(post, poster_id, pending_group):
    """Gắn ảnh vào video.
    - Cùng album (media_group_id) -> gắn đúng video đó (ảnh tới trước thì chờ).
    - Ảnh riêng -> gắn cho video mới nhất nếu nó chưa có poster,
      hoặc thay poster cũ nếu ảnh đăng trong POSTER_WINDOW sau video.
    """
    mid = post.get("message_id")
    gid = post.get("media_group_id")
    feed = load_feed()
    if gid:
        target = next((x for x in feed if x.get("media_group_id") == gid), None)
        if target is None:
            pending_group[gid] = poster_id  # ảnh tới trước video trong album -> chờ video
            print("anh mid=%s: album %s chua co video, cho..." % (mid, gid), flush=True)
            return
        set_poster(feed, target, poster_id)
        return
    if not feed:
        print("anh mid=%s: bo qua (chua co video nao)" % mid, flush=True)
        return
    latest = feed[0]
    in_window = 0 <= post.get("date", 0) - latest.get("date", 0) <= POSTER_WINDOW
    if not latest.get("poster_id") or in_window:
        set_poster(feed, latest, poster_id)
        return
    print("anh mid=%s: bo qua (video moi nhat da co poster, qua %ss)" % (mid, POSTER_WINDOW), flush=True)


def update_caption(post):
    """Sửa caption trên Telegram -> đổi tên/mô tả phim trên web (giữ poster, file)."""
    mid = post.get("message_id")
    feed = load_feed()
    item = next((x for x in feed if x.get("mid") == mid), None)
    if item is None:
        return
    title, desc = parse_caption(post.get("caption") or "")
    if not title:
        return
    item["title"], item["desc"] = title, desc
    save_feed(feed)
    print("doi ten mid=%s -> %s" % (mid, title), flush=True)


def poll_loop():
    offset = 0
    pending_group = {}  # media_group_id -> poster file_id (ảnh album tới trước video)
    try:
        offset = int((open(OFFSET_FILE).read() or "0").strip())
    except Exception:
        pass
    while True:
        try:
            if not bot_token():
                time.sleep(POLL_INTERVAL)
                continue
            res = api("getUpdates", {
                "offset": offset, "timeout": 25,
                "allowed_updates": json.dumps(["channel_post", "edited_channel_post"]),
            }, timeout=40)
            for upd in res.get("result", []):
                # Luôn lấy theo update_id vừa nhận (không dùng max): dải update_id của server
                # Bot API local khác dải của api.telegram.org, dùng max sẽ kẹt offset cũ.
                offset = upd.get("update_id", 0) + 1
                if upd.get("edited_channel_post"):
                    update_caption(upd["edited_channel_post"])
                    continue
                post = upd.get("channel_post")
                if not post:
                    continue
                poster_id = photo_file_id(post)
                if poster_id:
                    attach_poster(post, poster_id, pending_group)
                    continue
                item = handle_channel_post(post)
                if not item:
                    continue
                gid = item.get("media_group_id")
                if gid and gid in pending_group:
                    item["poster_id"] = pending_group.pop(gid)
                feed = [x for x in load_feed() if x.get("mid") != item["mid"]]
                feed.insert(0, item)
                save_feed(feed[:200])
                print("moi tu Telegram: %s" % item["title"], flush=True)
                threading.Thread(target=warm_item, args=(item,), daemon=True).start()
            with open(OFFSET_FILE, "w") as f:
                f.write(str(offset))
        except Exception as e:
            print("poll loi:", e, flush=True)
            time.sleep(5)


file_path_cache = {}


def get_file_path(file_id):
    if file_id in file_path_cache:
        return file_path_cache[file_id]
    res = api("getFile", {"file_id": file_id})
    if res.get("ok"):
        p = res["result"]["file_path"]
        file_path_cache[file_id] = p
        return p
    raise RuntimeError("getFile that bai")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Range")

    def send_json(self, obj, code=200):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.cors()
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        if parsed.path == "/api/feed":
            feed = load_feed()
            items = []
            for x in feed:
                items.append({
                    "mid": x["mid"], "title": x["title"], "desc": x.get("desc", ""),
                    "date": x.get("date", 0), "duration": x.get("duration", 0),
                    "stream": "/api/tg-stream?mid=%s" % x["mid"],
                    # đổi query khi có poster để trình duyệt không dùng thumb cũ trong cache
                    "thumb": "/api/tg-thumb?mid=%s%s" % (x["mid"], "&v=p" if x.get("poster_id") else ""),
                    "has_poster": bool(x.get("poster_id")),
                })
            return self.send_json({"ok": True, "configured": bool(bot_token()),
                                    "count": len(items), "items": items})
        if parsed.path == "/api/tg-thumb":
            return self.serve_thumb((qs.get("mid") or [""])[0])
        if parsed.path == "/api/tg-stream":
            return self.serve_stream((qs.get("mid") or [""])[0])
        return self.send_json({"error": "not found"}, 404)

    def do_HEAD(self):
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        if parsed.path == "/api/tg-stream":
            return self.serve_stream((qs.get("mid") or [""])[0], head_only=True)
        self.send_response(404)
        self.end_headers()

    def find_item(self, mid):
        try:
            mid = int(mid)
        except (TypeError, ValueError):
            return None
        for x in load_feed():
            if x.get("mid") == mid:
                return x
        return None

    def cached_image(self, cached, file_id, timeout_wait=60):
        """Trả đường dẫn ảnh đã cache; chưa có thì tải từ Telegram. Lỗi -> None."""
        if os.path.isfile(cached):
            return cached
        if not file_id:
            return None
        try:
            src, _ = local_path_for(file_id, timeout_wait=timeout_wait)
            shutil.copyfile(src, cached)
            return cached
        except Exception as e:
            print("tai anh loi:", e, flush=True)
            return None

    def serve_thumb(self, mid):
        item = self.find_item(mid)
        if not item:
            return self.send_json({"error": "khong thay video"}, 404)
        # Ưu tiên poster người dùng gởi, không có -> thumbnail của video
        if item.get("poster_id"):
            p = self.cached_image(os.path.join(THUMB_DIR, "%s_poster" % item["mid"]), item["poster_id"], 120)
            if p:
                return self.send_file(p, sniff_image_ctype(p))
        p = self.cached_image(os.path.join(THUMB_DIR, "%s.jpg" % item["mid"]), item.get("thumb_id"))
        if p:
            return self.send_file(p, "image/jpeg")
        return self.send_json({"error": "video khong co thumbnail"}, 404)

    def send_file(self, path, ctype):
        try:
            size = os.path.getsize(path)
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(size))
            self.send_header("Cache-Control", "public, max-age=86400")
            self.cors()
            self.end_headers()
            with open(path, "rb") as f:
                while True:
                    buf = f.read(65536)
                    if not buf:
                        break
                    self.wfile.write(buf)
        except BrokenPipeError:
            pass

    def serve_range_file(self, path, ctype):
        """Phục vụ file từ ổ cứng, hỗ trợ Range để tua/seek."""
        try:
            total = os.path.getsize(path)
        except OSError:
            return self.send_json({"error": "khong doc duoc file"}, 500)
        if total <= 0:
            return self.send_json({"error": "file rong"}, 500)
        start, end, code = 0, total - 1, 200
        rng = (self.headers.get("Range") or "").strip()
        m = re.match(r"bytes=(\d*)-(\d*)$", rng)
        if m:
            s, e = m.groups()
            if s == "" and e != "":
                start = max(0, total - int(e))
            else:
                if s != "":
                    start = int(s)
                if e != "":
                    end = min(int(e), total - 1)
            if 0 <= start < total and start <= end:
                code = 206
            else:
                self.send_response(416)
                self.send_header("Content-Range", "bytes */%d" % total)
                self.end_headers()
                return
        length = end - start + 1
        try:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(length))
            self.send_header("Accept-Ranges", "bytes")
            if code == 206:
                self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, total))
            self.send_header("Cache-Control", "public, max-age=86400")
            self.cors()
            self.end_headers()
        except (BrokenPipeError, ConnectionResetError):
            return
        try:
            with open(path, "rb") as f:
                f.seek(start)
                remaining = length
                while remaining > 0:
                    buf = f.read(min(65536, remaining))
                    if not buf:
                        break
                    try:
                        self.wfile.write(buf)
                    except (BrokenPipeError, ConnectionResetError):
                        break
                    remaining -= len(buf)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def serve_stream(self, mid, head_only=False):
        item = self.find_item(mid)
        if not item:
            return self.send_json({"error": "khong thay video"}, 404)
        try:
            path, _ = local_path_for(item["file_id"], timeout_wait=300)
        except Exception as e:
            return self.send_json({"error": str(e)}, 502)
        if head_only:
            try:
                total = os.path.getsize(path)
            except OSError:
                return self.send_json({"error": "khong doc duoc file"}, 500)
            self.send_response(200)
            self.send_header("Content-Type", sniff_video_ctype(path))
            self.send_header("Content-Length", str(total))
            self.send_header("Accept-Ranges", "bytes")
            self.cors()
            self.end_headers()
            return
        return self.serve_range_file(path, sniff_video_ctype(path))


if __name__ == "__main__":
    threading.Thread(target=poll_loop, daemon=True).start()
    print("telegram-sync chay port %s (token: %s)" % (PORT, "OK" if bot_token() else "CHUA CAU HINH"), flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
