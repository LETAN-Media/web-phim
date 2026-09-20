# Migration web-phim → Cloudflare Worker + R2

Ngày: 2026-09-20. Production VPS KHÔNG bị gián đoạn trong quá trình migration.

## Kiến trúc mới

```
GitHub (LETAN-Media/web-phim)
  → Cloudflare Worker `web-phim` + Static Assets (./public)
    → Frontend: /, CSS, JS (giữ nguyên giao diện)
    → /api/feed: đọc meta/feed.json từ R2 (private binding)
    → /media/<key>: stream video/poster từ R2 private, hỗ trợ GET/HEAD/Range (206)
    → Tương thích cũ: /api/tg-stream?mid=, /api/tg-thumb?mid= resolve qua feed R2
R2 bucket: web-phim-videos (PRIVATE, không bật r2.dev)
Telegram: giữ nguyên video gốc + metadata (telegram_message_id) để restore
```

## Files mới

- `wrangler.jsonc` — Worker + assets `./public` + R2 binding, không chứa secret
- `src/worker.js` — serve static + R2 streaming (guard clauses, Range 206/416, ETag, fallback VPS configurable)
- `scripts/migrate-videos-to-r2.py` — idempotent, SKIP khi object đã có, upload streaming, retry backoff, verify size, không xóa Telegram/VPS
- `scripts/r2-usage-report.py` — báo cáo object/dung lượng, cảnh báo >8GB / >9.5GB trên mốc 10GB free, không xóa
- `public/` — bản copy frontend để Worker serve (sync từ source trước mỗi deploy)

## ENV (không commit, chỉ ở /root/web-phim/.env)

CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID,
R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ENDPOINT, R2_BUCKET

## Vận hành

```sh
# Sync frontend rồi deploy
cp index.html public/index.html && cp js/*.js public/js/
set -a; source .env; set +a
wrangler deploy

# Migrate video mới (chạy lại an toàn)
python3 scripts/migrate-videos-to-r2.py

# Báo cáo R2
python3 scripts/r2-usage-report.py
```

## Fallback migration (hiện tại: OFF)

`ENABLE_LEGACY_VIDEO_FALLBACK=false`, `LEGACY_ORIGIN=https://phim.callboy76.live`.
Khi migration dở dang có thể bật `true` để Worker proxy về VPS cho object chưa có trên R2.
Sau khi đủ video: giữ `false` — không request nào về VPS.

## Rollback (Cloudflare lỗi → về VPS cũ)

1. DNS `phim.callboy76.live` hiện tại trỏ `172.237.1.240` (VPS, nginx `/var/www/phim`).
2. Nếu đã đổi DNS sang Cloudflare mà lỗi: đổi record `phim` về lại `172.237.1.240`, TTL thấp, verify `curl -I https://phim.callboy76.live/` HTTP 200.
3. VPS services giữ nguyên cho đến khi chủ xác nhận: pm2 `telegram-sync`, `phim-upload`, nginx, `/var/www/phim`, `/root/tg-bot-api`, `feed.json`.
4. Code rollback: `git` commit VPS-verified `d38f5c5` (xem backup `/root/backups/phim-20260920-192155/`).

## Trạng thái 2026-09-20

- R2: 5/5 video + posters/thumbs (16 objects, ~1.00GB/10GB).
- Preview: https://web-phim.callboy76-live.workers.dev — homepage/feed/video/Range/HEAD/404 đã PASS.
- Domain `phim.callboy76.live` CHƯA chuyển (chờ xác nhận). VPS vẫn phục vụ production.
