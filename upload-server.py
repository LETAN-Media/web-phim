#!/usr/bin/env python3
"""Upload server cho web phim - up file lớn không giới hạn (chia chunk 10MB).
Chạy: pm2 start /root/web-phim/upload-server.py --name phim-upload --interpreter python3
Nginx proxy /api/ -> 127.0.0.1:8201
"""
import os
import json
import urllib.parse
import shutil
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = 8201
VIDEO_DIR = "/var/www/phim/videos"
TMP_DIR = "/tmp/phim-uploads"

os.makedirs(VIDEO_DIR, exist_ok=True)
os.makedirs(TMP_DIR, exist_ok=True)

def safe_name(name):
    name = os.path.basename(name or "video.mp4")
    out = []
    for c in name:
        if c.isalnum() or c in "._-()[] ":
            out.append(c)
        else:
            out.append("_")
    out = "".join(out).strip().replace(" ", "_")
    return out[:150] or "video.mp4"

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

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
        if parsed.path == "/api/videos":
            files = []
            for f in sorted(os.listdir(VIDEO_DIR)):
                fp = os.path.join(VIDEO_DIR, f)
                if os.path.isfile(fp):
                    files.append({
                        "name": f,
                        "url": f"/videos/{urllib.parse.quote(f)}",
                        "size": os.path.getsize(fp),
                    })
            return self.send_json({"videos": files})
        return self.send_json({"error": "not found"}, 404)

    def do_DELETE(self):
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        if parsed.path == "/api/videos":
            name = safe_name((qs.get("name") or [""])[0])
            fp = os.path.join(VIDEO_DIR, name)
            if os.path.isfile(fp):
                os.remove(fp)
                return self.send_json({"ok": True})
            return self.send_json({"error": "không thấy file"}, 404)
        return self.send_json({"error": "not found"}, 404)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        if parsed.path != "/api/upload-chunk":
            return self.send_json({"error": "not found"}, 404)

        upload_id = "".join(c for c in (qs.get("uploadId") or [""])[0] if c.isalnum() or c in "-_")[:64]
        try:
            chunk_index = int((qs.get("chunkIndex") or ["0"])[0])
            total_chunks = int((qs.get("totalChunks") or ["1"])[0])
        except ValueError:
            return self.send_json({"error": "chunk sai"}, 400)
        filename = safe_name((qs.get("filename") or ["video.mp4"])[0])
        if not upload_id:
            return self.send_json({"error": "thiếu uploadId"}, 400)

        length = int(self.headers.get("Content-Length") or 0)
        # Chống spam: mỗi chunk tối đa 64MB
        if length > 64 * 1024 * 1024:
            return self.send_json({"error": "chunk quá lớn"}, 413)

        part_path = os.path.join(TMP_DIR, upload_id + ".part")
        # chunk 0 -> tạo mới, chunk >0 -> append
        mode = "wb" if chunk_index == 0 else "ab"
        try:
            with open(part_path, mode) as f:
                remaining = length
                while remaining > 0:
                    buf = self.rfile.read(min(1024 * 1024, remaining))
                    if not buf:
                        break
                    f.write(buf)
                    remaining -= len(buf)
        except Exception as e:
            return self.send_json({"error": str(e)}, 500)

        # Chunk cuối -> chốt file
        if chunk_index >= total_chunks - 1:
            # Tránh trùng tên
            final = filename
            base, ext = os.path.splitext(filename)
            i = 1
            while os.path.exists(os.path.join(VIDEO_DIR, final)):
                final = f"{base}_{i}{ext}"
                i += 1
            shutil.move(part_path, os.path.join(VIDEO_DIR, final))
            url = f"/videos/{urllib.parse.quote(final)}"
            return self.send_json({"done": True, "name": final, "url": url})

        return self.send_json({"done": False, "received": chunk_index + 1, "total": total_chunks})

if __name__ == "__main__":
    print(f"Upload server chạy ở port {PORT}, lưu vào {VIDEO_DIR}", flush=True)
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
