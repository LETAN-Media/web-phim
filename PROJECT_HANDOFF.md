# PROJECT HANDOFF — WEB PHIM

> Cập nhật: 2026-09-20 ~23:05 UTC (Codebuff session 2, sau khi R2 persistent cache PASS).
> Không chứa secret. Secret nằm trong /root/web-phim/.env, Cloudflare secrets, Northflank ENV.

## Kiến trúc hiện tại (R2 persistent cache ĐÃ HOẠT ĐỘNG)

```
Browser
  ↓ https://phim.callboy76.live
Cloudflare Worker "web-phim" (src/worker.js)
  ├─ /api/play: ký HMAC URL (TTL 6h) + prewarm 2MB đầu + trigger mirror
  └─ /m/<chat>/<mid>: verify sig → source order:
       1. Edge prewarm (Cache API, chỉ cửa sổ 2MB đầu, nguồn Telegram)
       2. R2 new account (S3 SigV4, key videos/<chat>/<mid>.mp4)  → X-Video-Source: R2
       3. Northflank gateway (MTProto)                            → X-Video-Source: TELEGRAM
          (MISS: stream ngay + fire-and-forget POST /v1/cache để mirror nền)
       4. Legacy VPS 302                                          → X-Video-Source: LEGACY
Northflank gateway: Telethon MTProto (Telegram = MASTER STORAGE)
  └─ background mirror: iter_media_range → S3 multipart 8MB → R2, verify size, READY
```

- R2 = persistent read-through cache theo nhu cầu (chỉ video được xem mới được mirror).
- KHÔNG dùng R2 native binding account cũ; Worker dùng S3 SigV4 với credentials account mới.
- Telegram KHÔNG BỊ xóa/thay thế; legacy fallback vẫn ON; VPS cũ vẫn sống.

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

- Worker: `wrangler rollback` hoặc deploy lại commit `5266f70` (pre-gateway-cutover stable) /
  `d38f5c5` (VPS-verified). R2 MISS tự rơi về gateway nên lỗi R2 không chết trang.
- Gateway: redeploy `c28c080` (trước mirror) — mirror DISABLED không ảnh hưởng streaming.
- DNS cuối cùng: record phim → 172.237.1.240 (VPS nginx sống, legacy fallback ON).
- KHÔNG xóa: VPS, /var/www/phim, /root/tg-bot-api, Telegram data, feed, R2 bucket mới/cũ.
