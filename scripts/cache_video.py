#!/usr/bin/env python3
"""Pre-cache a Telegram video to R2 via the gateway mirror endpoint.

Usage:
  python3 scripts/cache_video.py --chat -1003952062608 --message 25

Reads STREAM_SIGNING_SECRET from the gateway .env (or env). Never prints secrets.
Idempotent: the gateway dedups concurrent jobs and skips READY objects.
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

GATEWAY = "https://p01--telegram-stream-gateway--r4v2pzg2klvq.code.run"
GATEWAY_ENV = "/root/telegram-stream-gateway/.env"

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))) if os.path.isdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), "app")) else "/root/telegram-stream-gateway")


def load_secret():
    env = os.environ.get("STREAM_SIGNING_SECRET", "").strip()
    if env:
        return env
    if os.path.isfile(GATEWAY_ENV):
        for line in open(GATEWAY_ENV, encoding="utf-8"):
            if line.startswith("STREAM_SIGNING_SECRET="):
                return line.split("=", 1)[1].strip().strip("'\"")
    return None


def http_json(url, method="GET"):
    req = urllib.request.Request(url, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read().decode() or "{}")
        except Exception:
            body = {}
        return e.code, body
    except Exception as e:
        return 0, {"error": type(e).__name__}


def main():
    parser = argparse.ArgumentParser(description="Pre-cache a video into R2")
    parser.add_argument("--chat", required=True, type=int)
    parser.add_argument("--message", required=True, type=int)
    parser.add_argument("--wait", action="store_true", help="poll until READY/FAILED")
    args = parser.parse_args()

    secret = load_secret()
    if not secret:
        print("FATAL: STREAM_SIGNING_SECRET not found")
        sys.exit(2)

    from app.security import build_signed_query
    q = build_signed_query(args.chat, args.message, 3600, secret)
    base = f"{GATEWAY}/v1"

    status, trig = http_json(f"{base}/cache/{args.chat}/{args.message}?{q}", method="POST")
    print(f"POST /v1/cache: http={status} cache={trig.get('cache')}")

    status, st = http_json(f"{base}/cache-status/{args.chat}/{args.message}?{q}")
    state = st.get("state")
    print(f"cache-status: http={status} state={state} size={st.get('size')}")
    if state == "READY":
        print("ALREADY CACHED (READY)")
        return

    if not args.wait:
        print("mirror running in background (rerun with --wait to poll)")
        return

    for i in range(1, 61):
        status, st = http_json(f"{base}/cache-status/{args.chat}/{args.message}?{q}")
        state = st.get("state")
        print(f"poll {i}: state={state} size={st.get('size')} error={st.get('error')}", flush=True)
        if state in ("READY", "FAILED", "SKIPPED"):
            break
        time.sleep(15)
    print(f"FINAL: {state}")
    sys.exit(0 if state == "READY" else 4)


if __name__ == "__main__":
    main()
