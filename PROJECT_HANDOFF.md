# PROJECT HANDOFF — WEB PHIM

> Cập nhật: 2026-10-04 (cắt fallback VPS + điểm lượt xem KV).
> Không chứa secret. Secret nằm trong Cloudflare secrets + Northflank ENV (tg-config.json/.env trên VPS đã gitignore).
>
> ## WEB KHÔNG PHỤ THUỘC VPS
> Web chạy 100% trên Cloudflare (Worker + R2 + KV) và Northflank gateway.
> VPS chỉ còn vai trò "máy up bài + deploy": nhận video/poster từ Telegram
> (telegram-sync.py), sync vào public/ rồi `wrangler deploy`.
> VPS mất hẳn → web vẫn chạy đủ (xem phim, bìa, điểm, đếm view); chỉ mất:
> up video mới, đổi tên/bìa, deploy bản mới. Khôi phục: clone repo GitHub
> sang máy khác, `wrangler login`, `wrangler deploy` (KV/R2/secrets nằm
> trong tài khoản Cloudflare, không nằm trên VPS).

## Kiến trúc hiện tại (R2 persistent cache + KV views, KHÔNG fallback VPS)

```
Browser
  ↓ https://phim.callboy76.live  (Cloudflare → Worker "web-phim", không qua VPS)
Cloudflare Worker "web-phim" (src/worker.js)
  ├─ /api/feed: feed tĩnh public/data/feed.json
  ├─ /api/views + /api/views/hit: điểm lượt xem (KV binding VIEWS)
  ├─ /api/play: ký HMAC URL (TTL 6h) + prewarm 2MB đầu + trigger mirror
  └─ /m/<chat>/<mid>: verify sig → source order:
       1. Edge prewarm (Cache API, chỉ cửa sổ 2MB đầu, nguồn Telegram)
       2. R2 new account (S3 SigV4, key videos/<chat>/<mid>.mp4)  → X-Video-Source: R2
       3. Northflank gateway (MTProto)                            → X-Video-Source: TELEGRAM
          (MISS: stream ngay + fire-and-forget POST /v1/cache để mirror nền)
Northflank gateway: Telethon MTProto (Telegram = MASTER STORAGE)
  └─ background mirror: iter_media_range → S3 multipart 8MB → R2, verify size, READY
```

- R2 = persistent read-through cache theo nhu cầu (chỉ video được xem mới được mirror).
- KHÔNG dùng R2 native binding account cũ; Worker dùng S3 SigV4 với credentials account mới.
- Telegram là master storage. Nhánh fallback VPS ĐÃ XÓA khỏi worker (2026-10-04):
  không còn biến ENABLE_LEGACY_*/LEGACY_ORIGIN, không còn request nào về VPS lúc chạy.

## Repo / git

- Repo: LETAN-Media/web-phim — branch main
- HEAD: `e23d276` "worker: R2 persistent cache lookup (SigV4) + source order R2->gateway->legacy"
  (đã push; bao gồm fix ctx truyền vào handleMediaProxy)
- Production version: `8c49d829-1b68-4d3d-99ca-d733da702d25` (deploy sau commit này, cùng code)
- Secrets đã set trên Worker: STREAM_SIGNING_SECRET + R2_NEW_ENDPOINT/ACCESS_KEY_ID/SECRET/BUCKET

## Đã PASS (production thật 2026-09-20 22:45–23:00 UTC)

- Regression: home 200, /api/health ok, feed 5 items
- R2 HIT (mid=25, mid=23): HEAD 200; Range start/middle/end 206 exact; X-Video-Source: R2
- R2 MISS (mid=18): HEAD 200 X-Video-Source: TELEGRAM; mirror tự trigger nền
- NORTHFLANK_BYPASSED_ON_R2_HIT: PASS (Northflank runtime logs: 0 request /v1/video trong window)
- Performance first-1MB TTFB (preview): R2 = 0.10–0.14s vs TELEGRAM = 1.33s (~10x nhanh hơn)
- Gateway mirror e2e: mid=25 (92MB) CACHING→READY ~4 phút; mid=23 (180MB) READY; size khớp Telegram
- R2 object metadata: telegram_chat_id/message_id/file_size, original_filename, cached_at,
  storage_source=telegram

## R2 bucket (account mới — web-phim-videos)

- Object mới: videos/<chat_id>/<message_id>.mp4 (mirror tạo, key deterministic)
- Object cũ từ phase migration trước: videos/<mid>/video.mp4, meta/feed.json, posters/, thumbs/
  (key scheme khác, KHÔNG xung đột, KHÔNG xóa)
- Hiện tại: 17 objects, ~1.09GB / 10GB free tier → STATUS: OK
- Report: `python3 scripts/r2-cache-report.py` (read-only, cảnh báo >8GB/>9.5GB, không tự xóa)
- Pre-cache CLI: `python3 scripts/cache_video.py --chat -1003952062608 --message <mid> [--wait]`

## Gateway

- Repo: LETAN-Media/telegram-stream-gateway — main HEAD `302d380` (deployed)
- Northflank ENV đầy đủ (9 biến Telegram/auth + 4 biến R2_NEW_*)
- POST /v1/cache/{chat}/{mid}, GET /v1/cache-status/{chat}/{mid} (HMAC-signed)
- Mirror: dedup lock per-video, multipart 8MB, retry/backoff, abort-on-error, size verify
- R2_CACHE_ENABLED default true; R2_MAX_CACHE_FILE_SIZE=0 (unlimited) — chưa set trên NF (dùng default)

## Next steps (không bắt buộc, khi nào cần mới làm)

1. Metadata sync Telethon events.NewMessage → staging data/telegram_staging.json (KHÔNG đụng feed)
2. Cloudflare edge cache tối ưu thêm nếu vẫn muốn (hiện R2 đã đủ nhanh)
3. Cleanup multipart quá hạn trên R2 nếu mirror FAILED để lại mảnh (hiện abort tự động)

## Rollback

- Worker: `wrangler rollback` hoặc deploy lại commit cũ. R2 MISS tự rơi về gateway nên lỗi R2 không chết trang.
- Gateway: redeploy `c28c080` (trước mirror) — mirror DISABLED không ảnh hưởng streaming.
- VPS (máy up bài/deploy, KHÔNG nằm trong đường chạy web):
  pm2 `telegram-sync`, `phim-upload`, `/var/www/phim`, `/root/tg-bot-api`, `feed.json`.
  Giữ nguyên cho đến khi chủ xác nhận xóa.
