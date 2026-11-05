#!/usr/bin/env bash
# ==============================================================================
# Script cắt video thành HLS (.m3u8 + các segment .ts)
# Sử dụng: ./scripts/create-hls.sh <duong-dan-video.mp4> [thu-muc-xuat]
#
# Chuẩn:
# - Mỗi đoạn .ts khoảng 6 giây (dung lượng ~2-5MB), không bao giờ lo vượt trần Telegram
# - Tạo file index.m3u8 để phát tuần tự
# ==============================================================================
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Sử dụng: $0 <duong-dan-video.mp4> [thu-muc-xuat]"
  echo "Ví dụ:   $0 /tmp/phim-dai.mp4 /tmp/phim-hls"
  exit 1
fi

INPUT="$1"
if [ ! -f "$INPUT" ]; then
  echo "Lỗi: Không tìm thấy file $INPUT" >&2
  exit 1
fi

if [ $# -ge 2 ]; then
  OUTDIR="$2"
else
  DIRNAME=$(dirname "$INPUT")
  FILENAME=$(basename "$INPUT")
  BASENAME="${FILENAME%.*}"
  OUTDIR="${DIRNAME}/${BASENAME}_hls"
fi

mkdir -p "$OUTDIR"

echo "=========================================================="
echo "Bắt đầu cắt HLS cho: $INPUT"
echo "Thư mục xuất:        $OUTDIR"
echo "=========================================================="

ffmpeg -y -i "$INPUT" \
  -c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p \
  -c:a aac -b:a 128k -ac 2 \
  -f hls \
  -hls_time 6 \
  -hls_playlist_type vod \
  -hls_segment_filename "${OUTDIR}/segment_%04d.ts" \
  "${OUTDIR}/index.m3u8"

SEG_COUNT=$(ls -1 "${OUTDIR}"/segment_*.ts 2>/dev/null | wc -l)
echo "----------------------------------------------------------"
echo "Cắt HLS thành công!"
echo "Số đoạn .ts tạo ra: $SEG_COUNT"
echo "File playlist:      ${OUTDIR}/index.m3u8"
echo "=========================================================="
