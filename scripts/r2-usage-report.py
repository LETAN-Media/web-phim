#!/usr/bin/env python3
"""R2 usage report for web-phim-videos. Read-only. Never prints secrets.
Warns at >8GB and >9.5GB of the 10GB free tier. Never deletes anything.
"""
import os
import sys

FREE_BYTES = 10 * 1024 ** 3
WARN_BYTES = 8 * 1024 ** 3
CRIT_BYTES = int(9.5 * 1024 ** 3)

ENV_FILE = "/root/web-phim/.env"


def load_dotenv(path):
    if not os.path.isfile(path):
        return
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k = k.strip()
            v = v.strip()
            if k and k not in os.environ:
                os.environ[k] = v


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
        print("R2_BUCKET missing", flush=True)
        sys.exit(1)
    try:
        import boto3
    except ImportError:
        print("missing boto3", flush=True)
        sys.exit(2)

    s3 = boto3.client(
        "s3",
        endpoint_url=(os.environ.get("R2_ENDPOINT") or "").strip(),
        aws_access_key_id=(os.environ.get("R2_ACCESS_KEY_ID") or "").strip(),
        aws_secret_access_key=(os.environ.get("R2_SECRET_ACCESS_KEY") or "").strip(),
        region_name="auto",
    )

    total_size = 0
    total_objects = 0
    videos = 0
    paginator = s3.get_paginator("list_objects_v2")
    try:
        for page in paginator.paginate(Bucket=bucket):
            for obj in page.get("Contents", []):
                total_objects += 1
                total_size += obj.get("Size", 0)
                if str(obj.get("Key", "")).startswith("videos/"):
                    videos += 1
    except Exception as e:
        print(f"ERROR listing bucket: {type(e).__name__}", flush=True)
        sys.exit(1)

    remaining = FREE_BYTES - total_size
    print(f"bucket: {bucket}")
    print(f"objects: {total_objects} (videos: {videos})")
    print(f"used: {fmt(total_size)}")
    print(f"free-tier remaining: {fmt(remaining)} of {fmt(FREE_BYTES)}")
    if total_size >= CRIT_BYTES:
        print("STATUS: CRITICAL (>9.5GB) - stop uploads, do NOT auto-delete")
        sys.exit(3)
    if total_size >= WARN_BYTES:
        print("STATUS: WARNING (>8GB)")
        sys.exit(0)
    print("STATUS: OK")


if __name__ == "__main__":
    main()
