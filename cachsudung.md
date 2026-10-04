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
