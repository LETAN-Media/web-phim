# CÁCH SỬ DỤNG — WEB PHIM

## 1. Hiện trạng đường chạy (VPS chết vẫn sống)

```
domain → Cloudflare Worker → feed/bìa tĩnh,
phim từ R2 → gateway Northflank → Telegram,
điểm xem từ KV.
```

- Web chạy 100% trên Cloudflare (Worker + R2 + KV) và gateway Northflank.
  Không có request nào lúc chạy chạm vào VPS (nhánh fallback VPS đã xóa).
- VPS giờ chỉ còn 2 việc: **nhận video mới từ Telegram** và **deploy**.
- Mất VPS thì web vẫn chạy đủ (xem phim, bìa, điểm, đếm view), chỉ không
  up phim mới / đổi tên / đổi bìa / deploy được.
- Khôi phục: lấy máy khác clone repo, `wrangler login` + `wrangler deploy`
  là xong (KV/R2/secret nằm trong tài khoản Cloudflare, không nằm trên VPS).

## 2. Up video mới

- Up video lên kênh Telegram (caption dòng đầu = tên phim).
- Ảnh bìa: gửi ảnh riêng ngay sau video (cùng album càng chắc) → thành bìa.
- Chờ cron ~2 phút tự sync + deploy, hoặc chạy tay:

```bash
cd /root/web-phim
python3 scripts/sync-feed-to-public.py
wrangler deploy
```

- Lưu ý: ảnh lẻ up lên kênh **luôn tự gắn vào video MỚI NHẤT**.
  Muốn gắn cho video cũ → báo để chuyển bìa tay (xem mục 4).

## 3. Đổi tên phim

```bash
cd /root/web-phim
python3 -c "
import json
p='/var/www/phim/data/feed.json'
feed=json.load(open(p, encoding='utf-8'))
for x in feed:
    if x['mid']==MID_CAN_DOI:
        x['title']='TEN MOI'
json.dump(feed, open(p,'w',encoding='utf-8'), ensure_ascii=False)
"
python3 scripts/sync-feed-to-public.py
wrangler deploy
```

## 4. Chuyển bìa (ảnh mới tự gắn nhầm sang video mới nhất)

```bash
cd /root/web-phim
python3 -c "
import json
p='/var/www/phim/data/feed.json'
feed=json.load(open(p, encoding='utf-8'))
new=next(x for x in feed if x['mid']==MID_DANG_GIU_ANH)
old=next(x for x in feed if x['mid']==MID_MUON_GAN)
old['poster_id']=new['poster_id']
json.dump(feed, open(p,'w',encoding='utf-8'), ensure_ascii=False)
"
cp /var/www/phim/data/thumbs/MID_DANG_GIU_ANH_poster /var/www/phim/data/thumbs/MID_MUON_GAN_poster
python3 scripts/sync-feed-to-public.py
wrangler deploy
```

## 5. Xóa phim khỏi web

```bash
cd /root/web-phim
python3 -c "
import json
p='/var/www/phim/data/feed.json'
feed=[x for x in json.load(open(p, encoding='utf-8')) if x.get('mid') not in (MID1, MID2)]
json.dump(feed, open(p,'w',encoding='utf-8'), ensure_ascii=False)
"
python3 scripts/sync-feed-to-public.py
rm -f public/thumbs/MID1.jpg public/thumbs/MID2.jpg
wrangler deploy
```

- Chỉ gỡ khỏi web; tin nhắn Telegram và cache R2 vẫn còn.

## 6. Điểm lượt xem (sao ★)

- Mỗi phim Telegram có điểm khởi đầu **khác nhau** (tính theo mid).
- Mỗi lượt bấm **Phát** = **+1 điểm**, cộng dồn toàn site (lưu trên KV).
- Chỉ mở trang phim (prefetch) không tính điểm.
- Xem điểm hiện tại: `curl -s https://phim.callboy76.live/api/views`

## 7. Kiểm tra web sống

```bash
curl -s https://phim.callboy76.live/api/feed | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['count'])"
curl -s https://phim.callboy76.live/api/views | head -c 120; echo
curl -s https://phim.callboy76.live/api/health
```

## 8. Đẩy code lên GitHub

```bash
cd /root/web-phim
git add -A
git commit -m "mo ta ngan gon"
git push origin main
```

- `tg-config.json` và `.env` đã gitignore (không bao giờ commit).

## 9. Dựng lại trên VPS mới (VPS cũ mất/hỏng)

### Bước 0 — Sao lưu NGAY khi VPS cũ còn sống (quan trọng nhất)

```bash
# 1 gói duy nhất: code + config + dữ liệu feed (KHÔNG đẩy file này lên GitHub)
cd / && tar -czf backup-web-phim-$(date +%F).tar.gz root/web-phim var/www/phim
# 2. API_ID / API_HASH của Bot API server (lưu kèm vào chỗ an toàn)
docker inspect telegram-bot-api --format '{{.Config.Env}}' > /root/web-phim-API-env.txt
ls -lh /backup-web-phim-*.tar.gz
```

- Không cần sao lưu `/root/tg-bot-api` (cache tạm ~242M, máy mới tự tải lại).
- Quyền Cloudflare: chỉ cần đăng nhập được tài khoản Cloudflare
  (KV/R2/secret/route đều nằm trong tài khoản, không nằm trên VPS).

### Bước 1 — Máy mới (Ubuntu): cài công cụ

```bash
apt update && apt install -y docker.io git python3 cron
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs
npm i -g pm2 wrangler
```

### Bước 2 — Clone repo

```bash
git clone https://github.com/LETAN-Media/web-phim.git /root/web-phim
cd /root/web-phim
```

### Bước 3 — Chạy Telegram Bot API server (docker)

```bash
mkdir -p /root/tg-bot-api
docker run -d --name telegram-bot-api --restart always \
  -p 127.0.0.1:8081:8081 \
  -v /root/tg-bot-api:/var/lib/telegram-bot-api \
  -e TELEGRAM_API_ID=<API_ID buoc 0> \
  -e TELEGRAM_API_HASH=<API_HASH buoc 0> \
  -e TELEGRAM_LOCAL=1 \
  aiogram/telegram-bot-api:latest
```

- `API_ID`/`API_HASH`: lấy ở Bước 0, hoặc tạo mới tại my.telegram.org.
- Kiểm tra: `curl -s http://127.0.0.1:8081/ | head -c 100`

### Bước 4 — Khôi phục config + dữ liệu feed

```bash
# tg-config.json (dán bot_token đã sao lưu)
cat > /root/web-phim/tg-config.json <<'EOF'
{"bot_token": "<BOT_TOKEN>", "api_base": "http://127.0.0.1:8081", "file_base": "http://127.0.0.1:8081"}
EOF
# dữ liệu feed đã sao lưu
mkdir -p /var/www/phim/data/thumbs
cp ./backup-phim-data/feed.json /var/www/phim/data/feed.json
cp ./backup-phim-data/thumbs/* /var/www/phim/data/thumbs/
cp ./backup-phim-data/tg-offset.txt /var/www/phim/data/ 2>/dev/null; true
```

- Plan B (mất hẳn feed gốc): web vẫn cứu được từ GitHub —
  copy `public/thumbs/<mid>.jpg` thành `/var/www/phim/data/thumbs/<mid>_poster`,
  rồi tạo entry cho từng mid trong `/var/www/phim/data/feed.json`
  (lấy title/desc/date/duration từ `public/data/feed.json`, `file_id` để rỗng).
  Phim cũ hiện web đầy đủ; chỉ không tải lại thumb từ Telegram được
  (không cần vì file đã có sẵn).

### Bước 5 — Chạy service + cron + deploy

```bash
pm2 start /root/web-phim/telegram-sync.py --name telegram-sync --interpreter python3
pm2 save && pm2 startup   # tự chạy lại khi reboot (làm theo hướng dẫn nó in ra)
crontab -l | grep -q auto-sync-deploy || (crontab -l; echo "*/2 * * * * /root/web-phim/scripts/auto-sync-deploy.sh") | crontab -
wrangler login
cd /root/web-phim && python3 scripts/sync-feed-to-public.py && wrangler deploy
```

### Bước 6 — Kiểm tra

- Làm hết mục 7 (feed đủ 9 phim, views, health).
- Up thử 1 video + 1 ảnh lên kênh Telegram → ~2 phút sau web hiện.

### Ghi chú

- Không cần cài nginx cho web (domain đã trỏ thẳng Cloudflare Worker).
- `upload-server.py` (up file lớn) là tùy chọn, không bắt buộc để web chạy.
