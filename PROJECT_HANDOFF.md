# PROJECT HANDOFF — WEB PHIM

> Cập nhật: 2026-09-20 ~21:50 UTC bởi agent audit (Codebuff).
> File này KHÔNG chứa secret. Secret chỉ nằm trong `/root/web-phim/.env` và Cloudflare secrets.

## Kiến trúc hiện tại (đã cắt-over)

```
Browser
  ↓ https://phim.callboy76.live
Cloudflare Worker "web-phim" (src/worker.js, static assets ./public)
  ↓ 302 /api/play → /m/<chat>/<mid>?exp&sig (HMAC-SHA256, TTL 6h, ký server-side)
  ↓ proxy Range → Northflank gateway
Northflank "telegram-stream-gateway" (Telethon MTProto)
  ↓ GetFile offset/limit (chunk 512KB, aligned)
Telegram channel -1003952062608  ← MASTER STORAGE
```

- R2 KHÔNG còn trong hot path: `r2_buckets: []` trong wrangler.jsonc, worker không có code R2.
  Kế hoạch R2 = persistent cache (account mới, bucket `web-phim-videos`), xem mục R2 bên dưới.
- Edge prewarm (commit `5266f70`): trên `/api/play`, worker background-fetch bytes
  [0,512KB) + [512KB,2MB) vào Cache API. Range nhỏ trong cửa sổ 2MB được slice từ cache
  → 206 exact. Mục đích giảm latency request đầu (Safari probe đầu). Không buffering video body.

## Repo / git

- Repo: `LETAN-Media/web-phim` (origin https://github.com/LETAN-Media/web-phim.git)
- Branch: `main` = `origin/main` (fetch fails trong session này do không có gh credential,
  nhưng local không có unpushed/behind theo ref cũ)
- HEAD: `5266f70` "startup tune: edge prewarm 512KB-2MB cache, player prefetch play URL on detail open"
- Uncommitted: chỉ `backups/` untracked (DNS backup). Không có sửa code chưa commit.
- Lịch sử gần: `bc82299` drop R2 binding/static feed+thumbs, `6df0454` worker v2 signed play,
  `b19ab2f` migration R2 doc (phase cũ), `d38f5c5` worker + R2 streaming (phase cũ).

## Production URLs

- Web: https://phim.callboy76.live (Cloudflare Worker + custom domain, SSL OK)
- Gateway: https://p01--telegram-stream-gateway--r4v2pzg2klvq.code.run
- Legacy VPS: https://phim.callboy76.live gốc tại 172.237.1.240 (nginx, /var/www/phim) — VẪN SỐNG,
  đã verify trực tiếp bypass Cloudflare (HTTP 200).
- Rollback DNS: đổi record `phim` về `172.237.1.240` (backup: backups/cloudflare-dns-before-cutover.json)

## Deployment providers

- Worker: Cloudflare Workers, account `CLOUDFLARE_ACCOUNT_ID` trong .env. Secret đã set:
  `STREAM_SIGNING_SECRET` (wrangler secret list). Deploy lần cuối 21:18 UTC (sau commit 21:20? —
  xem "Deployment state" bên dưới).
- Gateway: Northflank Developer Sandbox, repo GitHub, branch `main`, CI/CD push → build Dockerfile.
- VPS cũ: pm2 `telegram-sync`, `phim-upload`, nginx — KHÔNG ĐỘNG INTO.

## Deployment state

- Worker production: version `45122059-...` deploy 21:18:22 UTC 2026-09-20.
  Commit mới nhất `5266f70` tạo 21:20:15 UTC → **production có thể THIẾU prewarm tune cuối
  (15s git–deploy drift), hoặc có deploy ngoài git lúc 21:18. Cần verify lại trước khi kết luận.**
- Gateway production: `/v1/cache-status` → 404 trên URL public → **build production CHƯA có code
  mirror (uncommitted local)**. healthz: `telegram_connected: true`, `telegram_configured: true`.
- Lưu ý: gateway production có thể đang chạy commit `c28c080` (206 verified) hoặc `eb35f87`
  (startup warm + metadata cache) — không xác định được từ ngoài; cả hai đều ổn cho streaming.

## Đã PASS (test thật 2026-09-20 ~21:43 UTC)

- Web https://phim.callboy76.live/ → HTTP 200
- /api/health → {"ok":true}
- /api/feed → 5 items, có chat_id/message_id/stream=/api/play
- Gateway /healthz → ok, telegram_connected=true
- HEAD video mid=25 → 200, content-length 91790483 (~92MB, MTProto >20MB OK)
- Range 0-1023 → 206 `bytes 0-1023/91790483`
- Range 5000000-5000999 → 206 exact
- Range suffix -1024 → 206 `bytes 91789459-91790482/91790483`
- SSL + custom domain OK; HTTP/2

## R2 persistent cache — trạng thái

**PARTIAL (IMPLEMENTED_BUT_UNVERIFIED, chưa commit, chưa deploy)**

- Code nằm ở gateway repo (KHÔNG phải worker): `app/r2_mirror.py` (untracked),
  `app/main.py` modified (thêm POST `/v1/cache/{chat}/{mid}` và GET `/v1/cache-status/...`),
  `requirements.txt` +boto3, `tests/test_mirror.py` (untracked).
- Local pytest: 35/35 PASS (không cover bug runtime bên dưới).
- Env fallback code hỗ trợ cả `R2_NEW_*` (ưu tiên) lẫn `R2_*` cũ.
- VPS env files KHÔNG có `R2_NEW_*` — các creds trong `/root/web-phim/.env` (`R2_*`) là của
  account chứa bucket `web-phim-videos` (endpoint account != `CLOUDFLARE_ACCOUNT_ID` chính).
- **Chưa verify end-to-end**: chưa từng trigger mirror thật, chưa thấy object READY trên R2.
- **BUG HIỆN TẠI**: `/v1/cache-status` gọi `object_key(chat, mid, size)` (3 args) nhưng
  `r2_mirror.object_key(chat_id, message_id)` chỉ nhận 2 → 500 khi gọi thật. Fix 1 dòng
  trước khi deploy (hoặc đổi signature để nhận size, đồng bộ cả hai nơi).
- Worker hiện KHÔNG có logic gọi /v1/cache → ngay cả khi deploy gateway mới, flow
  "worker miss → trigger mirror" vẫn phải viết thêm ở worker.

## Env check (FOUND/MISSING, không in value)

`/root/web-phim/.env`:
- CLOUDFLARE_API_TOKEN: FOUND
- CLOUDFLARE_ACCOUNT_ID: FOUND
- R2_ACCESS_KEY_ID: FOUND (account của bucket web-phim-videos — credentials cho R2 cache)
- R2_SECRET_ACCESS_KEY: FOUND
- R2_ENDPOINT: FOUND (account khác account chính — khớp thiết kế "R2 account mới")
- R2_BUCKET: FOUND (giá trị tên = web-phim-videos)

`/root/web-phim` Cloudflare secrets (wrangler secret list):
- STREAM_SIGNING_SECRET: FOUND (secret_text)

`/root/telegram-stream-gateway/.env`:
- TELEGRAM_API_ID: FOUND
- TELEGRAM_API_HASH: FOUND
- TELEGRAM_BOT_TOKEN: FOUND
- TELEGRAM_SESSION_STRING: FOUND
- ALLOW_UNSIGNED_STREAMS: FOUND (=false, an toàn)
- TELEGRAM_CHANNEL_INVITE: FOUND
- STREAM_SIGNING_SECRET: FOUND
- ALLOWED_CHAT_IDS: FOUND (chứa -1003952062608)
- R2_NEW_ENDPOINT / R2_NEW_ACCESS_KEY_ID / R2_NEW_SECRET_ACCESS_KEY / R2_NEW_BUCKET: MISSING
  (chưa cần nếu dùng fallback R2_* — nhưng R2_* cũng CHƯA có trong gateway/.env; phải thêm
  trước khi deploy mirror, hoặc inject qua Northflank dashboard ENV)

MISSING toàn cục: TELEGRAM_* bên worker không cần (worker không nói chuyện Telegram trực tiếp).
ENABLE_LEGACY_FALLBACK: FOUND trong wrangler.jsonc vars = "true".
ALLOWED_CHAT_IDS (worker): dùng CHANNEL_CHAT_ID var = -1003952062608.

## Bảo mật

- `.env` cả 2 repo đều gitignored; lịch sử git KHÔNG có `.env` được commit.
- Không có secret in/commit trong session audit này.

## Blocker / next steps

Blocker:
1. Gateway mirror code chưa commit/push/deploy; khi deploy sẽ gặp bug `object_key` 3-args (500).
2. Worker chưa có code R2 lookup/trigger (R2_LOOKUP, BACKGROUND_MIRROR trigger ở worker = NO).
3. Gateway production ENV (Northflank) chưa có R2 creds cho mirror.
4. Web–gateway drift ~15s (commit 21:20 vs deploy 21:18) — cần confirm version production.

Next steps đề xuất (theo thứ tự):
1. Fix bug `object_key` (đồng bộ signature), chạy pytest, commit + push gateway → Northflank
   tự deploy → verify `/v1/cache-status` không 500.
2. Bổ sung R2 creds (R2_*) vào Northflank ENV (dashboard, không commit).
3. Test mirror thật: POST /v1/cache/<chat>/25 → poll cache-status → READY → head object R2.
4. Viết R2 lookup + fallback order (R2 → gateway → legacy) + trigger mirror sau play, ở worker.
5. Verify worker R2 HIT path bằng header riêng (hiện KHÔNG có X-Video-Source — nên thêm để debug).

## Rollback

- DNS: record `phim` → `172.237.1.240` (VPS nginx còn sống, đã verify 200).
- Worker: rollback version qua `wrangler rollback` hoặc deploy lại commit `d38f5c5`
  (VPS-verified) — xem MIGRATION_CLOUDFLARE_R2.md.
- Gateway: redeploy commit `c28c080` (206 live verified) trên Northflank.
- Backup: `/root/backups/phim-20260920-192155/`, backups/cloudflare-dns-before-cutover.json.
- Tuyệt đối: không xóa VPS, /var/www/phim, /root/tg-bot-api, Telegram data, feed, cache cũ.
