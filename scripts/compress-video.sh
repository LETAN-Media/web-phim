#!/usr/bin/env bash
# ==============================================================================
# Script nén video chuẩn Web cho web phim
# Sử dụng: ./scripts/compress-video.sh <file_goc.mp4> [file_dich.mp4]
#
# Chuẩn:
# - Video: H.264 (CRF 23), tối đa 1080p, tối ưu stream web
# - Âm thanh: AAC 128kbps stereo
# - Cờ +faststart: Đưa metadata lên đầu file giúp phát ngay lập tức
# ==============================================================================
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Sử dụng: $0 <duong-dan-video.mp4> [duong-dan-xuat.mp4]"
  echo "Ví dụ:   $0 /tmp/phim-nang.mp4 /tmp/phim-da-nen.mp4"
  exit 1
fi

INPUT="$1"
if [ ! -f "$INPUT" ]; then
  echo "Lỗi: Không tìm thấy file $INPUT" >&2
  exit 1
fi

if [ $# -ge 2 ]; then
  OUTPUT="$2"
else
  DIRNAME=$(dirname "$INPUT")
  FILENAME=$(basename "$INPUT")
  EXT="${FILENAME##*.}"
  BASENAME="${FILENAME%.*}"
  OUTPUT="${DIRNAME}/${BASENAME}_compressed.mp4"
fi

echo "=========================================================="
echo "Bắt đầu nén video: $INPUT"
echo "File xuất:        $OUTPUT"
echo "=========================================================="

IN_SIZE_MB=$(du -m "$INPUT" | cut -f1)
echo "Dung lượng gốc: ${IN_SIZE_MB} MB"

ffmpeg -y -i "$INPUT" \
  -c:v libx264 \
  -preset fast \
  -crf 23 \
  -pix_fmt yuv420p \
  -vf "scale='min(1920,iw)':-2" \
  -c:a aac \
  -b:a 128k \
  -ac 2 \
  -movflags +faststart \
  "$OUTPUT"

OUT_SIZE_MB=$(du -m "$OUTPUT" | cut -f1)
echo "----------------------------------------------------------"
echo "Nén thành công!"
echo "Dung lượng gốc:   ${IN_SIZE_MB} MB"
echo "Dung lượng sau nén: ${OUT_SIZE_MB} MB"
echo "File lưu tại:     $OUTPUT"
echo "=========================================================="
