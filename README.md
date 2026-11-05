# WEB PHIM — HỆ THỐNG PHÁT PHIM TỰ ĐỘNG QUA TELEGRAM & CLOUDFLARE

> **Trạng thái hiện tại:** Hệ thống chạy 100% trên **Cloudflare Worker** + **Telegram Gateway**, đã cắt bỏ hoàn toàn Cloudflare R2 (không tốn phí lưu trữ, không giới hạn băng thông).

---

## 1. Kiến trúc hệ thống tinh gọn

```
Admin Up Video vào Telegram (Master Storage)
       │
       ▼
VPS: telegram-sync.py (Lắng nghe bot và cập nhật feed.json + ảnh bìa)
       │
       ▼ (Cron 2 phút tự động kiểm tra và wrangler deploy)
Cloudflare Worker (phim.callboy76.live)
  ├── Phục vụ giao diện tĩnh (public/)
  ├── Đếm lượt xem (/api/views, /api/views/hit qua Cloudflare KV)
  └── Stream video trực tiếp từ Telegram qua Northflank Gateway (/m/...)
```

---

## 2. Cách đăng phim mới (Hoàn toàn tự động)

1. **Chuẩn bị video:**
   - Nếu video quá nặng (> 1.5GB): Chạy script nén nhanh trước khi up:
     ```bash
     ./scripts/compress-video.sh /duong-dan/video.mp4
     ```
2. **Đăng lên kênh Telegram:**
   - Up video lên kênh (Dòng đầu tiên của Caption = Tên phim).
   - Up 1 ảnh riêng ngay sau video để làm **ảnh bìa (poster)**.
3. **Chờ 2 phút:**
   - Bot trên VPS tự động bắt tin nhắn, tải ảnh bìa, cập nhật `public/data/feed.json` và tự động deploy lên Cloudflare.

---

## 3. Các công cụ hữu ích trong `scripts/`

* **`./scripts/compress-video.sh <file.mp4>`**:
  Nén video chuẩn Web H.264/AAC, giảm 50%–70% dung lượng mà mắt thường không thấy giảm độ nét, bật cờ `+faststart` giúp bấm Play là xem ngay.
* **`./scripts/create-hls.sh <file.mp4>`**:
  Cắt video thành các đoạn nhỏ `.ts` 5MB kèm file danh sách `.m3u8` để phát HLS không giới hạn độ dài.
* **`./scripts/sync-feed-to-public.py`**:
  Đồng bộ thủ công feed từ `/var/www/phim/data` sang `public/`.
* **`./scripts/auto-sync-deploy.sh`**:
  Kịch bản tự động kiểm tra thay đổi và chạy `wrangler deploy` (chạy bởi cron mỗi 2 phút).

---

## 4. Cấu trúc thư mục chuẩn

```
web-phim/
├── public/                 # Giao diện web tĩnh (HTML, CSS, JS, ảnh bìa, data/feed.json)
│   ├── index.html          # Trang chủ chính
│   ├── 404.html            # Trang lỗi 404
│   ├── css/                # Giao diện CSS
│   ├── js/                 # Logic JavaScript & Player
│   ├── thumbs/             # Kho ảnh bìa các phim
│   └── data/               # Dữ liệu feed.json
├── src/
│   └── worker.js           # Cloudflare Worker backend (API + Stream Telegram)
├── scripts/
│   ├── auto-sync-deploy.sh # Cron tự động deploy
│   ├── compress-video.sh   # Công cụ nén video
│   ├── create-hls.sh       # Công cụ cắt HLS
│   └── sync-feed-to-public.py
├── telegram-sync.py        # Bot Telegram lắng nghe kênh trên VPS
├── tg-config.json          # Cấu hình bot token
├── wrangler.jsonc          # Cấu hình Cloudflare Worker
└── README.md               # Tài liệu này
```

---

## 5. Lệnh vận hành thường dùng

* **Xem trạng thái bot Telegram trên VPS:**
  ```bash
  pm2 status
  pm2 logs telegram-sync
  ```
* **Chạy deploy thủ công bằng tay:**
  ```bash
  cd /root/web-phim
  python3 scripts/sync-feed-to-public.py
  wrangler deploy
  ```
* **Kiểm tra web còn sống:**
  ```bash
  curl -s https://phim.callboy76.live/api/health
  curl -s https://phim.callboy76.live/api/feed | head -c 100
  ```
