# HƯỚNG DẪN LẤY LINK VIDEO TỪ KÊNH TELEGRAM LÊN WEB

Web này **không lưu video**, chỉ nhúng link từ Telegram của bạn.
Quy trình của bạn: **Up video lên kênh Telegram → lấy link → đăng lên web qua trang `admin.html`**.

---

## Cách 1: Dùng link bài đăng (DỄ NHẤT, 1 phút)

Áp dụng khi kênh của bạn là **Public** (Kênh công khai, có @username).

1. Tạo kênh Telegram, vào Cài đặt kênh → Loại kênh → **Công khai**, đặt username VD `@phimcuatoi`.
2. Upload video vào kênh (nhớ nén dưới 2GB nếu acc thường, 4GB nếu Premium).
3. Trên điện thoại: nhấn giữ video → **Copy Link**. Trên máy tính: bấm ⋯ → **Copy Post Link**.
   - Bạn sẽ được link dạng: `https://t.me/phimcuatoi/123`
4. Mở web → trang **Đăng phim** (`admin.html`) → dán link này vào ô **Video URL** → Lưu.
5. Xong! Web sẽ tự nhúng player Telegram (`?embed=1`).

> Lưu ý: nếu kênh Private (riêng tư) thì link dạng `https://t.me/c/12345/678` sẽ **KHÔNG embed được** cho khách. Muốn private thì dùng Cách 2.

## Cách 2: Lấy link MP4 trực tiếp qua Bot API (MƯỢT NHẤT, khuyên dùng)

Link này phát **trực tiếp như file MP4**, không hiện khung Telegram, tua nhanh, xem full màn hình đẹp.

1. Nhắn cho `@BotFather` → `/newbot` → đặt tên → nhận **TOKEN** dạng `123456:ABC-DEF...`.
2. Thêm bot vào kênh của bạn với quyền **Admin** (Post Messages).
3. Đăng video lên kênh.
4. Lấy `file_id`: mở trình duyệt vào:
   ```
   https://api.telegram.org/bot<TOKEN>/getUpdates?allowed_updates=["channel_post"]
   ```
   Tìm đoạn `"video":{"file_id":"BAACAgUAAxkB..."}`. Copy `file_id`.
   > Mẹo: nếu không thấy, forward video cho bot rồi gọi `getUpdates` không tham số.
5. Lấy `file_path`:
   ```
   https://api.telegram.org/bot<TOKEN>/getFile?file_id=<FILE_ID>
   ```
   Kết quả trả về: `"file_path":"videos/file_123.mp4"`.
6. Link phát trực tiếp:
   ```
   https://api.telegram.org/file/bot<TOKEN>/videos/file_123.mp4
   ```
7. Dán link này vào ô **Video URL** trong trang Đăng phim.

Ví dụ thật:
```
https://api.telegram.org/file/bot123456:AAExxxx/videos/file_0.mp4
```

> Link này sống vĩnh viễn trừ khi bạn xóa file gốc. Dùng được cho `<video>` tag, tua/seek thoải mái.

## Cách 3: Dùng kho trung gian (nếu video > 2GB hoặc cần băng thông lớn)

Telegram giới hạn file. Nếu phim dài, bạn có thể:
- Tách thành nhiều tập, mỗi tập 1 bài đăng → mỗi tập 1 phim hoặc 1 link.
- Hoặc up lên Google Drive / Bunny Stream / Cloudflare R2 rồi dán link MP4 vào web (web vẫn phát bình thường).

---

## Poster dọc lấy ở đâu?

- Tỉ lệ chuẩn: **2:3** (VD 400x600, 600x900).
- Bạn có thể tải poster từ TMDB, Google Images, rồi up lên https://postimages.org hoặc Telegram → lấy link ảnh.
- Nếu để trống, web tự tạo ảnh mẫu.

## Chạy web

Không cần cài gì. Mở terminal trong thư mục này:

```bash
python3 -m http.server 8000
```

Rồi mở: http://localhost:8000

- Trang chủ: `index.html`
- Trang đăng phim: `admin.html` (lưu vào localStorage của trình duyệt, có nút Xuất JSON để backup).
