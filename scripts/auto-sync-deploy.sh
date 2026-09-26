#!/bin/bash
# Auto-sync: copy feed VPS (/var/www/phim/data) -> public/ + deploy Worker
# CHI deploy khi feed/thumbs thuc su doi (so hash truoc/sau).
# Chay bang cron moi 2 phut. Chong chay chong cheo bang flock.
set -u
cd /root/web-phim || exit 1

exec 9>/tmp/web-phim-sync.lock
flock -n 9 || exit 0

LOG=/var/log/web-phim-sync.log

hash_state() {
  # Hash theo NOI DUNG file (khong dung ls -l: copy lai doi mtime gay deploy thua)
  (md5sum public/data/feed.json 2>/dev/null; md5sum public/thumbs/* 2>/dev/null | sort -k2) | md5sum | cut -d' ' -f1
}

before=$(hash_state)

python3 scripts/sync-feed-to-public.py >>"$LOG" 2>&1 || exit 1

after=$(hash_state)

if [ "$before" = "$after" ]; then
  exit 0
fi

echo "$(date -u '+%F %T UTC') feed changed, deploying..." >>"$LOG"
/usr/bin/wrangler deploy >>"$LOG" 2>&1
echo "$(date -u '+%F %T UTC') deploy exit=$?" >>"$LOG"
