#!/usr/bin/env python3
"""R2 persistent-cache report for web-phim-videos (new account).

Read-only. Never prints secrets. Never deletes anything.
Warns at >8GB, critical at >9.5GB of the 10GB free-tier target.
"""
import os
import sys

ENV_FILE = "/root/web-phim/.env"
FREE_TARGET_BYTES = 10 * 1024 ** 3
WARN_BYTES = 8 * 1024 ** 3
CRIT_BYTES = int(9.5 * 1024 ** 3)
VIDEO_PREFIX = "videos/"


def load_dotenv(path):
    if not os.path.isfile(path):
        return
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            if k.strip() and k.strip() not in os.environ:
                os.environ[k.strip()] = v.strip().strip("'\"")


def fmt(n):
    if n >= 1024 ** 3:
        return f"{n / 1024 ** 3:.2f} GB"
    if n >= 1024 ** 2:
        return f"{n / 1024 ** 2:.1f} MB"
    return f"{n} B"


def main():
    load_dotenv(ENV_FILE)
    bucket = (os.environ.get("R2_BUCKET") or "").strip()
    if not bucket:
        print("R2_BUCKET missing")
        sys.exit(1)
    try:
        import boto3
    except ImportError:
        print("missing boto3")
        sys.exit(2)

    s3 = boto3.client(
        "s3",
        endpoint_url=(os.environ.get("R2_ENDPOINT") or "").strip(),
        aws_access_key_id=(os.environ.get("R2_ACCESS_KEY_ID") or "").strip(),
        aws_secret_access_key=(os.environ.get("R2_SECRET_ACCESS_KEY") or "").strip(),
        region_name="auto",
    )

    objects = []
    try:
        for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket):
            objects.extend(page.get("Contents", []))
    except Exception as e:
        print(f"ERROR listing bucket: {type(e).__name__}")
        sys.exit(1)

    videos = [o for o in objects if str(o.get("Key", "")).startswith(VIDEO_PREFIX)]
    total_size = sum(o.get("Size", 0) for o in objects)
    largest = sorted(objects, key=lambda o: o.get("Size", 0), reverse=True)[:5]
    recent = sorted(objects, key=lambda o: o.get("LastModified", 0), reverse=True)[:5]

    print(f"R2_BUCKET={bucket}")
    print(f"OBJECT_COUNT={len(objects)}")
    print(f"VIDEO_COUNT={len(videos)}")
    print(f"TOTAL_SIZE_BYTES={total_size}")
    print(f"TOTAL_SIZE_GB={total_size / 1024 ** 3:.3f}")
    print(f"FREE_TARGET_GB={FREE_TARGET_BYTES / 1024 ** 3:.0f}")
    print("-- largest objects --")
    for o in largest:
        print(f"  {fmt(o.get('Size', 0)):>9}  {o.get('Key')}")
    print("-- most recent objects --")
    for o in recent:
        print(f"  {str(o.get('LastModified'))[:19]}  {o.get('Key')}")

    if total_size >= CRIT_BYTES:
        print("STATUS: CRITICAL (>9.5GB) - report only, NOT deleting anything")
        sys.exit(3)
    if total_size >= WARN_BYTES:
        print("STATUS: WARNING (>8GB) - report only, NOT deleting anything")
        return
    print("STATUS: OK")


if __name__ == "__main__":
    main()
